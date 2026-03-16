/**
 * Filesystem tools: read, write, edit.
 * Provides safe file operations with proper error handling.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { ToolHandler } from './registry.js';

/** Read file contents with optional offset/limit. */
export function createReadTool(): ToolHandler {
  return {
    definition: {
      name: 'read',
      description:
        'Read the contents of a file. Supports text files. Use offset and limit for large files.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to read (relative or absolute)',
          },
          offset: {
            type: 'number',
            description: 'Line number to start reading from (1-indexed)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of lines to read',
          },
        },
        required: ['path'],
      },
    },
    execute: async (input) => {
      const filePath = resolve(String(input['path']));

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      const offset = typeof input['offset'] === 'number' ? input['offset'] - 1 : 0;
      const limit = typeof input['limit'] === 'number' ? input['limit'] : lines.length;

      const sliced = lines.slice(Math.max(0, offset), offset + limit);
      return sliced.join('\n');
    },
  };
}

/** Write content to a file, creating parent directories if needed. */
export function createWriteTool(): ToolHandler {
  return {
    definition: {
      name: 'write',
      description:
        'Write content to a file. Creates the file and parent directories if they don\'t exist. Overwrites existing content.',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to write',
          },
          content: {
            type: 'string',
            description: 'Content to write to the file',
          },
        },
        required: ['path', 'content'],
      },
    },
    execute: async (input) => {
      const filePath = resolve(String(input['path']));
      const content = String(input['content']);

      // Ensure parent directory exists
      const dir = dirname(filePath);
      mkdirSync(dir, { recursive: true });

      writeFileSync(filePath, content, 'utf-8');
      return `Successfully wrote ${content.length} bytes to ${filePath}`;
    },
  };
}

/** Find and replace exact text in a file. */
export function createEditTool(): ToolHandler {
  return {
    definition: {
      name: 'edit',
      description:
        'Edit a file by replacing exact text. The old_string must match exactly (including whitespace).',
      input_schema: {
        type: 'object' as const,
        properties: {
          path: {
            type: 'string',
            description: 'Path to the file to edit',
          },
          old_string: {
            type: 'string',
            description: 'Exact text to find and replace',
          },
          new_string: {
            type: 'string',
            description: 'New text to replace the old text with',
          },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
    execute: async (input) => {
      const filePath = resolve(String(input['path']));
      const oldStr = String(input['old_string']);
      const newStr = String(input['new_string']);

      if (!existsSync(filePath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const content = readFileSync(filePath, 'utf-8');

      if (!content.includes(oldStr)) {
        throw new Error('old_string not found in file. Make sure it matches exactly.');
      }

      // Count occurrences
      const occurrences = content.split(oldStr).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `old_string found ${occurrences} times. Use a more specific string to match exactly once.`
        );
      }

      const updated = content.replace(oldStr, newStr);
      writeFileSync(filePath, updated, 'utf-8');

      return `Successfully edited ${filePath}`;
    },
  };
}
