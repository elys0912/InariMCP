/**
 * Contract: FOX_READ_ONLY (1 / true / yes) and FOX_ALLOW_SCRIPTS (0 / false /
 * no / off), read by safety/config.ts, reach the tool handlers: the guard
 * singleton is built from them, whatever safety.json says. Each case loads the modules afresh (vi.resetModules),
 * since the guard reads its config once per process. Which spellings count
 * (case, spaces, other values) is checked on loadConfig in
 * packages/mcp-server/tests/settings-normalize.test.ts.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

let tmpDir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = ['FOX_SAFETY_CONFIG', 'FOX_READ_ONLY', 'FOX_ALLOW_SCRIPTS'];

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inari-env-'));
  const configPath = path.join(tmpDir, 'safety.json');
  // safety.json allows everything; only the environment restricts.
  fs.writeFileSync(configPath, JSON.stringify({
    audit_log: false, max_actions_per_minute: 0, read_only: false, allow_script_execution: true,
  }));
  process.env['FOX_SAFETY_CONFIG'] = configPath;
  vi.resetModules();
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function call(tool: string, args: Record<string, unknown>): Promise<{ decision: unknown; text: string }> {
  const { createToolHandler } = await import('../../packages/mcp-server/src/tools/handlers.js');
  const result: CallToolResult = await createToolHandler(tool)(args);
  const blocks = result.content.flatMap((b) => (b.type === 'text' ? [b.text] : []));
  let decision: unknown = null;
  for (const b of blocks) {
    try { decision = (JSON.parse(b) as Record<string, unknown>)['decision'] ?? decision; } catch { /* text block */ }
  }
  return { decision, text: blocks.join('\n') };
}

async function status(): Promise<Record<string, unknown>> {
  const { createToolHandler } = await import('../../packages/mcp-server/src/tools/handlers.js');
  const result = await createToolHandler('fox_safety_status')({});
  const block = result.content[0];
  return JSON.parse(block && block.type === 'text' ? block.text : '{}') as Record<string, unknown>;
}

describe('environment overrides through the handler path', () => {
  it('FOX_READ_ONLY=1 refuses acting tools, public and earlier names alike', async () => {
    process.env['FOX_READ_ONLY'] = '1';
    expect(await status()).toMatchObject({ readOnly: true });
    expect((await call('fox_click', { selector: '#a' })).decision).toBe('read_only');
    expect((await call('fox_tab', { action: 'close', tabId: 1 })).decision).toBe('read_only');
    expect((await call('fox_close_tab', { tabId: 1 })).decision).toBe('read_only');
    expect((await call('fox_evaluate', { mode: 'script', script: '1' })).text).toMatch(/^fox_evaluate refused: safety guard is in read-only mode/);
  });

  it('FOX_ALLOW_SCRIPTS=0 refuses the script tools only', async () => {
    process.env['FOX_ALLOW_SCRIPTS'] = '0';
    expect(await status()).toMatchObject({ readOnly: false });
    expect((await call('fox_evaluate', { mode: 'script', script: '1' })).decision).toBe('scripts_disabled');
    expect((await call('fox_observer', { action: 'remove', observerId: 'o' })).decision).toBe('scripts_disabled');
    expect((await call('fox_execute_script', { script: '1' })).decision).toBe('scripts_disabled');
    // Not a script tool: refused later for another reason (no browser), not by the guard.
    expect((await call('fox_click', { selector: '#a' })).decision).toBeNull();
  });
});
