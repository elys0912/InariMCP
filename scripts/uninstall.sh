#!/usr/bin/env bash
#
# KitsuneMCP uninstaller for macOS / Linux.
#
#   1. Offers to stop a running KitsuneMCP daemon (only after /health confirms
#      that the process on the port is a kitsune-mcp daemon)
#   2. Removes the Firefox host manifest kitsune_mcp.json
#   3. Removes ~/.kitsune-mcp/native-host/
#   4. Offers to remove the Claude Code registration (claude mcp remove)
#   5. With --purge, removes the rest of ~/.kitsune-mcp/ (api_token,
#      safety.json, logs, screenshots); otherwise lists what is left
#
# The repository itself is not touched; remove the extension in Firefox by hand.
#
# Usage: scripts/uninstall.sh [--purge] [--stop-daemon | --no-stop-daemon]
#                             [--unregister-claude | --no-unregister-claude]

set -euo pipefail

HOST_NAME="kitsune_mcp"
CLAUDE_NAME="kitsune-mcp"

PURGE=0
STOP_DAEMON=""        # "" = ask, "yes", "no"
UNREGISTER_CLAUDE=""  # "" = ask, "yes", "no"

usage() {
  # Print the header comment block (from line 3 to the first non-comment line)
  awk 'NR > 2 && /^#/ { sub(/^# ?/, ""); print; next } NR > 2 { exit }' "$0"
}

step() { printf '\n==> %s\n' "$1"; }
ok()   { printf '    [ok] %s\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '    [warn] %s\n' "$1" >&2; }
fail() { printf '\n[error] %s\n' "$1" >&2; exit 1; }

confirm() {
  local question="$1" default="$2" hint answer
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  if [ ! -t 0 ]; then
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

set_flag() {
  # set_flag VAR value conflicting-option-name
  local current
  current="${!1}"
  if [ -n "$current" ] && [ "$current" != "$2" ]; then
    fail "conflicting options (see --help): $3"
  fi
  printf -v "$1" '%s' "$2"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1 ;;
    --stop-daemon) set_flag STOP_DAEMON yes "--stop-daemon / --no-stop-daemon" ;;
    --no-stop-daemon) set_flag STOP_DAEMON no "--stop-daemon / --no-stop-daemon" ;;
    --unregister-claude) set_flag UNREGISTER_CLAUDE yes "--unregister-claude / --no-unregister-claude" ;;
    --no-unregister-claude) set_flag UNREGISTER_CLAUDE no "--unregister-claude / --no-unregister-claude" ;;
    -h|--help) usage; exit 0 ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
  shift
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$HOME/.kitsune-mcp"
INSTALL_DIR="$DATA_DIR/native-host"

OS_NAME="$(uname -s)"
case "$OS_NAME" in
  Darwin) MOZ_HOSTS_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  Linux)  MOZ_HOSTS_DIR="$HOME/.mozilla/native-messaging-hosts" ;;
  *) fail "unsupported OS '$OS_NAME' (use scripts/uninstall.ps1 on Windows)." ;;
esac
MANIFEST_PATH="$MOZ_HOSTS_DIR/$HOST_NAME.json"

# Same resolution as the daemon: FOX_HTTP_PORT, legacy CLAUDE_BROWSER_HTTP_PORT, 8765
PORT="${FOX_HTTP_PORT:-${CLAUDE_BROWSER_HTTP_PORT:-8765}}"
case "$PORT" in
  ''|*[!0-9]*) PORT=8765 ;;
esac

echo "KitsuneMCP uninstaller ($OS_NAME)"

# ---------------------------------------------------------------------------
step "Checking for a running daemon (127.0.0.1:$PORT)"

health=""
if command -v curl >/dev/null 2>&1; then
  health="$(curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null || true)"
else
  warn "curl not found - cannot check for a running daemon"
fi

# The daemon answers with compact JSON: {"status":"ok","service":"kitsune-mcp",...}
if [ -z "$health" ]; then
  ok "no daemon is answering"
elif ! printf '%s' "$health" | grep -q '"service"[[:space:]]*:[[:space:]]*"kitsune-mcp"'; then
  warn "port $PORT answers /health but is not a kitsune-mcp daemon - leaving it alone"
else
  info "kitsune-mcp daemon is running"
  pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  elif command -v ss >/dev/null 2>&1; then
    pids="$(ss -ltnpH "sport = :$PORT" 2>/dev/null | sed -n 's/.*pid=\([0-9][0-9]*\).*/\1/p' | sort -u | tr '\n' ' ' || true)"
  fi
  pids="${pids% }"

  if [ -z "$pids" ]; then
    warn "could not find the process listening on port $PORT (needs lsof or ss); stop it manually if needed"
  elif [ "$STOP_DAEMON" = "no" ]; then
    info "left running (--no-stop-daemon). PID(s): $pids"
  else
    do_stop=0
    if [ "$STOP_DAEMON" = "yes" ]; then
      do_stop=1
    elif confirm "Stop the daemon (PID $pids)? Claude Code sessions using it lose the browser tools." y; then
      do_stop=1
    fi
    if [ "$do_stop" -eq 1 ]; then
      for pid in $pids; do
        comm="$(ps -p "$pid" -o comm= 2>/dev/null || true)"
        case "$comm" in
          *node*)
            if kill "$pid" 2>/dev/null; then ok "stopped daemon (PID $pid)"; else warn "could not stop PID $pid"; fi ;;
          *)
            warn "PID $pid is '$comm', not node - not stopping it" ;;
        esac
      done
    else
      info "left running"
    fi
  fi
