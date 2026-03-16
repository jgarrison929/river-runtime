/**
 * Memory Aging — rules for what gets forgotten over time.
 *
 * Separate from consolidation — this is about decay, not merging.
 * Designed to run weekly as a cron job. Idempotent.
 *
 * Aging rules:
 * 1. Patterns: archive low-confidence, halve stale confidence
 * 2. Knowledge: delete old superseded entries, archive low-confidence
 * 3. Episodic: summary-only for old low-importance (stubbed)
 * 4. Graph: prune single-mention orphans (never person/org)
 */

import type Database from 'better-sqlite3';
import type { LineageTracker } from './lineage.js';
import { logger } from '../utils/logger.js';

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

export interface AgingReport {
  patterns_archived: number;
  patterns_decayed: number;
  knowledge_deleted: number;
  knowledge_archived: number;
  episodes_compacted: number;
  graph_nodes_pruned: number;
  graph_edges_pruned: number;
  started_at: number;
  completed_at: number;
  errors: string[];
}

interface PatternAgingRow {
  id: string;
  confidence: number;
  last_applied_at: number | null;
  updated_at: number;
  status: string | null;
}

interface KnowledgeAgingRow {
  id: string;
  confidence: number;
  is_current: number;
  superseded_by: string | null;
  updated_at: number;
}

interface EpisodeAgingRow {
  id: string;
  importance: number;
  created_at: number;
  content: string;
  summary: string | null;
}

interface GraphNodeAgingRow {
  id: string;
  name: string;
  type: string;
  mention_count: number;
  last_seen: number;
}

interface EdgeCountRow {
  edge_count: number;
}

// ────────────────────────────────────────────────────────────────────
// MemoryAging
// ────────────────────────────────────────────────────────────────────

export class MemoryAging {
  private db: Database.Database;
  private lineageTracker: LineageTracker | null;

