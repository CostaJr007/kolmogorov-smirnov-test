// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

// Production OpenAI agent execution with retry, git checkpoints, and audit logging

import { fs, path } from 'zx';
import chalk, { type ChalkInstance } from 'chalk';
import { getOpenAIClient, DEFAULT_MODEL } from './openai-client.js';
import type { ChatCompletionMessageParam, ChatCompletionTool, ChatCompletionToolChoiceOption } from 'openai/resources/chat/completions';

import { isRetryableError, getRetryDelay, PentestError } from '../error-handling.js';
import { timingResults, Timer } from '../utils/metrics.js';
import { formatTimestamp } from '../utils/formatting.js';
import { createGitCheckpoint, commitGitSuccess, rollbackGitWorkspace, getGitCommitHash } from '../utils/git-manager.js';
import { AGENT_VALIDATORS } from '../constants.js';
import { AuditSession } from '../audit/index.js';
import type { SessionMetadata } from '../audit/utils.js';
import type { AgentName } from '../types/index.js';

import { detectExecutionContext, formatErrorOutput, formatCompletionMessage } from './output-formatters.js';
import { createProgressManager } from './progress-manager.js';
import { createAuditLogger } from './audit-logger.js';

// Import tool definitions
import { getToolsForAgent } from './tool-registry.js'; 

declare global {
  var SHANNON_DISABLE_LOADER: boolean | undefined;
}

export interface OpenAIPromptResult {
  result?: string | null | undefined;
  success: boolean;
  duration: number;
  turns?: number | undefined;
  cost: number;
  model?: string | undefined;
  partialCost?: number | undefined;
  apiErrorDetected?: boolean | undefined;
  error?: string | undefined;
  errorType?: string | undefined;
  prompt?: string | undefined;
  retryable?: boolean | undefined;
}

function outputLines(lines: string[]): void {
  for (const line of lines) {
    console.log(line);
  }
}

async function writeErrorLog(
  err: Error & { code?: string; status?: number },
  sourceDir: string,
  fullPrompt: string,
  duration: number
): Promise<void> {
  try {
    const errorLog = {
      timestamp: formatTimestamp(),
      agent: 'openai-executor',
      error: {
        name: err.constructor.name,
        message: err.message,
        code: err.code,
        status: err.status,
        stack: err.stack
      },
      context: {
        sourceDir,
        prompt: fullPrompt.slice(0, 200) + '...',
        retryable: isRetryableError(err)
      },
      duration
    };
    const logPath = path.join(sourceDir, 'error.log');
    await fs.appendFile(logPath, JSON.stringify(errorLog) + '\n');
  } catch (logError) {
    const logErrMsg = logError instanceof Error ? logError.message : String(logError);
    console.log(chalk.gray(`    (Failed to write error log: ${logErrMsg})`));
  }
}

export async function validateAgentOutput(
  result: OpenAIPromptResult,
  agentName: string | null,
  sourceDir: string
): Promise<boolean> {
  console.log(chalk.blue(`    Validating ${agentName} agent output`));

  try {
    if (!result.success || !result.result) {
      console.log(chalk.red(`    Validation failed: Agent execution was unsuccessful`));
      return false;
    }

    const validator = agentName ? AGENT_VALIDATORS[agentName as keyof typeof AGENT_VALIDATORS] : undefined;

    if (!validator) {
      console.log(chalk.yellow(`    No validator found for agent "${agentName}" - assuming success`));
      return true;
    }

    const validationResult = await validator(sourceDir);

    if (validationResult) {
      console.log(chalk.green(`    Validation passed: Required files/structure present`));
    } else {
      console.log(chalk.red(`    Validation failed: Missing required deliverable files`));
    }

    return validationResult;

  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.log(chalk.red(`    Validation failed with error: ${errMsg}`));
    return false;
  }
}

