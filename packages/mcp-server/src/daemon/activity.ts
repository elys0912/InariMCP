/**
 * Idle tracking for the shared daemon.
 *
 * The daemon is started on demand (by a relay or by the Native Host) and
 * nobody stops it explicitly, so it stops itself once nothing uses it:
 *   - no relay has been seen for RELAY_TTL_MS (relays send a heartbeat to
 *     GET /health every RELAY_HEARTBEAT_MS, and every POST /mcp/call counts),
 *   - no Native Host is connected over WebSocket,
 *   - no tool call is in flight,
 * and that has lasted for the idle timeout (FOX_DAEMON_IDLE_TIMEOUT seconds,
 * default 600; 0 disables the idle shutdown).
 */

import { ENV } from '@kitsune-mcp/shared';

/** How often a relay pings the daemon. */
export const RELAY_HEARTBEAT_MS = 30_000;
/** A relay not seen for this long is considered gone. */
export const RELAY_TTL_MS = 3 * RELAY_HEARTBEAT_MS;

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60_000;
const IDLE_CHECK_INTERVAL_MS = 30_000;

export function resolveIdleTimeoutMs(): number {
  const raw = process.env[ENV.FOX_DAEMON_IDLE_TIMEOUT];
  if (raw !== undefined && raw.trim() !== '') {
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  }
  return DEFAULT_IDLE_TIMEOUT_MS;
}

export class DaemonActivity {
  private readonly relays = new Map<string, number>();
  private inFlight = 0;
  private idleSince: number | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /** Record that a relay is alive (heartbeat or tool call). */
  noteRelay(id: string): void {
    this.relays.set(id, Date.now());
  }

  beginCall(): void {
    this.inFlight += 1;
  }

  endCall(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  /** Relays seen within RELAY_TTL_MS. Expired entries are dropped. */
  liveRelayCount(now: number = Date.now()): number {
    for (const [id, seen] of this.relays) {
      if (now - seen > RELAY_TTL_MS) this.relays.delete(id);
    }
    return this.relays.size;
  }

  /**
   * Start the idle watchdog.
   * @param nativeHostCount current number of Native Host WS connections
   * @param onIdle          called once when the idle timeout has elapsed
   */
  start(nativeHostCount: () => number, onIdle: () => void): void {
    const idleTimeoutMs = resolveIdleTimeoutMs();
    if (idleTimeoutMs === 0 || this.timer !== null) return;

    this.idleSince = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const busy =
        this.liveRelayCount(now) > 0 || nativeHostCount() > 0 || this.inFlight > 0;
      if (busy) {
        this.idleSince = null;
        return;
      }
      if (this.idleSince === null) {
        this.idleSince = now;
        return;
      }
      if (now - this.idleSince >= idleTimeoutMs) {
        this.stop();
        onIdle();
      }
    }, Math.min(IDLE_CHECK_INTERVAL_MS, Math.max(1_000, idleTimeoutMs / 2)));
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
