#!/usr/bin/env node
/**
 * KitsuneMCP installer (Windows / macOS / Linux). See --help.
 *
 *   node scripts/install.mjs [--dry-run] [--yes] [--register-claude] ...
 *
 * Replaces scripts/install.ps1 and scripts/install.sh: one implementation,
 * no PowerShell (reg.exe for the registry), no bash.
 */

import {
  CLAUDE_NAME, DIR_MODE, MANIFEST_MODE, MIN_NODE_MAJOR, UsageError, WRAPPER_MODE, buildManifest, buildWrapper, claudeAddArgs,
  claudeConfigPath, claudeEntryState, claudeRemoveArgs, dataPaths, detectFirefox, findClaudeEntries,
  formatCommand, httpEndpoint, isAscii, isWsl, lookup, manifestState, nmManifestTargets, nodeMajor, nodeVersionManager,
  parseInstallArgs, parseRegDefaultValue, pathApi, repoPaths, samePath, serializeJson,
} from './lib/core.mjs';
import {
  CMD_TIMEOUT_MS, NPM_TIMEOUT_MS, PROGRAM_TIMEOUT_MS, confirm, defaultDeps, exists, exitOnBrokenPipe, findClaude,
  isMain, makeReporter, npmInvocation, readTextOrNull, regQueryDefault, regSetDefault, runProgram, which,
  writeFileAtomic,
} from './lib/system.mjs';
import { installUsage, manualForPlatform, manualMarkdown } from './lib/texts.mjs';

class Fatal extends Error {}

/** claudeEntryState() → how a found registration is described. */
const ENTRY_STATE_TEXT = {
  same: 'matches this installation',
  'stale-node': 'this repository, but another node (bare "node" depends on PATH)',
  different: 'points elsewhere',
};

/**
 * @param {string[]} argv
 * @param {Partial<ReturnType<typeof defaultDeps>>} [overrides] for tests
 * @returns {Promise<number>} exit code
 */
export async function runInstall(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const r = makeReporter(deps);
  try {
    return await install(argv, deps, r);
  } catch (err) {
    if (err instanceof UsageError) {
      r.error(err.message);
      return 2;
    }
    if (err instanceof Fatal) {
      r.error(err.message);
      return 1;
    }
    // Anything else (an fs error: EACCES, ENOSPC …): one line, not a stack trace.
    r.error(err instanceof Error ? err.message : String(err));
    return 1;
  } finally {
    deps.closePrompt?.();
  }
}

