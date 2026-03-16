/**
 * Indexing Pipeline — background indexing of conversations into episodic memory.
 *
 * After each session interaction, chunks the conversation, generates embeddings,
 * extracts entities, and stores in the episodes table.
 *
 * This runs asynchronously — it never blocks message delivery.
 */

import type { LLMMessage } from '../llm/types.js';
import type { EpisodicMemory } from './episodic.js';
import { chunkConversation, estimateTokens } from './chunker.js';
import { logger } from '../utils/logger.js';

// --- Types ---

export interface IndexingOptions {
  /** Minimum number of new messages before triggering indexing (default: 4). */
  minNewMessages?: number;
  /** Maximum tokens per chunk (default: 500). */
  maxTokensPerChunk?: number;
  /** Message overlap between chunks (default: 1). */
  chunkOverlap?: number;
}

// --- Entity extraction patterns ---

/**
 * Simple regex-based entity extraction.
 * Detects people, technologies, projects, and common nouns.
 * Not as good as LLM-based extraction, but free and fast.
 */
const TECH_PATTERNS = [
  'typescript', 'javascript', 'python', 'rust', 'golang', 'java', 'ruby',
  'react', 'nextjs', 'next.js', 'vue', 'angular', 'svelte', 'solid',
  'node', 'deno', 'bun', 'express', 'fastify', 'hono',
  'postgresql', 'postgres', 'mysql', 'sqlite', 'redis', 'mongodb',
  'docker', 'kubernetes', 'k8s', 'terraform', 'aws', 'gcp', 'azure',
  'git', 'github', 'gitlab', 'vercel', 'railway', 'fly.io',
  'anthropic', 'openai', 'claude', 'gpt', 'gemini', 'llm',
  'discord', 'telegram', 'slack', 'webchat',
  'graphql', 'rest', 'grpc', 'websocket', 'http',
  'tailwind', 'shadcn', 'css', 'html',
  'pnpm', 'npm', 'yarn', 'webpack', 'vite', 'esbuild', 'tsx',
];

const PROJECT_PATTERNS = [
  'river', 'river-runtime', 'openclaw',
  'moltbook', 'clawhub',
];

// --- IndexingPipeline ---

export class IndexingPipeline {
  private episodic: EpisodicMemory;
  private options: Required<IndexingOptions>;

  /** Track the last indexed message index per session to avoid re-indexing. */
  private lastIndexedIndex: Map<string, number> = new Map();

  /** Track whether an indexing operation is in progress per session. */
  private activeIndexing: Set<string> = new Set();

  constructor(episodic: EpisodicMemory, options?: IndexingOptions) {
    this.episodic = episodic;
    this.options = {
      minNewMessages: options?.minNewMessages ?? 4,
      maxTokensPerChunk: options?.maxTokensPerChunk ?? 500,
      chunkOverlap: options?.chunkOverlap ?? 1,
    };
    logger.info('Indexing pipeline initialized', { options: this.options });
  }

