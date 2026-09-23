import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAuditLogPath } from './config.js';
import { maskSensitiveArgs } from './sanitizer.js';

export type AuditDecision =
  | 'allowed'
  | 'allowed_by_human'
  | 'denied'
  | 'rate_limited'
  | 'blocked_scheme'
  | 'blocked_url'
  | 'not_allowlisted'
  | 'read_only'
  | 'scripts_disabled'
  | 'confirmation_required'
  | 'observed_on_protected_domain'
  | 'out_of_scope';

export interface AuditEntry {
  ts: string;
  tool: string;
  decision: AuditDecision;
  url: string | null;
  transport: string | null;
  args: Record<string, unknown>;
}

export function audit(
  toolName: string,
  args: Record<string, unknown>,
  targetUrl: string | null,
  decision: AuditDecision,
  transport?: string,
): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    tool: toolName,
    decision,
    url: targetUrl,
    transport: transport ?? null,
    args: maskSensitiveArgs(args),
  };

  const logPath = getAuditLogPath();

  try {
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    process.stderr.write(
      `[KitsuneMCP] Failed to write audit log: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}
