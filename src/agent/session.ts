/**
 * Session management — JSONL-based conversation history persistence.
 * Each session is stored as a JSONL file keyed by session key.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { LLMMessage } from '../llm/types.js';
import { logger } from '../utils/logger.js';

interface SessionEntry {
  ts: number;
  role: 'user' | 'assistant';
  content: LLMMessage['content'];
}

export class SessionManager {
  private sessionsDir: string;
  private sessions: Map<string, LLMMessage[]> = new Map();

  constructor(sessionsDir: string) {
    this.sessionsDir = resolve(sessionsDir);
    mkdirSync(this.sessionsDir, { recursive: true });
    logger.info('Session manager initialized', { dir: this.sessionsDir });
  }

  /** Get or load session history for a given session key. */
  getHistory(sessionKey: string): LLMMessage[] {
    if (this.sessions.has(sessionKey)) {
      return this.sessions.get(sessionKey)!;
    }

    // Try to load from disk
    const filePath = this.getSessionFilePath(sessionKey);
    const messages: LLMMessage[] = [];

    if (existsSync(filePath)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          const entry = JSON.parse(line) as SessionEntry;
          messages.push({ role: entry.role, content: entry.content });
        }
        logger.debug('Loaded session from disk', {
          sessionKey,
          messageCount: messages.length,
        });
      } catch (err) {
        logger.error('Failed to load session', {
          sessionKey,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    this.sessions.set(sessionKey, messages);
    return messages;
  }

  /** Append a message to a session and persist it. */
  append(sessionKey: string, message: LLMMessage): void {
    const history = this.getHistory(sessionKey);
    history.push(message);

    // Persist to JSONL
    const entry: SessionEntry = {
      ts: Date.now(),
      role: message.role,
      content: message.content,
    };

    const filePath = this.getSessionFilePath(sessionKey);
    try {
      appendFileSync(filePath, JSON.stringify(entry) + '\n', 'utf-8');
    } catch (err) {
      logger.error('Failed to persist session entry', {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Trim old messages to keep context manageable.
   * Keeps the most recent `maxMessages` messages.
   */
  trim(sessionKey: string, maxMessages: number): void {
    const history = this.getHistory(sessionKey);
    if (history.length <= maxMessages) return;

    const trimmed = history.slice(-maxMessages);
    this.sessions.set(sessionKey, trimmed);

    // Rewrite the file with trimmed history
    const filePath = this.getSessionFilePath(sessionKey);
    try {
      const entries = trimmed.map((msg) => {
        const entry: SessionEntry = { ts: Date.now(), role: msg.role, content: msg.content };
        return JSON.stringify(entry);
      });
      writeFileSync(filePath, entries.join('\n') + '\n', 'utf-8');
      logger.debug('Trimmed session', { sessionKey, from: history.length, to: trimmed.length });
    } catch (err) {
      logger.error('Failed to rewrite trimmed session', {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Replace the entire history for a session (used by compaction).
   * Rewrites the file and in-memory cache.
   */
  replaceHistory(sessionKey: string, messages: LLMMessage[]): void {
    this.sessions.set(sessionKey, messages);

    const filePath = this.getSessionFilePath(sessionKey);
    try {
      const entries = messages.map((msg) => {
        const entry: SessionEntry = { ts: Date.now(), role: msg.role, content: msg.content };
        return JSON.stringify(entry);
      });
      writeFileSync(filePath, entries.join('\n') + '\n', 'utf-8');
      logger.info('Replaced session history', {
        sessionKey,
        messageCount: messages.length,
      });
    } catch (err) {
      logger.error('Failed to replace session history', {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Flush all in-memory sessions (for graceful shutdown). */
  flush(): void {
    logger.info('Flushing all sessions', { count: this.sessions.size });
    // Sessions are already persisted on each append, so this is mostly a no-op.
    // But we clear the in-memory cache.
    this.sessions.clear();
  }

  private getSessionFilePath(sessionKey: string): string {
    // Sanitize session key for use as filename
    const safe = sessionKey.replace(/[^a-zA-Z0-9_:-]/g, '_');
    return join(this.sessionsDir, `${safe}.jsonl`);
  }
}
