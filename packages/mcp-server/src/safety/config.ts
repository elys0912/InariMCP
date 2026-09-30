import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { z } from 'zod';
import { ENV, LEGACY_ENV } from '@kitsune-mcp/shared';

const ContainerScopeSchema = z.object({
  enabled: z.boolean(),
  containerName: z.string(),
});

export const SafetyConfigSchema = z.object({
  enabled: z.boolean(),
  readOnly: z.boolean(),
  allowScriptExecution: z.boolean(),
  confirmProtectedActions: z.boolean(),
  allowPasswordTyping: z.boolean(),
  maxActionsPerMinute: z.number().int().min(0),
  auditLog: z.boolean(),
  blockedUrlPatterns: z.array(z.string()),
  allowedUrlPatterns: z.array(z.string()),
  protectedUrlPatterns: z.array(z.string()),
  containerScope: ContainerScopeSchema,
});

export type SafetyConfig = z.infer<typeof SafetyConfigSchema>;

export const DEFAULT_CONFIG: SafetyConfig = {
  enabled: true,
  readOnly: false,
  allowScriptExecution: true,
  confirmProtectedActions: true,
  allowPasswordTyping: false,
  maxActionsPerMinute: 120,
  auditLog: true,
  blockedUrlPatterns: [],
  allowedUrlPatterns: [],
  // Host patterns (safety/url-pattern.ts): a host matches itself and its
  // subdomains; `re:` marks a regex over the normalised URL.
  protectedUrlPatterns: [
    'paypal.com',
    'venmo.com',
    'coinbase.com',
    'binance.com',
    'kraken.com',
    'chase.com',
    'bankofamerica.com',
    'wellsfargo.com',
    'schwab.com',
    'fidelity.com',
    'vanguard.com',
    'robinhood.com',
    'stripe.com/dashboard',
    '*.gov',
    'healthcare.gov',
    're:^https?://mychart\\.',
  ],
  containerScope: {
    enabled: false,
    containerName: 'KitsuneMCP Agent',
  },
} as const;

const SNAKE_TO_CAMEL: Record<string, keyof SafetyConfig> = {
  enabled: 'enabled',
  read_only: 'readOnly',
  allow_script_execution: 'allowScriptExecution',
  confirm_protected_actions: 'confirmProtectedActions',
  allow_password_typing: 'allowPasswordTyping',
  max_actions_per_minute: 'maxActionsPerMinute',
  audit_log: 'auditLog',
  blocked_url_patterns: 'blockedUrlPatterns',
  allowed_url_patterns: 'allowedUrlPatterns',
  protected_url_patterns: 'protectedUrlPatterns',
  container_scope: 'containerScope',
};

function snakeToCamelConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const camelKey = SNAKE_TO_CAMEL[key] ?? key;
    if (key === 'container_scope' && value && typeof value === 'object' && !Array.isArray(value)) {
      const cs = value as Record<string, unknown>;
      result[camelKey] = {
        enabled: cs['enabled'],
        containerName: cs['container_name'] ?? cs['containerName'],
      };
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

function resolveEnv(foxKey: string, legacyKey?: string): string | undefined {
  return process.env[foxKey] ?? (legacyKey ? process.env[legacyKey] : undefined);
}

function getConfigDir(): string {
  return path.join(os.homedir(), '.kitsune-mcp');
}

function getConfigPath(): string {
  const envPath = resolveEnv(ENV.FOX_SAFETY_CONFIG, LEGACY_ENV.CLAUDE_BROWSER_SAFETY_CONFIG);
  if (envPath) return envPath;
  return path.join(getConfigDir(), 'safety.json');
}

export function getAuditLogPath(): string {
  return path.join(getConfigDir(), 'logs', 'audit.jsonl');
}

/**
 * The loaded policy. `configError` is set when the config file exists but
 * cannot be used (unreadable, invalid JSON, schema violation); the
 * SafetyGuard then refuses every tool (fail-closed) instead of silently
 * running with DEFAULT_CONFIG.
 */
export type LoadedSafetyConfig = SafetyConfig & { configError?: string };

export function loadConfig(): LoadedSafetyConfig {
  const configPath = getConfigPath();
  let config: LoadedSafetyConfig = { ...DEFAULT_CONFIG };

  if (fs.existsSync(configPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new Error('safety.json must contain a JSON object');
      }
      const camelized = snakeToCamelConfig(raw as Record<string, unknown>);
      const merged = { ...DEFAULT_CONFIG, ...camelized };
      if (camelized['containerScope'] && typeof camelized['containerScope'] === 'object') {
        merged.containerScope = { ...DEFAULT_CONFIG.containerScope, ...(camelized['containerScope'] as object) };
      }
      config = SafetyConfigSchema.parse(merged);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      process.stderr.write(
        `[KitsuneMCP] WARNING: cannot use ${configPath} (${reason}). ` +
        'The safety guard refuses every tool until the file is fixed and the daemon restarted.\n',
      );
      return { ...DEFAULT_CONFIG, configError: `${configPath}: ${reason}` };
    }
  } else {
    // No config yet: write the defaults. Failing to write them is not a
    // policy problem, so the defaults stay in force.
    try {
      const dir = path.dirname(configPath);
      fs.mkdirSync(dir, { recursive: true });
      const fileConfig: Record<string, unknown> = {
        enabled: DEFAULT_CONFIG.enabled,
        read_only: DEFAULT_CONFIG.readOnly,
        allow_script_execution: DEFAULT_CONFIG.allowScriptExecution,
        confirm_protected_actions: DEFAULT_CONFIG.confirmProtectedActions,
        allow_password_typing: DEFAULT_CONFIG.allowPasswordTyping,
        max_actions_per_minute: DEFAULT_CONFIG.maxActionsPerMinute,
        audit_log: DEFAULT_CONFIG.auditLog,
        blocked_url_patterns: DEFAULT_CONFIG.blockedUrlPatterns,
        allowed_url_patterns: DEFAULT_CONFIG.allowedUrlPatterns,
        protected_url_patterns: DEFAULT_CONFIG.protectedUrlPatterns,
        container_scope: {
          enabled: DEFAULT_CONFIG.containerScope.enabled,
          container_name: DEFAULT_CONFIG.containerScope.containerName,
        },
      };
      fs.writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + '\n');
      process.stderr.write(`[KitsuneMCP] Wrote default safety config to ${configPath}\n`);
    } catch (e) {
      process.stderr.write(
        `[KitsuneMCP] Failed to write default ${configPath}, using defaults: ` +
        `${e instanceof Error ? e.message : String(e)}\n`,
      );
    }
  }

  if (resolveEnv(ENV.FOX_READ_ONLY, LEGACY_ENV.CLAUDE_BROWSER_READ_ONLY) === '1') {
    config = { ...config, readOnly: true };
  }
  if (resolveEnv(ENV.FOX_ALLOW_SCRIPTS, LEGACY_ENV.CLAUDE_BROWSER_ALLOW_SCRIPTS) === '0') {
    config = { ...config, allowScriptExecution: false };
  }

  return config;
}
