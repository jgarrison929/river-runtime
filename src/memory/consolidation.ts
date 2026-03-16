/**
 * Memory Consolidation — periodic maintenance that keeps the brain healthy.
 *
 * Tasks:
 * 1. Pattern consolidation — merge similar patterns
 * 2. Knowledge supersession — mark older versions as superseded
 * 3. Extraction queue cleanup — clean permanently failed items
 * 4. Episodic compaction — (stubbed) compress old episodes
 * 5. Stats reporting
 *
 * Designed to be idempotent — safe to run multiple times.
 */

import type Database from 'better-sqlite3';
import type { PatternStore } from './patterns.js';
import type { KnowledgeBase } from './knowledge.js';
import type { EpisodicMemory } from './episodic.js';
import type { KnowledgeGraph } from './graph.js';
import type { LineageTracker } from './lineage.js';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface ConsolidationReport {
  patterns_merged: number;
  knowledge_superseded: number;
  queue_cleaned: number;
  episodes_compacted: number;
  started_at: number;
  completed_at: number;
  errors: string[];
}

interface PatternRow {
  id: string;
  title: string;
  description: string;
  type: string;
  technology: string | null;
  confidence: number;
  occurrences: number;
  correct_approach: string | null;
  incorrect_approach: string | null;
  tags: string | null;
  status: string | null;
}

interface KnowledgeVersionRow {
  technology: string;
  title: string;
  entry_count: number;
}

interface KnowledgeEntryRow {
  id: string;
  version: string | null;
  created_at: number;
  is_current: number;
}

interface SourceCleanupRow {
  id: string;
  status: string;
  created_at: number;
}

// ────────────────────────────────────────────────────────────────────
// MemoryConsolidation
// ────────────────────────────────────────────────────────────────────

export class MemoryConsolidation {
  private db: Database.Database;
  private patternStore: PatternStore;
  private knowledgeBase: KnowledgeBase;
  private episodicMemory: EpisodicMemory;
  private graph: KnowledgeGraph;
  private lineageTracker: LineageTracker | null;

  constructor(
    db: Database.Database,
    patternStore: PatternStore,
    knowledgeBase: KnowledgeBase,
    episodicMemory: EpisodicMemory,
    graph: KnowledgeGraph,
    lineageTracker?: LineageTracker
  ) {
    this.db = db;
    this.patternStore = patternStore;
    this.knowledgeBase = knowledgeBase;
    this.episodicMemory = episodicMemory;
    this.graph = graph;
    this.lineageTracker = lineageTracker ?? null;

    // Ensure consolidation_runs table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidation_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patterns_merged INTEGER DEFAULT 0,
        knowledge_superseded INTEGER DEFAULT 0,
        queue_cleaned INTEGER DEFAULT 0,
        episodes_compacted INTEGER DEFAULT 0,
        errors TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `);

    logger.info('Memory consolidation initialized');
  }

  /** Run all consolidation tasks. Idempotent. */
  async runAll(): Promise<ConsolidationReport> {
    const report: ConsolidationReport = {
      patterns_merged: 0,
      knowledge_superseded: 0,
      queue_cleaned: 0,
      episodes_compacted: 0,
      started_at: Date.now(),
      completed_at: 0,
      errors: [],
    };

    logger.info('Starting memory consolidation');

    // 1. Pattern consolidation
    try {
      report.patterns_merged = this.consolidatePatterns();
    } catch (err) {
      const msg = `Pattern consolidation failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      report.errors.push(msg);
    }

    // 2. Knowledge supersession
    try {
      report.knowledge_superseded = this.supersedeKnowledge();
    } catch (err) {
      const msg = `Knowledge supersession failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      report.errors.push(msg);
    }

    // 3. Extraction queue cleanup
    try {
      report.queue_cleaned = this.cleanExtractionQueue();
    } catch (err) {
      const msg = `Queue cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      report.errors.push(msg);
    }

    // 4. Episodic compaction (stubbed for Phase 6)
    // TODO: Implement actual compaction
    // report.episodes_compacted = await this.compactEpisodes();

    report.completed_at = Date.now();

    // 5. Store the run report
    this.storeReport(report);

    const elapsed = report.completed_at - report.started_at;
    logger.info('Memory consolidation complete', {
      elapsed: `${elapsed}ms`,
      patterns_merged: report.patterns_merged,
      knowledge_superseded: report.knowledge_superseded,
      queue_cleaned: report.queue_cleaned,
      errors: report.errors.length,
    });