// Low-level OpenAI execution
export async function runOpenAIPrompt(
  prompt: string,
  sourceDir: string,
  context: string = '',
  description: string = 'OpenAI analysis',
  agentName: string | null = null,
  colorFn: ChalkInstance = chalk.cyan,
  sessionMetadata: SessionMetadata | null = null,
  auditSession: AuditSession | null = null,
  attemptNumber: number = 1
): Promise<OpenAIPromptResult> {
  const timer = new Timer(`agent-${description.toLowerCase().replace(/\s+/g, '-')}`);
  const fullPrompt = context ? `${context}\n\n${prompt}` : prompt;

  const execContext = detectExecutionContext(description);
  const progress = createProgressManager(
    { description, useCleanOutput: execContext.useCleanOutput },
    global.SHANNON_DISABLE_LOADER ?? false
  );
  const auditLogger = createAuditLogger(auditSession);

  console.log(chalk.blue(`  Running OpenAI (${DEFAULT_MODEL}): ${description}...`));

  const client = getOpenAIClient();
  const tools = getToolsForAgent(agentName, sourceDir);

  let turnCount = 0;
  let totalCost = 0; 
  let currentMessages: ChatCompletionMessageParam[] = [
    { role: 'system', content: 'You are an autonomous penetration testing agent. You have access to tools to execute commands and save files. Use them responsibly.' },
    { role: 'user', content: fullPrompt }
  ];

  progress.start();

  try {
    // Main Loop
    while (turnCount < 50) { 
      turnCount++;
      
      // Fix: Explicitly handle undefined vs 'auto' for tool_choice
      const toolChoice: ChatCompletionToolChoiceOption | undefined = tools.length > 0 ? 'auto' : undefined;

      const response = await client.chat.completions.create({
        model: DEFAULT_MODEL,
        messages: currentMessages,
        tools: tools.length > 0 ? tools : undefined,
        tool_choice: toolChoice,
      });

      const message = response.choices[0]?.message;
      if (!message) throw new Error('No response from OpenAI');

      currentMessages.push(message);

      // Log response
      if (message.content) {
        await auditLogger.logLlmResponse(turnCount, message.content);
        if (!execContext.useCleanOutput) {
           console.log(colorFn(`    Turn ${turnCount}: ${message.content.slice(0, 100)}...`));
        }
      }

      // Handle Tool Calls
      if (message.tool_calls && message.tool_calls.length > 0) {
        for (const toolCall of message.tool_calls) {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);
          
          await auditLogger.logToolStart(functionName, functionArgs);
          
          // Execute tool
          const toolResult = await import('./tool-registry.js').then(m => m.executeTool(functionName, functionArgs, sourceDir));
          
          await auditLogger.logToolEnd(toolResult);

          currentMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(toolResult)
          });
        }
      } else {
        // No tool calls, assume completion
        break;
      }
    }

    const duration = timer.stop();
    timingResults.agents[execContext.agentKey] = duration;
    
    // Fix: Handle null/undefined content safely
    const lastMessage = currentMessages[currentMessages.length - 1];
    let finalContent = '';
    
    if (lastMessage && 'content' in lastMessage) {
        if (typeof lastMessage.content === 'string') {
            finalContent = lastMessage.content;
        } else if (Array.isArray(lastMessage.content)) {
            // Handle array content (multimodal)
            finalContent = lastMessage.content
                .map(part => 'text' in part ? part.text : '')
                .join('');
        }
    }

    progress.finish(formatCompletionMessage(execContext, description, turnCount, duration));

    return {
      result: finalContent,
      success: true,
      duration,
      turns: turnCount,
      cost: totalCost,
      model: DEFAULT_MODEL,
      partialCost: totalCost,
    };

  } catch (error) {
    const duration = timer.stop();
    timingResults.agents[execContext.agentKey] = duration;
    const err = error as Error & { code?: string; status?: number };

    await auditLogger.logError(err, duration, turnCount);
    progress.stop();
    outputLines(formatErrorOutput(err, execContext, description, duration, sourceDir, isRetryableError(err)));
    await writeErrorLog(err, sourceDir, fullPrompt, duration);

    return {
      error: err.message,
      errorType: err.constructor.name,
      prompt: fullPrompt.slice(0, 100) + '...',
      success: false,
      duration,
      cost: totalCost,
      retryable: isRetryableError(err)
    };
  }
}

