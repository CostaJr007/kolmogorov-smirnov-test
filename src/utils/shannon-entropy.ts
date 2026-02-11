// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Shannon Entropy and Information Gain Utilities
 *
 * This module implements Shannon's Information Theory concepts to analyze
 * HTTP responses and detect anomalies or significant changes in server behavior.
 *
 * Used for Gray-box testing to identify "interesting" responses that deviate
 * from the baseline, even if no explicit error message is present.
 */

import { createHash } from 'crypto';

/**
 * Calculate Shannon Entropy of a string.
 * Higher entropy indicates more randomness (e.g., encrypted data, compressed data).
 * Lower entropy indicates more structure (e.g., repeated text, simple HTML).
 *
 * Formula: H(X) = -sum(p(x) * log2(p(x)))
 */
export function calculateEntropy(data: string): number {
  if (!data) return 0;

  const frequencies = new Map<string, number>();
  for (const char of data) {
    frequencies.set(char, (frequencies.get(char) || 0) + 1);
  }

  let entropy = 0;
  const len = data.length;
  for (const count of frequencies.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }

  return entropy;
}

/**
 * Calculate Information Gain (Kullback-Leibler Divergence) between two response bodies.
 * Measures how much "surprise" the new response brings compared to the baseline.
 *
 * Useful for detecting:
 * - WAF blocking (often low entropy, standard error pages)
 * - SQL Injection (often changes structure, high divergence)
 * - Blind boolean differences
 */
export function calculateInformationGain(baseline: string, target: string): number {
  // Simple approximation using Jaccard Similarity on token sets for text
  // For a more rigorous information theoretic approach, we'd use character distribution KL-divergence
  // but for HTTP responses, structural difference is often more important.
  
  // 1. Tokenize (simple split by non-alphanumeric)
  const tokenize = (text: string) => new Set(text.toLowerCase().split(/[^a-z0-9]+/));
  
  const setA = tokenize(baseline);
  const setB = tokenize(target);
  
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  
  if (union.size === 0) return 0;
  
  const jaccardSimilarity = intersection.size / union.size;
  
  // Information Gain ~ Dissimilarity
  return 1 - jaccardSimilarity;
}

/**
 * Analyze a set of HTTP responses to find outliers based on entropy and length.
 * 
 * @param responses Array of response objects { id, body, status, time }
 * @returns Array of outliers with anomaly scores
 */
export function detectAnomalies(responses: Array<{ id: string, body: string, status: number, time: number }>) {
  if (responses.length < 2) return [];

  const stats = responses.map(r => ({
    ...r,
    entropy: calculateEntropy(r.body),
    length: r.body.length
  }));

  // Calculate mean and stddev for entropy and length
  const meanEntropy = stats.reduce((sum, r) => sum + r.entropy, 0) / stats.length;
  const meanLength = stats.reduce((sum, r) => sum + r.length, 0) / stats.length;
  
  const stdDevEntropy = Math.sqrt(stats.reduce((sum, r) => sum + Math.pow(r.entropy - meanEntropy, 2), 0) / stats.length);
  const stdDevLength = Math.sqrt(stats.reduce((sum, r) => sum + Math.pow(r.length - meanLength, 2), 0) / stats.length);

  // Z-Score threshold for anomaly
  const THRESHOLD = 2.0;

  return stats.filter(r => {
    const zEntropy = stdDevEntropy > 0 ? Math.abs(r.entropy - meanEntropy) / stdDevEntropy : 0;
    const zLength = stdDevLength > 0 ? Math.abs(r.length - meanLength) / stdDevLength : 0;
    
    return zEntropy > THRESHOLD || zLength > THRESHOLD;
  }).map(r => ({
    id: r.id,
    reason: [] as string[],
    entropy: r.entropy,
    length: r.length
  }));
}
