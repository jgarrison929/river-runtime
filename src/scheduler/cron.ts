/**
 * Cron scheduler — runs periodic jobs using croner.
 * Loads jobs from config and a jobs.json file.
 * Supports systemEvent (inject into session) and agentTurn (run agent in isolated session) job types.
 * Stores job state in SQLite.
 */

import { Cron, type CronOptions } from 'croner';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger.js';

export type CronJobType = 'systemEvent' | 'agentTurn';

export interface CronJobDefinition {
  id: string;
  name: string;
  type: CronJobType;
  /** Cron expression (6-field with seconds, or 5-field standard) */
  cron: string;
  /** For systemEvent: text to inject. For agentTurn: prompt for the agent. */
  payload: string;
  /** For agentTurn: session key to use (default: auto-generated) */
  sessionKey?: string;
  /** For agentTurn: channel to send results to (e.g. "telegram:12345") */
  resultChannel?: string;
  /** For agentTurn: target within the channel */
  resultTarget?: string;
  enabled: boolean;
}

export interface CronJobState {
  id: string;
  lastRun: number | null;
  nextRun: number | null;
  runCount: number;
  lastStatus: 'success' | 'error' | null;
  lastError: string | null;
}

export type SystemEventHandler = (text: string, sessionKey?: string) => Promise<void>;
export type AgentTurnHandler = (
  prompt: string,
  sessionKey: string,
  resultChannel?: string,
  resultTarget?: string
) => Promise<string>;

export class CronScheduler {
  private jobs: Map<string, CronJobDefinition> = new Map();
  private runners: Map<string, Cron> = new Map();
  private db: Database.Database;
  private jobsFilePath: string | null;
  private systemEventHandler: SystemEventHandler | null = null;
  private agentTurnHandler: AgentTurnHandler | null = null;

  constructor(dataDir: string, jobsFilePath?: string) {
    // Initialize SQLite for job state
    mkdirSync(dataDir, { recursive: true });
    const dbPath = resolve(dataDir, 'scheduler.sqlite');
    this.db = new Database(dbPath);
    this.initDb();
    this.jobsFilePath = jobsFilePath ? resolve(jobsFilePath) : null;

    logger.info('Cron scheduler initialized', { dbPath, jobsFile: this.jobsFilePath });
  }

  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS job_state (
        id TEXT PRIMARY KEY,
        last_run INTEGER,
        next_run INTEGER,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_status TEXT,
        last_error TEXT
      );

