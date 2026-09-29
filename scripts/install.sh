#!/usr/bin/env bash
#
# KitsuneMCP installer for macOS / Linux.
#
#   1. Checks prerequisites (Node.js >= 18, npm; Firefox is optional - warning only)
#   2. npm install + npm run build (skip with --skip-build)
#   3. Generates the Native Messaging host wrapper in ~/.kitsune-mcp/native-host/run-host.sh
#   4. Writes the host manifest kitsune_mcp.json where Firefox looks for it:
#        macOS: ~/Library/Application Support/Mozilla/NativeMessagingHosts/
#        Linux: ~/.mozilla/native-messaging-hosts/
#   5. Optionally registers the MCP server with Claude Code (claude mcp add)
#
# Safe to run repeatedly: existing files are overwritten and reported.
# Nothing is written inside the repository except the build output.
#
# Usage: scripts/install.sh [--skip-build] [--register-claude | --no-register-claude]
#                           [--claude-scope user|local|project]

set -euo pipefail

HOST_NAME="kitsune_mcp"
CLAUDE_NAME="kitsune-mcp"
MIN_NODE_MAJOR=18

SKIP_BUILD=0
REGISTER_CLAUDE=""   # "" = ask, "yes", "no"
CLAUDE_SCOPE="user"

usage() {
  # Print the header comment block (from line 3 to the first non-comment line)
  awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "$0"
}

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    [ok] %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    [warn] %s\n' "$1" >&2; }
fail() { printf '\n[error] %s\n' "$1" >&2; exit 1; }

# confirm "question" default(y|n) -> exit status 0 for yes
confirm() {
  local question="$1" default="$2" hint answer
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ ! -t 0 ]; then
    # Not interactive: take the default
    [ "$default" = "y" ]
    return
  fi
  read -r -p "    $question $hint " answer || answer=""
  if [ -z "$answer" ]; then answer="$default"; fi
  case "$answer" in
    [Yy]*) return 0 ;;
    *) return 1 ;;
  esac
}

# Quote a string for a POSIX shell script: 'it'\''s'
shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --register-claude)
      if [ "$REGISTER_CLAUDE" = "no" ]; then fail "--register-claude and --no-register-claude cannot be used together."; fi
      REGISTER_CLAUDE="yes" ;;
    --no-register-claude)
      if [ "$REGISTER_CLAUDE" = "yes" ]; then fail "--register-claude and --no-register-claude cannot be used together."; fi
      REGISTER_CLAUDE="no" ;;
    --claude-scope)
      [ $# -ge 2 ] || fail "--claude-scope needs a value (user, local or project)."
      CLAUDE_SCOPE="$2"; shift ;;
    --claude-scope=*) CLAUDE_SCOPE="${1#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
  shift
done

case "$CLAUDE_SCOPE" in
  user|local|project) ;;
  *) fail "--claude-scope must be user, local or project (got '$CLAUDE_SCOPE')." ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NATIVE_HOST_PKG="$REPO_ROOT/packages/native-host"
HOST_ENTRY="$NATIVE_HOST_PKG/dist/index.js"
SERVER_ENTRY="$REPO_ROOT/packages/mcp-server/dist/index.js"
EXT_MANIFEST="$REPO_ROOT/packages/extension/manifest.json"
DATA_DIR="$HOME/.kitsune-mcp"
INSTALL_DIR="$DATA_DIR/native-host"
WRAPPER_PATH="$INSTALL_DIR/run-host.sh"

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin) MOZ_HOSTS_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  Linux)  MOZ_HOSTS_DIR="$HOME/.mozilla/native-messaging-hosts" ;;
  *) fail "unsupported OS '$OS_NAME' (use scripts/install.ps1 on Windows)." ;;
esac
MANIFEST_PATH="$MOZ_HOSTS_DIR/$HOST_NAME.json"

echo "KitsuneMCP installer ($OS_NAME)"
echo "Repository: $REPO_ROOT"

# ---------------------------------------------------------------------------
step "Checking prerequisites"

NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || fail "Node.js was not found in PATH. Install Node.js $MIN_NODE_MAJOR or later: https://nodejs.org/"
# Resolve to an absolute path (command -v may return a relative one in odd PATHs)
NODE_BIN="$(cd "$(dirname "$NODE_BIN")" && pwd)/$(basename "$NODE_BIN")"
NODE_VERSION="$("$NODE_BIN" --version 2>/dev/null || true)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p')"
[ -n "$NODE_MAJOR" ] || fail "could not determine the Node.js version ('$NODE_VERSION' from $NODE_BIN)."
if [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  fail "Node.js $NODE_VERSION is too old (need >= $MIN_NODE_MAJOR): $NODE_BIN"
fi
ok "Node.js $NODE_VERSION ($NODE_BIN)"
case "$NODE_BIN" in
  */.nvm/*|*/.volta/*|*/.fnm/*|*/fnm/*|*/.asdf/*|*/mise/*)
    warn "node comes from a version manager; the wrapper pins this exact binary."
    warn "Re-run the installer after switching / removing this Node.js version." ;;
esac

NPM_BIN="$(command -v npm || true)"
if [ -z "$NPM_BIN" ]; then
  [ "$SKIP_BUILD" -eq 1 ] || fail "npm was not found in PATH (it normally ships with Node.js)."
  warn "npm was not found (not needed with --skip-build)."
else
  ok "npm ($NPM_BIN)"
fi

FIREFOX_FOUND=""
if [ "$OS_NAME" = "Darwin" ]; then
  for app in "/Applications/Firefox.app" "$HOME/Applications/Firefox.app" \
             "/Applications/Firefox Developer Edition.app" "/Applications/Firefox Nightly.app"; do
    if [ -d "$app" ]; then FIREFOX_FOUND="$app"; break; fi
  done
else
  for bin in firefox firefox-esr firefox-developer-edition firefox-nightly; do
    if command -v "$bin" >/dev/null 2>&1; then FIREFOX_FOUND="$(command -v "$bin")"; break; fi
  done
  if [ -d /snap/firefox ]; then
    warn "Firefox from Snap detected. Native Messaging for Snap Firefox needs the"
    warn "xdg-desktop-portal 'native messaging' support; it may not work."
  fi
  if command -v flatpak >/dev/null 2>&1 && flatpak info org.mozilla.firefox >/dev/null 2>&1; then
    warn "Firefox from Flatpak detected. The Flatpak sandbox does not read"
    warn "$MOZ_HOSTS_DIR and cannot start host programs outside it; use a"
    warn "distribution package or the tarball from mozilla.org instead."
  fi
fi
if [ -n "$FIREFOX_FOUND" ]; then
  ok "Firefox ($FIREFOX_FOUND)"
else
  warn "Firefox was not found. Continuing; install Firefox before loading the extension."
fi

# ---------------------------------------------------------------------------
if [ "$SKIP_BUILD" -eq 1 ]; then
  step "Skipping npm install / npm run build (--skip-build)"
else
  step "Installing dependencies (npm install)"
  (cd "$REPO_ROOT" && "$NPM_BIN" install) || fail "npm install failed."
  step "Building (npm run build)"
  (cd "$REPO_ROOT" && "$NPM_BIN" run build) || fail "npm run build failed."
fi

for f in "$HOST_ENTRY" "$SERVER_ENTRY"; do
  [ -f "$f" ] || fail "build output not found: $f (run without --skip-build)."
done
ok "build output present"

# ---------------------------------------------------------------------------
step "Reading the extension ID"

GECKO_ID="$("$NODE_BIN" -e '
const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const id = m && m.browser_specific_settings && m.browser_specific_settings.gecko && m.browser_specific_settings.gecko.id;
if (typeof id !== "string" || id.trim() === "") process.exit(2);
process.stdout.write(id);
' "$EXT_MANIFEST")" || fail "browser_specific_settings.gecko.id is missing or unreadable in $EXT_MANIFEST"
ok "gecko ID: $GECKO_ID"

# ---------------------------------------------------------------------------
step "Writing the Native Messaging host wrapper to $INSTALL_DIR"

mkdir -p "$DATA_DIR" "$INSTALL_DIR"
chmod 700 "$DATA_DIR" "$INSTALL_DIR" 2>/dev/null || true

# The absolute node path is embedded because Firefox may be started with a
# PATH that has no node in it (e.g. launched from the Dock / a desktop file).
# Logging is done by the host itself (FOX_NATIVE_HOST_LOG, default
# ~/.kitsune-mcp/logs/native-host.log). Nothing may be printed to stdout here:
# it is the Native Messaging channel. If that node is gone (Node.js upgraded
# / moved), fall back to the node on PATH instead of failing.
if [ -e "$WRAPPER_PATH" ]; then action="overwrote"; else action="created"; fi
tmp_wrapper="$(mktemp "$INSTALL_DIR/.run-host.XXXXXX")"
{
  printf '#!/bin/sh\n'
  printf '# Generated by KitsuneMCP scripts/install.sh. Re-run the installer to update.\n'
  printf 'cd %s || exit 1\n' "$(shell_quote "$NATIVE_HOST_PKG")"
  printf 'if [ -x %s ]; then exec %s %s "$@"; fi\n' \
    "$(shell_quote "$NODE_BIN")" "$(shell_quote "$NODE_BIN")" "$(shell_quote "$HOST_ENTRY")"
  printf 'exec node %s "$@"\n' "$(shell_quote "$HOST_ENTRY")"
} > "$tmp_wrapper"
chmod 700 "$tmp_wrapper"
mv -f "$tmp_wrapper" "$WRAPPER_PATH"
ok "$action $WRAPPER_PATH"

# ---------------------------------------------------------------------------
step "Registering with Firefox ($MANIFEST_PATH)"

mkdir -p "$MOZ_HOSTS_DIR"
if [ -e "$MANIFEST_PATH" ]; then action="overwrote"; else action="created"; fi
# JSON is produced by node so paths are escaped correctly.
"$NODE_BIN" -e '
const [out, name, wrapper, id] = process.argv.slice(1);
const manifest = {
  name,
  description: "KitsuneMCP Native Messaging Host",
  path: wrapper,
  type: "stdio",
  allowed_extensions: [id],
};
require("fs").writeFileSync(out, JSON.stringify(manifest, null, 2) + "\n");
' "$MANIFEST_PATH" "$HOST_NAME" "$WRAPPER_PATH" "$GECKO_ID"
chmod 644 "$MANIFEST_PATH"
ok "$action $MANIFEST_PATH"

# ---------------------------------------------------------------------------
step "Claude Code"

MANUAL_CMD="claude mcp add --scope $CLAUDE_SCOPE $CLAUDE_NAME -- node $(shell_quote "$SERVER_ENTRY")"
CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ]; then
  # Default location of the native installer, often missing from PATH
  CLAUDE_BIN="$HOME/.local/bin/claude"
fi

if [ -z "$CLAUDE_BIN" ]; then
  warn "'claude' was not found in PATH. Register manually later:"
  info "  $MANUAL_CMD"
elif [ "$REGISTER_CLAUDE" = "no" ]; then
  info "Skipped (--no-register-claude). To register manually:"
  info "  $MANUAL_CMD"
# 'local' / 'project' scopes belong to the current directory: run claude
# from the repository so they refer to it.
elif (cd "$REPO_ROOT" && "$CLAUDE_BIN" mcp get "$CLAUDE_NAME" >/dev/null 2>&1); then
  ok "'$CLAUDE_NAME' is already registered with Claude Code (left unchanged)."
  info "Check it with: claude mcp get $CLAUDE_NAME"
else
  do_register=0
  if [ "$REGISTER_CLAUDE" = "yes" ]; then
    do_register=1
  elif confirm "Register '$CLAUDE_NAME' with Claude Code (scope: $CLAUDE_SCOPE)?" y; then
    do_register=1
  fi
  if [ "$do_register" -eq 1 ]; then
    if (cd "$REPO_ROOT" && "$CLAUDE_BIN" mcp add --scope "$CLAUDE_SCOPE" "$CLAUDE_NAME" -- node "$SERVER_ENTRY"); then
      ok "registered '$CLAUDE_NAME' (scope: $CLAUDE_SCOPE)"
    else
      warn "claude mcp add failed. Register manually:"
      info "  $MANUAL_CMD"
    fi
  else
    info "Skipped. To register manually:"
    info "  $MANUAL_CMD"
  fi
fi

# ---------------------------------------------------------------------------
cat <<EOF

Installation complete.

Next steps:
  1. Load the extension in Firefox (temporary add-on):
       about:debugging#/runtime/this-firefox -> 'Load Temporary Add-on...'
       select: $EXT_MANIFEST
     Until the extension is signed by AMO it cannot be installed permanently;
     a temporary add-on is removed when Firefox restarts (load it again).
  2. Restart Claude Code so it picks up the MCP server.
  3. Check the connection (browsers_connected should be 1):
       curl -s http://127.0.0.1:8765/health
  Logs: $DATA_DIR/logs/native-host.log (Native Host), $DATA_DIR/logs/daemon.log (daemon)
  Uninstall: scripts/uninstall.sh
EOF
