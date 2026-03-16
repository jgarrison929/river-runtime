/**
 * Dispatch Enhancer — enriches sub-agent task prompts with relevant
 * patterns and anti-patterns from River's pattern memory.
 *
 * Queries the PatternStore and appends a "Context from River's Memory"
 * section to the task description before spawning.
 */

import type { PatternStore, Pattern } from '../memory/patterns.js';
import type { KnowledgeBase, KnowledgeEntry } from '../memory/knowledge.js';
import { logger } from '../utils/logger.js';

/** Approximate token budget for injected context (~8000 tokens ≈ 32000 chars).
 *  Increased from 2000/8000 to leverage 1M context window (Mar 14, 2026). */
const MAX_CONTEXT_CHARS = 32000;

/**
 * Known technology keywords and their canonical names.
 * Used for auto-detecting technologies from task descriptions.
 */
const TECH_KEYWORDS: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  react: 'react',
  nextjs: 'nextjs',
  'next.js': 'nextjs',
  node: 'node',
  'node.js': 'node',
  websocket: 'websocket',
  ws: 'websocket',
  anthropic: 'anthropic-sdk',
  claude: 'anthropic-sdk',
  openai: 'openai',
  sqlite: 'sqlite',
  'better-sqlite3': 'sqlite',
  pnpm: 'pnpm',
  docker: 'docker',
  git: 'git',
  discord: 'discord.js',
  'discord.js': 'discord.js',
  telegram: 'telegram',
  grammy: 'telegram',
  fastify: 'fastify',
  css: 'css',
  tailwind: 'tailwind',
  rust: 'rust',
  python: 'python',
  'river-runtime': 'river-runtime',
  river: 'river-runtime',
};

export class DispatchEnhancer {
  private patternStore: PatternStore;
  private knowledgeBase: KnowledgeBase | null;

  constructor(patternStore: PatternStore, knowledgeBase?: KnowledgeBase) {
    this.patternStore = patternStore;
    this.knowledgeBase = knowledgeBase ?? null;
  }

  /** Set or update the knowledge base reference. */
  setKnowledgeBase(kb: KnowledgeBase): void {
    this.knowledgeBase = kb;
  }

  /**
   * Enhance a task description with relevant patterns and knowledge from memory.
   * Returns the original description with context sections appended.
   */
  enhance(taskDescription: string, technologies?: string[]): string {
    return this.enhanceWithTracking(taskDescription, technologies).prompt;
  }

  /**
   * Enhanced version that also returns which pattern IDs were injected,
   * for lineage tracking.
   */
  enhanceWithTracking(
    taskDescription: string,
    technologies?: string[]
  ): { prompt: string; injectedPatternIds: string[] } {
    try {
      // Auto-detect technologies if not provided
      const techs = technologies ?? this.detectTechnologies(taskDescription);

      if (techs.length === 0) {
        logger.debug('No technologies detected for dispatch enhancement');
        return { prompt: taskDescription, injectedPatternIds: [] };
      }

      // Get relevant patterns — only active patterns with decent confidence
      const allPatterns = this.patternStore.getRelevantPatterns(techs, taskDescription);
      const patterns = allPatterns.filter(
        (p) => p.status === 'active' && p.confidence >= 0.6
      );

      // Separate into patterns/lessons and anti-patterns
      const positivePatterns = patterns.filter(
        (p) => p.type === 'pattern' || p.type === 'lesson'
      );
      const antiPatterns = patterns.filter((p) => p.type === 'anti_pattern');

      // Get relevant knowledge entries
      const knowledgeEntries = this.knowledgeBase
        ? this.knowledgeBase.getForTechnologies(techs)
        : [];

      if (patterns.length === 0 && knowledgeEntries.length === 0) {
        logger.debug('No patterns or knowledge found for dispatch enhancement');
        return { prompt: taskDescription, injectedPatternIds: [] };
      }

      // Build the context section (split budget between patterns and knowledge)
      const contextSection = this.buildContextSection(
        positivePatterns,
        antiPatterns,
        knowledgeEntries
      );
      if (!contextSection) {
        return { prompt: taskDescription, injectedPatternIds: [] };
      }

      // Collect all injected pattern IDs for lineage tracking
      const injectedPatternIds = patterns.map((p) => p.id);

      logger.info('Dispatch enhanced', {
        technologies: techs,
        patternsInjected: positivePatterns.length,
        antiPatternsInjected: antiPatterns.length,
        knowledgeInjected: knowledgeEntries.length,
        contextChars: contextSection.length,
      });

      return {
        prompt: `${taskDescription}\n\n${contextSection}`,
        injectedPatternIds,
      };
    } catch (err) {
      logger.error('Dispatch enhancement failed, returning original task', {
        error: err instanceof Error ? err.message : String(err),
      });
      return { prompt: taskDescription, injectedPatternIds: [] };
    }
  }

