/**
 * Computer control module — screenshot, mouse, keyboard, and window management.
 * Uses PowerShell interop via child_process.execFile for Windows desktop control from WSL.
 *
 * All functions write PowerShell scripts to temp files and execute them,
 * cleaning up after execution. This avoids shell injection risks.
 */

import { execFile } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { logger } from '../utils/logger.js';

/** Path to PowerShell executable accessible from WSL. */
const PS = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

/** Directory where screenshots are saved (Windows path accessible from WSL). */
const SCREENSHOT_DIR = join(process.cwd(), 'data', 'screenshots');

/** Default timeout for PowerShell execution in milliseconds. */
const PS_TIMEOUT_MS = 30_000;

/** Result of a PowerShell execution. */
interface PsExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Window info returned by listWindows. */
export interface WindowInfo {
  processName: string;
  title: string;
  handle: string;
}

/** Screenshot region specification. */
export interface ScreenshotRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screenshot options. */
export interface ScreenshotOptions {
  monitor?: number;
  region?: ScreenshotRegion;
}

/**
 * Execute a PowerShell script by writing it to a temp file and running it.
 * Cleans up the temp file after execution completes.
 */
async function runPowerShell(script: string, timeoutMs: number = PS_TIMEOUT_MS): Promise<PsExecResult> {
  // Check PowerShell availability
  if (!existsSync(PS)) {
    throw new Error(`PowerShell not found at ${PS}. Windows interop may not be available.`);
  }

  // Write script to temp file
  const tempId = randomBytes(8).toString('hex');
  const tempPath = join(tmpdir(), `river-ps-${tempId}.ps1`);

  writeFileSync(tempPath, script, 'utf-8');

  try {
    const result = await new Promise<PsExecResult>((resolve, reject) => {
      execFile(
        PS,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tempPath],
        { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error && !('code' in error)) {
            reject(error);
            return;
          }

          const exitCode = error && 'code' in error
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : 0;

          resolve({
            stdout: typeof stdout === 'string' ? stdout.trim() : '',
            stderr: typeof stderr === 'string' ? stderr.trim() : '',
            exitCode: typeof exitCode === 'number' ? exitCode : 1,
          });
        }
      );
    });

    return result;
  } finally {
    // Clean up temp file
    try {
      unlinkSync(tempPath);
    } catch {
      logger.debug('Failed to clean up temp PS1 file', { path: tempPath });
    }
  }
}

/**
 * Convert a WSL path to a Windows path for use in PowerShell scripts.
 * e.g. /mnt/c/foo/bar -> C:\foo\bar
 */
function toWindowsPath(wslPath: string): string {
  const match = wslPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) {
    return wslPath;
  }
  const drive = match[1]!.toUpperCase();
  const rest = match[2]!.replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

/**
 * Capture a screenshot of the screen and save to file.
 * Returns the WSL path to the saved screenshot PNG.
 *
 * @param options - Optional monitor index or region to capture
 * @returns WSL file path to the saved screenshot
 */
