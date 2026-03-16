/**
 * YAML config loader with environment variable interpolation.
 * Loads river.config.yaml and resolves ${VAR} placeholders from process.env.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';
import { logger } from './utils/logger.js';

// Load .env before anything else — override: true ensures our .env wins
// over system environment variables (e.g., OpenClaw sets TELEGRAM_BOT_TOKEN globally)
loadDotenv({ override: true });

// --- Type Definitions ---

export interface DaemonConfig {
  port: number;
  workspace: string;
}

export interface IdentityConfig {
  files: string[];
}

export interface LLMModelConfig {
  provider: 'anthropic' | 'openai';
  model: string;
  max_tokens?: number;
  context_window?: number;  // max input tokens (e.g. 1000000 for 1M context)
}

export interface LLMConfig {
  primary: LLMModelConfig;
  fallbacks: LLMModelConfig[];
}

export interface TelegramChannelConfig {
  enabled: boolean;
  token: string;
  allowed_users: string[];
}

export interface DiscordGuildConfig {
  id: string;
  channels: string[];
}

export interface DiscordChannelConfig {
  enabled: boolean;
  token: string;
  guilds: DiscordGuildConfig[];
}

export interface ChannelsConfig {
  telegram: TelegramChannelConfig;
  discord: DiscordChannelConfig;
}

export interface ExecToolConfig {
  enabled: boolean;
  timeout_ms: number;
  shell: string;
}

export interface WebSearchToolConfig {
  enabled: boolean;
  brave_api_key: string;
}

export interface WebFetchToolConfig {
  enabled: boolean;
}

export interface ToolsConfig {
  exec: ExecToolConfig;
  web_search: WebSearchToolConfig;
  web_fetch: WebFetchToolConfig;
}

export interface DataConfig {
  dir: string;
  sessions_dir: string;
}

export interface SchedulerHeartbeatConfig {
  enabled: boolean;
  interval_minutes: number;
  prompt: string;
  notification_channel: string;
}

export interface SchedulerConfig {
  heartbeat: SchedulerHeartbeatConfig;
  jobs_file: string;
}

export interface CompactionRuntimeConfig {
  enabled: boolean;
  threshold_tokens: number;
  keep_recent_messages: number;
  summary_model: string;
}

export interface RiverConfig {
  daemon: DaemonConfig;
  identity: IdentityConfig;
  llm: LLMConfig;
  channels: ChannelsConfig;
  tools: ToolsConfig;
  data: DataConfig;
  scheduler: SchedulerConfig;
  compaction: CompactionRuntimeConfig;
}

// --- Environment Variable Interpolation ---

function interpolateEnv(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (_match, varName: string) => {
      const envVal = process.env[varName];
      if (envVal === undefined) {
        logger.warn(`Environment variable ${varName} not set, using empty string`);
        return '';
      }
      return envVal;
    });
  }
  if (Array.isArray(value)) {
    return value.map(interpolateEnv);
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = interpolateEnv(v);
    }
    return result;
  }
  return value;
}

// --- Config Loader ---

export function loadConfig(configPath?: string): RiverConfig {
  const searchPaths = configPath
    ? [configPath]
    : [
        resolve(process.cwd(), 'river.config.yaml'),
        resolve(process.cwd(), 'river.config.yml'),
        resolve(process.cwd(), 'config.yaml'),
      ];

  let raw: string | null = null;
  let foundPath: string | null = null;

  for (const p of searchPaths) {
    if (existsSync(p)) {
      raw = readFileSync(p, 'utf-8');
      foundPath = p;
      break;
    }
  }

  if (!raw || !foundPath) {
    throw new Error(`Config file not found. Searched: ${searchPaths.join(', ')}`);
  }

  logger.info('Loading config', { path: foundPath });

  const parsed = parseYaml(raw) as Record<string, unknown>;
  const interpolated = interpolateEnv(parsed) as RiverConfig;

  // Resolve relative data paths
  const baseDir = resolve(process.cwd());
  if (interpolated.data.dir && !interpolated.data.dir.startsWith('/')) {
    interpolated.data.dir = resolve(baseDir, interpolated.data.dir);
  }
  if (interpolated.data.sessions_dir && !interpolated.data.sessions_dir.startsWith('/')) {
    interpolated.data.sessions_dir = resolve(baseDir, interpolated.data.sessions_dir);
  }

  return interpolated;
}