async function install(argv, deps, r) {
  const opts = parseInstallArgs(argv);
  const { platform, home, env } = deps;
  const p = pathApi(platform);
  const data = dataPaths(platform, home);
  const repo = repoPaths(platform, deps.repoRoot);
  const nodePath = opts.node ? p.resolve(opts.node) : deps.execPath;
  const fsx = (f) => exists(deps.fs, f);

  if (opts.help) {
    r.raw(installUsage());
    r.raw(`\nManual alternative (this machine):\n\n${manualForPlatform('install', platform, { repoRoot: repo.repoRoot, nodePath, dataDir: data.dataDir, port: httpEndpoint(env).port })}`);
    return 0;
  }
  if (opts.manual) {
    r.raw(manualMarkdown('install'));
    return 0;
  }

  const dry = opts.dryRun;
  r.title(`KitsuneMCP installer (${platform})${dry ? ' — dry run, nothing is changed' : ''}`);
  r.title(`Repository: ${repo.repoRoot}`);

  // -------------------------------------------------------------------------
  r.step('Checking prerequisites');

  let version = deps.nodeVersion;
  if (opts.node) {
    if (!fsx(nodePath)) throw new Fatal(`--node: ${nodePath} does not exist`);
    const v = deps.run(nodePath, ['--version'], { timeoutMs: CMD_TIMEOUT_MS });
    version = v.status === 0 ? String(v.stdout).trim() : '';
  }
  const major = nodeMajor(version);
  if (!(major >= MIN_NODE_MAJOR)) {
    throw new Fatal(`Node.js ${version || '(unknown version)'} at ${nodePath} is too old or unusable (need >= ${MIN_NODE_MAJOR})`);
  }
  r.ok(`Node.js ${version} (${nodePath})`);
  const manager = nodeVersionManager(nodePath);
  if (manager) {
    r.warn(`this node comes from ${manager}; its path changes or disappears when you switch or remove the version.`);
    r.warn('The registration pins this exact file: re-run the installer afterwards, or pass --node with a stable path.');
  }

  if (isWsl({ platform, env, procVersion: deps.readProcVersion() })) {
    r.warn('running inside WSL: this registers the host for a Firefox running in Linux (WSLg).');
    r.warn('Firefox for Windows cannot start a Linux host: run the installer on Windows for it.');
    r.warn('A Claude Code in WSL and a Firefox on Windows use separate daemons and tokens and do not see each other.');
  }

  const firefox = detectFirefox({ platform, home, env, exists: fsx, which: (b) => which(b, deps) });
  if (platform === 'win32') {
    for (const hive of ['HKCU', 'HKLM']) {
      const q = regQueryDefault(deps, `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\firefox.exe`, parseRegDefaultValue);
      const exe = q.ok && q.value ? q.value.replace(/^"(.*)"$/, '$1') : '';
      if (exe && !firefox.some((f) => samePath(f.path, exe, platform))) firefox.push({ edition: 'Firefox (App Paths)', path: exe });
    }
  }
  if (firefox.length === 0) {
    r.warn('Firefox was not found. Continuing; install Firefox before loading the extension.');
  } else {
    for (const f of firefox) r.ok(`${f.edition} (${f.path})`);
  }

  // -------------------------------------------------------------------------
  if (opts.build) {
    r.step('Building (npm install, npm run build)');
    const npm = npmInvocation(deps);
    if (!npm) throw new Fatal('npm was not found (it normally ships with Node.js)');
    for (const args of [['install'], ['run', 'build']]) {
      const full = [...npm.prefix, ...args];
      if (dry) {
        r.plan(`run ${formatCommand(npm.file, full, platform)}`);
        continue;
      }
      const res = runProgram(deps, npm.file, full, { cwd: repo.repoRoot, inherit: true, timeoutMs: NPM_TIMEOUT_MS });
      if (res.status !== 0) throw new Fatal(`npm ${args.join(' ')} failed (exit code ${res.status ?? res.error?.message})`);
    }
  }

  const missing = [repo.hostEntry, repo.serverEntry].filter((f) => !fsx(f));
  if (missing.length === 0) {
    r.ok('build output present');
  } else if (dry && opts.build) {
    r.info('build output will be created by the build step');
  } else {
    const msg = `build output not found: ${missing.join(', ')} (run "npm ci" and "npm run build", or pass --build)`;
    if (!dry) throw new Fatal(msg);
    r.warn(msg);
  }

  // -------------------------------------------------------------------------
  r.step('Reading the extension ID');
  let geckoId;
  try {
    const ext = JSON.parse(deps.fs.readFileSync(repo.extManifest, 'utf8'));
    geckoId = ext?.browser_specific_settings?.gecko?.id;
  } catch (err) {
    throw new Fatal(`could not read ${repo.extManifest}: ${err.message}`);
  }
  if (typeof geckoId !== 'string' || geckoId.trim() === '') {
    throw new Fatal(`browser_specific_settings.gecko.id is missing in ${repo.extManifest}`);
  }
  r.ok(`gecko ID: ${geckoId}`);

  // -------------------------------------------------------------------------
  r.step(`Native Messaging host wrapper (${data.nativeHostDir})`);

  const plannedDirs = new Set();
  for (const dir of [data.dataDir, data.nativeHostDir]) {
    if (fsx(dir)) continue;
    plannedDirs.add(dir);
    if (dry) r.plan(`create ${dir}`);
    else {
      deps.fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      r.ok(`created ${dir}`);
    }
  }
  if (!dry && platform !== 'win32') {
    for (const dir of [data.dataDir, data.nativeHostDir]) {
      try {
        deps.fs.chmodSync(dir, DIR_MODE);
      } catch {
        // best effort
      }
    }
  }

  const wrapper = buildWrapper(platform, { nativeHostPkg: repo.nativeHostPkg, nodePath, hostEntry: repo.hostEntry });
  if (platform === 'win32' && !isAscii(wrapper)) {
    r.warn('a path contains non-ASCII characters: run-host.cmd switches to UTF-8 (chcp 65001).');
    r.warn('If Firefox cannot start the host, move the repository / Node.js to an ASCII-only path.');
  }
  writeIfChanged(deps, r, dry, data.wrapperPath, wrapper, platform === 'win32' ? undefined : WRAPPER_MODE);

  if (platform === 'win32' && fsx(data.nativeHostDir)) {
    // Wrappers from earlier manual setups (run-host-e2e.cmd …) are not referenced any more.
    for (const name of deps.fs.readdirSync(data.nativeHostDir)) {
      if (/^run-host.*\.cmd$/i.test(name) && name.toLowerCase() !== 'run-host.cmd') {
        const stale = p.join(data.nativeHostDir, name);
        if (dry) r.plan(`remove stale wrapper ${stale}`);
        else {
          deps.fs.rmSync(stale, { force: true });
          r.ok(`removed stale wrapper ${stale}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  r.step('Registering the host with Firefox');

  const manifest = buildManifest({ wrapperPath: data.wrapperPath, geckoId });
  const manifestText = serializeJson(manifest);
  const targets = nmManifestTargets({ platform, home, env, exists: fsx });

  for (const t of targets) {
    r.info(`${t.label}:`);
    let currentText;
    try {
      currentText = readTextOrNull(deps.fs, t.file);
    } catch (err) {
      throw new Fatal(`could not read ${t.file}: ${err.message}`);
    }
    const st = manifestState(manifest, currentText, platform);
    if (st.state === 'invalid') r.warn(`${t.file} is not a valid host manifest; replacing it`);
    if (st.state === 'different' && st.path && !samePath(st.path, data.wrapperPath, platform)) {
      r.warn(`${t.file} points to another host: ${st.path}`);
      if (!(await confirm(deps, opts, 'Replace it with this installation?', true))) {
        r.info('left unchanged');
        continue;
      }
    }
    if (st.state === 'same') r.ok(`unchanged ${t.file}`);
    else {
      const dir = p.dirname(t.file);
      if (!fsx(dir) && !plannedDirs.has(dir)) {
        plannedDirs.add(dir);
        if (dry) r.plan(`create ${dir}`);
        else deps.fs.mkdirSync(dir, { recursive: true });
      }
      writeIfChanged(deps, r, dry, t.file, manifestText, platform === 'win32' ? undefined : MANIFEST_MODE);
    }
    if (t.note) r.info(`note: ${t.note}`);

    if (t.registryKey) await registerWindows(deps, r, opts, t.registryKey, t.file);
  }

  // -------------------------------------------------------------------------
  r.step('Claude Code');
  await claudeStep(deps, r, opts, { nodePath, serverEntry: repo.serverEntry, repo, home, env, platform });

  // -------------------------------------------------------------------------
  const endpoint = httpEndpoint(env);
  const healthUrl = `http://${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}/health`;
  const health = platform === 'win32'
    ? `curl.exe --noproxy "*" -s ${healthUrl}`
    : `curl --noproxy '*' -s ${healthUrl}`;
  r.raw(`
${dry ? 'Dry run finished: nothing was changed.' : 'Installation complete.'}

Next steps:
  1. Load the extension in Firefox (temporary add-on):
       about:debugging#/runtime/this-firefox -> "Load Temporary Add-on..."
       select: ${repo.extManifest}
     A temporary add-on is removed when Firefox restarts (load it again).
  2. Restart Claude Code so it picks up the MCP server.
  3. Check the connection (browsers_connected should be 1):
       ${health}
  Logs: ${p.join(data.logsDir, 'native-host.log')} (Native Host), ${p.join(data.logsDir, 'daemon.log')} (daemon)
  Uninstall: node scripts/uninstall.mjs   (npm run teardown)
`);
  return 0;
}

/** Atomic write unless the content is already there. */
function writeIfChanged(deps, r, dry, file, content, mode) {
  const current = readTextOrNull(deps.fs, file);
  if (current === content) {
    r.ok(`unchanged ${file}`);
    return;
  }
  const verb = current === null ? 'create' : 'update';
  if (dry) {
    r.plan(`${verb} ${file}`);
    return;
  }
  writeFileAtomic(file, content, { mode }, deps.fs);
  r.ok(`${verb === 'create' ? 'created' : 'updated'} ${file}`);
}

async function registerWindows(deps, r, opts, key, manifestPath) {
  const q = regQueryDefault(deps, key, parseRegDefaultValue);
  if (!q.ok) throw new Fatal(`reg.exe query failed: ${q.error}`);
  if (q.value !== null && samePath(q.value, manifestPath, 'win32')) {
    r.ok(`unchanged ${key} = ${q.value}`);
    return;
  }
  if (q.value !== null) {
    r.warn(`${key} points to ${q.value || '(empty)'}`);
    if (!(await confirm(deps, opts, 'Point it to this installation?', true))) {
      r.info('left unchanged');
      return;
    }
  }
  if (opts.dryRun) {
    r.plan(`set ${key} = ${manifestPath} (reg.exe add)`);
    return;
  }
  const res = regSetDefault(deps, key, manifestPath);
  if (res.error || res.status !== 0) {
    throw new Fatal(`reg.exe add failed (${res.error?.message ?? `exit code ${res.status}`}): ${String(res.stderr).trim()}`);
  }
  r.ok(`${q.value === null ? 'registered' : 'updated'} ${key} = ${manifestPath}`);
}

/**
 * Read the Claude Code configuration and report the kitsune-mcp entries
 * found. Display only: install does not rewrite these files, so an
 * unreadable one is a warning.
 * @returns {{scope: string, entry: object}[]}
 */
function reportClaudeRegistrations(deps, r, { nodePath, serverEntry, repo, home, env, platform }) {
  const readJson = (file, unreadable) => {
    try {
      const t = readTextOrNull(deps.fs, file);
      return t === null ? null : JSON.parse(t);
    } catch (err) {
      r.warn(`could not read ${file} (${err.message})${unreadable}`);
      return null;
    }
  };
  const config = readJson(claudeConfigPath(platform, home, env), '; the current registration is unknown');
  const projectMcp = readJson(repo.projectMcpJson, '');
  const { found, otherLocal } = findClaudeEntries({ config, projectMcp, repoRoot: repo.repoRoot, platform });
  const describe = (e) => formatCommand(String(e.entry.command ?? ''), (Array.isArray(e.entry.args) ? e.entry.args : []).map(String), platform);
  for (const e of found) {
    const st = claudeEntryState(e.entry, { nodePath, serverEntry, platform });
    const text = lookup(ENTRY_STATE_TEXT, st, 'registration state');
    r.info(`registered (scope ${e.scope}): ${describe(e)} — ${text}`);
  }
  if (otherLocal.length > 0) {
    r.info(`also registered with scope local in ${otherLocal.length} other director${otherLocal.length === 1 ? 'y' : 'ies'}`);
  }
  return found;
}

/**
 * Run `claude mcp remove` (when replacing) and `claude mcp add` in the
 * repository (local / project scopes belong to the current directory).
 * @returns {boolean} false when a command failed (already reported)
 */
function runClaudeCommands(deps, r, opts, claude, steps, { repo, platform, manual }) {
  for (const args of steps) {
    if (opts.dryRun) {
      r.plan(`run ${formatCommand(claude, args, platform)} (in ${repo.repoRoot})`);
      continue;
    }
    const res = runProgram(deps, claude, args, { cwd: repo.repoRoot, inherit: true, timeoutMs: PROGRAM_TIMEOUT_MS });
    if (res.status !== 0) {
      r.warn(`claude ${args.slice(0, 2).join(' ')} failed (exit code ${res.status ?? res.error?.message}). Register by hand:`);
      r.info(`  ${manual}`);
      return false;
    }
  }
  return true;
}

async function claudeStep(deps, r, opts, ctx) {
  const { nodePath, serverEntry, platform } = ctx;
  const scope = opts.claudeScope;
  const manual = formatCommand('claude', claudeAddArgs(scope, nodePath, serverEntry), platform);
  const found = reportClaudeRegistrations(deps, r, ctx);
  const current = found.find((e) => e.scope === scope);
  const currentState = current ? claudeEntryState(current.entry, { nodePath, serverEntry, platform }) : undefined;

  if (!opts.registerClaude) {
    if (currentState !== 'same') {
      r.info('Not changed (pass --register-claude to register). To register by hand:');
      r.info(`  ${manual}`);
    }
    return;
  }

  const claude = findClaude(deps);
  if (!claude) {
    r.warn("'claude' was not found in PATH. Register by hand later:");
    r.info(`  ${manual}`);
    return;
  }
  if (current) {
    if (currentState === 'same') {
      r.ok(`'${CLAUDE_NAME}' (scope ${scope}) already matches this installation`);
      return;
    }
    if (!(await confirm(deps, opts, `Replace the '${CLAUDE_NAME}' registration (scope ${scope})?`, true))) {
      r.info('left unchanged');
      return;
    }
  }
  const steps = [...(current ? [claudeRemoveArgs(scope)] : []), claudeAddArgs(scope, nodePath, serverEntry)];
  if (!runClaudeCommands(deps, r, opts, claude, steps, { ...ctx, manual })) return;
  if (!opts.dryRun) r.ok(`registered '${CLAUDE_NAME}' (scope ${scope}); restart Claude Code to use it`);
}

if (isMain(import.meta.url)) {
  exitOnBrokenPipe();
  process.exitCode = await runInstall(process.argv.slice(2));
}
