/**
 * Heartbeat system — periodic agent check-in.
 * Reads HEARTBEAT.md from workspace, triggers an agent turn with the heartbeat prompt,
 * and routes non-trivial responses to a notification channel.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CronScheduler, CronJobDefinition } from './cron.js';
import { logger } from '../utils/logger.js';

export interface HeartbeatConfig {
  enabled: boolean;
  /** Interval in minutes between heartbeats (default: 30) */
  intervalMinutes: number;
  /** The prompt to send to the agent on each heartbeat */
  prompt: string;
  /** Channel to route non-trivial responses to (e.g. "telegram:123456789") */
  notificationChannel: string;
  /** Workspace directory to read HEARTBEAT.md from */
  workspace: string;
}

const HEARTBEAT_JOB_ID = 'system:heartbeat';

/**
 * Register the heartbeat as a special cron job.
 * The heartbeat triggers an agentTurn with the configured prompt.
 * If the agent responds with HEARTBEAT_OK (exact or containing), the response is discarded.
 * Otherwise, the response is sent to the notification channel.
 */
export function registerHeartbeat(
  scheduler: CronScheduler,
  config: HeartbeatConfig
): void {
  if (!config.enabled) {
    logger.info('Heartbeat disabled');
    return;
  }

  // Parse notification channel (format: "channel:target")
  const channelParts = config.notificationChannel.split(':');
  const resultChannel = channelParts[0];
  const resultTarget = channelParts.slice(1).join(':');

  // Build cron expression from interval
  // e.g., every 30 minutes: "*/30 * * * *"
  const interval = config.intervalMinutes;
  const cronExpr = interval < 60
    ? `*/${interval} * * * *`
    : `0 */${Math.floor(interval / 60)} * * *`;

  const jobDef: CronJobDefinition = {
    id: HEARTBEAT_JOB_ID,
    name: 'Heartbeat',
    type: 'agentTurn',
    cron: cronExpr,
    payload: config.prompt,
    sessionKey: 'heartbeat:main',
    resultChannel: resultChannel,
    resultTarget: resultTarget || undefined,
    enabled: true,
  };

  scheduler.addJob(jobDef);

  logger.info('Heartbeat registered', {
    interval: `${interval}m`,
    cron: cronExpr,
    notificationChannel: config.notificationChannel,
  });
}

/**
 * Check if a heartbeat response should be discarded.
 * Returns true if the response is HEARTBEAT_OK (meaning nothing to report).
 */
export function isHeartbeatOk(response: string): boolean {
  const trimmed = response.trim();
  return trimmed === 'HEARTBEAT_OK' || trimmed.toUpperCase() === 'HEARTBEAT_OK';
}

/**
 * Build the full heartbeat prompt, including HEARTBEAT.md content if it exists.
 */
export function buildHeartbeatPrompt(basePrompt: string, workspace: string): string {
  const heartbeatPath = resolve(workspace, 'HEARTBEAT.md');

  if (existsSync(heartbeatPath)) {
    try {
      const content = readFileSync(heartbeatPath, 'utf-8');
      return `${basePrompt}\n\n--- HEARTBEAT.md ---\n${content.trim()}\n--- END HEARTBEAT.md ---`;
    } catch (err) {
      logger.warn('Failed to read HEARTBEAT.md', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return basePrompt;
}
