/**
 * MCP Server subprocess management.
 *
 * Handles starting, stopping, health checking, and restarting the
 * MCP server process. Cross-platform port-kill support (Windows / Unix).
 */

import { spawn, execSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ENV, ENV_DEFAULTS, LEGACY_ENV } from '@kitsune-mcp/shared';

function log(msg: string): void {
  process.stderr.write(`[KitsuneMCP:NativeHost] ${msg}\n`);
}

function resolveHost(): string {
  return (
    process.env[ENV.FOX_HOST] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HOST] ??
    ENV_DEFAULTS.FOX_HOST
  );
}

function resolvePort(): number {
  const raw =
    process.env[ENV.FOX_HTTP_PORT] ??
    process.env[LEGACY_ENV.CLAUDE_BROWSER_HTTP_PORT];
  if (raw) {
    const parsed = Number(raw);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return ENV_DEFAULTS.FOX_HTTP_PORT;
}

export class ServerLauncher {
  readonly httpPort: number;
  readonly host: string;
  private cachedApiToken: string | undefined;

  private serverProcess: ChildProcess | null = null;
  private restartAttempts = 0;
  private lastStableTime = Date.now();

  private readonly pidFilePath: string;

  constructor() {
    this.host = resolveHost();
    this.httpPort = resolvePort();
    this.cachedApiToken = this.loadApiToken();
    this.pidFilePath = path.join(os.homedir(), '.kitsune-mcp', 'server.pid');
  }

  /**
   * The API token, re-read from disk whenever we don't yet have one cached.
   * This covers the case where the token file didn't exist yet when the
   * launcher was constructed (e.g. server hadn't generated it on first boot).
   * Once a token is found, it's cached and not re-read on every call.
   */
  private get apiToken(): string | undefined {
    if (this.cachedApiToken === undefined) {
      this.cachedApiToken = this.loadApiToken();
    }
    return this.cachedApiToken;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async start(): Promise<boolean> {
    if (this.restartAttempts >= ENV_DEFAULTS.MAX_RESTART_ATTEMPTS) {
      log(`max restart attempts (${ENV_DEFAULTS.MAX_RESTART_ATTEMPTS}) reached`);
      return false;
    }

    // Resolve server entry point relative to this package
    const serverEntry = path.resolve(
      __dirname,
      '..', '..', 'mcp-server', 'dist', 'index.js',
    );

    if (!fs.existsSync(serverEntry)) {
      log(`MCP server entry not found: ${serverEntry}`);
      return false;
    }

    try {
      this.serverProcess = spawn(
        process.execPath,
        [serverEntry],
        {
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        },
      );

      // Unref so the child doesn't keep the native-host alive on exit
      this.serverProcess.unref();

      this.restartAttempts++;
      this.lastStableTime = Date.now();

      const pid = this.serverProcess.pid;
      log(`started MCP server (PID: ${pid ?? 'unknown'}, attempt #${this.restartAttempts})`);

      // Save PID file
      if (pid !== undefined) {
        try {
          const dir = path.dirname(this.pidFilePath);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(this.pidFilePath, String(pid));
        } catch {
          // Non-critical
        }
      }

      // Wait up to 3 seconds for the server to become healthy
      for (let i = 0; i < 15; i++) {
        await this.sleep(200);
        if (await this.checkHealth()) {
          log('MCP server is now available');
          this.restartAttempts = 0;
          return true;
        }
      }

      log('MCP server started but not yet responding');
      return true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to start MCP server: ${msg}`);
      return false;
    }
  }

  async stop(): Promise<void> {
    if (!this.serverProcess || this.serverProcess.exitCode !== null) {
      this.serverProcess = null;
      return;
    }

    const pid = this.serverProcess.pid;
    if (pid === undefined) {
      this.serverProcess = null;
      return;
    }

    log(`stopping MCP server (PID: ${pid})`);

    try {
      this.serverProcess.kill('SIGTERM');
    } catch {
      // May already be dead
    }

    // Wait up to 5 seconds for graceful exit
    const exited = await this.waitForExit(5_000);

    if (!exited) {
      log(`MCP server PID ${pid} did not exit after SIGTERM, sending SIGKILL`);
      try {
        this.serverProcess.kill('SIGKILL');
      } catch {
        // Ignore
      }
      await this.waitForExit(2_000);
    }

    this.serverProcess = null;
  }

  async ensureRunning(): Promise<void> {
    if (await this.checkHealth()) {
      log('MCP server already running and responding');
      return;
    }

    if (await this.isPortInUse()) {
      log('port in use but server not responding — killing stale process');
      await this.killExisting();
    }

    log('MCP server not running, attempting to start');
    await this.start();
  }

  isPortInUse(): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      sock.setTimeout(1_000);

      sock.on('connect', () => {
        sock.destroy();
        resolve(true);
      });

      sock.on('timeout', () => {
        sock.destroy();
        resolve(false);
      });

      sock.on('error', () => {
        sock.destroy();
        resolve(false);
      });

      sock.connect(this.httpPort, this.host);
    });
  }

  checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: this.host,
          port: this.httpPort,
          path: '/health',
          method: 'GET',
          timeout: 3_000,
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            resolve(res.statusCode === 200 && body.toLowerCase().includes('ok'));
          });
        },
      );

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  }

  async killExisting(): Promise<void> {
    const port = this.httpPort;

    try {
      if (process.platform === 'win32') {
        await this.killExistingWindows(port);
      } else {
        await this.killExistingUnix(port);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`failed to kill existing server: ${msg}`);
    }
  }

  resetBackoff(): void {
    const now = Date.now();
    if (
      this.restartAttempts > 0 &&
      now - this.lastStableTime > ENV_DEFAULTS.STABLE_THRESHOLD_MS
    ) {
      log('resetting restart counter after stability period');
      this.restartAttempts = 0;
    }
  }

  getBackoffDelay(): number {
    return Math.min(
      ENV_DEFAULTS.BACKOFF_BASE_MS * Math.pow(2, this.restartAttempts - 1),
      ENV_DEFAULTS.BACKOFF_MAX_MS,
    );
  }

  getApiToken(): string | undefined {
    return this.apiToken;
  }

  getRestartAttempts(): number {
    return this.restartAttempts;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private loadApiToken(): string | undefined {
    const tokenPath = path.join(os.homedir(), '.kitsune-mcp', 'api_token');
    try {
      if (fs.existsSync(tokenPath)) {
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (token.length > 0) return token;
      }
    } catch {
      // Token file missing or unreadable
    }
    return undefined;
  }

  private async killExistingWindows(port: number): Promise<void> {
    try {
      const output = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8', timeout: 5_000 },
      );

      const pids = new Set<number>();
      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(/\s+/);
        const pidStr = parts[parts.length - 1];
        const pid = Number(pidStr);
        if (!Number.isNaN(pid) && pid > 0) pids.add(pid);
      }

      for (const pid of pids) {
        log(`killing process on port ${port}: PID ${pid}`);
        try {
          execSync(`taskkill /PID ${pid} /F`, { timeout: 5_000 });
        } catch {
          // Process may already be gone
        }
      }
    } catch {
      // netstat/findstr may fail if no process is listening
    }

    await this.sleep(500);
  }

  private async killExistingUnix(port: number): Promise<void> {
    let pids: number[] = [];

    // Try lsof first
    try {
      const output = execSync(`lsof -ti :${port}`, {
        encoding: 'utf-8',
        timeout: 5_000,
      });
      pids = output
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => !Number.isNaN(n) && n > 0);
    } catch {
      // lsof not available, try fuser
      try {
        execSync(`fuser -k ${port}/tcp`, { timeout: 5_000 });
        await this.sleep(500);
        return;
      } catch {
        log('neither lsof nor fuser available to kill existing server');
        return;
      }
    }

    // SIGTERM first
    for (const pid of pids) {
      log(`sending SIGTERM to process on port ${port}: PID ${pid}`);
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone
      }
    }

    await this.sleep(2_000);

    // SIGKILL any survivors
    for (const pid of pids) {
      try {
        process.kill(pid, 0); // Check if alive
        log(`process ${pid} still alive after SIGTERM, sending SIGKILL`);
        process.kill(pid, 'SIGKILL');
      } catch {
        // Already gone
      }
    }

    await this.sleep(500);
  }

  private waitForExit(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.serverProcess || this.serverProcess.exitCode !== null) {
        resolve(true);
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onExit = (): void => {
        cleanup();
        resolve(true);
      };

      const cleanup = (): void => {
        clearTimeout(timer);
        this.serverProcess?.removeListener('exit', onExit);
      };

      this.serverProcess.on('exit', onExit);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