      CREATE TABLE IF NOT EXISTS job_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        run_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        duration_ms INTEGER
      );
    `);
  }

  /** Set handler for systemEvent jobs. */
  onSystemEvent(handler: SystemEventHandler): void {
    this.systemEventHandler = handler;
  }

  /** Set handler for agentTurn jobs. */
  onAgentTurn(handler: AgentTurnHandler): void {
    this.agentTurnHandler = handler;
  }

  /** Load jobs from the jobs.json file (if configured). */
  loadJobsFile(): void {
    if (!this.jobsFilePath) return;

    if (!existsSync(this.jobsFilePath)) {
      logger.debug('Jobs file not found, skipping', { path: this.jobsFilePath });
      return;
    }

    try {
      const raw = readFileSync(this.jobsFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as CronJobDefinition[];

      if (!Array.isArray(parsed)) {
        logger.warn('Jobs file is not an array, skipping');
        return;
      }

      for (const job of parsed) {
        if (job.id && job.cron && job.type) {
          this.addJob(job);
        } else {
          logger.warn('Skipping invalid job definition', { job });
        }
      }

      logger.info('Loaded jobs from file', { count: parsed.length, path: this.jobsFilePath });
    } catch (err) {
      logger.error('Failed to load jobs file', {
        path: this.jobsFilePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Save current jobs to the jobs.json file. */
  saveJobsFile(): void {
    if (!this.jobsFilePath) return;

    try {
      const dir = dirname(this.jobsFilePath);
      mkdirSync(dir, { recursive: true });
      const jobs = Array.from(this.jobs.values());
      writeFileSync(this.jobsFilePath, JSON.stringify(jobs, null, 2), 'utf-8');
      logger.debug('Saved jobs file', { path: this.jobsFilePath, count: jobs.length });
    } catch (err) {
      logger.error('Failed to save jobs file', {
        path: this.jobsFilePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Add a job definition and start it if enabled. */
  addJob(def: CronJobDefinition): void {
    // Stop existing runner if replacing
    const existing = this.runners.get(def.id);
    if (existing) {
      existing.stop();
      this.runners.delete(def.id);
    }

    this.jobs.set(def.id, def);

    if (def.enabled) {
      this.startJob(def);
    }

    logger.info('Job added', { id: def.id, name: def.name, type: def.type, enabled: def.enabled });
  }

  /** Remove a job by ID. */
  removeJob(id: string): boolean {
    const runner = this.runners.get(id);
    if (runner) {
      runner.stop();
      this.runners.delete(id);
    }

    const removed = this.jobs.delete(id);
    if (removed) {
      logger.info('Job removed', { id });
    }
    return removed;
  }

  /** Update an existing job. */
  updateJob(id: string, updates: Partial<CronJobDefinition>): boolean {
    const existing = this.jobs.get(id);
    if (!existing) return false;

    const updated: CronJobDefinition = { ...existing, ...updates, id }; // id can't change
    this.addJob(updated); // addJob handles restart
    return true;
  }

  /** List all jobs with their state. */
  listJobs(): Array<CronJobDefinition & { state: CronJobState }> {
    return Array.from(this.jobs.values()).map((job) => ({
      ...job,
      state: this.getJobState(job.id),
    }));
  }

  /** Trigger a job immediately (regardless of schedule). */
  async runNow(id: string): Promise<string> {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Job '${id}' not found`);
    }

    return this.executeJob(job);
  }

  /** Start all enabled jobs. */
  startAll(): void {
    for (const job of this.jobs.values()) {
      if (job.enabled && !this.runners.has(job.id)) {
        this.startJob(job);
      }
    }

    logger.info('Cron scheduler started', {
      totalJobs: this.jobs.size,
      runningJobs: this.runners.size,
    });
  }

  /**
   * Add an internal job with a direct callback (not routed through agent/channel).
   * Used for system maintenance tasks like memory consolidation and aging.
   */
  addInternalJob(name: string, cronExpression: string, handler: () => Promise<void>): void {
    // Stop existing runner if replacing
    const existing = this.runners.get(name);
    if (existing) {
      existing.stop();
      this.runners.delete(name);
    }

    try {
      const runner = new Cron(cronExpression, { name, catch: true }, async () => {
        const startTime = Date.now();
        try {
          await handler();
          const durationMs = Date.now() - startTime;
          this.updateJobState(name, {
            lastRun: startTime,
            nextRun: runner.nextRun()?.getTime() ?? null,
            lastStatus: 'success',
            lastError: null,
            runCount: (this.getJobState(name).runCount ?? 0) + 1,
          });
          this.recordHistory(name, startTime, 'success', null, durationMs);
        } catch (err) {
          const durationMs = Date.now() - startTime;
          const error = err instanceof Error ? err.message : String(err);
          this.updateJobState(name, {
            lastRun: startTime,
            lastStatus: 'error',
            lastError: error,
            runCount: (this.getJobState(name).runCount ?? 0) + 1,
          });
          this.recordHistory(name, startTime, 'error', error, durationMs);
          logger.error('Internal cron job failed', { name, error });
        }
      });

      this.runners.set(name, runner);

      const nextRun = runner.nextRun();
      logger.info('Internal cron job registered', {
        name,
        cron: cronExpression,
        nextRun: nextRun?.toISOString(),
      });
    } catch (err) {
      logger.error('Failed to register internal cron job', {
        name,
        cron: cronExpression,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Stop all running jobs. */
  stopAll(): void {
    for (const [id, runner] of this.runners) {
      runner.stop();
      logger.debug('Stopped cron job', { id });
    }
    this.runners.clear();
    this.db.close();
    logger.info('Cron scheduler stopped');
  }

  private startJob(def: CronJobDefinition): void {
    try {
      const options: CronOptions = {
        name: def.id,
        catch: true,
      };

      const runner = new Cron(def.cron, options, async () => {
        try {
          await this.executeJob(def);
        } catch (err) {
          logger.error('Cron job execution error', {
            id: def.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });

      this.runners.set(def.id, runner);

      // Update next run time in state
      const nextRun = runner.nextRun();
      if (nextRun) {
        this.updateJobState(def.id, { nextRun: nextRun.getTime() });
      }

      logger.info('Cron job started', {
        id: def.id,
        cron: def.cron,
        nextRun: nextRun?.toISOString(),
      });
    } catch (err) {
      logger.error('Failed to start cron job', {
        id: def.id,
        cron: def.cron,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async executeJob(def: CronJobDefinition): Promise<string> {
    const startTime = Date.now();
    let status: 'success' | 'error' = 'success';
    let error: string | null = null;
    let result = '';

    logger.info('Executing cron job', { id: def.id, type: def.type });

    try {
      switch (def.type) {
        case 'systemEvent': {
          if (!this.systemEventHandler) {
            throw new Error('No systemEvent handler registered');
          }
          await this.systemEventHandler(def.payload, def.sessionKey);
          result = 'Event injected';
          break;
        }
        case 'agentTurn': {
          if (!this.agentTurnHandler) {
            throw new Error('No agentTurn handler registered');
          }
          const sessionKey = def.sessionKey ?? `cron:${def.id}:${randomUUID()}`;
          result = await this.agentTurnHandler(
            def.payload,
            sessionKey,
            def.resultChannel,
            def.resultTarget
          );
          break;
        }
        default:
          throw new Error(`Unknown job type: ${def.type}`);
      }
    } catch (err) {
      status = 'error';
      error = err instanceof Error ? err.message : String(err);
      result = `Error: ${error}`;
    }

    const durationMs = Date.now() - startTime;

    // Update state
    const runner = this.runners.get(def.id);
    const nextRun = runner?.nextRun();

    this.updateJobState(def.id, {
      lastRun: startTime,
      nextRun: nextRun ? nextRun.getTime() : null,
      lastStatus: status,
      lastError: error,
      runCount: (this.getJobState(def.id).runCount ?? 0) + 1,
    });

    // Record in history
    this.recordHistory(def.id, startTime, status, error, durationMs);

    logger.info('Cron job completed', {
      id: def.id,
      status,
      durationMs,
      nextRun: nextRun?.toISOString(),
    });

    return result;
  }

  private getJobState(id: string): CronJobState {
    const row = this.db
      .prepare('SELECT * FROM job_state WHERE id = ?')
      .get(id) as {
      id: string;
      last_run: number | null;
      next_run: number | null;
      run_count: number;
      last_status: string | null;
      last_error: string | null;
    } | undefined;

    return {
      id,
      lastRun: row?.last_run ?? null,
      nextRun: row?.next_run ?? null,
      runCount: row?.run_count ?? 0,
      lastStatus: (row?.last_status as 'success' | 'error') ?? null,
      lastError: row?.last_error ?? null,
    };
  }

  private updateJobState(
    id: string,
    updates: Partial<Omit<CronJobState, 'id'>>
  ): void {
    const current = this.getJobState(id);

    this.db
      .prepare(
        `INSERT OR REPLACE INTO job_state (id, last_run, next_run, run_count, last_status, last_error)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        updates.lastRun ?? current.lastRun,
        updates.nextRun ?? current.nextRun,
        updates.runCount ?? current.runCount,
        updates.lastStatus ?? current.lastStatus,
        updates.lastError ?? current.lastError
      );
  }

  private recordHistory(
    jobId: string,
    runAt: number,
    status: string,
    error: string | null,
    durationMs: number
  ): void {
    this.db
      .prepare(
        'INSERT INTO job_history (job_id, run_at, status, error, duration_ms) VALUES (?, ?, ?, ?, ?)'
      )
      .run(jobId, runAt, status, error, durationMs);

    // Keep only the last 1000 history entries per job
    this.db
      .prepare(
        `DELETE FROM job_history
         WHERE job_id = ? AND id NOT IN (
           SELECT id FROM job_history WHERE job_id = ? ORDER BY run_at DESC LIMIT 1000
         )`
      )
      .run(jobId, jobId);
  }
}
