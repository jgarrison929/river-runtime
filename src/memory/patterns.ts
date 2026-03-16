/**
 * Pattern Memory Store — tracks coding patterns, anti-patterns, and lessons
 * learned from sub-agent task outcomes.
 *
 * Uses the same SQLite database as MemoryStore (river.sqlite).
 */

import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

// --- Types ---

export type PatternType = 'pattern' | 'anti_pattern' | 'lesson';
export type PatternStatus = 'active' | 'disputed' | 'archived';
export type TaskOutcomeStatus = 'success' | 'partial' | 'failure';

export interface PatternInput {
  type: PatternType;
  title: string;
  description: string;
  technology?: string;
  context?: string;
  correct_approach?: string;
  incorrect_approach?: string;
  confidence?: number;
  occurrences?: number;
  source_task_id?: string;
  tags?: string[];
}

export interface Pattern extends PatternInput {
  id: string;
  confidence: number;
  occurrences: number;
  status: PatternStatus;
  last_applied_at?: number;
  disputed_by?: string;
  created_at: number;
  updated_at: number;
}

export interface TaskOutcomeInput {
  task_description: string;
  approach: string;
  technologies?: string[];
  files_changed?: string[];
  outcome: TaskOutcomeStatus;
  compile_success?: boolean | null;
  tests_passed?: boolean | null;
  issues?: string;
  fix?: string;
  duration_ms?: number;
  tokens_used?: number;
  patterns_applied?: string[];
  patterns_extracted?: string[];
  parent_session?: string;
}

export interface TaskOutcome extends TaskOutcomeInput {
  id: string;
  created_at: number;
}

export interface PatternStats {
  total: number;
  byType: Record<PatternType, number>;
  byTechnology: Record<string, number>;
  averageConfidence: number;
  totalOutcomes: number;
  outcomesByStatus: Record<TaskOutcomeStatus, number>;
}

// --- Row types for SQLite queries ---

interface PatternRow {
  id: string;
  type: string;
  title: string;
  description: string;
  technology: string | null;
  context: string | null;
  correct_approach: string | null;
  incorrect_approach: string | null;
  confidence: number;
  occurrences: number;
  last_applied_at: number | null;
  source_task_id: string | null;
  tags: string | null;
  status: string | null;
  disputed_by: string | null;
  created_at: number;
  updated_at: number;
}

interface CountRow {
  count: number;
}

interface TypeCountRow {
  type: string;
  count: number;
}

interface TechCountRow {
  technology: string;
  count: number;
}

interface AvgRow {
  avg_confidence: number | null;
}

interface OutcomeCountRow {
  outcome: string;
  count: number;
}

// --- PatternStore ---

