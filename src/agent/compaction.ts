/**
 * Context compaction — summarizes long conversations to stay within token limits.
 * When session history exceeds a threshold, the LLM summarizes the conversation,
 * replaces old messages with the summary, and archives the full pre-compaction history.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LLMRouter } from '../llm/router.js';
import type { LLMMessage } from '../llm/types.js';
import type { SessionManager } from './session.js';
import { logger } from '../utils/logger.js';

export interface CompactionConfig {
  enabled: boolean;
  /** Token threshold at which to trigger compaction */
  thresholdTokens: number;
  /** Number of recent messages to keep verbatim after compaction */
  keepRecentMessages: number;
  /** Model to use for summarization (can be cheaper than primary) */
  summaryModel: string;
  /** Directory to archive pre-compaction histories */
  archiveDir: string;
}

/** Rough token estimate: ~4 chars per token for English text */
function estimateTokens(messages: LLMMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if ('text' in block) {
          chars += block.text.length;
        } else if ('content' in block && typeof block.content === 'string') {
          chars += block.content.length;
        }
      }
    }
  }
  return Math.ceil(chars / 4);
}

export class ContextCompactor {
  private config: CompactionConfig;
  private llm: LLMRouter;
  private sessions: SessionManager;

  constructor(config: CompactionConfig, llm: LLMRouter, sessions: SessionManager) {
    this.config = config;
    this.llm = llm;
    this.sessions = sessions;

    // Ensure archive directory exists
    if (config.enabled) {
      mkdirSync(config.archiveDir, { recursive: true });
    }
  }

  /**
   * Check if a session needs compaction and perform it if so.
   * Returns true if compaction was performed.
   */
  async maybeCompact(sessionKey: string): Promise<boolean> {
    if (!this.config.enabled) return false;

    const history = this.sessions.getHistory(sessionKey);
    const estimatedTokens = estimateTokens(history);

    if (estimatedTokens < this.config.thresholdTokens) {
      return false;
    }

    logger.info('Session exceeds token threshold, compacting', {
      sessionKey,
      estimatedTokens,
      threshold: this.config.thresholdTokens,
      messageCount: history.length,
    });

    await this.compact(sessionKey, history);
    return true;
  }

  private async compact(sessionKey: string, history: LLMMessage[]): Promise<void> {
    const keepCount = this.config.keepRecentMessages;

    // Ensure we have enough messages to compact
    if (history.length <= keepCount + 2) {
      logger.debug('Not enough messages to compact', {
        sessionKey,
        messageCount: history.length,
        keepCount,
      });
      return;
    }

    // Split: messages to summarize vs messages to keep
    const toSummarize = history.slice(0, history.length - keepCount);
    const toKeep = history.slice(-keepCount);

    // Archive the full pre-compaction history
    this.archiveHistory(sessionKey, history);

    // Build the summary prompt
    const summaryPrompt = this.buildSummaryPrompt(toSummarize);

    try {
      const response = await this.llm.chat({
        system: 'You are a conversation summarizer. Create a concise but comprehensive summary of the conversation that preserves key context, decisions, facts, and any important details the AI assistant would need to continue the conversation naturally.',
        messages: [{ role: 'user', content: summaryPrompt }],
        tools: [],
      });

      const summaryText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // Build the new compacted history:
      // 1. A system-injected summary message
      // 2. The recent messages
      const compactedHistory: LLMMessage[] = [
        {
          role: 'user',
          content: `[CONTEXT SUMMARY — Previous conversation has been compacted]\n\n${summaryText}\n\n[END SUMMARY — Recent messages follow]`,
        },
        {
          role: 'assistant',
          content: 'Understood. I have the context from the summary and will continue naturally.',
        },
        ...toKeep,
      ];

      // Replace the session history
      this.sessions.replaceHistory(sessionKey, compactedHistory);

      logger.info('Session compacted', {
        sessionKey,
        originalMessages: history.length,
        compactedMessages: compactedHistory.length,
        summaryLength: summaryText.length,
        estimatedTokensSaved: estimateTokens(toSummarize),
      });
    } catch (err) {
      logger.error('Failed to compact session', {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
      // Don't lose data — leave original history intact
    }
  }

  private buildSummaryPrompt(messages: LLMMessage[]): string {
    const parts: string[] = [
      'Summarize the following conversation. Preserve:',
      '- Key decisions and agreements',
      '- Important facts, names, numbers, and dates',
      '- Any ongoing tasks or context the assistant needs',
      '- User preferences and established patterns',
      '- Technical details relevant to ongoing work',
      '',
      'Be concise but don\'t omit important context.',
      '',
      '--- CONVERSATION TO SUMMARIZE ---',
      '',
    ];

    for (const msg of messages) {
      const role = msg.role === 'user' ? 'User' : 'Assistant';
      if (typeof msg.content === 'string') {
        parts.push(`**${role}:** ${msg.content}`);
      } else if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((b): b is { type: 'text'; text: string } => 'text' in b && b.type === 'text')
          .map((b) => b.text);
        if (textParts.length > 0) {
          parts.push(`**${role}:** ${textParts.join(' ')}`);
        }
        // Note tool uses/results briefly
        const toolUses = msg.content.filter((b) => b.type === 'tool_use');
        if (toolUses.length > 0) {
          parts.push(`**${role}:** [used ${toolUses.length} tool(s)]`);
        }
      }
    }

    return parts.join('\n');
  }

  private archiveHistory(sessionKey: string, history: LLMMessage[]): void {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const safeName = sessionKey.replace(/[^a-zA-Z0-9_:-]/g, '_');
      const archivePath = join(this.config.archiveDir, `${safeName}_${timestamp}.jsonl`);

      const lines = history.map((msg) =>
        JSON.stringify({ ts: Date.now(), role: msg.role, content: msg.content })
      );
      writeFileSync(archivePath, lines.join('\n') + '\n', 'utf-8');

      logger.info('Archived pre-compaction history', {
        sessionKey,
        path: archivePath,
        messageCount: history.length,
      });
    } catch (err) {
      logger.error('Failed to archive history', {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