export async function screenshot(options?: ScreenshotOptions): Promise<string> {
  // Ensure screenshot directory exists
  if (!existsSync(SCREENSHOT_DIR)) {
    mkdirSync(SCREENSHOT_DIR, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `screenshot-${timestamp}.png`;
  const wslPath = join(SCREENSHOT_DIR, filename);
  const winPath = toWindowsPath(wslPath);

  let script: string;

  if (options?.region) {
    const { x, y, w, h } = options.region;
    script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bitmap = New-Object System.Drawing.Bitmap(${w}, ${h})
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen(${x}, ${y}, 0, 0, (New-Object System.Drawing.Size(${w}, ${h})))
$bitmap.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output '${wslPath}'
`;
  } else {
    // Full screen capture (all monitors or specific monitor)
    const monitorFilter = typeof options?.monitor === 'number'
      ? `| Where-Object { $_.DeviceName -eq ("\\\\.\\DISPLAY${options.monitor}") }`
      : '';

    script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$screens = [System.Windows.Forms.Screen]::AllScreens ${monitorFilter}
if ($screens.Count -eq 0) {
    Write-Error "No screens found"
    exit 1
}

# Calculate bounding rectangle across all selected screens
$left = ($screens | ForEach-Object { $_.Bounds.Left } | Measure-Object -Minimum).Minimum
$top = ($screens | ForEach-Object { $_.Bounds.Top } | Measure-Object -Minimum).Minimum
$right = ($screens | ForEach-Object { $_.Bounds.Right } | Measure-Object -Maximum).Maximum
$bottom = ($screens | ForEach-Object { $_.Bounds.Bottom } | Measure-Object -Maximum).Maximum

$width = $right - $left
$height = $bottom - $top

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($left, $top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
$bitmap.Save('${winPath}', [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bitmap.Dispose()
Write-Output '${wslPath}'
`;
  }

  const result = await runPowerShell(script);

  if (result.stderr) {
    logger.warn('Screenshot captured with warnings', { stderr: result.stderr });
  }

  // Verify the file was created
  if (!existsSync(wslPath)) {
    throw new Error(`Screenshot file was not created at ${wslPath}. stderr: ${result.stderr}`);
  }

  logger.info('Screenshot captured', { path: wslPath });
  return wslPath;
}

/**
 * Move the mouse cursor to absolute screen coordinates.
 *
 * @param x - Screen X coordinate
 * @param y - Screen Y coordinate
 */
export async function mouseMove(x: number, y: number): Promise<void> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseControl {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
}
"@
[MouseControl]::SetCursorPos(${x}, ${y}) | Out-Null
Write-Output "Moved to ${x},${y}"
`;

  const result = await runPowerShell(script);
  if (result.stderr) {
    throw new Error(`mouseMove failed: ${result.stderr}`);
  }
}

/**
 * Click at absolute screen coordinates.
 *
 * @param x - Screen X coordinate
 * @param y - Screen Y coordinate
 * @param button - Mouse button: 'left' (default) or 'right'
 */
export async function mouseClick(x: number, y: number, button: 'left' | 'right' = 'left'): Promise<void> {
  const downFlag = button === 'right' ? '0x0008' : '0x0002';
  const upFlag = button === 'right' ? '0x0010' : '0x0004';

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseClick {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
}
"@
[MouseClick]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 50
[MouseClick]::mouse_event(${downFlag}, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MouseClick]::mouse_event(${upFlag}, 0, 0, 0, [IntPtr]::Zero)
Write-Output "Clicked ${button} at ${x},${y}"
`;

  const result = await runPowerShell(script);
  if (result.stderr) {
    throw new Error(`mouseClick failed: ${result.stderr}`);
  }
}

/**
 * Double-click at absolute screen coordinates.
 *
 * @param x - Screen X coordinate
 * @param y - Screen Y coordinate
 */
export async function mouseDoubleClick(x: number, y: number): Promise<void> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseDblClick {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
}
"@
[MouseDblClick]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 50
[MouseDblClick]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MouseDblClick]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 80
[MouseDblClick]::mouse_event(0x0002, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 30
[MouseDblClick]::mouse_event(0x0004, 0, 0, 0, [IntPtr]::Zero)
Write-Output "Double-clicked at ${x},${y}"
`;

  const result = await runPowerShell(script);
  if (result.stderr) {
    throw new Error(`mouseDoubleClick failed: ${result.stderr}`);
  }
}

/**
 * Scroll the mouse wheel at absolute screen coordinates.
 * Positive amount scrolls up, negative scrolls down.
 *
 * @param x - Screen X coordinate
 * @param y - Screen Y coordinate
 * @param amount - Scroll amount (positive=up, negative=down). 120 = one click.
 */
export async function mouseScroll(x: number, y: number, amount: number): Promise<void> {
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class MouseScroll {
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, int dx, int dy, uint dwData, IntPtr dwExtraInfo);
}
"@
[MouseScroll]::SetCursorPos(${x}, ${y}) | Out-Null
Start-Sleep -Milliseconds 50
[MouseScroll]::mouse_event(0x0800, 0, 0, ${amount}, [IntPtr]::Zero)
Write-Output "Scrolled ${amount} at ${x},${y}"
`;

  const result = await runPowerShell(script);
  if (result.stderr) {
    throw new Error(`mouseScroll failed: ${result.stderr}`);
  }
}

/**
 * Type text into the currently focused window using SendKeys.
 * Handles special characters that need escaping for SendKeys.
 *
 * @param text - Text to type
 */
export async function typeText(text: string): Promise<void> {
  // Escape text for PowerShell string literal (single quotes)
  const escapedForPs = text.replace(/'/g, "''");

  const script = `
Add-Type -AssemblyName System.Windows.Forms
# SendKeys special chars: +^%~(){}[] need escaping with braces
$text = '${escapedForPs}'
$escaped = $text -replace '([+^%~(){}\\[\\]])', '{$1}'
[System.Windows.Forms.SendKeys]::SendWait($escaped)
Write-Output "Typed text"
`;

  const result = await runPowerShell(script);
  if (result.stderr) {
    throw new Error(`typeText failed: ${result.stderr}`);
  }
}

/**
 * Map of common key names to SendKeys format.
 */
const KEY_MAP: Record<string, string> = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  escape: '{ESC}',
  esc: '{ESC}',
  backspace: '{BACKSPACE}',
  delete: '{DELETE}',
  del: '{DELETE}',
  insert: '{INSERT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  f1: '{F1}',
  f2: '{F2}',
  f3: '{F3}',
  f4: '{F4}',
  f5: '{F5}',
  f6: '{F6}',
  f7: '{F7}',
  f8: '{F8}',
  f9: '{F9}',
  f10: '{F10}',
  f11: '{F11}',
  f12: '{F12}',
  space: ' ',
  capslock: '{CAPSLOCK}',
  numlock: '{NUMLOCK}',
  scrolllock: '{SCROLLLOCK}',
  printscreen: '{PRTSC}',
};

