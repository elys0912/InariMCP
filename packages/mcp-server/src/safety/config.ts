import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { ENV, isRecord } from '@inari-mcp/shared';
import { isTruthyEnv, resolveFoxEnv } from '../utils/headless-env.js';
import { auditLogPath, defaultSafetyConfigPath } from '@inari-mcp/shared/node';

// `.strict()` on both objects: an unknown key (a typo such as `readonly` for
// `read_only`) is a config error, not silently dropped, since the setting
// the user meant to tighten would otherwise not apply.
const ContainerScopeSchema = z.object({
  enabled: z.boolean(),
  // An empty name is not a container: the Extension refuses such a scope
  // (config_error), so it is a config error here too, enabled or not.
  containerName: z.string().min(1),
}).strict();

export const SafetyConfigSchema = z.object({
  enabled: z.boolean(),
  readOnly: z.boolean(),
  allowPasswordTyping: z.boolean(),
  maxActionsPerMinute: z.number().int().min(0),
  auditLog: z.boolean(),
  blockedUrlPatterns: z.array(z.string()),
  allowedUrlPatterns: z.array(z.string()),
  confirmReadSites: z.array(z.string()),
  containerScope: ContainerScopeSchema,
}).strict();

export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export const DEFAULT_CONFIG: SafetyConfig = {
  enabled: true,
  readOnly: false,
  allowPasswordTyping: false,
  maxActionsPerMinute: 120,
  auditLog: true,
  blockedUrlPatterns: [],
  allowedUrlPatterns: [],
  // Sites where reading tools (and screenshots) also ask the human first.
  // Acting tools always ask, on every site. Host patterns as in the other
  // lists (safety/url-pattern.ts).
  confirmReadSites: [],
  containerScope: {
    enabled: false,
    containerName: 'Inari MCP Agent',
  },
} as const;

/** Key in safety.json (snake_case) for every schema key; a missing entry is a compile error. */
const FILE_KEYS: { readonly [K in keyof SafetyConfig]: string } = {
  enabled: 'enabled',
  readOnly: 'read_only',
  allowPasswordTyping: 'allow_password_typing',
  maxActionsPerMinute: 'max_actions_per_minute',
  auditLog: 'audit_log',
  blockedUrlPatterns: 'blocked_url_patterns',
  allowedUrlPatterns: 'allowed_url_patterns',
  confirmReadSites: 'confirm_read_sites',
  containerScope: 'container_scope',
};

const CONTAINER_FILE_KEYS: { readonly [K in keyof SafetyConfig['containerScope']]: string } = {
  enabled: 'enabled',
  containerName: 'container_name',
};

function invert(table: Readonly<Record<string, string>>): ReadonlyMap<string, string> {
  return new Map(Object.entries(table).map(([camel, snake]) => [snake, camel]));
}

const FROM_FILE_KEY = invert(FILE_KEYS);
const FROM_CONTAINER_FILE_KEY = invert(CONTAINER_FILE_KEYS);
const TO_FILE_KEY: ReadonlyMap<string, string> = new Map(Object.entries(FILE_KEYS));
const TO_CONTAINER_FILE_KEY: ReadonlyMap<string, string> = new Map(Object.entries(CONTAINER_FILE_KEYS));

/**
 * snake_case keys to the schema's camelCase. The camelCase spelling is
 * accepted as well; any other key is kept as written, so that the strict
 * schema reports it under the name the user wrote. (Object.fromEntries
 * defines own properties, so even a `__proto__` key stays a reported key.)
 */
function camelizeKeys(raw: Record<string, unknown>, keys: ReadonlyMap<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [keys.get(key) ?? key, value]));
}

function toFileKeys(config: SafetyConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(FILE_KEYS) as (keyof SafetyConfig)[]) {
    out[FILE_KEYS[key]] = key === 'containerScope'
      ? {
          [CONTAINER_FILE_KEYS.enabled]: config.containerScope.enabled,
          [CONTAINER_FILE_KEYS.containerName]: config.containerScope.containerName,
        }
      : config[key];
  }
  return out;
}

export type SafetyConfigResult = { ok: true; config: SafetyConfig } | { ok: false; error: string };

