/**
 * Post-task extraction pipeline.
 * After a sub-agent completes a task, this extracts reusable patterns
 * and anti-patterns from the result using a cheaper LLM model.
 */

import { AnthropicProvider } from '../llm/anthropic.js';
import type { PatternStore, PatternInput, TaskOutcomeInput, TaskOutcomeStatus } from './patterns.js';
import type { LineageTracker } from './lineage.js';
import { logger } from '../utils/logger.js';

// --- Types ---

interface ExtractionResult {
  technologies: string[];
  files_changed: string[];
  outcome: TaskOutcomeStatus;
  compile_success: boolean | null;
  issues: string | null;
  fix: string | null;
  patterns: ExtractedPattern[];
}

interface ExtractedPattern {
  type: 'pattern' | 'anti_pattern' | 'lesson';
  title: string;
  description: string;
  technology: string;
  context: string;
  correct_approach: string;
  incorrect_approach: string;
  tags: string[];
}

const EXTRACTION_SYSTEM_PROMPT = `You are a pattern extraction system. Given a coding task and its outcome, extract reusable patterns and anti-patterns.

Respond with a JSON object:
{
  "technologies": ["tech1", "tech2"],
  "files_changed": ["path1", "path2"],
  "outcome": "success" | "partial" | "failure",
  "compile_success": true/false/null,
  "issues": "description of any problems encountered",
  "fix": "what fixed the issues (if applicable)",
  "patterns": [
    {
      "type": "pattern" | "anti_pattern" | "lesson",
      "title": "Short descriptive title",
      "description": "What was learned",
      "technology": "primary technology",
      "context": "When this applies",
      "correct_approach": "What to do",
      "incorrect_approach": "What NOT to do (for anti-patterns)",
      "tags": ["tag1", "tag2"]
    }
  ]
}

Only extract patterns that are genuinely reusable — not task-specific trivia.
If nothing useful was learned, return an empty patterns array.
Be specific and concrete, not vague.
Respond with ONLY valid JSON, no markdown fencing or extra text.`;

// The cheaper model for extraction (sonnet, not opus)
const EXTRACTION_MODEL = 'claude-sonnet-4-20250514';

export class ExtractionPipeline {
  private patternStore: PatternStore;
  private llm: AnthropicProvider;
  private lineageTracker: LineageTracker | null = null;

  constructor(patternStore: PatternStore) {
    this.patternStore = patternStore;
    this.llm = new AnthropicProvider();
  }

  /** Set the lineage tracker for provenance chain recording. */
  setLineageTracker(tracker: LineageTracker): void {
    this.lineageTracker = tracker;
  }

  /**
   * Extract patterns from a completed task.
   * Runs asynchronously — does NOT block the caller.
   * Call this with .catch() to avoid unhandled rejections.
   */
  async extractFromTaskCompletion(
    taskDescription: string,
    taskResult: string,
    outcomeHint: TaskOutcomeStatus,
    parentSession?: string
  ): Promise<string[]> {
    const startTime = Date.now();

    try {
      // Build the user prompt with task details
      const userPrompt = this.buildUserPrompt(taskDescription, taskResult, outcomeHint);

      // Call the LLM with the extraction prompt
      const response = await this.llm.chat({
        model: EXTRACTION_MODEL,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [
          { role: 'user', content: userPrompt },
        ],
        tools: [],
        max_tokens: 2048,
      });

      // Extract text from response
      const responseText = response.content
        .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
        .map((b) => b.text)
        .join('');

      // Parse the JSON response
      const extraction = this.parseExtraction(responseText);
      if (!extraction) {
        logger.warn('Failed to parse extraction response', {
          responseLength: responseText.length,
        });
        return [];
      }

      // Store the task outcome
      const outcomeInput: TaskOutcomeInput = {
        task_description: taskDescription,
        approach: taskResult.slice(0, 2000), // Truncate very long results
        technologies: extraction.technologies,
        files_changed: extraction.files_changed,
        outcome: extraction.outcome,
        compile_success: extraction.compile_success,
        issues: extraction.issues ?? undefined,
        fix: extraction.fix ?? undefined,
        duration_ms: Date.now() - startTime,
        patterns_applied: [],
        patterns_extracted: [],
        parent_session: parentSession,
      };

      const extractedPatternIds: string[] = [];

      // Store each extracted pattern
      for (const p of extraction.patterns) {
        const patternInput: PatternInput = {
          type: p.type,
          title: p.title,
          description: p.description,
          technology: p.technology || undefined,
          context: p.context || undefined,
          correct_approach: p.correct_approach || undefined,
          incorrect_approach: p.incorrect_approach || undefined,
          confidence: 0.5, // New patterns start at medium confidence
          occurrences: 1,
          tags: p.tags,
        };

        const patternId = this.patternStore.addPattern(patternInput);
        extractedPatternIds.push(patternId);

        // Record lineage: pattern was extracted from this session
        if (this.lineageTracker) {
          this.lineageTracker.recordExtraction(
            patternId,
            parentSession ?? 'extraction:unknown'
          );
        }
      }

      // Update the outcome with extracted pattern IDs
      outcomeInput.patterns_extracted = extractedPatternIds;
      this.patternStore.addTaskOutcome(outcomeInput);

      logger.info('Extraction complete', {
        patternsExtracted: extractedPatternIds.length,
        outcome: extraction.outcome,
        technologies: extraction.technologies,
        elapsed: Date.now() - startTime,
      });

      return extractedPatternIds;
    } catch (err) {
      logger.error('Extraction pipeline failed', {
        error: err instanceof Error ? err.message : String(err),
        elapsed: Date.now() - startTime,
      });
      return [];
    }
  }

  private buildUserPrompt(
    taskDescription: string,
    taskResult: string,
    outcomeHint: TaskOutcomeStatus
  ): string {
    // Truncate task result to avoid huge prompts (keep it under ~4000 chars)
    const truncatedResult =
      taskResult.length > 4000
        ? taskResult.slice(0, 3900) + '\n\n[...truncated...]'
        : taskResult;

    return `## Task Description
${taskDescription}

## Task Result
${truncatedResult}

## Outcome Hint
The task was considered: ${outcomeHint}

Please analyze this task and extract any reusable patterns or anti-patterns.`;
  }

  private parseExtraction(responseText: string): ExtractionResult | null {
    try {
      // Try to parse directly
      const parsed = JSON.parse(responseText) as ExtractionResult;
      return this.validateExtraction(parsed);
    } catch {
      // Try to extract JSON from markdown fencing or surrounding text
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]) as ExtractionResult;
          return this.validateExtraction(parsed);
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private validateExtraction(data: ExtractionResult): ExtractionResult | null {
    // Validate required fields
    if (!data.outcome || !['success', 'partial', 'failure'].includes(data.outcome)) {
      return null;
    }

    // Ensure arrays exist
    if (!Array.isArray(data.technologies)) {
      data.technologies = [];
    }
    if (!Array.isArray(data.files_changed)) {
      data.files_changed = [];
    }
    if (!Array.isArray(data.patterns)) {
      data.patterns = [];
    }

    // Validate each pattern
    data.patterns = data.patterns.filter((p) => {
      return (
        p.type &&
        ['pattern', 'anti_pattern', 'lesson'].includes(p.type) &&
        typeof p.title === 'string' &&
        p.title.length > 0 &&
        typeof p.description === 'string' &&
        p.description.length > 0
      );
    });

    // Ensure tags are arrays
    for (const p of data.patterns) {
      if (!Array.isArray(p.tags)) {
        p.tags = [];
      }
    }

    return data;
  }
}
