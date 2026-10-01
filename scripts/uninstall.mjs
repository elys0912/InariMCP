#!/usr/bin/env node
/**
 * KitsuneMCP uninstaller (Windows / macOS / Linux). See --help.
 *
 * Replaces scripts/uninstall.ps1 and scripts/uninstall.sh.
 *
 * Order (review 8 "uninstall"): stopping the daemon first does not stick —
 * the Native Host notices within ~20 s and starts it again, recreating
 * api_token and the logs. So the Native Messaging registration goes first
 * (the extension can no longer start a host), then the Claude Code
 * registration, then the running Native Hosts, then the daemon, and only
 * then ~/.kitsune-mcp.
 */

import {
  CLAUDE_NAME, UsageError, claudeConfigPath, claudeRemoveArgs, classifyProcesses, dataPaths,
  findClaudeEntries, formatCommand, httpEndpoint, nmManifestTargets, parseRegDefaultValue,
  parseUninstallArgs, pathApi, repoPaths,
} from './lib/core.mjs';
import {
  confirm, defaultDeps, exists, exitOnBrokenPipe, findClaude, isMain, listNodeProcesses, makeReporter, probeDaemon,
  readTextOrNull, regDeleteKey, regQueryDefault, removeTreeSafe, runProgram, stopDaemonGracefully, stopProcess,
} from './lib/system.mjs';
import { manualForPlatform, manualMarkdown, uninstallUsage } from './lib/texts.mjs';

class Fatal extends Error {}

export async function runUninstall(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const r = makeReporter(deps);
  try {
    return await uninstall(argv, deps, r);
  } catch (err) {
    if (err instanceof UsageError) {
      r.error(err.message);
      return 2;
    }
    if (err instanceof Fatal) {
      r.error(err.message);
      return 1;
    }
    throw err;
  } finally {
    deps.closePrompt?.();
  }
}

