/**
 * Sub-agent spawning and lifecycle management.
 * Spawns isolated sessions for complex tasks, tracks them,
 * and announces results back to the parent session.
 */

import { randomUUID } from 'node:crypto';
import type { AgentCore } from './core.js';
import type { DispatchEnhancer } from './dispatch.js';
import type { ExtractionPipeline } from '../memory/extraction.js';
import type { PatternStore, TaskOutcomeStatus } from '../memory/patterns.js';
import type { LineageTracker } from '../memory/lineage.js';
import type { InboundMessage } from '../channels/types.js';
import { logger } from '../utils/logger.js';

export interface SubAgentTask {
  /** Human-readable description of the task */
  description: string;
  /** The prompt to inject as the first user message */
  prompt: string;
  /** Parent session key that spawned this sub-agent */
  parentSessionKey: string;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeoutMs?: number;
  /** Optional: channel to report results to */
  reportChannel?: string;
  /** Optional: target for result message */
  reportTarget?: string;
}

export interface SubAgentInfo {
  id: string;
  sessionKey: string;
  description: string;
  parentSessionKey: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timeout';
  startedAt: number;
  completedAt?: number;
  result?: string;
  error?: string;
}

export class SubAgentManager {
  private active: Map<string, SubAgentInfo> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private agent: AgentCore | null = null;
  private dispatchEnhancer: DispatchEnhancer | null = null;
  private extractionPipeline: ExtractionPipeline | null = null;
  private patternStore: PatternStore | null = null;
  private lineageTracker: LineageTracker | null = null;

  /** Set the agent core reference (needed to avoid circular deps at init time). */
  setAgent(agent: AgentCore): void {
    this.agent = agent;
  }

  /** Set the pattern memory components for dispatch enhancement and extraction. */
  setPatternMemory(
    patternStore: PatternStore,
    dispatchEnhancer: DispatchEnhancer,
    extractionPipeline: ExtractionPipeline
  ): void {
    this.patternStore = patternStore;
    this.dispatchEnhancer = dispatchEnhancer;
    this.extractionPipeline = extractionPipeline;
    logger.info('Sub-agent manager wired with pattern memory');
  }

  /** Set the lineage tracker for provenance chain recording. */
  setLineageTracker(tracker: LineageTracker): void {
    this.lineageTracker = tracker;
    logger.info('Sub-agent manager wired with lineage tracker');
  }

  /**
   * Spawn a sub-agent to work on a task.
   * Returns the sub-agent ID immediately; the task runs in the background.
   */
  spawn(task: SubAgentTask): string {
    if (!this.agent) {
      throw new Error('SubAgentManager: agent core not set');
    }

    const id = randomUUID();
    const sessionKey = `subagent:${task.parentSessionKey}:${id}`;
    const timeoutMs = task.timeoutMs ?? 300_000; // 5 min default

    // Enhance the task prompt with pattern memory (if available)
    let enhancedPrompt = task.prompt;
    let injectedPatternIds: string[] = [];
    if (this.dispatchEnhancer) {
      try {
        const result = this.dispatchEnhancer.enhanceWithTracking(task.prompt);
        enhancedPrompt = result.prompt;
        injectedPatternIds = result.injectedPatternIds;
        if (enhancedPrompt !== task.prompt) {
          logger.info('Task prompt enhanced with pattern memory', {
            id,
            originalLength: task.prompt.length,
            enhancedLength: enhancedPrompt.length,
            patternsInjected: injectedPatternIds.length,
          });
        }
      } catch (err) {
        logger.error('Dispatch enhancement failed, using original prompt', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Record lineage for injected patterns (fire-and-forget)
    if (this.lineageTracker && injectedPatternIds.length > 0) {
      for (const patternId of injectedPatternIds) {
        this.lineageTracker.recordInjection(patternId, sessionKey, task.description.substring(0, 200));
      }
    }

    const enhancedTask: SubAgentTask = { ...task, prompt: enhancedPrompt };

    const info: SubAgentInfo = {
      id,
      sessionKey,
      description: task.description,
      parentSessionKey: task.parentSessionKey,
      status: 'running',
      startedAt: Date.now(),
    };

    this.active.set(id, info);

    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);

    logger.info('Spawning sub-agent', {
      id,
      sessionKey,
      description: task.description,
      parentSessionKey: task.parentSessionKey,
      timeoutMs,
    });

    // Run in background (fire and forget, but we track it)
    this.runSubAgent(id, sessionKey, enhancedTask, timeoutMs, abortController.signal).catch(
      (err) => {
        logger.error('Sub-agent background error', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    );

    return id;
  }

  /** Kill/cancel an active sub-agent. */
  kill(id: string): boolean {
    const info = this.active.get(id);
    if (!info || info.status !== 'running') {
      return false;
    }

    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
    }

    info.status = 'cancelled';
    info.completedAt = Date.now();
    this.abortControllers.delete(id);

    logger.info('Sub-agent cancelled', { id, sessionKey: info.sessionKey });
    return true;
  }

  /** Get info about a specific sub-agent. */
  getInfo(id: string): SubAgentInfo | undefined {
    return this.active.get(id);
  }

  /** List all sub-agents, optionally filtered by parent session key. */
  list(parentSessionKey?: string): SubAgentInfo[] {
    const all = Array.from(this.active.values());
    if (parentSessionKey) {
      return all.filter((sa) => sa.parentSessionKey === parentSessionKey);
    }
    return all;
  }

  /** List only currently running sub-agents. */
  listActive(): SubAgentInfo[] {
    return Array.from(this.active.values()).filter((sa) => sa.status === 'running');
  }

  /** Clean up completed sub-agents older than maxAgeMs. */
  cleanup(maxAgeMs: number = 3_600_000): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [id, info] of this.active) {
      if (info.status !== 'running' && info.completedAt && now - info.completedAt > maxAgeMs) {
        this.active.delete(id);
        this.abortControllers.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug('Cleaned up sub-agents', { cleaned });
    }

    return cleaned;
  }

  private async runSubAgent(
    id: string,
    sessionKey: string,
    task: SubAgentTask,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<void> {
    const info = this.active.get(id);
    if (!info) return;

    // Create a fake inbound message to trigger the agent loop
    const fakeMessage: InboundMessage = {
      id: `subagent-${id}`,
      channel: 'webchat', // Sub-agents don't have a real channel
      sessionKey,
      userId: 'system',
      userName: 'SubAgent Task',
      text: task.prompt,
      timestamp: Date.now(),
    };

    // Set up timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Sub-agent timeout')), timeoutMs);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new Error('Sub-agent cancelled'));
      });
    });