/**
 * Press a single key (e.g. "enter", "tab", "escape", "f5").
 *
 * @param key - Key name to press
 */
export async function pressKey(key: string): Promise<void> {
  const normalized = key.toLowerCase().trim();
  const sendKey = KEY_MAP[normalized] ?? `{${key.toUpperCase()}}`;

  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${sendKey}')
Write-Output "Pressed ${key}"
`;

  const result = await runPowerShell(script);
  if (result.stderr) {
    throw new Error(`pressKey failed: ${result.stderr}`);
  }
}

/**
 * Press a key combination (e.g. ["ctrl", "c"], ["alt", "tab"], ["ctrl", "shift", "s"]).
 * Modifier keys: ctrl (+), alt (%), shift (^) in SendKeys notation.
 *
 * @param keys - Array of key names, modifiers first
 */
export async function keyCombo(keys: string[]): Promise<void> {
  if (keys.length === 0) {
    throw new Error('keyCombo requires at least one key');
  }

  // Separate modifiers from the final key
  const modifiers: string[] = [];
  let finalKey = '';

  for (const key of keys) {
    const lower = key.toLowerCase().trim();
    switch (lower) {
      case 'ctrl':
      case 'control':
        modifiers.push('^');
        break;
      case 'alt':
        modifiers.push('%');
        break;
      case 'shift':
        modifiers.push('+');
        break;
      default:
        finalKey = lower;
    }
  }

  if (!finalKey) {
    throw new Error('keyCombo requires a non-modifier key');
  }

  // Build the SendKeys string
  const modStr = modifiers.join('');
  const keyStr = KEY_MAP[finalKey] ?? finalKey;
  const combo = `${modStr}(${keyStr})`;

  const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait('${combo}')
Write-Output "Pressed combo: ${keys.join('+')}"
`;

  const result = await runPowerShell(script);
  if (result.stderr) {
    throw new Error(`keyCombo failed: ${result.stderr}`);
  }
}

/**
 * List all visible windows with their process name, title, and handle.
 *
 * @returns Array of window information objects
 */
export async function listWindows(): Promise<WindowInfo[]> {
  const script = `
Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | ForEach-Object {
    [PSCustomObject]@{
        ProcessName = $_.ProcessName
        Title = $_.MainWindowTitle
        Handle = $_.MainWindowHandle.ToString()
    }
} | ConvertTo-Json -Compress
`;

  const result = await runPowerShell(script);

  if (!result.stdout) {
    return [];
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout);

    // PowerShell returns a single object (not array) when there's only one result
    const items = Array.isArray(parsed) ? parsed : [parsed];

    return items.map((item: unknown) => {
      const obj = item as Record<string, unknown>;
      return {
        processName: String(obj['ProcessName'] ?? ''),
        title: String(obj['Title'] ?? ''),
        handle: String(obj['Handle'] ?? ''),
      };
    });
  } catch (err) {
    logger.error('Failed to parse window list', {
      stdout: result.stdout.substring(0, 500),
      error: err instanceof Error ? err.message : String(err),
    });
    throw new Error(`Failed to parse window list: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Bring a window to the foreground by partial title match.
 *
 * @param title - Partial window title to match (case-insensitive)
 * @returns true if window was found and focused, false otherwise
 */
export async function focusWindow(title: string): Promise<boolean> {
  // Escape single quotes for PowerShell
  const escapedTitle = title.replace(/'/g, "''");

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WindowFocus {
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@

$procs = Get-Process | Where-Object {
    $_.MainWindowTitle -like '*${escapedTitle}*' -and $_.MainWindowHandle -ne [IntPtr]::Zero
}

if ($procs) {
    $proc = $procs | Select-Object -First 1
    # SW_RESTORE = 9 (restore if minimized)
    [WindowFocus]::ShowWindow($proc.MainWindowHandle, 9) | Out-Null
    Start-Sleep -Milliseconds 100
    [WindowFocus]::SetForegroundWindow($proc.MainWindowHandle) | Out-Null
    Write-Output "FOCUSED:$($proc.MainWindowTitle)"
} else {
    Write-Output "NOT_FOUND"
}
`;

  const result = await runPowerShell(script);

  if (result.stdout.startsWith('FOCUSED:')) {
    const focusedTitle = result.stdout.substring('FOCUSED:'.length);
    logger.info('Window focused', { requested: title, focused: focusedTitle });
    return true;
  }

  logger.info('Window not found', { title });
  return false;
}
