/**
 * Golden: tools/list as an MCP client sees it (names, descriptions, input
 * schemas, annotations).
 *
 * Regenerate (only when a change of the tool list is intended):
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tools-list.test.ts
 *
 * tests/golden/tools-list.json: the default list, the 17 public tools
 * (tools/public-tools.ts).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PROFILE_NAMES, registerTools } from '../../packages/mcp-server/src/tools/registry.js';
import { PUBLIC_TOOLS } from '../../packages/mcp-server/src/tools/public-tools.js';

const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const GOLDEN_DIR = fileURLToPath(new URL('../golden/', import.meta.url));

interface ListedTool {
  name: string;
  description?: string;
  inputSchema: unknown;
  annotations?: unknown;
}

export async function listTools(caps: string): Promise<ListedTool[]> {
  const server = new McpServer({ name: 'golden', version: '0' });
  registerTools(server, () => async () => ({ content: [] }), caps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'golden', version: '0' });
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools
    .map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function golden(name: string, actual: unknown): unknown {
  const file = path.join(GOLDEN_DIR, name);
  if (UPDATE) fs.writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

describe('tools/list', () => {
  it('lists the public tools by default', async () => {
    const actual = await listTools('');
    expect(actual.map((t) => t.name).sort()).toEqual(Object.keys(PUBLIC_TOOLS).sort());
    expect(actual).toEqual(golden('tools-list.json', actual));
    for (const tool of actual) {
      expect((tool.inputSchema as { type?: string }).type, tool.name).toBe('object');
    }
  });

  it('every public tool is in a FOX_CAPS profile', async () => {
    const names = new Set((await listTools(PROFILE_NAMES.join(','))).map((t) => t.name));
    expect([...names].sort()).toEqual(Object.keys(PUBLIC_TOOLS).sort());
  });
});

describe('FOX_CAPS boundaries', () => {
  const names = async (caps: string) => (await listTools(caps)).map((t) => t.name);

  it('all with a profile lists every public tool', async () => {
    expect(await names('all,core')).toEqual(Object.keys(PUBLIC_TOOLS).sort());
  });

  it('an unknown profile is ignored with a warning', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await names('nope')).toEqual(['fox_safety_status']);
      expect(await names('nope,human')).toEqual(['fox_detect_captcha', 'fox_request_approval', 'fox_safety_status']);
      const warnings = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((t) => t.includes("Unknown FOX_CAPS profile: 'nope'"));
      expect(warnings).toHaveLength(2);
    } finally {
      stderr.mockRestore();
    }
  });

  // InariMCP removed the script and logging tools, the earlier tool names
  // (`legacy`) and the empty workflow profile, and their profiles with them.
  it('logs, script, legacy and workflow are no profiles', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      expect(await names('logs,script')).toEqual(['fox_safety_status']);
      expect(await names('legacy,workflow')).toEqual(['fox_safety_status']);
      const warnings = stderr.mock.calls.map(([chunk]) => String(chunk)).filter((t) => t.includes('Unknown FOX_CAPS profile'));
      expect(warnings).toHaveLength(4);
    } finally {
      stderr.mockRestore();
    }
  });

  it('segments are trimmed and compared case-insensitively', async () => {
    expect(await names(' Human , WAIT ')).toEqual(await names('human,wait'));
    expect(await names(' , ')).toEqual(Object.keys(PUBLIC_TOOLS).sort());
  });

  it('fox_safety_status is marked as closed-world', async () => {
    const status = (await listTools('')).find((t) => t.name === 'fox_safety_status');
    expect(status?.annotations).toMatchObject({ openWorldHint: false });
  });
});