fi

# A Native Host still running (Firefox with the extension loaded) restarts
# the daemon on its own; tell the user.
if command -v pgrep >/dev/null 2>&1; then
  host_pids="$(pgrep -f 'native-host/dist/index\.js' 2>/dev/null | tr '\n' ' ' || true)"
  host_pids="${host_pids% }"
  if [ -n "$host_pids" ]; then
    warn "a KitsuneMCP Native Host is still running (PID $host_pids)."
    warn "Remove the extension in Firefox (or restart Firefox); otherwise it may start the daemon again."
  fi
fi

# ---------------------------------------------------------------------------
step "Removing the Firefox registration"

if [ -e "$MANIFEST_PATH" ]; then
  rm -f "$MANIFEST_PATH"
  ok "removed $MANIFEST_PATH"
else
  ok "not present: $MANIFEST_PATH"
fi

# ---------------------------------------------------------------------------
step "Removing $INSTALL_DIR"

if [ -d "$INSTALL_DIR" ]; then
  for f in "$INSTALL_DIR"/* "$INSTALL_DIR"/.[!.]*; do
    if [ -e "$f" ]; then info "delete: $f"; fi
  done
  rm -rf "$INSTALL_DIR"
  ok "removed"
else
  ok "not present"
fi

# ---------------------------------------------------------------------------
step "Claude Code"

CLAUDE_BIN="$(command -v claude || true)"
if [ -z "$CLAUDE_BIN" ] && [ -x "$HOME/.local/bin/claude" ]; then
  CLAUDE_BIN="$HOME/.local/bin/claude"
fi

if [ -z "$CLAUDE_BIN" ]; then
  info "'claude' was not found. If you registered KitsuneMCP, remove it with:"
  info "  claude mcp remove $CLAUDE_NAME"
elif [ "$UNREGISTER_CLAUDE" = "no" ]; then
  info "Skipped (--no-unregister-claude). To remove it: claude mcp remove $CLAUDE_NAME"
# Run from the repository so local/project scopes refer to it.
elif ! (cd "$REPO_ROOT" && "$CLAUDE_BIN" mcp get "$CLAUDE_NAME" >/dev/null 2>&1); then
  ok "'$CLAUDE_NAME' is not registered (as seen from $REPO_ROOT)"
  info "If it was added with scope local in another directory, run 'claude mcp remove $CLAUDE_NAME' there."
else
  do_remove=0
  if [ "$UNREGISTER_CLAUDE" = "yes" ]; then
    do_remove=1
  elif confirm "Remove '$CLAUDE_NAME' from Claude Code?" y; then
    do_remove=1
  fi
  if [ "$do_remove" -eq 1 ]; then
    if (cd "$REPO_ROOT" && "$CLAUDE_BIN" mcp remove "$CLAUDE_NAME"); then
      ok "removed '$CLAUDE_NAME'"
    else
      warn "claude mcp remove failed."
      info "If it exists in several scopes, run: claude mcp remove $CLAUDE_NAME --scope <user|local|project>"
    fi
  else
    info "left registered"
  fi
fi

# ---------------------------------------------------------------------------
step "Data directory $DATA_DIR"

if [ ! -d "$DATA_DIR" ]; then
  ok "not present"
elif [ "$PURGE" -eq 1 ]; then
  for f in "$DATA_DIR"/* "$DATA_DIR"/.[!.]*; do
    if [ -e "$f" ]; then info "delete: $f"; fi
  done
  rm -rf "$DATA_DIR"
  ok "removed (--purge)"
else
  has_left=0
  for f in "$DATA_DIR"/* "$DATA_DIR"/.[!.]*; do
    if [ -e "$f" ]; then has_left=1; break; fi
  done
  if [ "$has_left" -eq 0 ]; then
    rmdir "$DATA_DIR"
    ok "empty - removed"
  else
    info "kept (run with --purge to delete):"
    for f in "$DATA_DIR"/* "$DATA_DIR"/.[!.]*; do
      if [ -e "$f" ]; then info "  $(basename "$f")"; fi
    done
  fi
fi

cat <<EOF

Uninstall complete.
Remove the extension in Firefox as well (about:addons, or about:debugging for a temporary add-on).
The repository ($REPO_ROOT) was not modified.
EOF
