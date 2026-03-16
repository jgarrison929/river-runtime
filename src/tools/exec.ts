/**
 * Shell execution tool.
 * Runs commands with timeout, captures stdout/stderr.
 */

import { spawn } from 'node:child_process';
import type { ToolHandler } from './registry.js';
import type { ExecToolConfig } from '../config.js';

interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed: boolean;
}

function runCommand(
  command: string,
  shell: string,
  timeoutMs: number,
  workdir?: string
): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn(shell, ['-c', command], {
      cwd: workdir || process.cwd(),
      env: process.env,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      killed = true;
      proc.kill('SIGKILL');
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code,
        killed,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: stderr + '\n' + err.message,
        exitCode: 1,
        killed: false,
      });
    });
  });
}

export function createExecTool(config: ExecToolConfig): ToolHandler {
  return {
    definition: {
      name: 'exec',
      description:
        'Execute a shell command. Returns stdout, stderr, and exit code. Commands are killed after the configured timeout.',
      input_schema: {
        type: 'object' as const,
        properties: {
          command: {
            type: 'string',
            description: 'Shell command to execute',
          },
          workdir: {
            type: 'string',
            description: 'Working directory (defaults to daemon cwd)',
          },
          timeout: {
            type: 'number',
            description: `Timeout in milliseconds (default: ${config.timeout_ms})`,
          },
        },
        required: ['command'],
      },
    },
    execute: async (input) => {
      if (!config.enabled) {
        throw new Error('Shell execution is disabled in configuration');
      }

      const command = String(input['command']);

      // Safety: prevent the agent from killing its own process or restarting itself
      const BLOCKED_PATTERNS = [
        /\bkill\b.*\b(node|river|3002)\b/i,
        /\bkillall\b.*\bnode\b/i,
        /\bpkill\b.*\bnode\b/i,
        /\btmux\b.*\b(kill-session|new-session)\b.*\briver\b/i,
        /\blsof\b.*:3002.*\bxargs\b.*\bkill\b/i,
        /\bsystemctl\b.*\b(stop|restart)\b/i,
        /\brm\s+-rf\s+\//,
      ];

      for (const pattern of BLOCKED_PATTERNS) {
        if (pattern.test(command)) {
          return `[blocked] This command could kill the daemon process. Refusing to execute: ${command.slice(0, 80)}`;
        }
      }

      const workdir = input['workdir'] ? String(input['workdir']) : undefined;
      const timeout =
        typeof input['timeout'] === 'number'
          ? input['timeout']
          : config.timeout_ms;

      const result = await runCommand(command, config.shell, timeout, workdir);

      const parts: string[] = [];

      if (result.stdout) {
        parts.push(result.stdout);
      }
      if (result.stderr) {
        parts.push(`[stderr]\n${result.stderr}`);
      }
      if (result.killed) {
        parts.push(`[killed: command exceeded ${timeout}ms timeout]`);
      }
      if (result.exitCode !== 0 && result.exitCode !== null) {
        parts.push(`[exit code: ${result.exitCode}]`);
      }

      return parts.join('\n') || '(no output)';
    },
  };
}
