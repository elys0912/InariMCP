import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadOrCreateApiToken, readApiTokenFile } from '@kitsune-mcp/shared/node';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-token-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('shared/node token', () => {
  it('creates a 64-char hex token when the file is missing, then reads the same one back', () => {
    const tokenPath = path.join(dir, 'api_token');
    const token = loadOrCreateApiToken(tokenPath);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(readApiTokenFile(tokenPath)).toBe(token);
    expect(loadOrCreateApiToken(tokenPath)).toBe(token);
  });

  it('an existing file that stays empty is not overwritten: the daemon throws instead', () => {
    const tokenPath = path.join(dir, 'api_token');
    fs.writeFileSync(tokenPath, '');
    expect(() => loadOrCreateApiToken(tokenPath)).toThrow(/exists but is empty/);
    expect(fs.readFileSync(tokenPath, 'utf-8')).toBe('');
  });

  it('an unreadable token path (a directory) throws for the daemon, reads as "no token" for the others', () => {
    const tokenPath = path.join(dir, 'api_token');
    fs.mkdirSync(tokenPath);
    expect(readApiTokenFile(tokenPath)).toBeUndefined();
    expect(() => loadOrCreateApiToken(tokenPath)).toThrow(expect.objectContaining({ code: 'EISDIR' }));
    expect(fs.statSync(tokenPath).isDirectory()).toBe(true);
  });
});
