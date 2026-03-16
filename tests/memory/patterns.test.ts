/**
 * Tests for PatternStore — pattern memory for coding patterns, anti-patterns,
 * and lessons learned.
 *
 * Uses in-memory SQLite for fast, real-SQL tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PatternStore } from '../../src/memory/patterns.js';
import type { PatternInput } from '../../src/memory/patterns.js';

describe('PatternStore', () => {
  let db: Database.Database;
  let store: PatternStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new PatternStore(db);
  });

  // ── Basic CRUD ────────────────────────────────────

  it('should add and retrieve a pattern', () => {
    const input: PatternInput = {
      type: 'pattern',
      title: 'Use strict null checks',
      description: 'Enable strictNullChecks in tsconfig for safety',
      technology: 'typescript',
      confidence: 0.8,
    };
    const id = store.addPattern(input);
    expect(id).toBeTruthy();

    const pattern = store.getById(id);
    expect(pattern).toBeTruthy();
    expect(pattern!.title).toBe('Use strict null checks');
    expect(pattern!.type).toBe('pattern');
    expect(pattern!.technology).toBe('typescript');
    expect(pattern!.confidence).toBe(0.8);
  });

  it('should default confidence to 0.5', () => {
    const id = store.addPattern({
      type: 'lesson',
      title: 'Test lesson',
      description: 'A lesson',
    });
    const pattern = store.getById(id);
    expect(pattern!.confidence).toBe(0.5);
  });

  it('should default occurrences to 1', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Test',
      description: 'test',
    });
    const pattern = store.getById(id);
    expect(pattern!.occurrences).toBe(1);
  });

  it('should store and retrieve tags', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Tagged pattern',
      description: 'Has tags',
      tags: ['typescript', 'testing', 'vitest'],
    });
    const pattern = store.getById(id);
    expect(pattern!.tags).toEqual(['typescript', 'testing', 'vitest']);
  });

  it('should return undefined for non-existent pattern', () => {
    const pattern = store.getById('nonexistent');
    expect(pattern).toBeUndefined();
  });

  // ── Reinforcement and Degradation ─────────────────

  it('should reinforce a pattern (increase confidence and occurrences)', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Test',
      description: 'test',
      confidence: 0.5,
    });

    store.reinforcePattern(id);
    const pattern = store.getById(id);
    expect(pattern!.confidence).toBeCloseTo(0.55);
    expect(pattern!.occurrences).toBe(2);
  });

  it('should cap reinforced confidence at 1.0', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Test',
      description: 'test',
      confidence: 0.98,
    });

    store.reinforcePattern(id);
    const pattern = store.getById(id);
    expect(pattern!.confidence).toBeLessThanOrEqual(1.0);
  });

  it('should degrade a pattern (decrease confidence)', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Test',
      description: 'test',
      confidence: 0.7,
    });

    store.degradePattern(id);
    const pattern = store.getById(id);
    expect(pattern!.confidence).toBeCloseTo(0.6);
  });

  it('should not degrade confidence below 0.0', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Test',
      description: 'test',
      confidence: 0.05,
    });

    store.degradePattern(id);
    const pattern = store.getById(id);
    expect(pattern!.confidence).toBeGreaterThanOrEqual(0.0);
  });

  // ── Search ────────────────────────────────────────

  it('should find patterns by technology', () => {
    store.addPattern({ type: 'pattern', title: 'TS Pattern', description: 'TypeScript', technology: 'typescript' });
    store.addPattern({ type: 'pattern', title: 'JS Pattern', description: 'JavaScript', technology: 'javascript' });

    const results = store.findPatterns('typescript');
    expect(results.length).toBeGreaterThan(0);
    expect(results.every(p => p.technology === 'typescript' || p.description.includes('typescript'))).toBe(true);
  });

  it('should find patterns by title keyword', () => {
    store.addPattern({ type: 'lesson', title: 'Always validate inputs', description: 'Validation matters' });

    const results = store.findPatterns('validate');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].title).toContain('validate');
  });

  it('should get relevant patterns for technologies', () => {
    store.addPattern({
      type: 'pattern',
      title: 'Use Fastify schema validation',
      description: 'Use JSON Schema for route validation in Fastify',
      technology: 'fastify',
      confidence: 0.9,
    });
    store.addPattern({
      type: 'anti_pattern',
      title: 'Avoid manual validation',
      description: 'Do not validate manually in Fastify routes',
      technology: 'fastify',
      confidence: 0.8,
    });

    const results = store.getRelevantPatterns(['fastify'], 'Build a REST API');
    expect(results.length).toBe(2);
    // Should be ordered by confidence DESC
    expect(results[0].confidence).toBeGreaterThanOrEqual(results[1].confidence);
  });

  // ── Anti-Patterns ─────────────────────────────────

  it('should get anti-patterns', () => {
    store.addPattern({ type: 'anti_pattern', title: 'AP1', description: 'Bad thing', technology: 'typescript' });
    store.addPattern({ type: 'pattern', title: 'P1', description: 'Good thing', technology: 'typescript' });

    const antiPatterns = store.getAntiPatterns();
    expect(antiPatterns.length).toBe(1);
    expect(antiPatterns[0].type).toBe('anti_pattern');
  });

  it('should filter anti-patterns by technology', () => {
    store.addPattern({ type: 'anti_pattern', title: 'AP-TS', description: 'TS bad', technology: 'typescript' });
    store.addPattern({ type: 'anti_pattern', title: 'AP-JS', description: 'JS bad', technology: 'javascript' });

    const tsAntiPatterns = store.getAntiPatterns('typescript');
    expect(tsAntiPatterns.length).toBe(1);
    expect(tsAntiPatterns[0].title).toBe('AP-TS');
  });

  // ── Top Patterns ──────────────────────────────────

  it('should get top patterns by confidence', () => {
    store.addPattern({ type: 'pattern', title: 'Low', description: 'low', confidence: 0.3 });
    store.addPattern({ type: 'pattern', title: 'High', description: 'high', confidence: 0.9 });
    store.addPattern({ type: 'pattern', title: 'Mid', description: 'mid', confidence: 0.6 });

    const top = store.getTopPatterns(2);
    expect(top).toHaveLength(2);
    expect(top[0].confidence).toBe(0.9);
    expect(top[1].confidence).toBe(0.6);
  });

  // ── Dispute / Archive / Activate ──────────────────

  it('should dispute high-confidence patterns instead of degrading', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Disputed',
      description: 'test',
      confidence: 0.8,
    });

    store.disputePattern(id, 'contradicted by new evidence');
    const pattern = store.getById(id);
    expect(pattern!.status).toBe('disputed');
    expect(pattern!.disputed_by).toBe('contradicted by new evidence');
    // Confidence should NOT be degraded
    expect(pattern!.confidence).toBe(0.8);
  });

  it('should degrade low-confidence patterns on dispute', () => {
    const id = store.addPattern({
      type: 'pattern',
      title: 'Low Conf',
      description: 'test',
      confidence: 0.4,
    });

    store.disputePattern(id, 'reason');
    const pattern = store.getById(id);
    // Low confidence → degrade instead of dispute
    expect(pattern!.status).not.toBe('disputed');
    expect(pattern!.confidence).toBeCloseTo(0.3);
  });

  it('should archive a pattern', () => {
    const id = store.addPattern({ type: 'pattern', title: 'Archive me', description: 'test' });
    store.archivePattern(id);
    const pattern = store.getById(id);
    expect(pattern!.status).toBe('archived');
  });

  it('should activate a disputed pattern', () => {
    const id = store.addPattern({ type: 'pattern', title: 'Reactivate', description: 'test', confidence: 0.8 });
    store.disputePattern(id, 'reason');
    expect(store.getById(id)!.status).toBe('disputed');

    store.activatePattern(id);
    const pattern = store.getById(id);
    expect(pattern!.status).toBe('active');
    expect(pattern!.disputed_by).toBeUndefined();
  });

  it('should list disputed patterns', () => {
    const id1 = store.addPattern({ type: 'pattern', title: 'D1', description: 'test', confidence: 0.9 });
    const id2 = store.addPattern({ type: 'pattern', title: 'D2', description: 'test', confidence: 0.8 });
    store.addPattern({ type: 'pattern', title: 'Active', description: 'test' });

    store.disputePattern(id1, 'r1');
    store.disputePattern(id2, 'r2');

    const disputed = store.getDisputedPatterns();
    expect(disputed).toHaveLength(2);
  });

  // ── Task Outcomes ─────────────────────────────────

  it('should record a task outcome', () => {
    const id = store.addTaskOutcome({
      task_description: 'Fix the bug',
      approach: 'Refactored the module',
      technologies: ['typescript'],
      outcome: 'success',
      compile_success: true,
      tests_passed: true,
    });
    expect(id).toBeTruthy();
  });

  // ── Stats ─────────────────────────────────────────

  it('should return stats', () => {
    store.addPattern({ type: 'pattern', title: 'P1', description: 'test', technology: 'typescript', confidence: 0.8 });
    store.addPattern({ type: 'anti_pattern', title: 'AP1', description: 'test', technology: 'typescript', confidence: 0.6 });
    store.addPattern({ type: 'lesson', title: 'L1', description: 'test', confidence: 0.7 });

    const stats = store.getStats();
    expect(stats.total).toBe(3);
    expect(stats.byType.pattern).toBe(1);
    expect(stats.byType.anti_pattern).toBe(1);
    expect(stats.byType.lesson).toBe(1);
    expect(stats.averageConfidence).toBeCloseTo(0.7, 1);
    expect(stats.byTechnology['typescript']).toBe(2);
  });

  it('should report isEmpty correctly', () => {
    expect(store.isEmpty()).toBe(true);
    store.addPattern({ type: 'pattern', title: 'Test', description: 'test' });
    expect(store.isEmpty()).toBe(false);
  });
});
