/**
 * Tests for DispatchEnhancer — context injection budget and technology detection.
 *
 * Verifies the MAX_CONTEXT_CHARS constant and the technology detection logic.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PatternStore } from '../../src/memory/patterns.js';
import { DispatchEnhancer } from '../../src/agent/dispatch.js';

describe('Dispatch Enhancement', () => {
  let db: Database.Database;
  let patternStore: PatternStore;
  let enhancer: DispatchEnhancer;

  beforeEach(() => {
    db = new Database(':memory:');
    patternStore = new PatternStore(db);
    enhancer = new DispatchEnhancer(patternStore);
  });

  it('should return original task when no technologies detected', () => {
    const task = 'Do something completely generic with no tech keywords';
    const result = enhancer.enhance(task);
    expect(result).toBe(task);
  });

  it('should return original task when no matching patterns exist', () => {
    const task = 'Build a TypeScript module';
    const result = enhancer.enhance(task, ['typescript']);
    // No patterns in the store, so nothing to inject
    expect(result).toBe(task);
  });

  it('should inject matching patterns into task description', () => {
    patternStore.addPattern({
      type: 'pattern',
      title: 'Use strict mode',
      description: 'Always enable strict mode in TypeScript',
      technology: 'typescript',
      confidence: 0.9,
    });

    const task = 'Build a TypeScript module';
    const result = enhancer.enhance(task, ['typescript']);

    // Should contain original task + context section
    expect(result).toContain(task);
    expect(result).toContain("Context from River's Memory");
    expect(result).toContain('strict mode');
  });

  it('should not inject patterns with confidence below 0.6', () => {
    patternStore.addPattern({
      type: 'pattern',
      title: 'Low confidence pattern',
      description: 'This pattern has low confidence',
      technology: 'typescript',
      confidence: 0.3,
    });

    const task = 'Build a TypeScript module';
    const result = enhancer.enhance(task, ['typescript']);
    // Low confidence → should not be injected
    expect(result).toBe(task);
  });

  it('should track injected pattern IDs', () => {
    const id = patternStore.addPattern({
      type: 'pattern',
      title: 'Tracked pattern',
      description: 'This should be tracked',
      technology: 'fastify',
      confidence: 0.9,
    });

    const { prompt, injectedPatternIds } = enhancer.enhanceWithTracking(
      'Build a Fastify API',
      ['fastify']
    );

    expect(prompt).toContain("Context from River's Memory");
    expect(injectedPatternIds).toContain(id);
  });

  it('should detect technologies from task description', () => {
    // Add patterns for multiple technologies
    patternStore.addPattern({
      type: 'pattern',
      title: 'TS Pattern',
      description: 'TypeScript best practice',
      technology: 'typescript',
      confidence: 0.9,
    });

    // The word "TypeScript" should auto-detect the technology
    const result = enhancer.enhance('Build a TypeScript REST API with Fastify');
    // Should find "typescript" and "fastify" keywords
    expect(result).toContain("Context from River's Memory");
  });

  it('should separate patterns and anti-patterns in output', () => {
    patternStore.addPattern({
      type: 'pattern',
      title: 'Good pattern',
      description: 'Do this',
      technology: 'typescript',
      confidence: 0.9,
      correct_approach: 'Use this approach',
    });
    patternStore.addPattern({
      type: 'anti_pattern',
      title: 'Bad pattern',
      description: 'Avoid this',
      technology: 'typescript',
      confidence: 0.8,
      incorrect_approach: 'Never do this',
    });

    const result = enhancer.enhance('Build TypeScript module', ['typescript']);
    expect(result).toContain('Relevant Patterns');
    expect(result).toContain('Anti-Patterns to Avoid');
  });

  it('should respect context char budget (not exceed 32K)', () => {
    // Add many verbose patterns to try to exceed the budget
    for (let i = 0; i < 100; i++) {
      patternStore.addPattern({
        type: 'pattern',
        title: `Pattern ${i}`,
        description: 'A'.repeat(500),
        technology: 'typescript',
        confidence: 0.9,
        correct_approach: 'B'.repeat(300),
      });
    }

    const task = 'Build TypeScript module';
    const result = enhancer.enhance(task, ['typescript']);

    // The context section should be bounded
    const contextSection = result.substring(task.length);
    expect(contextSection.length).toBeLessThan(32000 + 100); // some slack for headers
  });
});
