// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

import { ChromaClient, Collection } from 'chromadb';
import { getOpenAIClient } from '../ai/openai-client.js';
import chalk from 'chalk';

const CHROMA_URL = process.env.CHROMA_DB_URL || 'http://localhost:8000';
const COLLECTION_NAME = 'exploit_history';

let client: ChromaClient | null = null;
let collection: Collection | null = null;

async function getCollection(): Promise<Collection> {
  if (collection) return collection;

  if (!client) {
    client = new ChromaClient({ path: CHROMA_URL });
  }

  try {
    collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
      metadata: { "hnsw:space": "cosine" }
    });
    return collection;
  } catch (error) {
    console.error(chalk.red('Failed to connect to ChromaDB:'), error);
    throw error;
  }
}

async function getEmbeddings(texts: string[]): Promise<number[][]> {
  const openai = getOpenAIClient();
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return response.data.map(d => d.embedding);
}

export interface ExploitEntry {
  id: string;
  title: string;
  description: string;
  platform: string;
  cve?: string;
  technique: string;
}

export async function ingestExploitData(entries: ExploitEntry[]): Promise<void> {
  const col = await getCollection();
  
  const ids = entries.map(e => e.id);
  const documents = entries.map(e => `${e.title}\n${e.description}\nTechnique: ${e.technique}`);
  const metadatas = entries.map(e => ({
    title: e.title,
    platform: e.platform,
    cve: e.cve || '',
    technique: e.technique
  }));

  const embeddings = await getEmbeddings(documents);

  await col.add({
    ids,
    embeddings,
    metadatas,
    documents
  });

  console.log(chalk.green(`Ingested ${entries.length} exploit entries into Knowledge Base.`));
}

export async function searchExploits(query: string, limit: number = 5): Promise<ExploitEntry[]> {
  const col = await getCollection();
  const queryEmbedding = await getEmbeddings([query]);

  const results = await col.query({
    queryEmbeddings: queryEmbedding,
    nResults: limit,
  });

  if (!results.ids[0] || !results.metadatas[0] || !results.documents[0]) {
    return [];
  }

  // Fix: Explicitly type the map parameters to avoid implicit any
  return results.ids[0].map((id: string, index: number) => {
    const meta = results.metadatas[0]![index] as any;
    return {
      id,
      title: meta.title,
      description: results.documents[0]![index] || '',
      platform: meta.platform,
      cve: meta.cve,
      technique: meta.technique
    };
  });
}
