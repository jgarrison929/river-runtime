/**
 * Embedding provider — generates vector embeddings from text.
 *
 * Primary: OpenAI text-embedding-3-small (1536 dimensions, high quality).
 * Fallback: Simple TF-IDF bag-of-words approach (works offline, lower quality).
 *
 * Uses the same SQLite database pattern as other memory modules.
 */

import { logger } from '../utils/logger.js';

// --- Types ---

export interface EmbeddingProvider {
  /** Generate a single embedding vector from text. */
  embed(text: string): Promise<number[]>;
  /** Generate embeddings for multiple texts in a single batch. */
  embedBatch(texts: string[]): Promise<number[][]>;
  /** The dimensionality of the embedding vectors. */
  readonly dimensions: number;
  /** The name of this provider (for logging). */
  readonly name: string;
}

// --- OpenAI Embedding Provider ---

interface OpenAIEmbeddingResponse {
  data: Array<{
    embedding: number[];
    index: number;
  }>;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions = 1536;
  readonly name = 'openai:text-embedding-3-small';
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(apiKey: string, options?: { baseUrl?: string; model?: string }) {
    this.apiKey = apiKey;
    this.baseUrl = options?.baseUrl ?? 'https://api.openai.com/v1';
    this.model = options?.model ?? 'text-embedding-3-small';
  }

  async embed(text: string): Promise<number[]> {
    const results = await this.embedBatch([text]);
    return results[0]!;
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // OpenAI API supports batching up to 2048 inputs
    const batchSize = 512;
    const allEmbeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const response = await this.callApi(batch);
      // Sort by index to maintain order
      const sorted = response.data.sort((a, b) => a.index - b.index);
      for (const item of sorted) {
        allEmbeddings.push(item.embedding);
      }
    }

    return allEmbeddings;
  }

  private async callApi(texts: string[]): Promise<OpenAIEmbeddingResponse> {
    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `OpenAI embedding API error (${response.status}): ${errorText}`
      );
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    logger.debug('OpenAI embedding batch complete', {
      count: texts.length,
      tokens: data.usage.total_tokens,
    });

    return data;
  }
}

// --- Keyword Fallback Provider ---

/**
 * Simple bag-of-words embedding fallback for when no API key is available.
 * Uses a fixed vocabulary built from input text with TF-IDF-like weighting.
 *
 * This is intentionally low quality — it's a graceful degradation, not a
 * production embedding model. Cosine similarity will still work for keyword overlap.
 */
export class KeywordFallbackProvider implements EmbeddingProvider {
  readonly dimensions = 384; // Smaller dimension for keyword approach
  readonly name = 'keyword-fallback';

  /** Common English stop words to exclude from embeddings. */
  private static readonly STOP_WORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'is', 'was', 'are', 'were', 'be', 'been',
    'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
    'could', 'should', 'may', 'might', 'shall', 'can', 'it', 'its', 'this',
    'that', 'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'me',
    'him', 'her', 'us', 'them', 'my', 'your', 'his', 'our', 'their', 'what',
    'which', 'who', 'when', 'where', 'how', 'not', 'no', 'nor', 'if', 'then',
    'than', 'too', 'very', 'just', 'about', 'also', 'so', 'as', 'up', 'out',
    'into', 'over', 'after', 'before', 'between', 'each', 'all', 'both',
    'few', 'more', 'most', 'other', 'some', 'such', 'only', 'own', 'same',
    'here', 'there', 'again', 'further', 'once', 'during', 'while',
  ]);

  async embed(text: string): Promise<number[]> {
    return this.textToVector(text);
  }

  async embedBatch(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.textToVector(t));
  }

  private textToVector(text: string): number[] {
    const words = this.tokenize(text);
    const vector = new Float64Array(this.dimensions);

    // Use deterministic hashing to map words to dimensions
    for (const word of words) {
      const hash = this.hashString(word);
      const index = Math.abs(hash) % this.dimensions;
      // Use sign of a second hash for +/- direction (sparse random projection)
      const sign = this.hashString(word + '_sign') > 0 ? 1 : -1;
      vector[index] += sign;
    }

    // L2 normalize
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      norm += vector[i]! * vector[i]!;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] = vector[i]! / norm;
      }
    }

    return Array.from(vector);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !KeywordFallbackProvider.STOP_WORDS.has(w));
  }

  /** Simple deterministic string hash (djb2). */
  private hashString(str: string): number {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }
}

// --- Factory ---

/**
 * Create the best available embedding provider.
 * Prefers OpenAI if OPENAI_API_KEY is set, falls back to keyword-based.
 */
export function createEmbeddingProvider(): EmbeddingProvider {
  const openaiKey = process.env['OPENAI_API_KEY'];

  if (openaiKey && openaiKey.length > 10) {
    logger.info('Using OpenAI embedding provider', { model: 'text-embedding-3-small' });
    return new OpenAIEmbeddingProvider(openaiKey);
  }

  logger.warn('No OPENAI_API_KEY found — using keyword fallback embedding provider');
  return new KeywordFallbackProvider();
}

// --- Utilities ---

/** Compute cosine similarity between two vectors. Returns 0-1 (1 = identical). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}

/** Serialize a number array to a Buffer (Float32Array) for SQLite BLOB storage. */
export function vectorToBuffer(vector: number[]): Buffer {
  const float32 = new Float32Array(vector);
  return Buffer.from(float32.buffer);
}

/** Deserialize a Buffer (Float32Array) back to a number array. */
export function bufferToVector(buf: Buffer): number[] {
  const float32 = new Float32Array(
    buf.buffer,
    buf.byteOffset,
    buf.byteLength / Float32Array.BYTES_PER_ELEMENT
  );
  return Array.from(float32);
}
