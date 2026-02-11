// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { createSaveDeliverableTool } from '../../mcp-server/src/tools/save-deliverable.js';
import { generateTotpTool } from '../../mcp-server/src/tools/generate-totp.js';
import { SaveDeliverableInputSchema } from '../../mcp-server/src/tools/save-deliverable.js';
import { GenerateTotpInputSchema } from '../../mcp-server/src/tools/generate-totp.js';
import { saveDeliverableFile } from '../../mcp-server/src/utils/file-operations.js';
import { validateQueueJson } from '../../mcp-server/src/validation/queue-validator.js';
import { DELIVERABLE_FILENAMES, isQueueType, type DeliverableType } from '../../mcp-server/src/types/deliverables.js';
import { validateTotpSecret } from '../../mcp-server/src/validation/totp-validator.js';
import { createHmac } from 'crypto';
import { calculateEntropy, calculateInformationGain } from '../utils/shannon-entropy.js';
import { searchExploits } from '../rag/knowledge-base.js';

// --- Tool Definitions (OpenAI Format) ---

const saveDeliverableToolDef: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'save_deliverable',
    description: 'Saves deliverable files with automatic validation. Queue files must have {"vulnerabilities": [...]} structure.',
    parameters: zodToJsonSchema(SaveDeliverableInputSchema) as Record<string, unknown>,
  },
};

const generateTotpToolDef: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'generate_totp',
    description: 'Generates 6-digit TOTP code for authentication. Secret must be base32-encoded.',
    parameters: zodToJsonSchema(GenerateTotpInputSchema) as Record<string, unknown>,
  },
};

const analyzeResponseToolDef: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'analyze_response',
    description: 'Analyzes HTTP response for anomalies using Shannon Entropy and Information Gain.',
    parameters: {
      type: 'object',
      properties: {
        baseline_body: { type: 'string', description: 'The baseline HTTP response body (e.g., normal page)' },
        target_body: { type: 'string', description: 'The target HTTP response body (e.g., after injection)' },
      },
      required: ['baseline_body', 'target_body'],
    },
  },
};

const consultExploitHistoryToolDef: ChatCompletionTool = {
  type: 'function',
  function: {
    name: 'consult_exploit_history',
    description: 'Searches the Knowledge Base for similar past exploits and bypass techniques.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Description of the vulnerability or technology stack (e.g., "PostgreSQL time-based blind injection bypass WAF")' },
        limit: { type: 'integer', description: 'Number of results to return (default: 3)' },
      },
      required: ['query'],
    },
  },
};

// --- Tool Execution Logic ---

async function executeSaveDeliverable(args: any, targetDir: string) {
  const { deliverable_type, content } = args;

  if (isQueueType(deliverable_type)) {
    const queueValidation = validateQueueJson(content);
    if (!queueValidation.valid) {
      return {
        status: 'error',
        message: queueValidation.message ?? 'Invalid queue JSON',
        error: true
      };
    }
  }

  // Fix: Cast deliverable_type to DeliverableType to avoid implicit any error
  const filename = DELIVERABLE_FILENAMES[deliverable_type as DeliverableType];
  const filepath = saveDeliverableFile(targetDir, filename, content);

  return {
    status: 'success',
    message: `Deliverable saved successfully: ${filename}`,
    filepath,
    deliverableType: deliverable_type
  };
}

// TOTP Logic (Ported/Imported)
function base32Decode(encoded: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  let output = Buffer.alloc(Math.ceil((encoded.length * 5) / 8));
  let index = 0;

  for (const char of encoded.toUpperCase()) {
    const val = alphabet.indexOf(char);
    if (val === -1) continue;

    value = (value << 5) | val;
    bits += 5;

    if (bits >= 8) {
      output[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
    }
  }
  return output.slice(0, index);
}

function generateHOTP(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  
  const hmac = createHmac('sha1', key);
  hmac.update(counterBuffer);
  const hash = hmac.digest();
  
  const offset = hash[hash.length - 1]! & 0x0f;
  const code = ((hash[offset]! & 0x7f) << 24) |
               ((hash[offset + 1]! & 0xff) << 16) |
               ((hash[offset + 2]! & 0xff) << 8) |
               (hash[offset + 3]! & 0xff);
               
  return (code % 1000000).toString().padStart(6, '0');
}

async function executeGenerateTotp(args: any) {
  const { secret } = args;
  try {
    validateTotpSecret(secret);
    const currentTime = Math.floor(Date.now() / 1000);
    const timeStep = 30;
    const counter = Math.floor(currentTime / timeStep);
    const totpCode = generateHOTP(secret, counter);
    
    return {
      status: 'success',
      totpCode,
      timestamp: new Date().toISOString()
    };
  } catch (e: any) {
    return { status: 'error', message: e.message };
  }
}

async function executeAnalyzeResponse(args: any) {
  const { baseline_body, target_body } = args;
  
  const entropyBaseline = calculateEntropy(baseline_body);
  const entropyTarget = calculateEntropy(target_body);
  const informationGain = calculateInformationGain(baseline_body, target_body);
  
  return {
    entropy_baseline: entropyBaseline,
    entropy_target: entropyTarget,
    entropy_diff: Math.abs(entropyTarget - entropyBaseline),
    information_gain: informationGain,
    length_diff: Math.abs(target_body.length - baseline_body.length),
    is_anomaly: informationGain > 0.8 || Math.abs(entropyTarget - entropyBaseline) > 1.0 // Simple heuristic
  };
}

async function executeConsultExploitHistory(args: any) {
  const { query, limit } = args;
  try {
    const results = await searchExploits(query, limit || 3);
    return {
      status: 'success',
      results: results.map(r => ({
        title: r.title,
        technique: r.technique,
        description: r.description.slice(0, 200) + '...' // Truncate for context window
      }))
    };
  } catch (e: any) {
    return { status: 'error', message: `Knowledge Base unavailable: ${e.message}` };
  }
}

// --- Registry ---

export function getToolsForAgent(agentName: string | null, sourceDir: string): ChatCompletionTool[] {
  const tools = [saveDeliverableToolDef, generateTotpToolDef];
  
  // Add analysis tool for vuln/exploit agents
  if (agentName && (agentName.includes('vuln') || agentName.includes('exploit'))) {
    tools.push(analyzeResponseToolDef);
    tools.push(consultExploitHistoryToolDef);
  }
  
  return tools;
}

export async function executeTool(name: string, args: any, sourceDir: string) {
  switch (name) {
    case 'save_deliverable':
      return executeSaveDeliverable(args, sourceDir);
    case 'generate_totp':
      return executeGenerateTotp(args);
    case 'analyze_response':
      return executeAnalyzeResponse(args);
    case 'consult_exploit_history':
      return executeConsultExploitHistory(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
