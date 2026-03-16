/**
 * Agent tool handlers for computer control.
 * Wraps the computer-control module functions as ToolHandler instances
 * for registration in the ToolRegistry.
 */

import type { ToolHandler } from './registry.js';
import {
  screenshot,
  mouseMove,
  mouseClick,
  mouseDoubleClick,
  mouseScroll,
  typeText,
  pressKey,
  keyCombo,
  listWindows,
  focusWindow,
} from './computer-control.js';
import { logger } from '../utils/logger.js';

/**
 * Create the take_screenshot tool.
 * Captures the screen (or a specific monitor) and returns the file path.
 */
export function createScreenshotTool(): ToolHandler {
  return {
    definition: {
      name: 'take_screenshot',
      description:
        'Capture a screenshot of the Windows desktop. Returns the file path to the saved PNG image. ' +
        'Use this to see what is currently displayed on screen.',
      input_schema: {
        type: 'object' as const,
        properties: {
          monitor: {
            type: 'number',
            description: 'Monitor number to capture (1-based). Omit to capture all monitors.',
          },
        },
        required: [],
      },
    },
    execute: async (input) => {
      const monitor = typeof input['monitor'] === 'number' ? input['monitor'] : undefined;

      try {
        const filePath = await screenshot(monitor !== undefined ? { monitor } : undefined);
        return `Screenshot saved to: ${filePath}\nYou can reference this image in subsequent tool calls.`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('take_screenshot failed', { error: msg });
        return `Error capturing screenshot: ${msg}`;
      }
    },
  };
}

/**
 * Create the computer_click tool.
 * Clicks at specific screen coordinates with optional button and double-click.
 */
