/**
 * Global setup: report changes to the real ~/.inari-mcp made during the run.
 *
 * tests/setup/isolate-home.ts should make this impossible. The check only
 * warns: a daemon or Native Host in real use (or another checkout running
 * tests) may legitimately write there at the same time.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

type Snapshot = Map<string, string>;

function snapshot(dir: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        const st = fs.statSync(p);
        out.set(p, `${st.size}:${st.mtimeMs}`);
      } catch {
        // vanished
      }
    }
  };
  walk(dir);
  return out;
}

export default function setup(): () => void {
  const dir = path.join(os.homedir(), '.inari-mcp');
  const before = snapshot(dir);
  return () => {
    const after = snapshot(dir);
    const changed = [...after].filter(([p, sig]) => before.get(p) !== sig).map(([p]) => p);
    if (changed.length > 0) {
      process.stderr.write(
        `\n[test setup] WARNING: files under the real ${dir} changed during the test run ` +
        `(a test may not be isolated, or a real daemon wrote them):\n  ${changed.join('\n  ')}\n`,
      );
    }
  };
}
