/**
 * --help and --manual texts of scripts/install.mjs and scripts/uninstall.mjs.
 *
 * The manual steps are the fallback when the scripts cannot run (review 8
 * "no manual procedure"); `--manual` prints them as Markdown for the README,
 * `--help` prints the ones for the current OS with this machine's paths.
 */

import { CLAUDE_NAME, DEFAULT_HTTP_PORT, HOST_NAME, WIN_REG_KEY, shellQuote } from './core.mjs';

const WIN = {
  repo: 'C:\\path\\to\\InariMCP',
  node: 'C:\\Program Files\\nodejs\\node.exe',
  data: '%USERPROFILE%\\.inari-mcp',
};
/**
 * macOS / Linux values are shell words, already quoted (shellQuote for real
 * paths), so `${v.data}/native-host` stays one word even with a space or a
 * quote in the path.
 */
const UNIX = {
  repo: shellQuote('/path/to/InariMCP'),
  node: shellQuote('/usr/local/bin/node'),
  data: '"$HOME/.inari-mcp"',
};

function manualInstallWindows(v) {
  return `### Windows (without PowerShell)

1. Build: \`npm ci\` and \`npm run build\` in the repository.
2. Create the folder \`${v.data}\\native-host\`.
3. Create \`${v.data}\\native-host\\run-host.cmd\` (use full paths; write \`%%\` for a \`%\` in a path):
   \`\`\`bat
   @echo off
   cd /d "${v.repo}\\packages\\native-host"
   "${v.node}" "${v.repo}\\packages\\native-host\\dist\\index.js" %*
   \`\`\`
4. Copy \`packages\\native-host\\${HOST_NAME}.json\` to \`${v.data}\\native-host\\${HOST_NAME}.json\` and set
   \`"path"\` to the full path of \`run-host.cmd\` (JSON: write each \`\\\` as \`\\\\\`).
5. Register it for Firefox (every edition reads this key):
   \`\`\`bat
   reg add "${WIN_REG_KEY}" /ve /t REG_SZ /d "${v.data}\\native-host\\${HOST_NAME}.json" /f
   \`\`\`
6. Optional, Claude Code: \`claude mcp add --scope user ${CLAUDE_NAME} -- "${v.node}" "${v.repo}\\packages\\mcp-server\\dist\\index.js"\`
`;
}

function manualInstallUnix(v) {
  return `### macOS / Linux

1. Build: \`npm ci\` and \`npm run build\` in the repository.
2. \`mkdir -p ${v.data}/native-host && chmod 700 ${v.data} ${v.data}/native-host\`
3. Create \`${v.data}/native-host/run-host.sh\` and \`chmod 700\` it:
   \`\`\`sh
   #!/bin/sh
   cd ${v.repo}/packages/native-host || exit 1
   exec ${v.node} ${v.repo}/packages/native-host/dist/index.js "$@"
   \`\`\`
4. Copy \`packages/native-host/${HOST_NAME}.json\`, set \`"path"\` to the full path of \`run-host.sh\`, and save it as
   - macOS: \`~/Library/Application Support/Mozilla/NativeMessagingHosts/${HOST_NAME}.json\`
   - Linux: \`~/.mozilla/native-messaging-hosts/${HOST_NAME}.json\`
     (Snap Firefox also \`~/snap/firefox/common/.mozilla/native-messaging-hosts/\`;
     Flatpak Firefox also \`~/.var/app/org.mozilla.firefox/.mozilla/native-messaging-hosts/\` and
     \`widget.use-xdg-desktop-portal.native-messaging = 1\` in about:config)
5. Optional, Claude Code: \`claude mcp add --scope user ${CLAUDE_NAME} -- ${v.node} ${v.repo}/packages/mcp-server/dist/index.js\`
`;
}

function manualUninstallWindows(v) {
  return `### Windows (without PowerShell)

Order matters: while the host is registered and Firefox runs the extension,
the Native Host starts the daemon again (and recreates the token and logs).

1. \`reg delete "${WIN_REG_KEY}" /f\`
2. \`rmdir /s /q "${v.data}\\native-host"\`
3. \`claude mcp remove --scope user ${CLAUDE_NAME}\` (and \`--scope local\` / \`project\` if used)
4. Remove the extension in Firefox (about:addons, or about:debugging for a temporary add-on), or quit Firefox.
5. Stop the daemon: \`"${v.node}" "${v.repo}\\packages\\mcp-server\\dist\\index.js" --stop-daemon\`.
   Without the API token: \`netstat -ano | findstr :${v.port ?? DEFAULT_HTTP_PORT}\` shows the PID in the LISTENING line; \`taskkill /PID <pid> /F\`.
   Close Claude Code sessions that still use InariMCP (they start the daemon again on the next tool call).
6. Optional: \`rmdir /s /q "${v.data}"\` (API token, safety.json, logs, screenshots).
`;
}