  constructor(db: Database.Database, lineageTracker?: LineageTracker) {
    this.db = db;
    this.lineageTracker = lineageTracker ?? null;

    // Ensure aging_runs table exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS aging_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        patterns_archived INTEGER DEFAULT 0,
        patterns_decayed INTEGER DEFAULT 0,
        knowledge_deleted INTEGER DEFAULT 0,
        knowledge_archived INTEGER DEFAULT 0,
        episodes_compacted INTEGER DEFAULT 0,
        graph_nodes_pruned INTEGER DEFAULT 0,
        graph_edges_pruned INTEGER DEFAULT 0,
        errors TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER NOT NULL
      );
    `);

    logger.info('Memory aging initialized');
  }

  /** Apply all aging rules. Idempotent. */
  async applyAgingRules(): Promise<AgingReport> {
    const report: AgingReport = {
      patterns_archived: 0,
      patterns_decayed: 0,
      knowledge_deleted: 0,
      knowledge_archived: 0,
      episodes_compacted: 0,
      graph_nodes_pruned: 0,
      graph_edges_pruned: 0,
      started_at: Date.now(),
      completed_at: 0,
      errors: [],
    };

    logger.info('Starting memory aging');

    // 1. Pattern aging
    try {
      const patternResult = this.agePatterns();
      report.patterns_archived = patternResult.archived;
      report.patterns_decayed = patternResult.decayed;
    } catch (err) {
      const msg = `Pattern aging failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      report.errors.push(msg);
    }

    // 2. Knowledge aging
    try {
      const knowledgeResult = this.ageKnowledge();
      report.knowledge_deleted = knowledgeResult.deleted;
      report.knowledge_archived = knowledgeResult.archived;
    } catch (err) {
      const msg = `Knowledge aging failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      report.errors.push(msg);
    }

    // 3. Episodic aging (stubbed)
    try {
      report.episodes_compacted = this.ageEpisodes();
    } catch (err) {
      const msg = `Episodic aging failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      report.errors.push(msg);
    }

    // 4. Graph pruning
    try {
      const graphResult = this.ageGraph();
      report.graph_nodes_pruned = graphResult.nodesPruned;
      report.graph_edges_pruned = graphResult.edgesPruned;
    } catch (err) {
      const msg = `Graph aging failed: ${err instanceof Error ? err.message : String(err)}`;
      logger.error(msg);
      report.errors.push(msg);
    }

    report.completed_at = Date.now();

    // Store the report
    this.storeReport(report);

    const elapsed = report.completed_at - report.started_at;
    logger.info('Memory aging complete', {
      elapsed: `${elapsed}ms`,
      patterns_archived: report.patterns_archived,
      patterns_decayed: report.patterns_decayed,
      knowledge_deleted: report.knowledge_deleted,
      knowledge_archived: report.knowledge_archived,
      graph_nodes_pruned: report.graph_nodes_pruned,
    });

    return report;
  }

  // ──────────────────────────────────────────────────────────────────
  // 1. Pattern Aging
  // ──────────────────────────────────────────────────────────────────

  /**
   * Pattern aging rules:
   * - Confidence < 0.3 for 6+ months → archive
   * - Not applied in 12+ months → halve confidence
   */
  private agePatterns(): { archived: number; decayed: number } {
    const now = Math.floor(Date.now() / 1000);
    const sixMonthsAgo = now - 6 * 30 * 86400;
    const twelveMonthsAgo = now - 12 * 30 * 86400;
    let archived = 0;
    let decayed = 0;

    // Archive: confidence < 0.3 AND updated_at < 6 months ago
    const lowConfidence = this.db
      .prepare(
        `SELECT id, confidence, last_applied_at, updated_at, status
         FROM patterns
         WHERE confidence < 0.3
           AND updated_at < ?
           AND COALESCE(status, 'active') = 'active'`
      )
      .all(sixMonthsAgo) as PatternAgingRow[];

    for (const pattern of lowConfidence) {
      try {
        this.db
          .prepare('UPDATE patterns SET status = ?, updated_at = ? WHERE id = ?')
          .run('archived', now, pattern.id);
        archived++;

        // Record lineage for the archival
        if (this.lineageTracker) {
          this.lineageTracker.recordArchival(pattern.id, pattern.confidence);
        }
      } catch {
        // status column might not exist yet — skip
      }
    }

    // Decay: not applied in 12+ months → halve confidence
    const stale = this.db
      .prepare(
        `SELECT id, confidence, last_applied_at, updated_at, status
         FROM patterns
         WHERE COALESCE(status, 'active') = 'active'
           AND confidence > 0.1
           AND (
             (last_applied_at IS NOT NULL AND last_applied_at < ?)
             OR (last_applied_at IS NULL AND created_at < ?)
           )`
      )
      .all(twelveMonthsAgo, twelveMonthsAgo) as PatternAgingRow[];

    for (const pattern of stale) {
      const newConfidence = Math.max(0.1, pattern.confidence / 2);
      this.db
        .prepare('UPDATE patterns SET confidence = ?, updated_at = ? WHERE id = ?')
        .run(newConfidence, now, pattern.id);
      decayed++;

      logger.debug('Pattern confidence decayed', {
        id: pattern.id,
        oldConfidence: pattern.confidence,
        newConfidence,
      });
    }

    return { archived, decayed };
  }

  // ──────────────────────────────────────────────────────────────────
  // 2. Knowledge Aging
  // ──────────────────────────────────────────────────────────────────

  /**
   * Knowledge aging rules:
   * - Superseded for 6+ months → delete
   * - Confidence < 0.3 → archive (set is_current = 0)
   */
  private ageKnowledge(): { deleted: number; archived: number } {
    const now = Math.floor(Date.now() / 1000);
    const sixMonthsAgo = now - 6 * 30 * 86400;
    let deleted = 0;
    let archived = 0;

    // Delete entries superseded for 6+ months
    const oldSuperseded = this.db
      .prepare(
        `SELECT id, confidence, is_current, superseded_by, updated_at
         FROM knowledge_entries
         WHERE is_current = 0 AND superseded_by IS NOT NULL AND updated_at < ?`
      )
      .all(sixMonthsAgo) as KnowledgeAgingRow[];

    if (oldSuperseded.length > 0) {
      const ids = oldSuperseded.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(', ');
      this.db
        .prepare(`DELETE FROM knowledge_entries WHERE id IN (${placeholders})`)
        .run(...ids);
      deleted = oldSuperseded.length;

      logger.debug('Deleted old superseded knowledge entries', { count: deleted });
    }

    // Archive: current entries with confidence < 0.3
    const lowConfidence = this.db
      .prepare(
        `SELECT id, confidence, is_current, superseded_by, updated_at
         FROM knowledge_entries
         WHERE is_current = 1 AND confidence < 0.3`
      )
      .all() as KnowledgeAgingRow[];

    for (const entry of lowConfidence) {
      this.db
        .prepare('UPDATE knowledge_entries SET is_current = 0, updated_at = ? WHERE id = ?')
        .run(now, entry.id);
      archived++;
    }

    return { deleted, archived };
  }

  // ──────────────────────────────────────────────────────────────────
  // 3. Episodic Aging (STUBBED)
  // ──────────────────────────────────────────────────────────────────

  /**
   * Episodic aging rules (partially stubbed):
   * - > 365 days old AND importance < 0.3 → log for future summary-only
   * - > 730 days old AND importance < 0.5 → log for future archival
   * - Never delete high-importance episodes (importance >= 0.8)
   *
   * NOTE: We do NOT actually delete content yet. This is stubbed per spec.
   * The method identifies candidates and logs them, but leaves data intact.
   */
  private ageEpisodes(): number {
    const now = Math.floor(Date.now() / 1000);
    const oneYearAgo = now - 365 * 86400;
    const twoYearsAgo = now - 730 * 86400;

    // Identify candidates for summary-only (>365 days, importance < 0.3)
    const summaryOnlyCandidates = this.db
      .prepare(
        `SELECT id, importance, created_at, content, summary
         FROM episodes
         WHERE created_at < ? AND importance < 0.3 AND importance < 0.8`
      )
      .all(oneYearAgo) as EpisodeAgingRow[];

    // Identify candidates for archival (>730 days, importance < 0.5)
    const archivalCandidates = this.db
      .prepare(
        `SELECT id, importance, created_at, content, summary
         FROM episodes
         WHERE created_at < ? AND importance < 0.5 AND importance < 0.8`
      )
      .all(twoYearsAgo) as EpisodeAgingRow[];

    if (summaryOnlyCandidates.length > 0 || archivalCandidates.length > 0) {
      logger.info('Episodic aging candidates identified (NOT yet compacted)', {
        summaryOnly: summaryOnlyCandidates.length,
        archival: archivalCandidates.length,
      });
    }

    // TODO (Phase 6): Actually truncate content to summary-only
    // for (const episode of summaryOnlyCandidates) {
    //   if (episode.summary) {
    //     this.db.prepare('UPDATE episodes SET content = ? WHERE id = ?')
    //       .run(`[Compacted] ${episode.summary}`, episode.id);
    //   }
    // }

    return 0; // No actual compaction performed yet
  }

  // ──────────────────────────────────────────────────────────────────
  // 4. Graph Pruning
  // ──────────────────────────────────────────────────────────────────

  /**
   * Graph aging rules:
   * - mention_count = 1 after 365 days → prune
   * - No edges for 365 days → prune
   * - NEVER prune 'person' or 'organization' nodes
   */
  private ageGraph(): { nodesPruned: number; edgesPruned: number } {
    const now = Math.floor(Date.now() / 1000);
    const oneYearAgo = now - 365 * 86400;
    let nodesPruned = 0;
    let edgesPruned = 0;

    // Protected types that should never be pruned
    const protectedTypes = ['person', 'organization'];
    const protectedPlaceholders = protectedTypes.map(() => '?').join(', ');

    // Find single-mention nodes older than 1 year (excluding protected types)
    const singleMention = this.db
      .prepare(
        `SELECT id, name, type, mention_count, last_seen
         FROM graph_nodes
         WHERE mention_count <= 1
           AND last_seen < ?
           AND type NOT IN (${protectedPlaceholders})`
      )
      .all(oneYearAgo, ...protectedTypes) as GraphNodeAgingRow[];

    for (const node of singleMention) {
      // Delete edges first
      const deletedEdges = this.db
        .prepare('DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?')
        .run(node.id, node.id);
      edgesPruned += deletedEdges.changes;

      // Delete the node
      this.db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(node.id);
      nodesPruned++;

      logger.debug('Graph node pruned (single mention)', { name: node.name, type: node.type });
    }

    // Find nodes with no edges older than 1 year (excluding protected types)
    const orphaned = this.db
      .prepare(
        `SELECT n.id, n.name, n.type, n.mention_count, n.last_seen
         FROM graph_nodes n
         WHERE n.last_seen < ?
           AND n.type NOT IN (${protectedPlaceholders})
           AND n.id NOT IN (
             SELECT source_id FROM graph_edges
             UNION
             SELECT target_id FROM graph_edges
           )`
      )
      .all(oneYearAgo, ...protectedTypes) as GraphNodeAgingRow[];

    for (const node of orphaned) {
      this.db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(node.id);
      nodesPruned++;

      logger.debug('Graph node pruned (orphaned)', { name: node.name, type: node.type });
    }

    return { nodesPruned, edgesPruned };
  }

  // ──────────────────────────────────────────────────────────────────
  // Report Storage
  // ──────────────────────────────────────────────────────────────────

  private storeReport(report: AgingReport): void {
    this.db
      .prepare(
        `INSERT INTO aging_runs
         (patterns_archived, patterns_decayed, knowledge_deleted, knowledge_archived,
          episodes_compacted, graph_nodes_pruned, graph_edges_pruned,
          errors, started_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        report.patterns_archived,
        report.patterns_decayed,
        report.knowledge_deleted,
        report.knowledge_archived,
        report.episodes_compacted,
        report.graph_nodes_pruned,
        report.graph_edges_pruned,
        report.errors.length > 0 ? JSON.stringify(report.errors) : null,
        Math.floor(report.started_at / 1000),
        Math.floor(report.completed_at / 1000)
      );
  }

  /** Get recent aging run history. */
  getHistory(limit: number = 10): AgingReport[] {
    const rows = this.db
      .prepare('SELECT * FROM aging_runs ORDER BY completed_at DESC LIMIT ?')
      .all(limit) as Array<{
        patterns_archived: number;
        patterns_decayed: number;
        knowledge_deleted: number;
        knowledge_archived: number;
        episodes_compacted: number;
        graph_nodes_pruned: number;
        graph_edges_pruned: number;
        errors: string | null;
        started_at: number;
        completed_at: number;
      }>;

    return rows.map((r) => ({
      patterns_archived: r.patterns_archived,
      patterns_decayed: r.patterns_decayed,
      knowledge_deleted: r.knowledge_deleted,
      knowledge_archived: r.knowledge_archived,
      episodes_compacted: r.episodes_compacted,
      graph_nodes_pruned: r.graph_nodes_pruned,
      graph_edges_pruned: r.graph_edges_pruned,
      started_at: r.started_at * 1000,
      completed_at: r.completed_at * 1000,
      errors: r.errors ? (JSON.parse(r.errors) as string[]) : [],
    }));
  }
}
