/**
 * Tests for Anthropic thinking configuration logic.
 *
 * Covers:
 * - Adaptive thinking for Opus 4.6 / Sonnet 4.6 (model decides budget)
 * - Manual budget caps for older models (Opus 4, Sonnet 4)
 * - Temperature deletion when thinking enabled
 * - max_tokens adjustment
 */

import { describe, it, expect } from 'vitest';

// ─── Extract the thinking param logic as a pure function ───────────
// Mirrors the logic in AnthropicProvider.chat()

interface ThinkingConfig {
  enabled: boolean;
  budget_tokens?: number;
}

interface ThinkingParams {
  max_tokens: number;
  thinking?: { type: 'enabled'; budget_tokens?: number };
  temperatureDeleted: boolean;
  mode: 'adaptive' | 'manual' | 'off';
}

function buildThinkingParams(
  model: string,
  requestedMaxTokens: number,
  thinking?: ThinkingConfig
): ThinkingParams {
  let maxTokens = requestedMaxTokens;
  let thinkingBlock: { type: 'enabled'; budget_tokens?: number } | undefined;
  let temperatureDeleted = false;
  let mode: 'adaptive' | 'manual' | 'off' = 'off';

  if (thinking?.enabled) {
    const supportsAdaptive = model.includes('4-6') ||
      model.includes('4.6') ||
      model === 'claude-opus-4-6' ||
      model === 'claude-sonnet-4-6';

    if (supportsAdaptive) {
      // Adaptive: model decides budget
      thinkingBlock = { type: 'enabled' };
      mode = 'adaptive';
    } else if (thinking.budget_tokens) {
      // Manual: cap to model limits
      const modelMaxOutput = model.includes('sonnet') ? 64000 : 32000;
      const cappedBudget = Math.min(thinking.budget_tokens, modelMaxOutput - 4000);
      thinkingBlock = { type: 'enabled', budget_tokens: cappedBudget };
      mode = 'manual';
    } else {
      // Fallback: manual with default
      thinkingBlock = { type: 'enabled', budget_tokens: 10000 };
      mode = 'manual';
    }

    const modelMaxOutput = model.includes('sonnet') ? 64000 : 32000;
    maxTokens = modelMaxOutput;
    temperatureDeleted = true;
  }

  return { max_tokens: maxTokens, thinking: thinkingBlock, temperatureDeleted, mode };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe('Adaptive Thinking (Opus 4.6 / Sonnet 4.6)', () => {
  it('should use adaptive mode for claude-opus-4-6', () => {
    const result = buildThinkingParams('claude-opus-4-6', 16384, { enabled: true });
    expect(result.mode).toBe('adaptive');
    expect(result.thinking).toEqual({ type: 'enabled' });
    expect(result.thinking?.budget_tokens).toBeUndefined();
  });

  it('should use adaptive mode for claude-sonnet-4-6', () => {
    const result = buildThinkingParams('claude-sonnet-4-6', 16384, { enabled: true });
    expect(result.mode).toBe('adaptive');
    expect(result.thinking?.budget_tokens).toBeUndefined();
  });

  it('should use adaptive mode for versioned 4.6 model IDs', () => {
    const result = buildThinkingParams('claude-opus-4-6-20260301', 16384, { enabled: true });
    expect(result.mode).toBe('adaptive');
  });

  it('should ignore budget_tokens in adaptive mode', () => {
    const result = buildThinkingParams('claude-opus-4-6', 16384, { enabled: true, budget_tokens: 128000 });
    expect(result.mode).toBe('adaptive');
    expect(result.thinking?.budget_tokens).toBeUndefined();
  });

  it('should delete temperature for adaptive thinking', () => {
    const result = buildThinkingParams('claude-opus-4-6', 16384, { enabled: true });
    expect(result.temperatureDeleted).toBe(true);
  });
});

describe('Manual Thinking (Opus 4, Sonnet 4)', () => {
  it('should cap thinking budget to Opus max (32K) minus response headroom', () => {
    const result = buildThinkingParams('claude-opus-4-20250514', 8192, { enabled: true, budget_tokens: 128000 });
    expect(result.mode).toBe('manual');
    expect(result.thinking?.budget_tokens).toBe(28000);
    expect(result.max_tokens).toBe(32000);
  });

  it('should cap thinking budget to Sonnet max (64K) minus response headroom', () => {
    const result = buildThinkingParams('claude-sonnet-4-20250514', 8192, { enabled: true, budget_tokens: 128000 });
    expect(result.thinking?.budget_tokens).toBe(60000);
    expect(result.max_tokens).toBe(64000);
  });

  it('should not cap budget when under model limit', () => {
    const result = buildThinkingParams('claude-opus-4-20250514', 8192, { enabled: true, budget_tokens: 10000 });
    expect(result.thinking?.budget_tokens).toBe(10000);
  });

  it('should default to 10000 when no budget specified', () => {
    const result = buildThinkingParams('claude-opus-4-20250514', 8192, { enabled: true });
    expect(result.mode).toBe('manual');
    expect(result.thinking?.budget_tokens).toBe(10000);
  });

  it('should handle exact boundary budget', () => {
    const result = buildThinkingParams('claude-opus-4-20250514', 8192, { enabled: true, budget_tokens: 28000 });
    expect(result.thinking?.budget_tokens).toBe(28000);
  });
});

describe('Thinking Off', () => {
  it('should not add thinking when disabled', () => {
    const result = buildThinkingParams('claude-opus-4-6', 16384, { enabled: false });
    expect(result.thinking).toBeUndefined();
    expect(result.mode).toBe('off');
    expect(result.temperatureDeleted).toBe(false);
    expect(result.max_tokens).toBe(16384);
  });

  it('should not add thinking when config undefined', () => {
    const result = buildThinkingParams('claude-opus-4-6', 16384);
    expect(result.thinking).toBeUndefined();
    expect(result.mode).toBe('off');
  });
});