  /** Detect technologies from task description text. */
  private detectTechnologies(text: string): string[] {
    const lower = text.toLowerCase();
    const detected = new Set<string>();

    for (const [keyword, canonical] of Object.entries(TECH_KEYWORDS)) {
      // Use word boundary matching to avoid false positives
      const regex = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (regex.test(lower)) {
        detected.add(canonical);
      }
    }

    return Array.from(detected);
  }

  /** Build the context section, respecting the token budget. */
  private buildContextSection(
    positivePatterns: Pattern[],
    antiPatterns: Pattern[],
    knowledgeEntries?: KnowledgeEntry[]
  ): string | null {
    let section = '## Context from River\'s Memory\n';
    let currentLength = section.length;

    // Budget: split between patterns (~half) and knowledge (~half)
    const patternBudget = Math.floor(MAX_CONTEXT_CHARS * 0.5);
    const knowledgeBudget = MAX_CONTEXT_CHARS - patternBudget;

    // --- Patterns section ---
    let patternChars = 0;

    // Add positive patterns
    if (positivePatterns.length > 0) {
      const header = '\n### Relevant Patterns (from prior experience)\n';
      patternChars += header.length;

      if (currentLength + patternChars < MAX_CONTEXT_CHARS) {
        section += header;
        currentLength += header.length;

        for (const p of positivePatterns) {
          const line = this.formatPatternLine(p);
          if (patternChars + line.length > patternBudget) break;
          section += line;
          currentLength += line.length;
          patternChars += line.length;
        }
      }
    }

    // Add anti-patterns
    if (antiPatterns.length > 0) {
      const header = '\n### Anti-Patterns to Avoid\n';

      if (patternChars + header.length < patternBudget) {
        section += header;
        currentLength += header.length;
        patternChars += header.length;

        for (const p of antiPatterns) {
          const line = this.formatAntiPatternLine(p);
          if (patternChars + line.length > patternBudget) break;
          section += line;
          currentLength += line.length;
          patternChars += line.length;
        }
      }
    }

    // --- Knowledge section ---
    if (knowledgeEntries && knowledgeEntries.length > 0) {
      const header = '\n### Technical Knowledge (from River\'s docs library)\n';
      let knowledgeChars = header.length;

      if (currentLength + knowledgeChars < MAX_CONTEXT_CHARS) {
        section += header;
        currentLength += header.length;

        for (const entry of knowledgeEntries) {
          const line = this.formatKnowledgeLine(entry);
          if (knowledgeChars + line.length > knowledgeBudget) break;
          section += line;
          currentLength += line.length;
          knowledgeChars += line.length;
        }
      }
    }

    // Don't inject if we only have the header
    if (section === '## Context from River\'s Memory\n') {
      return null;
    }

    return section;
  }

  private formatPatternLine(p: Pattern): string {
    const confidence = this.confidenceLabel(p.confidence);
    let line = `- [${confidence} confidence] ${p.description}`;

    if (p.correct_approach) {
      line += ` → ${p.correct_approach}`;
    }
    if (p.occurrences > 1) {
      line += ` (seen ${p.occurrences} times)`;
    }

    return line + '\n';
  }

  private formatAntiPatternLine(p: Pattern): string {
    let line = `- `;

    if (p.incorrect_approach) {
      line += `Don't: ${p.incorrect_approach}`;
      if (p.correct_approach) {
        line += ` → Instead: ${p.correct_approach}`;
      }
    } else {
      line += p.description;
    }

    if (p.occurrences > 1) {
      line += ` (burned us ${p.occurrences} times)`;
    }

    return line + '\n';
  }

  private formatKnowledgeLine(entry: KnowledgeEntry): string {
    const techLabel = entry.version
      ? `${entry.technology} v${entry.version}`
      : entry.technology;

    const prefix =
      entry.entry_type === 'breaking_change'
        ? '[BREAKING]'
        : entry.entry_type === 'anti_pattern'
          ? '[AVOID]'
          : `[${techLabel}]`;

    let line = `- ${prefix} ${entry.content}`;

    // Add code example for API signatures (compact, single-line if short)
    if (entry.entry_type === 'api_signature' && entry.code_example) {
      const compactExample = entry.code_example.replace(/\n/g, ' ').trim();
      if (compactExample.length < 120) {
        line += ` — \`${compactExample}\``;
      }
    }

    return line + '\n';
  }

  private confidenceLabel(confidence: number): string {
    if (confidence >= 0.8) return 'HIGH';
    if (confidence >= 0.5) return 'MEDIUM';
    return 'LOW';
  }
}