export class PatternStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initialize();
    logger.info('Pattern store initialized');
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS patterns (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('pattern', 'anti_pattern', 'lesson')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        technology TEXT,
        context TEXT,
        correct_approach TEXT,
        incorrect_approach TEXT,
        confidence REAL NOT NULL DEFAULT 0.5,
        occurrences INTEGER NOT NULL DEFAULT 1,
        last_applied_at INTEGER,
        source_task_id TEXT,
        tags TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS task_outcomes (
        id TEXT PRIMARY KEY,
        task_description TEXT NOT NULL,
        approach TEXT NOT NULL,
        technologies TEXT,
        files_changed TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('success', 'partial', 'failure')),
        compile_success INTEGER,
        tests_passed INTEGER,
        issues TEXT,
        fix TEXT,
        duration_ms INTEGER,
        tokens_used INTEGER,
        patterns_applied TEXT,
        patterns_extracted TEXT,
        parent_session TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE INDEX IF NOT EXISTS idx_patterns_tech ON patterns(technology);
      CREATE INDEX IF NOT EXISTS idx_patterns_type ON patterns(type);
      CREATE INDEX IF NOT EXISTS idx_patterns_confidence ON patterns(confidence DESC);
      CREATE INDEX IF NOT EXISTS idx_outcomes_outcome ON task_outcomes(outcome);
      CREATE INDEX IF NOT EXISTS idx_outcomes_tech ON task_outcomes(technologies);
    `);

    // Phase 5 schema migration: add status and disputed_by columns
    this.migrateSchema();
  }

  /** Add status and disputed_by columns if they don't exist yet. */
  private migrateSchema(): void {
    // Check if 'status' column exists
    const columns = this.db
      .prepare("PRAGMA table_info(patterns)")
      .all() as Array<{ name: string }>;

    const columnNames = new Set(columns.map((c) => c.name));

    if (!columnNames.has('status')) {
      this.db.exec(
        "ALTER TABLE patterns ADD COLUMN status TEXT DEFAULT 'active'"
      );
      logger.info('Added status column to patterns table');
    }

    if (!columnNames.has('disputed_by')) {
      this.db.exec(
        'ALTER TABLE patterns ADD COLUMN disputed_by TEXT'
      );
      logger.info('Added disputed_by column to patterns table');
    }
  }

  /** Insert a new pattern. Returns the generated ID. */
  addPattern(input: PatternInput): string {
    const id = randomUUID();
    const now = Math.floor(Date.now() / 1000);

    this.db
      .prepare(
        `INSERT INTO patterns (id, type, title, description, technology, context,
         correct_approach, incorrect_approach, confidence, occurrences,
         source_task_id, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        input.title,
        input.description,
        input.technology ?? null,
        input.context ?? null,
        input.correct_approach ?? null,
        input.incorrect_approach ?? null,
        input.confidence ?? 0.5,
        input.occurrences ?? 1,
        input.source_task_id ?? null,
        input.tags ? JSON.stringify(input.tags) : null,
        now,
        now
      );

    logger.debug('Pattern added', { id, type: input.type, title: input.title });
    return id;
  }

  /** Record a task outcome. Returns the generated ID. */
  addTaskOutcome(input: TaskOutcomeInput): string {
    const id = randomUUID();

    this.db
      .prepare(
        `INSERT INTO task_outcomes (id, task_description, approach, technologies,
         files_changed, outcome, compile_success, tests_passed, issues, fix,
         duration_ms, tokens_used, patterns_applied, patterns_extracted, parent_session)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.task_description,
        input.approach,
        input.technologies ? JSON.stringify(input.technologies) : null,
        input.files_changed ? JSON.stringify(input.files_changed) : null,
        input.outcome,
        input.compile_success === null || input.compile_success === undefined
          ? null
          : input.compile_success
            ? 1
            : 0,
        input.tests_passed === null || input.tests_passed === undefined
          ? null
          : input.tests_passed
            ? 1
            : 0,
        input.issues ?? null,
        input.fix ?? null,
        input.duration_ms ?? null,
        input.tokens_used ?? null,
        input.patterns_applied ? JSON.stringify(input.patterns_applied) : null,
        input.patterns_extracted ? JSON.stringify(input.patterns_extracted) : null,
        input.parent_session ?? null
      );

    logger.debug('Task outcome recorded', { id, outcome: input.outcome });
    return id;
  }

  /** Search patterns by technology, tags, or text in title/description. */
  findPatterns(query: string): Pattern[] {
    const likeQuery = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM patterns
         WHERE technology LIKE ? OR title LIKE ? OR description LIKE ?
            OR tags LIKE ? OR context LIKE ?
         ORDER BY confidence DESC
         LIMIT 50`
      )
      .all(likeQuery, likeQuery, likeQuery, likeQuery, likeQuery) as PatternRow[];

    return rows.map(rowToPattern);
  }

  /**
   * Get patterns relevant to a planned task, ordered by confidence.
   * Matches on technologies and keywords from the task description.
   */
  getRelevantPatterns(technologies: string[], taskDescription: string): Pattern[] {
    const results: Map<string, Pattern> = new Map();

    // Match by technology
    for (const tech of technologies) {
      const rows = this.db
        .prepare(
          `SELECT * FROM patterns
           WHERE technology = ? OR tags LIKE ?
           ORDER BY confidence DESC
           LIMIT 20`
        )
        .all(tech, `%${tech}%`) as PatternRow[];

      for (const row of rows) {
        if (!results.has(row.id)) {
          results.set(row.id, rowToPattern(row));
        }
      }
    }

    // Match by keywords in task description (split into significant words)
    const keywords = taskDescription
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 10); // Limit to avoid too many queries

    for (const keyword of keywords) {
      const rows = this.db
        .prepare(
          `SELECT * FROM patterns
           WHERE LOWER(title) LIKE ? OR LOWER(description) LIKE ? OR LOWER(context) LIKE ?
           ORDER BY confidence DESC
           LIMIT 10`
        )
        .all(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`) as PatternRow[];

      for (const row of rows) {
        if (!results.has(row.id)) {
          results.set(row.id, rowToPattern(row));
        }
      }
    }

    // Sort all results by confidence descending
    return Array.from(results.values()).sort((a, b) => b.confidence - a.confidence);
  }

  /** Reinforce a pattern — bump confidence and occurrence count. */
  reinforcePattern(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE patterns
         SET confidence = MIN(confidence + 0.05, 1.0),
             occurrences = occurrences + 1,
             last_applied_at = ?,
             updated_at = ?
         WHERE id = ?`
      )
      .run(now, now, id);

    logger.debug('Pattern reinforced', { id });
  }

  /** Degrade a pattern — lower confidence when it doesn't help. */
  degradePattern(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE patterns
         SET confidence = MAX(confidence - 0.1, 0.0),
             updated_at = ?
         WHERE id = ?`
      )
      .run(now, id);

    logger.debug('Pattern degraded', { id });
  }

  /** Get the highest-confidence patterns. */
  getTopPatterns(limit: number = 20): Pattern[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM patterns ORDER BY confidence DESC LIMIT ?`
      )
      .all(limit) as PatternRow[];

    return rows.map(rowToPattern);
  }

  /** Get known anti-patterns, optionally filtered by technology. */
  getAntiPatterns(technology?: string): Pattern[] {
    if (technology) {
      const rows = this.db
        .prepare(
          `SELECT * FROM patterns
           WHERE type = 'anti_pattern' AND (technology = ? OR tags LIKE ?)
           ORDER BY confidence DESC`
        )
        .all(technology, `%${technology}%`) as PatternRow[];
      return rows.map(rowToPattern);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM patterns WHERE type = 'anti_pattern' ORDER BY confidence DESC`
      )
      .all() as PatternRow[];

    return rows.map(rowToPattern);
  }

  /** Get summary stats about the pattern store. */
  getStats(): PatternStats {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM patterns').get() as CountRow
    ).count;

    const byTypeRows = this.db
      .prepare('SELECT type, COUNT(*) as count FROM patterns GROUP BY type')
      .all() as TypeCountRow[];

    const byType: Record<PatternType, number> = {
      pattern: 0,
      anti_pattern: 0,
      lesson: 0,
    };
    for (const row of byTypeRows) {
      byType[row.type as PatternType] = row.count;
    }

    const byTechRows = this.db
      .prepare(
        `SELECT technology, COUNT(*) as count FROM patterns
         WHERE technology IS NOT NULL GROUP BY technology`
      )
      .all() as TechCountRow[];

    const byTechnology: Record<string, number> = {};
    for (const row of byTechRows) {
      byTechnology[row.technology] = row.count;
    }

    const avgRow = this.db
      .prepare('SELECT AVG(confidence) as avg_confidence FROM patterns')
      .get() as AvgRow;

    const totalOutcomes = (
      this.db.prepare('SELECT COUNT(*) as count FROM task_outcomes').get() as CountRow
    ).count;

    const outcomeRows = this.db
      .prepare('SELECT outcome, COUNT(*) as count FROM task_outcomes GROUP BY outcome')
      .all() as OutcomeCountRow[];

    const outcomesByStatus: Record<TaskOutcomeStatus, number> = {
      success: 0,
      partial: 0,
      failure: 0,
    };
    for (const row of outcomeRows) {
      outcomesByStatus[row.outcome as TaskOutcomeStatus] = row.count;
    }

    return {
      total,
      byType,
      byTechnology,
      averageConfidence: avgRow.avg_confidence ?? 0,
      totalOutcomes,
      outcomesByStatus,
    };
  }

  /** Check if the patterns table is empty. */
  isEmpty(): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) as count FROM patterns')
      .get() as CountRow;
    return row.count === 0;
  }

  /** Get a pattern by ID. */
  getById(id: string): Pattern | undefined {
    const row = this.db
      .prepare('SELECT * FROM patterns WHERE id = ?')
      .get(id) as PatternRow | undefined;
    return row ? rowToPattern(row) : undefined;
  }

  /**
   * Mark a pattern as disputed. When a pattern is contradicted
   * but has confidence > 0.6, it's flagged for human review
   * rather than auto-decayed.
   */
  disputePattern(id: string, reason: string): void {
    const now = Math.floor(Date.now() / 1000);
    const pattern = this.getById(id);
    if (!pattern) return;

    if (pattern.confidence > 0.6) {
      // High-confidence patterns become disputed instead of degraded
      this.db
        .prepare(
          `UPDATE patterns SET status = 'disputed', disputed_by = ?, updated_at = ? WHERE id = ?`
        )
        .run(reason, now, id);

      logger.info('Pattern disputed (high confidence, needs review)', { id, reason });
    } else {
      // Low-confidence contradicted patterns just get degraded
      this.degradePattern(id);
    }
  }

  /** Archive a pattern (set status = 'archived'). */
  archivePattern(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare('UPDATE patterns SET status = ?, updated_at = ? WHERE id = ?')
      .run('archived', now, id);

    logger.debug('Pattern archived', { id });
  }

  /** Restore a disputed or archived pattern to active status. */
  activatePattern(id: string): void {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `UPDATE patterns SET status = 'active', disputed_by = NULL, updated_at = ? WHERE id = ?`
      )
      .run(now, id);

    logger.debug('Pattern activated', { id });
  }

  /** Get all disputed patterns (for human review). */
  getDisputedPatterns(): Pattern[] {
    const rows = this.db
      .prepare("SELECT * FROM patterns WHERE status = 'disputed' ORDER BY confidence DESC")
      .all() as PatternRow[];

    return rows.map(rowToPattern);
  }

  /** Expose the underlying database for cross-module queries. */
  getDb(): Database.Database {
    return this.db;
  }
}

// --- Helpers ---

function rowToPattern(row: PatternRow): Pattern {
  return {
    id: row.id,
    type: row.type as PatternType,
    title: row.title,
    description: row.description,
    technology: row.technology ?? undefined,
    context: row.context ?? undefined,
    correct_approach: row.correct_approach ?? undefined,
    incorrect_approach: row.incorrect_approach ?? undefined,
    confidence: row.confidence,
    occurrences: row.occurrences,
    status: (row.status as PatternStatus) ?? 'active',
    last_applied_at: row.last_applied_at ?? undefined,
    disputed_by: row.disputed_by ?? undefined,
    source_task_id: row.source_task_id ?? undefined,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