async function uninstall(argv, deps, r) {
  const opts = parseUninstallArgs(argv);
  const { platform, home, env } = deps;
  const p = pathApi(platform);
  const data = dataPaths(platform, home);
  const repo = repoPaths(platform, deps.repoRoot);
  const fsx = (f) => exists(deps.fs, f);

  if (opts.help) {
    r.raw(uninstallUsage());
    r.raw(`\nManual alternative (this machine):\n\n${manualForPlatform('uninstall', platform, { repoRoot: repo.repoRoot, nodePath: deps.execPath, dataDir: data.dataDir })}`);
    return 0;
  }
  if (opts.manual) {
    r.raw(manualMarkdown('uninstall'));
    return 0;
  }

  const dry = opts.dryRun;
  let problems = 0;
  r.title(`KitsuneMCP uninstaller (${platform})${dry ? ' — dry run, nothing is changed' : ''}`);

  // -------------------------------------------------------------------------
  r.step('1. Removing the Firefox Native Messaging registration');

  for (const t of nmManifestTargets({ platform, home, env, exists: fsx, all: true })) {
    if (t.registryKey) {
      const q = regQueryDefault(deps, t.registryKey, parseRegDefaultValue);
      if (!q.ok) {
        r.warn(`reg.exe query failed: ${q.error}`);
        problems++;
      } else if (q.value === null) {
        r.ok(`not registered: ${t.registryKey}`);
      } else if (dry) {
        r.plan(`delete ${t.registryKey} (was: ${q.value})`);
      } else {
        const res = regDeleteKey(deps, t.registryKey);
        if (res.error || res.status !== 0) {
          r.warn(`reg.exe delete failed: ${String(res.stderr).trim() || res.error?.message}`);
          problems++;
        } else {
          r.ok(`deleted ${t.registryKey} (was: ${q.value})`);
        }
      }
      continue; // the manifest file goes with ~/.kitsune-mcp/native-host below
    }
    if (!fsx(t.file)) continue;
    const text = readTextOrNull(deps.fs, t.file);
    let pointsTo = '';
    try {
      pointsTo = JSON.parse(text ?? '').path ?? '';
    } catch {
      // unreadable: remove anyway, it has our host name
    }
    if (dry) r.plan(`delete ${t.file}${pointsTo ? ` (host: ${pointsTo})` : ''}`);
    else {
      try {
        deps.fs.rmSync(t.file, { force: true });
        r.ok(`deleted ${t.file}`);
      } catch (err) {
        r.warn(`could not delete ${t.file}: ${err.message}`);
        problems++;
      }
    }
  }

  // -------------------------------------------------------------------------
  r.step(`2. Removing ${data.nativeHostDir}`);
  problems += removeDir(deps, r, dry, data.nativeHostDir);

  // -------------------------------------------------------------------------
  r.step('3. Claude Code');
  problems += await claudeStep(deps, r, opts, { repo, home, env, platform });

  // -------------------------------------------------------------------------
  r.step('4. Stopping running processes');

  const endpoint = httpEndpoint(env);
  const token = (readTextOrNull(deps.fs, data.tokenPath) ?? '').trim() || undefined;
  const daemon = await probeDaemon(deps, endpoint, token);
  const procs = listNodeProcesses(deps);
  const classes = procs
    ? classifyProcesses(procs, { hostEntry: repo.hostEntry, serverEntry: repo.serverEntry, platform, selfPid: deps.pid })
    : null;

  if (daemon.kind === 'none') r.ok(`no daemon answers on ${endpoint.host}:${endpoint.port}`);
  else if (daemon.kind === 'foreign') r.warn(`${endpoint.host}:${endpoint.port} answers but is not a KitsuneMCP daemon — left alone`);
  else {
    r.info(`KitsuneMCP daemon on ${endpoint.host}:${endpoint.port} (version ${daemon.version ?? '?'}, browsers connected: ${daemon.browsers ?? '?'}, ` +
      `${daemon.verified ? `verified with the API token${daemon.pid ? `, PID ${daemon.pid}` : ''}` : 'not verified: no matching API token'})`);
  }
  if (!classes) {
    r.warn('could not list processes (ps / WMI unavailable): running Native Hosts cannot be found.');
    r.warn('Quit Firefox or remove the extension, otherwise a running Native Host starts the daemon again.');
  } else {
    for (const o of classes.others) r.info(`not touched (another KitsuneMCP checkout?): PID ${o.pid} ${o.cmd}`);
  }

  // Daemon PIDs: the verified /daemon/info PID, plus daemons of this repository found in the process list.
  const daemonPids = new Set(classes ? classes.daemons.map((d) => d.pid) : []);
  if (daemon.kind === 'kitsune' && daemon.pid) daemonPids.add(daemon.pid);
  if (daemon.kind === 'kitsune' && !daemon.pid && daemonPids.size === 0) {
    r.warn('the daemon\'s PID is unknown (not verified and not found in the process list); stop it by hand (see --help).');
    problems++;
  }
  const hostPids = classes ? classes.hosts.map((h) => h.pid) : [];

  if (!opts.stop) {
    if (hostPids.length + daemonPids.size > 0) {
      r.info(`left running (--no-stop): Native Host ${hostPids.join(', ') || '-'}, daemon ${[...daemonPids].join(', ') || '-'}`);
    }
  } else if (hostPids.length + daemonPids.size === 0) {
    if (classes) r.ok('no KitsuneMCP Native Host or daemon of this repository is running');
  } else {
    // Native Hosts first: a live host restarts a stopped daemon. Then the
    // daemon, gracefully over its signed POST /daemon/shutdown when we hold
    // its token (running calls finish, Firefox is closed); by signal only
    // when it cannot be asked (no token, older daemon, no answer).
    const graceful = daemon.kind === 'kitsune' && daemon.verified && token !== undefined;
    const order = [...hostPids.map((pid) => ['Native Host', pid]), ...[...daemonPids].map((pid) => ['daemon', pid])];
    if (!dry && !(await confirm(deps, opts,
      `Stop ${order.map(([k, pid]) => `${k} ${pid}`).join(', ')}? Claude Code sessions lose the browser tools.`, true))) {
      r.info('left running');
    } else {
      let daemonStopped = false;
      for (const [kind, pid] of order) {
        if (dry) {
          r.plan(kind === 'daemon' && graceful
            ? `stop daemon PID ${pid} over POST /daemon/shutdown (signal after ${opts.graceMs / 1000}s if it keeps running)`
            : `stop ${kind} PID ${pid} (SIGTERM, SIGKILL after ${opts.graceMs / 1000}s)`);
          continue;
        }
        if (kind === 'daemon' && graceful && !daemonStopped) {
          const outcome = await stopDaemonGracefully(deps, endpoint, token, opts.graceMs);
          if (outcome === 'stopped') {
            daemonStopped = true;
            if (!deps.isAlive(pid)) {
              r.ok(`daemon PID ${pid}: stopped (POST /daemon/shutdown)`);
              continue;
            }
            r.info(`daemon answered the stop request but PID ${pid} is still alive — sending a signal`);
          } else {
            r.info(`POST /daemon/shutdown ${outcome === 'refused' ? 'was refused (older daemon?)' : outcome === 'unanswered' ? 'got no answer' : 'did not stop it in time'} — sending a signal`);
          }
        } else if (kind === 'daemon' && daemonStopped && !deps.isAlive(pid)) {
          r.ok(`daemon PID ${pid}: already gone`);
          continue;
        }
        const result = await stopProcess(deps, pid, opts.graceMs);
        if (result === 'failed') {
          r.warn(`could not stop ${kind} PID ${pid}`);
          problems++;
        } else {
          r.ok(`${kind} PID ${pid}: ${result === 'killed' ? 'killed after the grace period' : result === 'gone' ? 'already gone' : 'stopped'}`);
        }
      }
      if (!dry && daemon.kind === 'kitsune') {
        const after = await probeDaemon(deps, endpoint, token);
        if (after.kind === 'kitsune') {
          r.warn(`a KitsuneMCP daemon still answers on ${endpoint.host}:${endpoint.port}`);
          problems++;
        }
      }
    }
  }
  if (classes && classes.relays.length > 0) {
    r.warn(`Claude Code sessions still run KitsuneMCP (relay PID ${classes.relays.map((x) => x.pid).join(', ')}).`);
    r.warn('They start the daemon again (and recreate api_token) on their next browser tool call: restart them.');
  }

  // -------------------------------------------------------------------------
  r.step(`5. Data directory ${data.dataDir}`);
  if (!fsx(data.dataDir)) r.ok('not present');
  else if (opts.purge) problems += removeDir(deps, r, dry, data.dataDir);
  else {
    const left = deps.fs.readdirSync(data.dataDir).filter((n) => !(dry && n === 'native-host'));
    if (left.length === 0) {
      if (dry) r.plan(`remove the empty directory ${data.dataDir}`);
      else {
        deps.fs.rmdirSync(data.dataDir);
        r.ok('empty — removed');
      }
    } else {
      r.info('kept (use --purge to delete it):');
      for (const n of left) r.info(`  ${n}`);
    }
  }

  r.raw(`
${dry ? 'Dry run finished: nothing was changed.' : problems === 0 ? 'Uninstall complete.' : `Uninstall finished with ${problems} problem(s); see the warnings above.`}
Remove the extension in Firefox as well (about:addons, or about:debugging for a temporary add-on).
The repository (${repo.repoRoot}) was not modified.
`);
  return dry || problems === 0 ? 0 : 1;
}

