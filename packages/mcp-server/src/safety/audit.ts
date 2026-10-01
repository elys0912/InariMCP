import * as fs from 'node:fs';
import * as path from 'node:path';
import { getAuditLogPath } from './config.js';
import { maskSensitiveArgs } from './sanitizer.js';
import { rotateIfLarge } from '../utils/log-file.js';

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
  | 'out_of_scope'
  /** A human approved / declined a protected-site action (tools/approval-flow.ts). */
  | 'approval_granted'
  | 'approval_denied'
  | 'invalid_url'
  | 'blocked_after_navigation'
  | 'config_error';

export interface AuditEntry {
  ts: string;
  tool: string;
  decision: AuditDecision;
  url: string | null;
  transport: string | null;
  args: Record<string, unknown>;
  /** The deprecated tool name the call was made with (WP13 legacy aliases). */
  legacyTool?: string;
}

export function audit(
  toolName: string,
  args: Record<string, unknown>,
  targetUrl: string | null,
  decision: AuditDecision,
  transport?: string,
  legacyTool?: string,
): void {
  const entry: AuditEntry = {
    ts: new Date().toISOString(),
    tool: toolName,
    decision,
    url: targetUrl,
    transport: transport ?? null,
    args: maskSensitiveArgs(args),
    ...(legacyTool !== undefined ? { legacyTool } : {}),
  };

  const logPath = getAuditLogPath();

  try {
    const dir = path.dirname(logPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    rotateIfLarge(logPath);
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (e) {
    process.stderr.write(
      `[KitsuneMCP] Failed to write audit log: ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
}