    try {
      const result = await Promise.race([
        this.agent!.processMessage(fakeMessage),
        timeoutPromise,
      ]);

      info.status = 'completed';
      info.result = result.text;
      info.completedAt = Date.now();

      logger.info('Sub-agent completed', {
        id,
        sessionKey,
        elapsed: info.completedAt - info.startedAt,
        resultLength: result.text.length,
      });

      // Record lineage validation for injected patterns (fire-and-forget)
      this.recordOutcomeLineage(sessionKey, 'success');

      // Run extraction pipeline in background (non-blocking)
      this.runPostTaskExtraction(task, result.text, 'success').catch((err) => {
        logger.error('Post-task extraction background error', {
          id,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      if (errMsg === 'Sub-agent cancelled') {
        info.status = 'cancelled';
      } else if (errMsg === 'Sub-agent timeout') {
        info.status = 'timeout';
        info.error = `Timed out after ${timeoutMs}ms`;
      } else {
        info.status = 'failed';
        info.error = errMsg;
      }

      info.completedAt = Date.now();

      logger.error('Sub-agent failed', {
        id,
        sessionKey,
        status: info.status,
        error: errMsg,
        elapsed: info.completedAt - info.startedAt,
      });

      // Record lineage validation for failures too
      if (info.status === 'failed') {
        this.recordOutcomeLineage(sessionKey, 'failure', errMsg);
      }

      // Run extraction for failures too (we learn from mistakes)
      if (info.status === 'failed') {
        this.runPostTaskExtraction(task, errMsg, 'failure').catch((extractErr) => {
          logger.error('Post-task extraction background error (failure)', {
            id,
            error: extractErr instanceof Error ? extractErr.message : String(extractErr),
          });
        });
      }
    } finally {
      this.abortControllers.delete(id);
    }
  }

  /**
   * Record lineage validation/contradiction for all patterns injected into a dispatch.
   * Fire-and-forget — never blocks the main flow.
   */
  private recordOutcomeLineage(
    dispatchSessionKey: string,
    outcome: 'success' | 'partial' | 'failure',
    notes?: string
  ): void {
    if (!this.lineageTracker) return;

    try {
      const lineage = this.lineageTracker.getDispatchLineage(dispatchSessionKey);
      for (const patternId of lineage.injectedPatterns) {
        // Get current confidence for before/after tracking
        const pattern = this.patternStore?.getById(patternId);
        const confidenceBefore = pattern?.confidence;

        this.lineageTracker.recordValidation(
          patternId,
          dispatchSessionKey,
          outcome,
          notes,
          confidenceBefore,
          undefined // confidence_after will be recorded by pattern reinforce/degrade
        );
      }
    } catch (err) {
      logger.warn('Failed to record outcome lineage', {
        dispatchSessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Run post-task extraction asynchronously.
   * Extracts patterns from task results and stores them in pattern memory.
   * Non-blocking — does not delay task completion announcements.
   */
  private async runPostTaskExtraction(
    task: SubAgentTask,
    result: string,
    outcome: TaskOutcomeStatus
  ): Promise<void> {
    if (!this.extractionPipeline || !this.patternStore) {
      return;
    }

    logger.debug('Starting post-task extraction', {
      description: task.description,
      outcome,
    });

    await this.extractionPipeline.extractFromTaskCompletion(
      task.description,
      result,
      outcome,
      task.parentSessionKey
    );
  }
}
