/**
 * Tests for LineageTracker — provenance chains for experiential learning.
 *
 * Uses in-memory SQLite for fast, real-SQL tests.
 * Must also create the `patterns` table since LineageTracker has FK references.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { LineageTracker } from '../../src/memory/lineage.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  // LineageTracker's FK references patterns(id), so we need a minimal patterns table
  db.exec(`
    CREATE TABLE IF NOT EXISTS patterns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '',
      confidence REAL NOT NULL DEFAULT 0.5
    );
  `);
  return db;
}

function seedPattern(db: Database.Database, id: string, title: string = 'Test Pattern', confidence: number = 0.7): void {
  db.prepare('INSERT OR IGNORE INTO patterns (id, title, confidence) VALUES (?, ?, ?)').run(id, title, confidence);
}

describe('LineageTracker', () => {
  let db: Database.Database;
  let tracker: LineageTracker;

  beforeEach(() => {
    db = createTestDb();
    tracker = new LineageTracker(db);
    tracker.init();
  });

  // ── Recording Events ──────────────────────────────

  it('should record extraction events', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordExtraction('pattern-1', 'session-key-1', 'msg-1');

    const history = tracker.getPatternHistory('pattern-1');
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe('extracted');
    expect(history[0].pattern_id).toBe('pattern-1');
    expect(history[0].source_session_key).toBe('session-key-1');
    expect(history[0].source_message_id).toBe('msg-1');
  });

  it('should record extraction without messageId', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordExtraction('pattern-1', 'session-1');

    const history = tracker.getPatternHistory('pattern-1');
    expect(history).toHaveLength(1);
    expect(history[0].source_message_id).toBeUndefined();
  });

  it('should record injection events', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordInjection('pattern-1', 'dispatch-session-1', 'Build a feature');

    const history = tracker.getPatternHistory('pattern-1');
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe('injected');
    expect(history[0].dispatch_session_key).toBe('dispatch-session-1');
    expect(history[0].dispatch_task).toBe('Build a feature');
  });

  it('should truncate long task descriptions to 200 chars', () => {
    seedPattern(db, 'pattern-1');
    const longTask = 'A'.repeat(500);
    tracker.recordInjection('pattern-1', 'dispatch-1', longTask);

    const history = tracker.getPatternHistory('pattern-1');
    expect(history[0].dispatch_task!.length).toBeLessThanOrEqual(200);
  });

  it('should record validation events with confidence tracking', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordValidation('pattern-1', 'dispatch-1', 'success', 'It worked', 0.8, 0.85);

    const history = tracker.getPatternHistory('pattern-1');
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe('validated');
    expect(history[0].outcome).toBe('success');
    expect(history[0].confidence_before).toBe(0.8);
    expect(history[0].confidence_after).toBe(0.85);
  });

  it('should record contradicted as event_type for failures', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordValidation('pattern-1', 'dispatch-1', 'failure', 'Nope');

    const history = tracker.getPatternHistory('pattern-1');
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe('contradicted');
    expect(history[0].outcome).toBe('failure');
  });

  it('should record partial outcomes as validated', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordValidation('pattern-1', 'dispatch-1', 'partial', 'Mostly worked');

    const history = tracker.getPatternHistory('pattern-1');
    expect(history[0].event_type).toBe('validated');
    expect(history[0].outcome).toBe('partial');
  });

  it('should record consolidation events', () => {
    seedPattern(db, 'pattern-absorbed');
    seedPattern(db, 'pattern-surviving');
    tracker.recordConsolidation('pattern-absorbed', 'pattern-surviving');

    const history = tracker.getPatternHistory('pattern-absorbed');
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe('consolidated');
    expect(history[0].related_pattern_id).toBe('pattern-surviving');
  });

  it('should record spawn events', () => {
    seedPattern(db, 'parent-pattern');
    seedPattern(db, 'child-pattern');
    tracker.recordSpawn('parent-pattern', 'child-pattern', 'session-1');

    const history = tracker.getPatternHistory('parent-pattern');
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe('spawned');
    expect(history[0].related_pattern_id).toBe('child-pattern');
  });

  it('should record archival events', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordArchival('pattern-1', 0.3);

    const history = tracker.getPatternHistory('pattern-1');
    expect(history).toHaveLength(1);
    expect(history[0].event_type).toBe('archived');
    expect(history[0].confidence_before).toBe(0.3);
    expect(history[0].confidence_after).toBe(0);
  });

  // ── Pattern Impact ────────────────────────────────

  it('should calculate pattern impact correctly', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordInjection('pattern-1', 'dispatch-1', 'Task 1');
    tracker.recordInjection('pattern-1', 'dispatch-2', 'Task 2');
    tracker.recordValidation('pattern-1', 'dispatch-1', 'success');
    tracker.recordValidation('pattern-1', 'dispatch-2', 'failure');

    const impact = tracker.getPatternImpact('pattern-1');
    expect(impact.patternId).toBe('pattern-1');
    expect(impact.totalInjections).toBe(2);
    expect(impact.successfulOutcomes).toBe(1);
    expect(impact.failedOutcomes).toBe(1);
    expect(impact.successRate).toBeCloseTo(0.5);
  });

  it('should return 0 success rate when no outcomes', () => {
    seedPattern(db, 'pattern-1');
    tracker.recordInjection('pattern-1', 'dispatch-1', 'Task');

    const impact = tracker.getPatternImpact('pattern-1');
    expect(impact.successRate).toBe(0);
    expect(impact.totalInjections).toBe(1);
  });

  it('should count spawned patterns in impact', () => {
    seedPattern(db, 'parent');
    seedPattern(db, 'child-1');
    seedPattern(db, 'child-2');
    tracker.recordSpawn('parent', 'child-1');
    tracker.recordSpawn('parent', 'child-2');

    const impact = tracker.getPatternImpact('parent');
    expect(impact.spawnedPatterns).toBe(2);
  });

  // ── Session / Dispatch Queries ────────────────────

  it('should get patterns associated with a session', () => {
    seedPattern(db, 'p1');
    seedPattern(db, 'p2');
    tracker.recordExtraction('p1', 'session-A');
    tracker.recordInjection('p2', 'session-A', 'task');
    tracker.recordValidation('p2', 'session-A', 'success');

    const sessionPatterns = tracker.getSessionPatterns('session-A');
    expect(sessionPatterns.extracted).toContain('p1');
    expect(sessionPatterns.injected).toContain('p2');
    expect(sessionPatterns.validated).toContain('p2');
  });

  it('should get dispatch lineage', () => {
    seedPattern(db, 'p1');
    seedPattern(db, 'p2');
    tracker.recordInjection('p1', 'dispatch-X', 'task');
    tracker.recordInjection('p2', 'dispatch-X', 'task');
    tracker.recordValidation('p1', 'dispatch-X', 'success');

    const lineage = tracker.getDispatchLineage('dispatch-X');
    expect(lineage.injectedPatterns).toHaveLength(2);
    expect(lineage.outcomes).toHaveLength(1);
    expect(lineage.outcomes[0].event_type).toBe('validated');
  });

  // ── Stats ─────────────────────────────────────────

  it('should get overall stats', () => {
    seedPattern(db, 'p1');
    tracker.recordExtraction('p1', 'sess-1');
    tracker.recordInjection('p1', 'disp-1', 'task');
    tracker.recordValidation('p1', 'disp-1', 'success');

    const stats = tracker.getStats();
    expect(stats.totalEvents).toBe(3);
    expect(stats.byType['extracted']).toBe(1);
    expect(stats.byType['injected']).toBe(1);
    expect(stats.byType['validated']).toBe(1);
  });

  it('should return empty stats for fresh database', () => {
    const stats = tracker.getStats();
    expect(stats.totalEvents).toBe(0);
    expect(Object.keys(stats.byType)).toHaveLength(0);
    expect(stats.mostImpactful).toHaveLength(0);
    expect(stats.recentActivity).toHaveLength(0);
  });

  it('should include most impactful patterns in stats', () => {
    seedPattern(db, 'p1');
    // Create several injections to make p1 show up as impactful
    for (let i = 0; i < 5; i++) {
      tracker.recordInjection('p1', `disp-${i}`, `task-${i}`);
    }
    tracker.recordValidation('p1', 'disp-0', 'success');

    const stats = tracker.getStats();
    expect(stats.mostImpactful.length).toBeGreaterThan(0);
    expect(stats.mostImpactful[0].patternId).toBe('p1');
    expect(stats.mostImpactful[0].totalInjections).toBe(5);
  });

  it('should include recent activity in stats', () => {
    seedPattern(db, 'p1');
    tracker.recordExtraction('p1', 'sess-1');

    const stats = tracker.getStats();
    expect(stats.recentActivity).toHaveLength(1);
    expect(stats.recentActivity[0].event_type).toBe('extracted');
  });

  // ── Chronological Ordering ────────────────────────

  it('should return history in chronological order', () => {
    seedPattern(db, 'p1');
    tracker.recordExtraction('p1', 'sess-1');
    tracker.recordInjection('p1', 'disp-1', 'task');
    tracker.recordValidation('p1', 'disp-1', 'success');

    const history = tracker.getPatternHistory('p1');
    expect(history).toHaveLength(3);
    // Chronological: extraction → injection → validation
    expect(history[0].event_type).toBe('extracted');
    expect(history[1].event_type).toBe('injected');
    expect(history[2].event_type).toBe('validated');
    // Timestamps should be ascending
    expect(history[0].created_at).toBeLessThanOrEqual(history[1].created_at);
    expect(history[1].created_at).toBeLessThanOrEqual(history[2].created_at);
  });
});
