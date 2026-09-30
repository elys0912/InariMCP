/**
 * Human approval for protected-site actions (guard Layer 7).
 *
 * When the guard (or the Extension) answers `confirmation_required`, the
 * daemon opens an approval *request* bound to a target:
 *
 *   target = tool name + hostname of the protected URL + hash of the
 *            tool arguments (canonical JSON, SHA-256)
 *
 * A human decision obtained outside the page — MCP elicitation answered in
 * the MCP client, or the KitsuneMCP toolbar popup in Firefox — turns that
 * request into a one-time *token*. The retried tool call presents the token
 * (out of band: `approvalToken` in the POST /mcp/call body, never a tool
 * argument), the handler consumes it, and the guard lets exactly that call
 * through (`allowed_by_human`).
 *
 *   request: expires REQUEST_TTL_MS after creation; one token at most.
 *   token:   `kat_` + 32 random bytes (base64url); stored only as its
 *            SHA-256; expires TOKEN_TTL_MS after issue; consumed by the
 *            first presentation, whether or not the target matches.
 *
 * Nothing in the page or in the LLM's own tool calls can create a token:
 * tokens are issued only by the daemon's approval endpoints
 * (tools/approval-flow.ts), after an answer from the MCP client's
 * elicitation or from the Extension's popup.
 */

import * as crypto from 'node:crypto';
import { ENV, ENV_DEFAULTS } from '@kitsune-mcp/shared';
import type { SafetyDenial } from './guard.js';

/**
 * FOX_APPROVAL_ELICITATION: `0` / `false` / `off` / `no` (any case) turn
 * elicitation approvals off (the relay always asks in the Extension's popup,
 * the daemon refuses POST /approval/elicitation); any other non-empty value
 * turns them on; unset or empty means ENV_DEFAULTS.FOX_APPROVAL_ELICITATION.
 *
 * Accepted risk while on: elicitation answers reach the daemon over local
 * HTTP, so a process holding the API token can approve its own requests.
 */
export function isElicitationApprovalEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[ENV.FOX_APPROVAL_ELICITATION] ?? '').trim().toLowerCase();
  if (raw === '') return ENV_DEFAULTS.FOX_APPROVAL_ELICITATION;
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/** How long a human has to answer an approval request. */
export const REQUEST_TTL_MS = 120_000;
/** How long an issued token stays valid (the relay retries at once). */
export const TOKEN_TTL_MS = 60_000;
/** Upper bound of open requests; the oldest is dropped beyond it. */
export const MAX_PENDING_REQUESTS = 32;

const TOKEN_PREFIX = 'kat_';

export type ApprovalChannel = 'elicitation' | 'browser';

/** What an approval applies to. */
export interface ApprovalTarget {
  toolName: string;
  /** Lower-case hostname of the protected URL. */
  host: string;
  /** SHA-256 (hex) of the canonical JSON of the tool arguments. */
  argsHash: string;
}

export interface ApprovalRequest {
  id: string;
  target: ApprovalTarget;
  protectedUrl: string;
  matchedPattern: string;
  /** Human-readable argument summary (what the human is asked to approve). */
  summary: string;
  createdAt: number;
  expiresAt: number;
}

/** A consumed token: the call it was issued for. */
export interface ApprovalGrant {
  target: ApprovalTarget;
  via: ApprovalChannel;
  requestId: string;
}

interface StoredToken extends ApprovalGrant {
  expiresAt: number;
}

// ---------------------------------------------------------------------------
// Target helpers
// ---------------------------------------------------------------------------

/** Lower-case hostname of an absolute URL, or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (typeof url !== 'string' || url === '') return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === '' ? null : host;
  } catch {
    return null;
  }
}

/** JSON with object keys sorted at every level (stable across key order). */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export function hashArgs(args: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(canonicalJson(args)).digest('hex');
}

const SUMMARY_VALUE_MAX = 160;
const SUMMARY_MAX = 800;
const SUMMARY_MASKED_KEYS: ReadonlySet<string> = new Set(['password']);

/**
 * One line per argument, for the human who decides. Values are shown (the
 * human must see what is typed / run), long strings are cut.
 */
export function summarizeArgs(args: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const key of Object.keys(args).sort()) {
    const raw = args[key];
    if (raw === undefined) continue;
    let text = SUMMARY_MASKED_KEYS.has(key)
      ? '***'
      : typeof raw === 'string' ? JSON.stringify(raw) : canonicalJson(raw);
    if (text.length > SUMMARY_VALUE_MAX) text = `${text.slice(0, SUMMARY_VALUE_MAX)}…`;
    lines.push(`${key}: ${text}`);
  }
  const summary = lines.join('\n');
  return summary.length > SUMMARY_MAX ? `${summary.slice(0, SUMMARY_MAX)}…` : (summary || '(no arguments)');
}

