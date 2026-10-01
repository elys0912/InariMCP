/**
 * Golden: tools/list as an MCP client sees it (names, descriptions, input
 * schemas, annotations).
 *
 * Regenerate (only when a change of the tool list is intended):
 *   UPDATE_GOLDEN=1 npx vitest run tests/contract/tools-list.test.ts
 *
 * tests/golden/tools-list-legacy.json: FOX_CAPS=legacy, the tools as they
 * were before the WP13 consolidation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../../packages/mcp-server/src/tools/registry.js';

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
  it('FOX_CAPS=legacy lists the pre-consolidation tools unchanged', async () => {
    const actual = await listTools('legacy');
    expect(actual).toEqual(golden('tools-list-legacy.json', actual));
  });

  it('FOX_CAPS=legacy,<profile> uses the pre-consolidation profiles', async () => {
    const names = (await listTools('legacy,wait')).map((t) => t.name);
    expect(names).toEqual([
      'fox_safety_status',
      'fox_wait_for_element',
      'fox_wait_for_navigation',
      'fox_wait_for_network_idle',
      'fox_wait_for_url',
    ]);
  });
});

// TODO(test): unknown profile names next to legacy; legacy combined with all.
