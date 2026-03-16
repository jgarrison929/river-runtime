/**
 * Pattern Lineage Tracker — provenance chains for experiential learning.
 *
 * Tracks the full lifecycle of patterns: where they came from (extraction),
 * how they're used (injection into dispatches), what happened (validation/
 * contradiction), and what they spawned (new patterns from outcomes).
 *
 * Inspired by Hyperspace's Research DAG concept, adapted for a single
 * persistent agent. Every pattern gets a traceable chain:
 *   Conversation → Pattern → Dispatch → Outcome → New Pattern
 *
 * Design principles:
 * - Fire-and-forget: never blocks the main agent flow
 * - Observer-only: reads/writes lineage, never controls patterns
 * - Lightweight: minimal overhead per event
 */

import type Database from 'better-sqlite3';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export type LineageEventType =
  | 'extracted'     // pattern was extracted from a conversation
  | 'injected'      // pattern was injected into a dispatch
  | 'validated'     // pattern was validated by a successful outcome
  | 'contradicted'  // pattern was contradicted by a failed outcome
  | 'consolidated'  // pattern was merged with another during consolidation
  | 'spawned'       // pattern directly led to creation of a new pattern
  | 'archived';     // pattern was archived during aging

export interface LineageEvent {
  id: number;
  event_type: LineageEventType;
  pattern_id: string;
  source_session_key?: string;
  source_message_id?: string;
  dispatch_session_key?: string;
  dispatch_task?: string;
  related_pattern_id?: string;
  outcome?: 'success' | 'partial' | 'failure';
  outcome_notes?: string;
  confidence_before?: number;
  confidence_after?: number;
  created_at: number;
}

export interface LineageChain {
  pattern: { id: string; summary: string; confidence: number };
  events: LineageEvent[];
  children: LineageChain[];  // patterns spawned from this one
  parents: LineageChain[];   // patterns that led to this one
}

export interface PatternImpact {
  patternId: string;
  totalInjections: number;
  successfulOutcomes: number;
  failedOutcomes: number;
  spawnedPatterns: number;
  successRate: number;   // successful / (successful + failed), 0 if none
  firstUsed: number;     // timestamp
  lastUsed: number;      // timestamp
}

export interface LineageStats {
  totalEvents: number;
  byType: Record<string, number>;
  mostImpactful: PatternImpact[];   // top 5 by injection count with high success rate
  recentActivity: LineageEvent[];    // last 10 events
}

// ────────────────────────────────────────────────────────────────────
// Row types for SQLite
// ────────────────────────────────────────────────────────────────────

interface LineageRow {
  id: number;
  event_type: string;
  pattern_id: string;
  source_session_key: string | null;
  source_message_id: string | null;
  dispatch_session_key: string | null;
  dispatch_task: string | null;
  related_pattern_id: string | null;
  outcome: string | null;
  outcome_notes: string | null;
  confidence_before: number | null;
  confidence_after: number | null;
  created_at: number;
}

interface CountRow {
  count: number;
}

interface TypeCountRow {
  event_type: string;
  count: number;
}

interface InjectionStatsRow {
  pattern_id: string;
  total_injections: number;
  successful: number;
  failed: number;
  spawned: number;
  first_used: number;
  last_used: number;
}

interface PatternSummaryRow {
  id: string;
  title: string;
  confidence: number;
}

// ────────────────────────────────────────────────────────────────────
// LineageTracker
// ────────────────────────────────────────────────────────────────────

