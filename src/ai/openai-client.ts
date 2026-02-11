// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

// Singleton instance
let openaiInstance: OpenAI | null = null;

export function getOpenAIClient(): OpenAI {
  if (!openaiInstance) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is not set in environment variables');
    }

    openaiInstance = new OpenAI({
      apiKey: apiKey,
      baseURL: process.env.OPENAI_BASE_URL, // Optional: for compatible APIs
    });
  }
  return openaiInstance;
}

export const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