/**
 * Validate the parsed content of safety.json: keys missing from the file
 * (and from `container_scope`) take DEFAULT_CONFIG's value; an unknown key
 * or a wrong type is an error. Shared by loadConfig() and the doctor.
 */
export function parseSafetyConfig(raw: unknown): SafetyConfigResult {
  if (!isRecord(raw)) return { ok: false, error: 'safety.json must contain a JSON object' };
  const camelized = camelizeKeys(raw, FROM_FILE_KEY);
  const scope = camelized['containerScope'];
  const merged = {
    ...DEFAULT_CONFIG,
    ...camelized,
    // Only the keys written in the file: a partial container_scope keeps the
    // defaults for the rest.
    ...(isRecord(scope)
      ? { containerScope: { ...DEFAULT_CONFIG.containerScope, ...camelizeKeys(scope, FROM_CONTAINER_FILE_KEY) } }
      : {}),
  };
  const parsed = SafetyConfigSchema.safeParse(merged);
  if (parsed.success) return { ok: true, config: parsed.data };
  const issues = parsed.error.issues.map((i) => (i.path.length > 0 ? `${fileKeyPath(i.path)}: ${i.message}` : i.message));
  return { ok: false, error: issues.join('; ') };
}

/** A schema path as written in safety.json, e.g. `container_scope.container_name`. */
function fileKeyPath(issuePath: readonly (string | number)[]): string {
  return issuePath
    .map(String)
    .map((key, i) =>
      (i === 0 ? TO_FILE_KEY.get(key) : i === 1 && issuePath[0] === 'containerScope' ? TO_CONTAINER_FILE_KEY.get(key) : undefined) ?? key)
    .join('.');
}

/** Text of safety.json as JSON (a leading BOM, as some Windows editors write, is ignored). */
export function parseSafetyConfigText(text: string): SafetyConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    return { ok: false, error: `invalid JSON (${e instanceof Error ? e.message : String(e)})` };
  }
  return parseSafetyConfig(raw);
}

/** FOX_SAFETY_CONFIG when set and not blank, else ~/.inari-mcp/safety.json. */
export function safetyConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return resolveFoxEnv(env, ENV.FOX_SAFETY_CONFIG) ?? defaultSafetyConfigPath();
}

/** Mode of a config directory the daemon creates: the owner only. */
const PRIVATE_DIR_MODE = 0o700;

export function getAuditLogPath(): string {
  return auditLogPath();
}

/**
 * The loaded policy. `configError` is set when the config file exists but
 * cannot be used (unreadable, invalid JSON, schema violation); the
 * SafetyGuard then refuses every tool (fail-closed) instead of silently
 * running with DEFAULT_CONFIG.
 */
export type LoadedSafetyConfig = SafetyConfig & { configError?: string };

export function loadConfig(): LoadedSafetyConfig {
  const configPath = safetyConfigPath();
  let config: LoadedSafetyConfig = { ...DEFAULT_CONFIG };

  if (fs.existsSync(configPath)) {
    let result: SafetyConfigResult;
    try {
      result = parseSafetyConfigText(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
      result = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!result.ok) {
      process.stderr.write(
        `[InariMCP] WARNING: cannot use ${configPath} (${result.error}). ` +
        'The safety guard refuses every tool until the file is fixed and the daemon restarted.\n',
      );
      return { ...DEFAULT_CONFIG, configError: `${configPath}: ${result.error}` };
    }
    config = result.config;
  } else {
    // No config yet: write the defaults. Failing to write them is not a
    // policy problem, so the defaults stay in force.
    try {
      fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: PRIVATE_DIR_MODE });
      fs.writeFileSync(configPath, JSON.stringify(toFileKeys(DEFAULT_CONFIG), null, 2) + '\n');
      process.stderr.write(`[InariMCP] Wrote default safety config to ${configPath}\n`);
    } catch (e) {
      process.stderr.write(
        `[InariMCP] Failed to write default ${configPath}, using defaults: ` +
        `${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  // It only tightens the policy, so the values beyond 1 (true, yes) are safe to accept.
  if (isTruthyEnv(resolveFoxEnv(process.env, ENV.FOX_READ_ONLY))) {
    config = { ...config, readOnly: true };
  }

  return config;
}
