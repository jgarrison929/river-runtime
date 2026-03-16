/**
 * Structured logging utility for river-runtime.
 * Simple, zero-dependency, JSON-based structured logger.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  [key: string]: unknown;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[currentLevel];
}

function formatEntry(level: LogLevel, msg: string, meta?: Record<string, unknown>): string {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...meta,
  };
  return JSON.stringify(entry);
}

export const logger = {
  debug(msg: string, meta?: Record<string, unknown>): void {
    if (shouldLog('debug')) {
      process.stdout.write(formatEntry('debug', msg, meta) + '\n');
    }
  },

  info(msg: string, meta?: Record<string, unknown>): void {
    if (shouldLog('info')) {
      process.stdout.write(formatEntry('info', msg, meta) + '\n');
    }
  },

  warn(msg: string, meta?: Record<string, unknown>): void {
    if (shouldLog('warn')) {
      process.stderr.write(formatEntry('warn', msg, meta) + '\n');
    }
  },

  error(msg: string, meta?: Record<string, unknown>): void {
    if (shouldLog('error')) {
      process.stderr.write(formatEntry('error', msg, meta) + '\n');
    }
  },
};