export class LineageTracker {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Create the lineage table and indexes. Call once at startup. */
  init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pattern_lineage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL CHECK(event_type IN (
          'extracted',
          'injected',
          'validated',
          'contradicted',
          'consolidated',
          'spawned',
          'archived'
        )),
        pattern_id TEXT NOT NULL,
        source_session_key TEXT,
        source_message_id TEXT,
        dispatch_session_key TEXT,
        dispatch_task TEXT,
        related_pattern_id TEXT,
        outcome TEXT CHECK(outcome IN ('success', 'partial', 'failure', NULL)),
        outcome_notes TEXT,
        confidence_before REAL,
        confidence_after REAL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        FOREIGN KEY (pattern_id) REFERENCES patterns(id)
      );

      CREATE INDEX IF NOT EXISTS idx_lineage_pattern ON pattern_lineage(pattern_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_lineage_type ON pattern_lineage(event_type);
      CREATE INDEX IF NOT EXISTS idx_lineage_session ON pattern_lineage(source_session_key);
      CREATE INDEX IF NOT EXISTS idx_lineage_dispatch ON pattern_lineage(dispatch_session_key);
    `);

    logger.info('Pattern lineage tracker initialized');
  }

  // ──────────────────────────────────────────────────────────────────
  // Record Events (fire-and-forget style)
  // ──────────────────────────────────────────────────────────────────

  /** Record that a pattern was extracted from a conversation. */
  recordExtraction(patternId: string, sessionKey: string, messageId?: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO pattern_lineage (event_type, pattern_id, source_session_key, source_message_id, created_at)
           VALUES ('extracted', ?, ?, ?, ?)`
        )
        .run(patternId, sessionKey, messageId ?? null, Date.now());

      logger.debug('Lineage: extraction recorded', { patternId, sessionKey });
    } catch (err) {
      logger.warn('Lineage: failed to record extraction', {
        patternId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Record that a pattern was injected into a sub-agent dispatch. */
  recordInjection(patternId: string, dispatchSessionKey: string, task: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO pattern_lineage (event_type, pattern_id, dispatch_session_key, dispatch_task, created_at)
           VALUES ('injected', ?, ?, ?, ?)`
        )
        .run(patternId, dispatchSessionKey, task.substring(0, 200), Date.now());

      logger.debug('Lineage: injection recorded', { patternId, dispatchSessionKey });
    } catch (err) {
      logger.warn('Lineage: failed to record injection', {
        patternId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Record that a pattern was validated or contradicted by a task outcome. */
  recordValidation(
    patternId: string,
    dispatchSessionKey: string,
    outcome: 'success' | 'partial' | 'failure',
    notes?: string,
    confidenceBefore?: number,
    confidenceAfter?: number
  ): void {
    const eventType: LineageEventType = outcome === 'failure' ? 'contradicted' : 'validated';
    try {
      this.db
        .prepare(
          `INSERT INTO pattern_lineage
           (event_type, pattern_id, dispatch_session_key, outcome, outcome_notes,
            confidence_before, confidence_after, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          eventType,
          patternId,
          dispatchSessionKey,
          outcome,
          notes?.substring(0, 500) ?? null,
          confidenceBefore ?? null,
          confidenceAfter ?? null,
          Date.now()
        );

      logger.debug('Lineage: validation recorded', { patternId, eventType, outcome });
    } catch (err) {
      logger.warn('Lineage: failed to record validation', {
        patternId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Record that a pattern was merged into another during consolidation. */
  recordConsolidation(absorbedPatternId: string, survivingPatternId: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO pattern_lineage (event_type, pattern_id, related_pattern_id, created_at)
           VALUES ('consolidated', ?, ?, ?)`
        )
        .run(absorbedPatternId, survivingPatternId, Date.now());

      logger.debug('Lineage: consolidation recorded', {
        absorbed: absorbedPatternId,
        surviving: survivingPatternId,
      });
    } catch (err) {
      logger.warn('Lineage: failed to record consolidation', {
        absorbedPatternId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Record that one pattern spawned another (provenance link). */
  recordSpawn(parentPatternId: string, childPatternId: string, sessionKey?: string): void {
    try {
      this.db
        .prepare(
          `INSERT INTO pattern_lineage
           (event_type, pattern_id, related_pattern_id, source_session_key, created_at)
           VALUES ('spawned', ?, ?, ?, ?)`
        )
        .run(parentPatternId, childPatternId, sessionKey ?? null, Date.now());

      logger.debug('Lineage: spawn recorded', {
        parent: parentPatternId,
        child: childPatternId,
      });
    } catch (err) {
      logger.warn('Lineage: failed to record spawn', {
        parentPatternId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Record that a pattern was archived during aging. */
  recordArchival(patternId: string, confidenceBefore: number): void {
    try {
      this.db
        .prepare(
          `INSERT INTO pattern_lineage
           (event_type, pattern_id, confidence_before, confidence_after, created_at)
           VALUES ('archived', ?, ?, 0, ?)`
        )
        .run(patternId, confidenceBefore, Date.now());

      logger.debug('Lineage: archival recorded', { patternId, confidenceBefore });
    } catch (err) {
      logger.warn('Lineage: failed to record archival', {
        patternId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Query Lineage
  // ──────────────────────────────────────────────────────────────────

  /** Get the full event history for a pattern, ordered chronologically. */
  getPatternHistory(patternId: string): LineageEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM pattern_lineage WHERE pattern_id = ? ORDER BY created_at ASC`
      )
      .all(patternId) as LineageRow[];

    return rows.map(rowToEvent);
  }

  /**
   * Get the full lineage chain for a pattern — its events, parent patterns,
   * and child patterns — recursively up to `depth` levels.
   */
  getPatternChain(patternId: string, depth: number = 3): LineageChain | null {
    if (depth <= 0) return null;

    // Get the pattern summary
    const patternRow = this.db
      .prepare('SELECT id, title, confidence FROM patterns WHERE id = ?')
      .get(patternId) as PatternSummaryRow | undefined;

    if (!patternRow) return null;

    // Get all events for this pattern
    const events = this.getPatternHistory(patternId);

    // Find children: patterns this one spawned
    const childIds = this.db
      .prepare(
        `SELECT DISTINCT related_pattern_id FROM pattern_lineage
         WHERE pattern_id = ? AND event_type = 'spawned' AND related_pattern_id IS NOT NULL`
      )
      .all(patternId) as Array<{ related_pattern_id: string }>;

    const children: LineageChain[] = [];
    for (const row of childIds) {
      const childChain = this.getPatternChain(row.related_pattern_id, depth - 1);
      if (childChain) children.push(childChain);
    }

    // Find parents: patterns that spawned this one
    const parentIds = this.db
      .prepare(
        `SELECT DISTINCT pattern_id FROM pattern_lineage
         WHERE related_pattern_id = ? AND event_type = 'spawned'`
      )
      .all(patternId) as Array<{ pattern_id: string }>;

    const parents: LineageChain[] = [];
    for (const row of parentIds) {
      const parentChain = this.getPatternChain(row.pattern_id, depth - 1);
      if (parentChain) parents.push(parentChain);
    }

    return {
      pattern: {
        id: patternRow.id,
        summary: patternRow.title,
        confidence: patternRow.confidence,
      },
      events,
      children,
      parents,
    };
  }

  /** Get all patterns associated with a session (extracted, injected, or validated). */
  getSessionPatterns(sessionKey: string): { extracted: string[]; injected: string[]; validated: string[] } {
    const extracted = this.db
      .prepare(
        `SELECT DISTINCT pattern_id FROM pattern_lineage
         WHERE source_session_key = ? AND event_type = 'extracted'`
      )
      .all(sessionKey) as Array<{ pattern_id: string }>;

    const injected = this.db
      .prepare(
        `SELECT DISTINCT pattern_id FROM pattern_lineage
         WHERE dispatch_session_key = ? AND event_type = 'injected'`
      )
      .all(sessionKey) as Array<{ pattern_id: string }>;

    const validated = this.db
      .prepare(
        `SELECT DISTINCT pattern_id FROM pattern_lineage
         WHERE dispatch_session_key = ? AND event_type IN ('validated', 'contradicted')`
      )
      .all(sessionKey) as Array<{ pattern_id: string }>;

    return {
      extracted: extracted.map((r) => r.pattern_id),
      injected: injected.map((r) => r.pattern_id),
      validated: validated.map((r) => r.pattern_id),
    };
  }

  /** Get lineage for a specific dispatch — what patterns were injected, what outcomes occurred. */
  getDispatchLineage(dispatchSessionKey: string): { injectedPatterns: string[]; outcomes: LineageEvent[] } {
    const injected = this.db
      .prepare(
        `SELECT DISTINCT pattern_id FROM pattern_lineage
         WHERE dispatch_session_key = ? AND event_type = 'injected'`
      )
      .all(dispatchSessionKey) as Array<{ pattern_id: string }>;

    const outcomeRows = this.db
      .prepare(
        `SELECT * FROM pattern_lineage
         WHERE dispatch_session_key = ? AND event_type IN ('validated', 'contradicted')
         ORDER BY created_at ASC`
      )
      .all(dispatchSessionKey) as LineageRow[];

    return {
      injectedPatterns: injected.map((r) => r.pattern_id),
      outcomes: outcomeRows.map(rowToEvent),
    };
  }

  /** Calculate the impact metrics for a specific pattern. */
  getPatternImpact(patternId: string): PatternImpact {
    const injections = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM pattern_lineage
         WHERE pattern_id = ? AND event_type = 'injected'`
      )
      .get(patternId) as CountRow;

    const successful = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM pattern_lineage
         WHERE pattern_id = ? AND event_type = 'validated' AND outcome = 'success'`
      )
      .get(patternId) as CountRow;

    const failed = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM pattern_lineage
         WHERE pattern_id = ? AND event_type = 'contradicted'`
      )
      .get(patternId) as CountRow;

    const spawned = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM pattern_lineage
         WHERE pattern_id = ? AND event_type = 'spawned'`
      )
      .get(patternId) as CountRow;

    const timeRange = this.db
      .prepare(
        `SELECT MIN(created_at) as first_used, MAX(created_at) as last_used
         FROM pattern_lineage WHERE pattern_id = ?`
      )
      .get(patternId) as { first_used: number | null; last_used: number | null };

    const total = successful.count + failed.count;
    const successRate = total > 0 ? successful.count / total : 0;

    return {
      patternId,
      totalInjections: injections.count,
      successfulOutcomes: successful.count,
      failedOutcomes: failed.count,
      spawnedPatterns: spawned.count,
      successRate: Math.round(successRate * 100) / 100,
      firstUsed: timeRange.first_used ?? 0,
      lastUsed: timeRange.last_used ?? 0,
    };
  }

  /** Get overall lineage statistics. */
  getStats(): LineageStats {
    const total = (
      this.db.prepare('SELECT COUNT(*) as count FROM pattern_lineage').get() as CountRow
    ).count;

    const byTypeRows = this.db
      .prepare('SELECT event_type, COUNT(*) as count FROM pattern_lineage GROUP BY event_type')
      .all() as TypeCountRow[];

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.event_type] = row.count;
    }

    // Get the top 5 most impactful patterns (most injections with good success rate)
    const topPatternIds = this.db
      .prepare(
        `SELECT pattern_id,
                SUM(CASE WHEN event_type = 'injected' THEN 1 ELSE 0 END) as total_injections,
                SUM(CASE WHEN event_type = 'validated' AND outcome = 'success' THEN 1 ELSE 0 END) as successful,
                SUM(CASE WHEN event_type = 'contradicted' THEN 1 ELSE 0 END) as failed,
                SUM(CASE WHEN event_type = 'spawned' THEN 1 ELSE 0 END) as spawned,
                MIN(created_at) as first_used,
                MAX(created_at) as last_used
         FROM pattern_lineage
         GROUP BY pattern_id
         HAVING total_injections > 0
         ORDER BY total_injections DESC, successful DESC
         LIMIT 5`
      )
      .all() as InjectionStatsRow[];

    const mostImpactful: PatternImpact[] = topPatternIds.map((row) => {
      const total = row.successful + row.failed;
      return {
        patternId: row.pattern_id,
        totalInjections: row.total_injections,
        successfulOutcomes: row.successful,
        failedOutcomes: row.failed,
        spawnedPatterns: row.spawned,
        successRate: total > 0 ? Math.round((row.successful / total) * 100) / 100 : 0,
        firstUsed: row.first_used,
        lastUsed: row.last_used,
      };
    });

    // Last 10 events
    const recentRows = this.db
      .prepare('SELECT * FROM pattern_lineage ORDER BY created_at DESC LIMIT 10')
      .all() as LineageRow[];

    return {
      totalEvents: total,
      byType,
      mostImpactful,
      recentActivity: recentRows.map(rowToEvent),
    };
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function rowToEvent(row: LineageRow): LineageEvent {
  return {
    id: row.id,
    event_type: row.event_type as LineageEventType,
    pattern_id: row.pattern_id,
    source_session_key: row.source_session_key ?? undefined,
    source_message_id: row.source_message_id ?? undefined,
    dispatch_session_key: row.dispatch_session_key ?? undefined,
    dispatch_task: row.dispatch_task ?? undefined,
    related_pattern_id: row.related_pattern_id ?? undefined,
    outcome: row.outcome as 'success' | 'partial' | 'failure' | undefined,
    outcome_notes: row.outcome_notes ?? undefined,
    confidence_before: row.confidence_before ?? undefined,
    confidence_after: row.confidence_after ?? undefined,
    created_at: row.created_at,
  };
}
