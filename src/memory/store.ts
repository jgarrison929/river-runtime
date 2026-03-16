/**
 * Memory store — SQLite-based session state and simple text search.
 * Phase 1: basic grep-style search over memory files.
 * Phase 3c: enhanced with episodic memory vector search.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { ToolHandler } from '../tools/registry.js';
import type { EpisodicMemory } from './episodic.js';
import { logger } from '../utils/logger.js';

export class MemoryStore {
  private db: Database.Database;

  /** Expose the raw database for use by other stores (e.g., PatternStore). */
  getDb(): Database.Database {
    return this.db;
  }

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    const dbPath = join(dataDir, 'river.sqlite');
    this.db = new Database(dbPath);

    this.initialize();
    logger.info('Memory store initialized', { path: dbPath });
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);

    // Store version info
    this.db
      .prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
      .run('version', '0.1.0');
    this.db
      .prepare('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)')
      .run('initialized_at', new Date().toISOString());
  }

  /** Get a key-value pair. */
  get(key: string): string | undefined {
    const row = this.db
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get(key) as { value: string } | undefined;
    return row?.value;
  }

  /** Set a key-value pair. */
  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, unixepoch())'
      )
      .run(key, value);
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
    logger.info('Memory store closed');
  }
}

/**
 * Create a memory_search tool that greps over memory files
 * and optionally searches episodic memory via vector search.
 */
export function createMemorySearchTool(
  workspace: string,
  episodicMemory?: EpisodicMemory
): ToolHandler {
  // Store a mutable reference so we can set it after construction
  let episodic = episodicMemory;

  const handler: ToolHandler & { setEpisodicMemory(em: EpisodicMemory): void } = {
    definition: {
      name: 'memory_search',
      description:
        'Search through memory files (MEMORY.md and memory/*.md) and episodic conversation memory for matching text. Returns matching lines with context. Includes both file-based and semantic memory results.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Text to search for (case-insensitive for files, semantic for episodic memory)',
          },
          max_results: {
            type: 'number',
            description: 'Maximum number of matching sections to return (default: 10)',
          },
        },
        required: ['query'],
      },
    },
    execute: async (input) => {
      const query = String(input['query']).toLowerCase();
      const maxResults = typeof input['max_results'] === 'number' ? input['max_results'] : 10;

      const results: string[] = [];

      // --- File-based search ---

      // Search MEMORY.md
      const memoryPath = resolve(workspace, 'MEMORY.md');
      if (existsSync(memoryPath)) {
        const content = readFileSync(memoryPath, 'utf-8');
        const matches = searchFile('MEMORY.md', content, query);
        results.push(...matches.map((m) => `[file] ${m}`));
      }

      // Search memory/*.md files
      const memoryDir = resolve(workspace, 'memory');
      if (existsSync(memoryDir)) {
        const files = readdirSync(memoryDir).filter((f) => f.endsWith('.md'));
        for (const file of files) {
          const filePath = join(memoryDir, file);
          const content = readFileSync(filePath, 'utf-8');
          const matches = searchFile(`memory/${file}`, content, query);
          results.push(...matches.map((m) => `[file] ${m}`));
        }
      }

      // --- Episodic memory search ---

      if (episodic) {
        try {
          const episodicResults = await episodic.search(
            String(input['query']),
            Math.min(maxResults, 5),
            0.4
          );

          for (const result of episodicResults) {
            const { episode, similarity } = result;
            const date = new Date(episode.createdAt * 1000).toLocaleDateString(
              'en-US',
              { month: 'short', day: 'numeric', year: 'numeric' }
            );
            const preview =
              episode.content.length > 300
                ? episode.content.slice(0, 300) + '...'
                : episode.content;
            results.push(
              `[memory] **${date}** (${episode.channel ?? 'unknown'}, similarity: ${(similarity * 100).toFixed(0)}%):\n${preview}`
            );
          }
        } catch (err) {
          logger.warn('Episodic memory search failed in tool', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (results.length === 0) {
        return `No matches found for "${query}"`;
      }

      return results.slice(0, maxResults).join('\n\n---\n\n');
    },
    setEpisodicMemory(em: EpisodicMemory): void {
      episodic = em;
    },
  };

  return handler;
}

/** Search a file for query matches, returning matching sections with context. */
function searchFile(filename: string, content: string, query: string): string[] {
  const lines = content.split('\n');
  const results: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(query)) {
      // Get surrounding context (2 lines before, 2 after)
      const start = Math.max(0, i - 2);
      const end = Math.min(lines.length, i + 3);
      const context = lines.slice(start, end).join('\n');
      results.push(`**${filename}** (line ${i + 1}):\n${context}`);
    }
  }

  return results;
}