export function createClickTool(): ToolHandler {
  return {
    definition: {
      name: 'computer_click',
      description:
        'Click at specific screen coordinates. Supports left/right click and double-click. ' +
        'Use take_screenshot first to determine the correct coordinates.',
      input_schema: {
        type: 'object' as const,
        properties: {
          x: {
            type: 'number',
            description: 'Screen X coordinate to click',
          },
          y: {
            type: 'number',
            description: 'Screen Y coordinate to click',
          },
          button: {
            type: 'string',
            enum: ['left', 'right'],
            description: "Mouse button to click (default: 'left')",
          },
          double: {
            type: 'boolean',
            description: 'Whether to double-click (default: false)',
          },
        },
        required: ['x', 'y'],
      },
    },
    execute: async (input) => {
      const x = Number(input['x']);
      const y = Number(input['y']);
      const button = input['button'] === 'right' ? 'right' as const : 'left' as const;
      const isDouble = input['double'] === true;

      if (isNaN(x) || isNaN(y)) {
        return 'Error: x and y must be valid numbers.';
      }

      try {
        if (isDouble) {
          await mouseDoubleClick(x, y);
          return `Double-clicked at (${x}, ${y})`;
        } else {
          await mouseClick(x, y, button);
          return `Clicked ${button} at (${x}, ${y})`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('computer_click failed', { x, y, button, double: isDouble, error: msg });
        return `Error clicking: ${msg}`;
      }
    },
  };
}

/**
 * Create the computer_type tool.
 * Types text into the currently active window.
 */
export function createTypeTool(): ToolHandler {
  return {
    definition: {
      name: 'computer_type',
      description:
        'Type text into the currently active window. Uses Windows SendKeys, so the target window must be focused first. ' +
        'Special characters are automatically escaped.',
      input_schema: {
        type: 'object' as const,
        properties: {
          text: {
            type: 'string',
            description: 'Text to type into the active window',
          },
        },
        required: ['text'],
      },
    },
    execute: async (input) => {
      const text = String(input['text']);

      if (!text) {
        return 'Error: text must not be empty.';
      }

      try {
        await typeText(text);
        return `Typed ${text.length} characters`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('computer_type failed', { textLength: text.length, error: msg });
        return `Error typing text: ${msg}`;
      }
    },
  };
}

/**
 * Create the computer_press_key tool.
 * Presses a key or key combination (e.g. "enter", "ctrl+c", "alt+tab").
 */
export function createPressKeyTool(): ToolHandler {
  return {
    definition: {
      name: 'computer_press_key',
      description:
        'Press a key or key combination. Single keys: "enter", "tab", "escape", "f5", "delete", "home", "end", etc. ' +
        'Key combos use + separator: "ctrl+c", "ctrl+v", "alt+tab", "ctrl+shift+s". ' +
        'Modifier keys: ctrl, alt, shift.',
      input_schema: {
        type: 'object' as const,
        properties: {
          key: {
            type: 'string',
            description: 'Key or key combination to press (e.g. "enter", "ctrl+c", "alt+tab")',
          },
        },
        required: ['key'],
      },
    },
    execute: async (input) => {
      const key = String(input['key']).trim();

      if (!key) {
        return 'Error: key must not be empty.';
      }

      try {
        // Check if this is a key combination (contains +)
        if (key.includes('+')) {
          const keys = key.split('+').map(k => k.trim());
          await keyCombo(keys);
          return `Pressed key combo: ${key}`;
        } else {
          await pressKey(key);
          return `Pressed key: ${key}`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('computer_press_key failed', { key, error: msg });
        return `Error pressing key: ${msg}`;
      }
    },
  };
}

/**
 * Create the list_windows tool.
 * Lists all visible windows with process name, title, and handle.
 */
export function createListWindowsTool(): ToolHandler {
  return {
    definition: {
      name: 'list_windows',
      description:
        'List all visible windows on the Windows desktop. Returns process name, window title, and handle for each window. ' +
        'Use this to find windows before focusing them.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    execute: async () => {
      try {
        const windows = await listWindows();

        if (windows.length === 0) {
          return 'No visible windows found.';
        }

        const lines = windows.map(
          (w) => `• ${w.processName}: "${w.title}" (handle: ${w.handle})`
        );

        return `Found ${windows.length} windows:\n${lines.join('\n')}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('list_windows failed', { error: msg });
        return `Error listing windows: ${msg}`;
      }
    },
  };
}

/**
 * Create the focus_window tool.
 * Brings a window to the foreground by partial title match.
 */
export function createFocusWindowTool(): ToolHandler {
  return {
    definition: {
      name: 'focus_window',
      description:
        'Bring a window to the foreground by matching part of its title. Case-insensitive partial match. ' +
        'Use list_windows first to see available windows.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: {
            type: 'string',
            description: 'Partial window title to match (case-insensitive)',
          },
        },
        required: ['title'],
      },
    },
    execute: async (input) => {
      const title = String(input['title']);

      if (!title) {
        return 'Error: title must not be empty.';
      }

      try {
        const focused = await focusWindow(title);

        if (focused) {
          return `Window matching "${title}" brought to foreground.`;
        } else {
          return `No window found matching "${title}". Use list_windows to see available windows.`;
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('focus_window failed', { title, error: msg });
        return `Error focusing window: ${msg}`;
      }
    },
  };
}

/**
 * Create the mouse_move tool.
 * Moves the mouse cursor without clicking.
 */
export function createMouseMoveTool(): ToolHandler {
  return {
    definition: {
      name: 'mouse_move',
      description:
        'Move the mouse cursor to specific screen coordinates without clicking. ' +
        'Useful for hovering over elements or positioning before other actions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          x: {
            type: 'number',
            description: 'Screen X coordinate to move to',
          },
          y: {
            type: 'number',
            description: 'Screen Y coordinate to move to',
          },
        },
        required: ['x', 'y'],
      },
    },
    execute: async (input) => {
      const x = Number(input['x']);
      const y = Number(input['y']);

      if (isNaN(x) || isNaN(y)) {
        return 'Error: x and y must be valid numbers.';
      }

      try {
        await mouseMove(x, y);
        return `Mouse moved to (${x}, ${y})`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('mouse_move failed', { x, y, error: msg });
        return `Error moving mouse: ${msg}`;
      }
    },
  };
}

/**
 * Create the mouse_scroll tool.
 * Scrolls the mouse wheel at specific coordinates.
 */
export function createMouseScrollTool(): ToolHandler {
  return {
    definition: {
      name: 'mouse_scroll',
      description:
        'Scroll the mouse wheel at specific screen coordinates. ' +
        'Positive amount scrolls up, negative scrolls down. 120 = one wheel click.',
      input_schema: {
        type: 'object' as const,
        properties: {
          x: {
            type: 'number',
            description: 'Screen X coordinate to scroll at',
          },
          y: {
            type: 'number',
            description: 'Screen Y coordinate to scroll at',
          },
          amount: {
            type: 'number',
            description: 'Scroll amount. Positive = up, negative = down. 120 = one click.',
          },
        },
        required: ['x', 'y', 'amount'],
      },
    },
    execute: async (input) => {
      const x = Number(input['x']);
      const y = Number(input['y']);
      const amount = Number(input['amount']);

      if (isNaN(x) || isNaN(y) || isNaN(amount)) {
        return 'Error: x, y, and amount must be valid numbers.';
      }

      try {
        await mouseScroll(x, y, amount);
        const direction = amount > 0 ? 'up' : 'down';
        return `Scrolled ${direction} (${Math.abs(amount)} units) at (${x}, ${y})`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error('mouse_scroll failed', { x, y, amount, error: msg });
        return `Error scrolling: ${msg}`;
      }
    },
  };
}
