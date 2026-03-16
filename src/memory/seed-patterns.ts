/**
 * Seed patterns — initial patterns from known experience.
 * Run on first startup when the patterns table is empty.
 * Idempotent: checks if patterns already exist before seeding.
 */

import type { PatternStore, PatternInput } from './patterns.js';
import { logger } from '../utils/logger.js';

const SEED_PATTERNS: PatternInput[] = [
  {
    type: 'anti_pattern',
    title: 'Wrong Anthropic model ID format',
    description:
      'Anthropic model IDs use format like claude-sonnet-4-20250514, not claude-sonnet-4-5-20250514',
    technology: 'anthropic-sdk',
    context: 'Any time you configure or reference an Anthropic model',
    incorrect_approach: 'claude-sonnet-4-5-20250514, claude-opus-4-6',
    correct_approach: 'claude-sonnet-4-20250514, claude-opus-4-20250514',
    confidence: 0.95,
    occurrences: 3,
    tags: ['api', 'configuration', 'model-ids'],
  },
  {
    type: 'anti_pattern',
    title: 'WebSocket event name mismatch',
    description:
      'Frontend and backend must use identical WebSocket event type strings',
    technology: 'websocket',
    context: 'Any WebSocket integration between frontend and backend',
    incorrect_approach:
      'Using different event names on each side without verification',
    correct_approach:
      'Define event types in a shared types file imported by both sides, or verify both sides use identical strings',
    confidence: 0.9,
    occurrences: 2,
    tags: ['integration', 'frontend-backend', 'debugging'],
  },
  {
    type: 'lesson',
    title: 'Sub-agent tasks over 8 minutes usually timeout',
    description:
      'Complex tasks dispatched to sub-agents should be broken into smaller pieces',
    technology: 'river-runtime',
    context: 'Dispatching work to sub-agents',
    correct_approach:
      'Break large tasks into focused sub-tasks of 5 minutes or less',
    confidence: 0.8,
    occurrences: 4,
    tags: ['sub-agents', 'task-management', 'timeout'],
  },
  {
    type: 'pattern',
    title: 'pnpm workspace filter for per-package commands',
    description:
      'In pnpm monorepos, use --filter for per-package operations',
    technology: 'pnpm',
    context: 'Running commands in a pnpm monorepo workspace',
    correct_approach:
      'pnpm --filter daemon exec tsc --noEmit, pnpm --filter web build',
    incorrect_approach:
      'Running commands from the package directory without --filter',
    confidence: 0.85,
    occurrences: 5,
    tags: ['monorepo', 'build', 'tooling'],
  },
];

/**
 * Seed the pattern store with initial known patterns.
 * Only runs if the patterns table is empty (idempotent).
 */
export function seedPatterns(patternStore: PatternStore): void {
  if (!patternStore.isEmpty()) {
    logger.debug('Pattern store not empty, skipping seed');
    return;
  }

  logger.info('Seeding pattern store with initial patterns', {
    count: SEED_PATTERNS.length,
  });

  for (const pattern of SEED_PATTERNS) {
    patternStore.addPattern(pattern);
  }

  logger.info('Pattern store seeded successfully');
}