// Main entry point with retry logic
export async function runOpenAIPromptWithRetry(
  prompt: string,
  sourceDir: string,
  _allowedTools: string = 'Read',
  context: string = '',
  description: string = 'OpenAI analysis',
  agentName: string | null = null,
  colorFn: ChalkInstance = chalk.cyan,
  sessionMetadata: SessionMetadata | null = null
): Promise<OpenAIPromptResult> {
  const maxRetries = 3;
  let lastError: Error | undefined;
  let retryContext = context;

  console.log(chalk.cyan(`Starting ${description} with ${maxRetries} max attempts`));

  let auditSession: AuditSession | null = null;
  if (sessionMetadata && agentName) {
    auditSession = new AuditSession(sessionMetadata);
    await auditSession.initialize();
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await createGitCheckpoint(sourceDir, description, attempt);

    if (auditSession && agentName) {
      const fullPrompt = retryContext ? `${retryContext}\n\n${prompt}` : prompt;
      await auditSession.startAgent(agentName, fullPrompt, attempt);
    }

    try {
      const result = await runOpenAIPrompt(
        prompt, sourceDir, retryContext,
        description, agentName, colorFn, sessionMetadata, auditSession, attempt
      );

      if (result.success) {
        const validationPassed = await validateAgentOutput(result, agentName, sourceDir);

        if (validationPassed) {
          if (auditSession && agentName) {
            const commitHash = await getGitCommitHash(sourceDir);
            await auditSession.endAgent(agentName, {
              attemptNumber: attempt,
              duration_ms: result.duration,
              cost_usd: result.cost || 0,
              success: true,
              checkpoint: commitHash || undefined,
            });
          }

          await commitGitSuccess(sourceDir, description);
          console.log(chalk.green.bold(`${description} completed successfully on attempt ${attempt}/${maxRetries}`));
          return result;
        } else {
          console.log(chalk.yellow(`${description} completed but output validation failed`));
          
          if (auditSession && agentName) {
            await auditSession.endAgent(agentName, {
              attemptNumber: attempt,
              duration_ms: result.duration,
              cost_usd: result.cost || 0,
              success: false,
              error: 'Output validation failed',
              isFinalAttempt: attempt === maxRetries
            });
          }

          lastError = new Error('Output validation failed');

          if (attempt < maxRetries) {
            await rollbackGitWorkspace(sourceDir, 'validation failure');
            continue;
          } else {
            throw new PentestError(
              `Agent ${description} failed output validation after ${maxRetries} attempts.`,
              'validation',
              false
            );
          }
        }
      }

    } catch (error) {
      const err = error as Error;
      lastError = err;

      if (auditSession && agentName) {
        await auditSession.endAgent(agentName, {
          attemptNumber: attempt,
          duration_ms: 0, 
          cost_usd: 0,
          success: false,
          error: err.message,
          isFinalAttempt: attempt === maxRetries
        });
      }

      if (!isRetryableError(err)) {
        await rollbackGitWorkspace(sourceDir, 'non-retryable error cleanup');
        throw err;
      }

      if (attempt < maxRetries) {
        await rollbackGitWorkspace(sourceDir, 'retryable error cleanup');
        const delay = getRetryDelay(err, attempt);
        console.log(chalk.yellow(`${description} failed (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`));
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        await rollbackGitWorkspace(sourceDir, 'final failure cleanup');
        console.log(chalk.red(`${description} failed after ${maxRetries} attempts`));
      }
    }
  }

  throw lastError;
}
