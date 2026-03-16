/**
 * Context builder — loads identity files into the system prompt.
 * Reads SOUL.md, MEMORY.md, USER.md, etc. and combines them
 * into a formatted system prompt for the LLM.
 *
 * Phase 3c: Also retrieves relevant episodic memories for context injection.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { IdentityConfig, DaemonConfig } from '../config.js';
import type { EpisodicMemory, EpisodeSearchResult } from '../memory/episodic.js';
import { logger } from '../utils/logger.js';

export interface ContextBuilderOptions {
  identity: IdentityConfig;
  daemon: DaemonConfig;
  episodicMemory?: EpisodicMemory;
}

export class ContextBuilder {
  private identity: IdentityConfig;
  private workspace: string;
  private episodicMemory: EpisodicMemory | null;
  private cachedPrompt: string | null = null;
  private lastBuildTime = 0;
  private readonly cacheTtlMs = 60_000; // Rebuild every 60s

  constructor(options: ContextBuilderOptions) {
    this.identity = options.identity;
    this.workspace = options.daemon.workspace;
    this.episodicMemory = options.episodicMemory ?? null;
  }

  /** Set or replace the episodic memory instance. */
  setEpisodicMemory(episodic: EpisodicMemory): void {
    this.episodicMemory = episodic;
  }

  /**
   * Build the system prompt from identity files.
   * Caches the result for cacheTtlMs to avoid re-reading files on every message.
   */
  buildSystemPrompt(): string {
    const now = Date.now();
    if (this.cachedPrompt && now - this.lastBuildTime < this.cacheTtlMs) {
      return this.cachedPrompt;
    }

    const sections: string[] = [];

    // Runtime preamble
    sections.push(this.buildPreamble());

    // Load each identity file
    for (const filename of this.identity.files) {
      const filePath = resolve(this.workspace, filename);
      if (existsSync(filePath)) {
        try {
          const content = readFileSync(filePath, 'utf-8');
          sections.push(`## ${filename}\n\n${content.trim()}`);
          logger.debug('Loaded identity file', { filename, length: content.length });
        } catch (err) {
          logger.warn('Failed to read identity file', {
            filename,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } else {
        logger.debug('Identity file not found, skipping', { filename });
      }
    }

    this.cachedPrompt = sections.join('\n\n---\n\n');
    this.lastBuildTime = now;

    logger.info('System prompt built', {
      fileCount: this.identity.files.length,
      promptLength: this.cachedPrompt.length,
    });

    return this.cachedPrompt;
  }

  /**
   * Build a system prompt enhanced with relevant episodic memories.
   * Searches episodic memory for context related to the current message.
   *
   * @param recentContext - Recent message text to use as a search query
   * @returns The full system prompt with episodic memories section included
   */
  async buildEnhancedPrompt(recentContext?: string): Promise<string> {
    const basePrompt = this.buildSystemPrompt();

    if (!this.episodicMemory || !recentContext) {
      return basePrompt;
    }

    try {
      const memories = await this.episodicMemory.searchHybrid(recentContext, {
        limit: 5,
        minSimilarity: 0.5,
      });

      if (memories.length === 0) {
        return basePrompt;
      }

      const memoriesSection = this.formatEpisodicMemories(memories);
      if (!memoriesSection) {
        return basePrompt;
      }

      return `${basePrompt}\n\n---\n\n${memoriesSection}`;
    } catch (err) {
      logger.warn('Failed to retrieve episodic memories for context', {
        error: err instanceof Error ? err.message : String(err),
      });
      return basePrompt;
    }
  }

  /**
   * Format episodic memory search results into a system prompt section.
   * Keeps under ~2000 tokens to avoid bloating context.
   */
  private formatEpisodicMemories(results: EpisodeSearchResult[]): string | null {
    if (results.length === 0) return null;

    const maxChars = 8000; // ~2000 tokens
    let totalChars = 0;
    const entries: string[] = [];

    for (const result of results) {
      const { episode, similarity } = result;
      const date = new Date(episode.createdAt * 1000).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      });

      const entry = [
        `**${date}** (${episode.channel ?? 'unknown'}, relevance: ${(similarity * 100).toFixed(0)}%)`,
        episode.summary ?? episode.content.slice(0, 300),
        episode.topics.length > 0 ? `Topics: ${episode.topics.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      if (totalChars + entry.length > maxChars) break;
      totalChars += entry.length;
      entries.push(entry);
    }

    if (entries.length === 0) return null;

    return `## Relevant Past Conversations\n\n${entries.join('\n\n---\n\n')}`;
  }

  /** Force a rebuild of the system prompt on next call. */
  invalidateCache(): void {
    this.cachedPrompt = null;
    this.lastBuildTime = 0;
  }

  private buildPreamble(): string {
    const now = new Date();
    const tz = 'America/Los_Angeles';
    const formatted = now.toLocaleString('en-US', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });

    return [
      '# River Runtime',
      '',
      'You are River, running on the river-runtime daemon.',
      `Current date/time: ${formatted} (${tz})`,
      `Workspace: ${this.workspace}`,
      '',
      'Your identity files (SOUL.md, USER.md, MEMORY.md, AGENTS.md, etc.) are already loaded into this system prompt below.',
      'DO NOT use the read tool to re-read them — they are already here. Just respond conversationally.',
      'On Telegram, keep responses concise and conversational. No tool calls needed for simple chat.',
      '',
      'You have access to tools for file operations, shell execution, and web access.',
      'Use them only when the user asks for something that requires them.',
    ].join('\n');
  }
}