/** @returns {number} problems */
function removeDir(deps, r, dry, dir) {
  if (!exists(deps.fs, dir)) {
    r.ok('not present');
    return 0;
  }
  if (dry) {
    r.plan(`delete ${dir} (${deps.fs.readdirSync(dir).join(', ') || 'empty'})`);
    return 0;
  }
  try {
    const res = removeTreeSafe(dir, deps.fs);
    if (res.status === 'refused') {
      r.warn(`${dir} contains a symlink or junction — not deleted automatically:`);
      for (const l of res.links) r.warn(`  ${l}`);
      r.warn('Remove the link(s) by hand first (without following them), then run this again.');
      return 1;
    }
    r.ok(`deleted ${dir}`);
    return 0;
  } catch (err) {
    r.warn(`could not delete ${dir}: ${err.message} (a running process may hold a file open)`);
    return 1;
  }
}

/** @returns {Promise<number>} problems */
async function claudeStep(deps, r, opts, { repo, home, env, platform }) {
  const configFile = claudeConfigPath(platform, home, env);
  let config = null;
  let projectMcp = null;
  try {
    const t = readTextOrNull(deps.fs, configFile);
    config = t === null ? null : JSON.parse(t);
  } catch {
    r.warn(`could not parse ${configFile}`);
  }
  try {
    const t = readTextOrNull(deps.fs, repo.projectMcpJson);
    projectMcp = t === null ? null : JSON.parse(t);
  } catch {
    r.warn(`could not parse ${repo.projectMcpJson}`);
  }
  const { found, otherLocal } = findClaudeEntries({ config, projectMcp, repoRoot: repo.repoRoot, platform });
  if (otherLocal.length > 0) {
    r.info(`'${CLAUDE_NAME}' is also registered with scope local in: ${otherLocal.join(', ')}`);
    r.info(`  remove it there with: claude mcp remove --scope local ${CLAUDE_NAME}`);
  }
  if (found.length === 0) {
    r.ok(`'${CLAUDE_NAME}' is not registered (user scope, and local / project scope of ${repo.repoRoot})`);
    return 0;
  }
  const scopes = found.map((f) => f.scope);
  r.info(`'${CLAUDE_NAME}' is registered with scope ${scopes.join(', ')}`);
  const manual = scopes.map((s) => formatCommand('claude', claudeRemoveArgs(s), platform)).join(' && ');

  let remove;
  if (opts.claude === 'keep') remove = false;
  else if (opts.claude === 'remove') remove = true;
  else if (opts.dryRun && !opts.yes) {
    r.info(`would ask whether to remove it (default: keep); --unregister-claude removes it: ${manual}`);
    return 0;
  } else remove = await confirm(deps, opts, `Remove '${CLAUDE_NAME}' from Claude Code?`, false);
  if (!remove) {
    r.info(`kept. To remove it: ${manual}`);
    return 0;
  }

  const claude = findClaude(deps);
  if (!claude) {
    r.warn(`'claude' was not found in PATH. Remove it by hand: ${manual}`);
    return 1;
  }
  let problems = 0;
  for (const s of scopes) {
    const args = claudeRemoveArgs(s);
    if (opts.dryRun) {
      r.plan(`run ${formatCommand(claude, args, platform)} (in ${repo.repoRoot})`);
      continue;
    }
    const res = runProgram(deps, claude, args, { cwd: repo.repoRoot, inherit: true, timeoutMs: 120_000 });
    if (res.status === 0) r.ok(`removed '${CLAUDE_NAME}' (scope ${s})`);
    else {
      r.warn(`claude mcp remove --scope ${s} failed (exit code ${res.status ?? res.error?.message})`);
      problems++;
    }
  }
  return problems;
}

if (isMain(import.meta.url)) {
  exitOnBrokenPipe();
  process.exitCode = await runUninstall(process.argv.slice(2));
}
