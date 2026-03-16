/**
 * Knowledge Base Store — structured technical knowledge from documentation,
 * changelogs, and experience. Solves the frozen-model problem by letting
 * River learn about new APIs, breaking changes, and best practices.
 *
 * Uses the same SQLite database as PatternStore (river.sqlite via store.ts getDb()).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

// --- Types ---

export type KnowledgeEntryType =
  | 'api_signature'
  | 'migration_note'
  | 'breaking_change'
  | 'best_practice'
  | 'anti_pattern'
  | 'concept'
  | 'example';

export type SourceType = 'official_docs' | 'changelog' | 'blog' | 'tutorial' | 'experience';
export type SourceStatus = 'pending' | 'processed' | 'failed';

export interface KnowledgeEntryInput {
  technology: string;
  version?: string;
  entry_type: KnowledgeEntryType;
  title: string;
  content: string;
  code_example?: string;
  source_url?: string;
  source_type?: SourceType;
  confidence?: number;
  tags?: string[];
}

export interface KnowledgeEntry extends KnowledgeEntryInput {
  id: string;
  confidence: number;
  is_current: boolean;
  superseded_by?: string;
  created_at: number;
  updated_at: number;
}

export interface KnowledgeSourceInput {
  url: string;
  technology: string;
  version?: string;
  title?: string;
  content_hash?: string;
}

export interface KnowledgeSource extends KnowledgeSourceInput {
  id: string;
  date_read: number;
  entries_extracted: number;
  status: SourceStatus;
  created_at: number;
}

export interface KnowledgeStats {
  totalEntries: number;
  currentEntries: number;
  supersededEntries: number;
  byTechnology: Record<string, number>;
  byType: Record<KnowledgeEntryType, number>;
  totalSources: number;
  sourcesByStatus: Record<SourceStatus, number>;
}

// --- Row types for SQLite queries ---

interface KnowledgeEntryRow {
  id: string;
  technology: string;
  version: string | null;
  entry_type: string;
  title: string;
  content: string;
  code_example: string | null;
  source_url: string | null;
  source_type: string | null;
  confidence: number;
  is_current: number;
  superseded_by: string | null;
  tags: string | null;
  created_at: number;
  updated_at: number;
}

interface KnowledgeSourceRow {
  id: string;
  url: string;
  technology: string;
  version: string | null;
  title: string | null;
  date_read: number;
  content_hash: string | null;
  entries_extracted: number;
  status: string;
  created_at: number;
}

interface CountRow {
  count: number;
}

interface TechCountRow {
  technology: string;
  count: number;
}

interface TypeCountRow {
  entry_type: string;
  count: number;
}

interface StatusCountRow {
  status: string;
  count: number;
}

// --- KnowledgeBase ---

export class KnowledgeBase {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
    logger.info('Knowledge base initialized');
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        technology TEXT NOT NULL,
        version TEXT,
        entry_type TEXT NOT NULL CHECK(entry_type IN (
          'api_signature', 'migration_note', 'breaking_change',
          'best_practice', 'anti_pattern', 'concept', 'example'
        )),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        code_example TEXT,
        source_url TEXT,
        source_type TEXT CHECK(source_type IN ('official_docs', 'changelog', 'blog', 'tutorial', 'experience')),
        confidence REAL NOT NULL DEFAULT 0.7,
        is_current INTEGER NOT NULL DEFAULT 1,
        superseded_by TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS knowledge_sources (
        id TEXT PRIMARY KEY,
        url TEXT NOT NULL,
        technology TEXT NOT NULL,
        version TEXT,
        title TEXT,
        date_read INTEGER NOT NULL DEFAULT (unixepoch()),
        content_hash TEXT,
        entries_extracted INTEGER DEFAULT 0,
        status TEXT CHECK(status IN ('pending', 'processed', 'failed')) DEFAULT 'pending',
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_tech ON knowledge_entries(technology);
      CREATE INDEX IF NOT EXISTS idx_knowledge_type ON knowledge_entries(entry_type);
      CREATE INDEX IF NOT EXISTS idx_knowledge_tech_version ON knowledge_entries(technology, version);
      CREATE INDEX IF NOT EXISTS idx_knowledge_current ON knowledge_entries(is_current);
      CREATE INDEX IF NOT EXISTS idx_sources_tech ON knowledge_sources(technology);
    `);
  }

  /** Insert a new knowledge entry. Returns the generated ID. */
  addEntry(input: KnowledgeEntryInput): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO knowledge_entries (id, technology, version, entry_type, title, content,
         code_example, source_url, source_type, confidence, is_current, tags,
         created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`
      )
      .run(
        id,
        input.technology,
        input.version ?? null,
        input.entry_type,
        input.title,
        input.content,
        input.code_example ?? null,
        input.source_url ?? null,
        input.source_type ?? null,
        input.confidence ?? 0.7,
        input.tags ? JSON.stringify(input.tags) : null,
        now,
        now
      );

    logger.debug('Knowledge entry added', {
      id,
      technology: input.technology,
      type: input.entry_type,
      title: input.title,
    });
    return id;
  }

  /** Record a documentation source. Returns the generated ID. */
  addSource(input: KnowledgeSourceInput): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO knowledge_sources (id, url, technology, version, title,
         content_hash, date_read, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.url,
        input.technology,
        input.version ?? null,
        input.title ?? null,
        input.content_hash ?? null,
        now,
        now
      );

    logger.debug('Knowledge source added', { id, url: input.url, technology: input.technology });
    return id;
  }

  /** Find knowledge entries matching technology, optionally filtered by version and type. */
  findEntries(
    technology: string,
    version?: string,
    entryType?: KnowledgeEntryType
  ): KnowledgeEntry[] {
    let sql = 'SELECT * FROM knowledge_entries WHERE technology = ? AND is_current = 1';
    const params: (string | number)[] = [technology];

    if (version) {
      sql += ' AND (version = ? OR version IS NULL)';
      params.push(version);
    }

    if (entryType) {
      sql += ' AND entry_type = ?';
      params.push(entryType);
    }

    sql += ' ORDER BY confidence DESC, updated_at DESC LIMIT 50';

    const rows = this.db.prepare(sql).all(...params) as KnowledgeEntryRow[];
    return rows.map(rowToEntry);
  }

  /** Get all current entries for a list of technologies. */
  getForTechnologies(technologies: string[]): KnowledgeEntry[] {
    if (technologies.length === 0) return [];

    const placeholders = technologies.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entries
         WHERE technology IN (${placeholders}) AND is_current = 1
         ORDER BY
           CASE entry_type
             WHEN 'breaking_change' THEN 0
             WHEN 'anti_pattern' THEN 1
             WHEN 'migration_note' THEN 2
             WHEN 'best_practice' THEN 3
             WHEN 'api_signature' THEN 4
             WHEN 'concept' THEN 5
             WHEN 'example' THEN 6
           END,
           confidence DESC
         LIMIT 100`
      )
      .all(...technologies) as KnowledgeEntryRow[];

    return rows.map(rowToEntry);
  }

  /** Get breaking changes for a technology, optionally filtered by version. */
  getBreakingChanges(technology: string, version?: string): KnowledgeEntry[] {
    return this.findEntries(technology, version, 'breaking_change');
  }

  /** Get best practices for a technology. */
  getBestPractices(technology: string): KnowledgeEntry[] {
    return this.findEntries(technology, undefined, 'best_practice');
  }

  /** Find an API signature by technology and function name (searches title and content). */
  getApiSignature(technology: string, functionName: string): KnowledgeEntry[] {
    const likeQuery = `%${functionName}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM knowledge_entries
         WHERE technology = ? AND entry_type = 'api_signature'
           AND is_current = 1
           AND (title LIKE ? OR content LIKE ?)
         ORDER BY confidence DESC
         LIMIT 10`
      )
      .all(technology, likeQuery, likeQuery) as KnowledgeEntryRow[];

    return rows.map(rowToEntry);
  }

  /** Mark an entry as superseded by a newer one. */
  supersede(oldId: string, newId: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE knowledge_entries
         SET is_current = 0, superseded_by = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(newId, now, oldId);

    logger.debug('Knowledge entry superseded', { oldId, newId });
  }

  /** Update a source as processed with the number of entries extracted. */
  markSourceProcessed(sourceId: string, entriesCount: number): void {
    this.db
      .prepare(
        `UPDATE knowledge_sources
         SET status = 'processed', entries_extracted = ?
         WHERE id = ?`
      )
      .run(entriesCount, sourceId);

    logger.debug('Knowledge source marked processed', { sourceId, entriesCount });
  }

  /** Mark a source as failed. */
  markSourceFailed(sourceId: string): void {
    this.db
      .prepare(
        `UPDATE knowledge_sources SET status = 'failed' WHERE id = ?`
      )
      .run(sourceId);
  }

  /** Get summary stats about the knowledge base. */
  getStats(): KnowledgeStats {
    const totalEntries = (
      this.db.prepare('SELECT COUNT(*) as count FROM knowledge_entries').get() as CountRow
    ).count;

    const currentEntries = (
      this.db.prepare('SELECT COUNT(*) as count FROM knowledge_entries WHERE is_current = 1').get() as CountRow
    ).count;

    const supersededEntries = totalEntries - currentEntries;

    const techRows = this.db
      .prepare(
        'SELECT technology, COUNT(*) as count FROM knowledge_entries WHERE is_current = 1 GROUP BY technology'
      )
      .all() as TechCountRow[];

    const byTechnology: Record<string, number> = {};
    for (const row of techRows) {
      byTechnology[row.technology] = row.count;
    }

    const typeRows = this.db
      .prepare(
        'SELECT entry_type, COUNT(*) as count FROM knowledge_entries WHERE is_current = 1 GROUP BY entry_type'
      )
      .all() as TypeCountRow[];

    const byType: Record<KnowledgeEntryType, number> = {
      api_signature: 0,
      migration_note: 0,
      breaking_change: 0,
      best_practice: 0,
      anti_pattern: 0,
      concept: 0,
      example: 0,
    };
    for (const row of typeRows) {
      byType[row.entry_type as KnowledgeEntryType] = row.count;
    }

    const totalSources = (
      this.db.prepare('SELECT COUNT(*) as count FROM knowledge_sources').get() as CountRow
    ).count;

    const statusRows = this.db
      .prepare('SELECT status, COUNT(*) as count FROM knowledge_sources GROUP BY status')
      .all() as StatusCountRow[];

    const sourcesByStatus: Record<SourceStatus, number> = {
      pending: 0,
      processed: 0,
      failed: 0,
    };
    for (const row of statusRows) {
      sourcesByStatus[row.status as SourceStatus] = row.count;
    }

    return {
      totalEntries,
      currentEntries,
      supersededEntries,
      byTechnology,
      byType,
      totalSources,
      sourcesByStatus,
    };
  }

  /** Get a single entry by ID. */
  getById(id: string): KnowledgeEntry | undefined {
    const row = this.db
      .prepare('SELECT * FROM knowledge_entries WHERE id = ?')
      .get(id) as KnowledgeEntryRow | undefined;
    return row ? rowToEntry(row) : undefined;
  }

  /** Check if the knowledge base is empty. */
  isEmpty(): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM knowledge_entries')
      .get() as CountRow;
    return row.count === 0;
  }
}

// --- Helpers ---

function rowToEntry(row: KnowledgeEntryRow): KnowledgeEntry {
  return {
    id: row.id,
    technology: row.technology,
    version: row.version ?? undefined,
    entry_type: row.entry_type as KnowledgeEntryType,
    title: row.title,
    content: row.content,
    code_example: row.code_example ?? undefined,
    source_url: row.source_url ?? undefined,
    source_type: row.source_type ? (row.source_type as SourceType) : undefined,
    confidence: row.confidence,
    is_current: row.is_current === 1,
    superseded_by: row.superseded_by ?? undefined,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