  /**
   * Index new messages from a session into episodic memory.
   * This is designed to be called after each message exchange.
   * Runs in the background — returns immediately.
   */
  indexSession(
    sessionKey: string,
    messages: LLMMessage[],
    channel: string,
    participant?: string
  ): void {
    // Don't index if already in progress for this session
    if (this.activeIndexing.has(sessionKey)) {
      logger.debug('Indexing already in progress, skipping', { sessionKey });
      return;
    }

    // Check if we have enough new messages
    const lastIdx = this.lastIndexedIndex.get(sessionKey) ?? 0;
    const newMessages = messages.slice(lastIdx);

    if (newMessages.length < this.options.minNewMessages) {
      logger.debug('Not enough new messages to index', {
        sessionKey,
        newCount: newMessages.length,
        threshold: this.options.minNewMessages,
      });
      return;
    }

    // Fire and forget — don't block the response
    this.activeIndexing.add(sessionKey);
    this.doIndex(sessionKey, newMessages, channel, participant)
      .catch((err) => {
        logger.error('Background indexing failed', {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        this.activeIndexing.delete(sessionKey);
        this.lastIndexedIndex.set(sessionKey, messages.length);
      });
  }

  /**
   * Force-index a set of messages (for manual/batch indexing).
   */
  async forceIndex(
    sessionKey: string,
    messages: LLMMessage[],
    channel: string,
    participant?: string
  ): Promise<number> {
    return this.doIndex(sessionKey, messages, channel, participant);
  }

  private async doIndex(
    sessionKey: string,
    messages: LLMMessage[],
    channel: string,
    participant?: string
  ): Promise<number> {
    const startTime = Date.now();

    // Chunk the messages
    const chunks = chunkConversation(messages, {
      maxTokens: this.options.maxTokensPerChunk,
      overlap: this.options.chunkOverlap,
      respectTurnBoundaries: true,
    });

    if (chunks.length === 0) {
      logger.debug('No chunks produced from messages', { sessionKey });
      return 0;
    }

    logger.debug('Chunked conversation for indexing', {
      sessionKey,
      messageCount: messages.length,
      chunkCount: chunks.length,
    });

    let indexed = 0;
    for (const chunk of chunks) {
      try {
        // Extract entities from the chunk
        const entities = extractEntities(chunk.content);

        // Extract topics
        const topics = extractTopics(chunk.content);

        // Compute importance based on content signals
        const importance = computeImportance(chunk.content);

        await this.episodic.addEpisode({
          sessionKey,
          content: chunk.content,
          participant,
          channel,
          topics,
          importance,
          entities,
        });

        indexed++;
      } catch (err) {
        logger.warn('Failed to index chunk', {
          sessionKey,
          chunkIndex: chunks.indexOf(chunk),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info('Indexing complete', {
      sessionKey,
      chunksIndexed: indexed,
      totalChunks: chunks.length,
      elapsed: `${elapsed}ms`,
    });

    return indexed;
  }
}

// --- Entity extraction ---

/**
 * Extract entities from text using pattern matching.
 * Returns a list of { name, type } pairs.
 */
export function extractEntities(
  text: string
): Array<{ name: string; type: string }> {
  const lower = text.toLowerCase();
  const entities: Array<{ name: string; type: string }> = [];
  const seen = new Set<string>();

  // Match known technologies
  for (const tech of TECH_PATTERNS) {
    if (lower.includes(tech) && !seen.has(tech)) {
      seen.add(tech);
      entities.push({ name: tech, type: 'technology' });
    }
  }

  // Match known projects
  for (const project of PROJECT_PATTERNS) {
    if (lower.includes(project) && !seen.has(project)) {
      seen.add(project);
      entities.push({ name: project, type: 'project' });
    }
  }

  // Match @mentions (e.g., "@user", "@agent")
  const mentionRegex = /@(\w+)/g;
  let match;
  while ((match = mentionRegex.exec(lower)) !== null) {
    const name = match[1]!;
    if (!seen.has(name) && name.length > 1) {
      seen.add(name);
      entities.push({ name, type: 'person' });
    }
  }

  // Match capitalized proper nouns (simple heuristic)
  const properNounRegex = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g;
  while ((match = properNounRegex.exec(text)) !== null) {
    const name = match[1]!.toLowerCase();
    // Filter out common sentence starters
    if (
      !seen.has(name) &&
      name.length > 2 &&
      !COMMON_SENTENCE_STARTERS.has(name)
    ) {
      seen.add(name);
      entities.push({ name, type: 'person' });
    }
  }

  return entities;
}

const COMMON_SENTENCE_STARTERS = new Set([
  'the', 'this', 'that', 'these', 'those', 'here', 'there', 'when', 'where',
  'what', 'which', 'who', 'how', 'why', 'but', 'and', 'also', 'however',
  'yes', 'sure', 'okay', 'well', 'let', 'now', 'just', 'first', 'next',
  'then', 'after', 'before', 'since', 'because', 'although', 'while',
  'please', 'thanks', 'great', 'good', 'nice', 'cool', 'done', 'note',
  'warning', 'error', 'user', 'assistant', 'tool',
]);

// --- Topic extraction ---

/**
 * Extract topics from text using keyword frequency analysis.
 */
function extractTopics(text: string): string[] {
  const lower = text.toLowerCase();
  const topics: string[] = [];

  // Check for common topic indicators
  const topicPatterns: Record<string, string[]> = {
    coding: ['function', 'class', 'import', 'export', 'const ', 'interface', 'type '],
    debugging: ['error', 'bug', 'fix', 'issue', 'crash', 'broken', 'failed'],
    architecture: ['design', 'architecture', 'pattern', 'structure', 'refactor'],
    deployment: ['deploy', 'production', 'staging', 'release', 'ci/cd', 'docker'],
    planning: ['plan', 'roadmap', 'milestone', 'sprint', 'priority', 'backlog'],
    conversation: ['how are you', 'feeling', 'think about', 'opinion'],
    memory: ['remember', 'recall', 'forgot', 'memory', 'context'],
    tools: ['tool', 'command', 'script', 'automation', 'pipeline'],
  };

  for (const [topic, keywords] of Object.entries(topicPatterns)) {
    const matchCount = keywords.filter((kw) => lower.includes(kw)).length;
    if (matchCount >= 2) {
      topics.push(topic);
    }
  }

  // Also include detected technologies as topics
  for (const tech of TECH_PATTERNS) {
    if (lower.includes(tech) && topics.length < 8) {
      if (!topics.includes(tech)) {
        topics.push(tech);
      }
    }
  }

  return topics.slice(0, 8); // Cap at 8 topics
}

// --- Importance computation ---

/**
 * Compute an importance score (0.0 - 1.0) for a chunk based on content signals.
 */
function computeImportance(text: string): number {
  let score = 0.5; // Base importance

  const lower = text.toLowerCase();
  const tokenCount = estimateTokens(text);

  // Longer chunks tend to be more substantive
  if (tokenCount > 300) score += 0.05;
  if (tokenCount > 600) score += 0.05;

  // Decision-making language
  const decisionWords = ['decided', 'agreed', 'chose', 'will do', 'plan to', 'going to'];
  if (decisionWords.some((w) => lower.includes(w))) score += 0.1;

  // Problem-solving
  const problemWords = ['fixed', 'solved', 'resolved', 'figured out', 'root cause'];
  if (problemWords.some((w) => lower.includes(w))) score += 0.1;

  // Emotional/personal content
  const personalWords = ['feel', 'think', 'believe', 'important', 'love', 'family'];
  if (personalWords.some((w) => lower.includes(w))) score += 0.05;

  // Code changes
  if (lower.includes('commit') || lower.includes('merged') || lower.includes('deployed')) {
    score += 0.05;
  }

  // Explicit importance markers
  if (lower.includes('important') || lower.includes('critical') || lower.includes('urgent')) {
    score += 0.1;
  }

  return Math.min(1.0, Math.max(0.0, score));
}