    return report;
  }

  // ──────────────────────────────────────────────────────────────────
  // 1. Pattern Consolidation
  // ──────────────────────────────────────────────────────────────────

  /**
   * Find similar patterns using text similarity (title LIKE matching)
   * and merge duplicates. Keeps the higher-confidence one, combines
   * descriptions, sums occurrences.
   */
  private consolidatePatterns(): number {
    let merged = 0;

    // Get all active patterns grouped by technology
    const patterns = this.db
      .prepare(
        `SELECT id, title, description, type, technology, confidence, occurrences,
                correct_approach, incorrect_approach, tags, status
         FROM patterns
         WHERE COALESCE(status, 'active') = 'active'
         ORDER BY technology, confidence DESC`
      )
      .all() as PatternRow[];

    // Group by technology for comparison
    const byTech = new Map<string, PatternRow[]>();
    for (const p of patterns) {
      const tech = p.technology ?? '__none__';
      const group = byTech.get(tech) ?? [];
      group.push(p);
      byTech.set(tech, group);
    }

    // Within each technology group, find similar patterns by title
    const mergedIds = new Set<string>();

    for (const [tech, group] of byTech) {
      for (let i = 0; i < group.length; i++) {
        const primary = group[i];
        if (!primary || mergedIds.has(primary.id)) continue;

        for (let j = i + 1; j < group.length; j++) {
          const candidate = group[j];
          if (!candidate || mergedIds.has(candidate.id)) continue;

          // Check title similarity (simple normalized comparison)
          if (primary.type !== candidate.type) continue;

          const similarity = this.textSimilarity(primary.title, candidate.title);
          if (similarity < 0.8) continue;

          // Merge candidate into primary (primary has higher confidence due to ORDER BY)
          this.mergePatterns(primary, candidate);
          mergedIds.add(candidate.id);
          merged++;

          // Record lineage for the consolidation
          if (this.lineageTracker) {
            this.lineageTracker.recordConsolidation(candidate.id, primary.id);
          }

          logger.debug('Patterns merged', {
            primary: primary.id,
            merged: candidate.id,
            technology: tech,
            similarity: Math.round(similarity * 100),
          });
        }
      }
    }

    return merged;
  }

  /** Merge candidate pattern into primary. Keeps primary, archives candidate. */
  private mergePatterns(primary: PatternRow, candidate: PatternRow): void {
    const now = Math.floor(Date.now() / 1000);

    // Combine descriptions if they differ meaningfully
    let newDescription = primary.description;
    if (candidate.description !== primary.description) {
      const candidateExtra = candidate.description.trim();
      if (candidateExtra.length > 20 && !primary.description.includes(candidateExtra)) {
        newDescription = `${primary.description}\n\nAlso observed: ${candidateExtra}`;
      }
    }

    // Combine correct/incorrect approaches
    const correctApproach = primary.correct_approach ?? candidate.correct_approach;
    const incorrectApproach = primary.incorrect_approach ?? candidate.incorrect_approach;

    // Merge tags
    const primaryTags: string[] = primary.tags ? (JSON.parse(primary.tags) as string[]) : [];
    const candidateTags: string[] = candidate.tags ? (JSON.parse(candidate.tags) as string[]) : [];
    const mergedTags = [...new Set([...primaryTags, ...candidateTags])];

    // Sum occurrences, keep higher confidence
    const newOccurrences = primary.occurrences + candidate.occurrences;
    const newConfidence = Math.max(primary.confidence, candidate.confidence);

    // Update primary
    this.db
      .prepare(
        `UPDATE patterns
         SET description = ?, correct_approach = ?, incorrect_approach = ?,
             occurrences = ?, confidence = ?, tags = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        newDescription,
        correctApproach,
        incorrectApproach,
        newOccurrences,
        newConfidence,
        JSON.stringify(mergedTags),
        now,
        primary.id
      );

    // Archive the candidate (set status if column exists, otherwise delete)
    try {
      this.db
        .prepare('UPDATE patterns SET status = ?, updated_at = ? WHERE id = ?')
        .run('archived', now, candidate.id);
    } catch {
      // If status column doesn't exist yet, just delete
      this.db.prepare('DELETE FROM patterns WHERE id = ?').run(candidate.id);
    }
  }

  /**
   * Simple text similarity based on normalized word overlap (Jaccard-ish).
   * Returns 0-1 where 1 means identical word sets.
   */
  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/).filter((w) => w.length > 2));
    const wordsB = new Set(b.toLowerCase().split(/\s+/).filter((w) => w.length > 2));

    if (wordsA.size === 0 && wordsB.size === 0) return 1;
    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let intersection = 0;
    for (const word of wordsA) {
      if (wordsB.has(word)) intersection++;
    }

    const union = wordsA.size + wordsB.size - intersection;
    return union === 0 ? 0 : intersection / union;
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. Knowledge Supersession
  // ──────────────────────────────────────────────────────────────────

  /**
   * For each technology: find entries with the same title but different versions.
   * Mark older versions as superseded (is_current = 0).
   */
  private supersedeKnowledge(): number {
    let superseded = 0;

    // Find technology+title combos that have multiple versions
    const dupes = this.db
      .prepare(
        `SELECT technology, title, COUNT(*) as entry_count
         FROM knowledge_entries
         WHERE is_current = 1 AND version IS NOT NULL
         GROUP BY technology, title
         HAVING COUNT(*) > 1`
      )
      .all() as KnowledgeVersionRow[];

    for (const dupe of dupes) {
      // Get all entries for this technology+title, ordered by version (newest first)
      const entries = this.db
        .prepare(
          `SELECT id, version, created_at, is_current
           FROM knowledge_entries
           WHERE technology = ? AND title = ? AND is_current = 1
           ORDER BY created_at DESC`
        )
        .all(dupe.technology, dupe.title) as KnowledgeEntryRow[];

      if (entries.length <= 1) continue;

      // Keep the newest (first), supersede the rest
      const newest = entries[0];
      if (!newest) continue;

      for (let i = 1; i < entries.length; i++) {
        const older = entries[i];
        if (!older) continue;

        this.knowledgeBase.supersede(older.id, newest.id);
        superseded++;

        logger.debug('Knowledge entry superseded', {
          technology: dupe.technology,
          title: dupe.title,
          oldVersion: older.version,
          newVersion: newest.version,
        });
      }
    }

    return superseded;
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. Extraction Queue Cleanup
  // ──────────────────────────────────────────────────────────────────

  /**
   * Clean up the knowledge_sources table:
   * - Delete permanently failed sources older than 30 days
   */
  private cleanExtractionQueue(): number {
    let cleaned = 0;
    const thirtyDaysAgo = Math.floor(Date.now() / 1000) - 30 * 86400;

    // Delete failed sources older than 30 days
    const failedOld = this.db
      .prepare(
        `SELECT id, status, created_at FROM knowledge_sources
         WHERE status = 'failed' AND created_at < ?`
      )
      .all(thirtyDaysAgo) as SourceCleanupRow[];

    if (failedOld.length > 0) {
      const ids = failedOld.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      this.db
        .prepare(`DELETE FROM knowledge_sources WHERE id IN (${placeholders})`)
        .run(...ids);

      cleaned += failedOld.length;
      logger.debug('Cleaned failed sources', { count: failedOld.length });
    }

    return cleaned;
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. Episodic Compaction (STUB)
  // ──────────────────────────────────────────────────────────────────

  // TODO (Phase 6): Implement episodic compaction
  // Episodes older than 365 days: keep summary + embedding, delete full content
  // For now this is intentionally not called.
  // private async compactEpisodes(): Promise<number> {
  //   return 0;
  // }

  // ──────────────────────────────────────────────────────────────────
  // 5. Report Storage
  // ──────────────────────────────────────────────────────────────────

  private storeReport(report: ConsolidationReport): void {
    this.db
      .prepare(
        `INSERT INTO consolidation_runs
         (patterns_merged, knowledge_superseded, queue_cleaned, episodes_compacted,
          errors, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        report.patterns_merged,
        report.knowledge_superseded,
        report.queue_cleaned,
        report.episodes_compacted,
        report.errors.length > 0 ? JSON.stringify(report.errors) : null,
        Math.floor(report.started_at / 1000),
        Math.floor(report.completed_at / 1000)
      );
  }

  /** Get recent consolidation run history. */
  getHistory(limit: number = 10): ConsolidationReport[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM consolidation_runs ORDER BY completed_at DESC LIMIT ?`
      )
      .all(limit) as Array<{
        patterns_merged: number;
        knowledge_superseded: number;
        queue_cleaned: number;
        episodes_compacted: number;
        errors: string | null;
        started_at: number;
        completed_at: number;
      }>;

    return rows.map((r) => ({
      patterns_merged: r.patterns_merged,
      knowledge_superseded: r.knowledge_superseded,
      queue_cleaned: r.queue_cleaned,
      episodes_compacted: r.episodes_compacted,
      started_at: r.started_at * 1000,
      completed_at: r.completed_at * 1000,
      errors: r.errors ? (JSON.parse(r.errors) as string[]) : [],
    }));
  }
}