/** Target of a confirmation_required answer, or null when its URL has no host. */
export function approvalTargetFor(
  toolName: string,
  args: Record<string, unknown>,
  protectedUrl: string,
): ApprovalTarget | null {
  const host = hostOf(protectedUrl);
  if (host === null) return null;
  return { toolName, host, argsHash: hashArgs(args) };
}

/**
 * Whether a consumed grant lifts this guard denial: only a
 * `confirmation_required` denial, and only for the host the human approved.
 * Every other denial (read-only, blocklist, rate limit, …) stands.
 */
export function grantCoversDenial(
  denial: SafetyDenial | null,
  grant: ApprovalGrant | null | undefined,
): boolean {
  if (!grant || denial === null) return false;
  if (denial.safetyDecision !== 'confirmation_required') return false;
  return hostOf(denial.elicitation?.protectedUrl) === grant.target.host;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export interface ApprovalStoreOptions {
  now?: () => number;
  requestTtlMs?: number;
  tokenTtlMs?: number;
  maxPending?: number;
}

function digest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export class ApprovalStore {
  private readonly now: () => number;
  private readonly requestTtlMs: number;
  private readonly tokenTtlMs: number;
  private readonly maxPending: number;
  private readonly requests = new Map<string, ApprovalRequest>();
  /** SHA-256(token) → grant. */
  private readonly tokens = new Map<string, StoredToken>();

  constructor(options: ApprovalStoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.requestTtlMs = options.requestTtlMs ?? REQUEST_TTL_MS;
    this.tokenTtlMs = options.tokenTtlMs ?? TOKEN_TTL_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_REQUESTS;
  }

  /** Open a request for a human decision on `target`. */
  createRequest(
    target: ApprovalTarget,
    info: { protectedUrl: string; matchedPattern: string; summary: string },
  ): ApprovalRequest {
    this.prune();
    while (this.requests.size >= this.maxPending) {
      const oldest = this.requests.keys().next().value;
      if (oldest === undefined) break;
      this.requests.delete(oldest);
    }
    const createdAt = this.now();
    const request: ApprovalRequest = {
      id: crypto.randomUUID(),
      target: { ...target },
      protectedUrl: info.protectedUrl,
      matchedPattern: info.matchedPattern,
      summary: info.summary,
      createdAt,
      expiresAt: createdAt + this.requestTtlMs,
    };
    this.requests.set(request.id, request);
    return request;
  }

  /** An open, unexpired request. */
  getRequest(id: string): ApprovalRequest | undefined {
    this.prune();
    return this.requests.get(id);
  }

  /** The human declined (or the channel gave up): close the request. */
  closeRequest(id: string): void {
    this.requests.delete(id);
  }

  /**
   * The human approved request `id`: close it and issue its one token.
   * Null when the request is unknown, expired or already used.
   */
  issueToken(id: string, via: ApprovalChannel): { token: string; expiresAt: number } | null {
    const request = this.getRequest(id);
    if (!request) return null;
    this.requests.delete(id);
    const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
    const expiresAt = this.now() + this.tokenTtlMs;
    this.tokens.set(digest(token), { target: { ...request.target }, via, requestId: id, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Consume a presented token. The token is removed on every presentation
   * (single use); the grant is returned only when it is unexpired and was
   * issued for this tool and these exact arguments. The host is checked by
   * the guard (grantCoversDenial) and by the Extension (approvedHost).
   */
  consume(token: string, toolName: string, argsHash: string): ApprovalGrant | null {
    this.prune();
    if (typeof token !== 'string' || !token.startsWith(TOKEN_PREFIX)) return null;
    const key = digest(token);
    const stored = this.tokens.get(key);
    if (!stored) return null;
    this.tokens.delete(key);
    if (stored.expiresAt <= this.now()) return null;
    if (stored.target.toolName !== toolName || stored.target.argsHash !== argsHash) return null;
    return { target: stored.target, via: stored.via, requestId: stored.requestId };
  }

  get pendingCount(): number {
    this.prune();
    return this.requests.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, request] of this.requests) {
      if (request.expiresAt <= now) this.requests.delete(id);
    }
    for (const [key, stored] of this.tokens) {
      if (stored.expiresAt <= now) this.tokens.delete(key);
    }
  }
}

let store: ApprovalStore | null = null;

export function getApprovalStore(): ApprovalStore {
  if (store === null) store = new ApprovalStore();
  return store;
}