function manualUninstallUnix(v) {
  return `### macOS / Linux

Order matters: while the host is registered and Firefox runs the extension,
the Native Host starts the daemon again (and recreates the token and logs).

1. Delete \`${HOST_NAME}.json\` from every Native Messaging directory listed in the install steps.
2. \`rm -rf ${v.data}/native-host\`
3. \`claude mcp remove --scope user ${CLAUDE_NAME}\` (and \`--scope local\` / \`project\` if used)
4. Remove the extension in Firefox (about:addons, or about:debugging for a temporary add-on), or quit Firefox.
5. Stop the daemon: \`${v.node} ${v.repo}/packages/mcp-server/dist/index.js --stop-daemon\`.
   Without the API token: \`kill $(lsof -tiTCP:${v.port ?? DEFAULT_HTTP_PORT} -sTCP:LISTEN)\` (or find the PID with \`ss -ltnp 'sport = :${v.port ?? DEFAULT_HTTP_PORT}'\`).
   Close Claude Code sessions that still use InariMCP (they start the daemon again on the next tool call).
6. Optional: \`rm -rf ${v.data}\` (API token, safety.json, logs, screenshots).
`;
}

/** README text: both OS families, placeholder paths. */
export function manualMarkdown(kind) {
  const title = kind === 'install' ? '## Manual installation' : '## Manual uninstallation';
  const body = kind === 'install'
    ? [manualInstallWindows(WIN), manualInstallUnix(UNIX)]
    : [manualUninstallWindows(WIN), manualUninstallUnix(UNIX)];
  return `${title}\n\n${body.join('\n')}`;
}

/**
 * Manual steps for one platform with this machine's paths.
 * @param {{repoRoot: string, nodePath: string, dataDir: string, port?: number}} v
 */
export function manualForPlatform(kind, platform, v) {
  if (platform === 'win32') {
    const vars = { repo: v.repoRoot, node: v.nodePath, data: v.dataDir, port: v.port };
    return kind === 'install' ? manualInstallWindows(vars) : manualUninstallWindows(vars);
  }
  const vars = { repo: shellQuote(v.repoRoot), node: shellQuote(v.nodePath), data: shellQuote(v.dataDir), port: v.port };
  return kind === 'install' ? manualInstallUnix(vars) : manualUninstallUnix(vars);
}

export function installUsage() {
  return `Usage: node scripts/install.mjs [options]      (npm run setup -- [options])

Registers the InariMCP Native Messaging host for Firefox (Windows / macOS /
Linux, no PowerShell needed) and, on request, the MCP server with Claude Code.
Safe to run again: unchanged files and registrations are left alone.

  1. checks Node.js (>= 20) and the build output (packages/*/dist)
  2. creates ~/.inari-mcp/native-host/ with the host wrapper (run-host.cmd / run-host.sh)
  3. writes ${HOST_NAME}.json where Firefox reads it
       Windows: ~/.inari-mcp/native-host/${HOST_NAME}.json + registry ${WIN_REG_KEY}
       macOS:   ~/Library/Application Support/Mozilla/NativeMessagingHosts/
       Linux:   ~/.mozilla/native-messaging-hosts/ (+ XDG / Snap / Flatpak directories when present)
  4. with --register-claude: claude mcp add --scope <scope> ${CLAUDE_NAME} -- <node> <server entry>

Options:
  -n, --dry-run            show what would change; change nothing
  -y, --yes                answer yes to every question (no prompts)
      --register-claude    register the MCP server with Claude Code (default: print the command)
      --claude-scope S     user (default), local or project
      --node PATH          node executable to register (default: the one running this script)
      --build              run "npm install" and "npm run build" first
      --manual             print the manual installation steps (Markdown) and exit
  -h, --help               this help

Questions are asked only when stdin is a terminal; otherwise the default answer is used.
Compatibility: --skip-build (default now) and --no-register-claude are accepted.
`;
}

export function uninstallUsage() {
  return `Usage: node scripts/uninstall.mjs [options]    (npm run teardown -- [options])

Removes the InariMCP registration, in an order that keeps it removed:
  1. removes the Firefox Native Messaging registration (registry key / manifest files),
     so the extension cannot start the Native Host again
  2. removes ~/.inari-mcp/native-host/ (host wrapper)
  3. removes the Claude Code registration (--unregister-claude, or when confirmed)
  4. stops this repository's Native Host processes, then the daemon: over its signed
     POST /daemon/shutdown when ~/.inari-mcp/api_token is present (running calls finish,
     Firefox is closed), else SIGTERM, then SIGKILL after --grace seconds (Windows cannot
     signal gracefully)
  5. with --purge: deletes ~/.inari-mcp/ (API token, safety.json, logs, screenshots)
The repository and the Firefox extension are not touched (remove the extension in Firefox).

Options:
  -n, --dry-run            show what would change; change nothing
  -y, --yes                answer yes to every question (includes removing the Claude Code registration)
      --unregister-claude  remove the Claude Code registration without asking
      --keep-claude        keep the Claude Code registration
      --no-stop            do not stop running processes
      --grace SECONDS      wait before SIGKILL (default 5)
      --purge              also delete ~/.inari-mcp/
      --manual             print the manual uninstallation steps (Markdown) and exit
  -h, --help               this help

Questions are asked only when stdin is a terminal; otherwise the default answer is used.
Compatibility: --stop-daemon, --no-stop-daemon and --no-unregister-claude are accepted.
`;
}
