/**
 * KitsuneMCP - Popup Script
 */

// SetupState is declared in background.ts: the extension's scripts are
// classic scripts, type-checked in one shared global scope.
interface StatusResponse {
  success: boolean;
  connected?: boolean;
  version?: string;
  setup?: SetupState;
  error?: string;
}

interface ScreenshotResponse {
  success: boolean;
  imageData?: string;
  error?: string;
}

interface PageInfoResponse {
  interactiveElements?: unknown[];
  [key: string]: unknown;
}

type ToastType = 'info' | 'success' | 'error' | 'warning';

type PillStyle = 'connected' | 'disconnected' | 'starting' | 'notice';

function updateStatus(style: PillStyle, text: string): void {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  const statusText = statusEl.querySelector('.status-text');
  if (!statusText) return;

  statusEl.classList.remove('connected', 'disconnected', 'starting', 'notice');
  statusEl.classList.add(style);
  statusText.textContent = text;
}

// ---------------------------------------------------------------------------
// Setup guidance
// ---------------------------------------------------------------------------

interface SetupGuide {
  title: string;
  text: string;
  command?: string;
  note?: string;
  /** Show the link to the installation guide. */
  link?: boolean;
  /** Yellow "notice" instead of red "problem". */
  notice?: boolean;
}

const LOG_DIR = '~/.kitsune-mcp/logs';

function installerCommand(os: string): string {
  return os === 'win' ? 'npm run install:windows' : 'npm run install:unix';
}

function guideFor(state: SetupState, os: string): SetupGuide | null {
  switch (state.kind) {
    case 'hostMissing':
      return {
        title: 'Setup needed',
        text:
          'Firefox cannot find the KitsuneMCP native host. Run the installer ' +
          'in your KitsuneMCP folder (a clone of the repository):',
        command: installerCommand(os),
        note: 'Then press Recheck.',
        link: true,
      };
    case 'hostError':
      return {
        title: 'Native host failed',
        text:
          `The native host is registered but did not work (${state.error}). ` +
          'Re-running the installer fixes the usual cause, a Node.js that was ' +
          'upgraded or moved:',
        command: installerCommand(os),
        note: `Details: ${LOG_DIR}/native-host.log`,
        link: true,
      };
    case 'daemonDown':
      return {
        title: 'MCP server not responding',
        text:
          'The native host runs, but the KitsuneMCP server does not answer' +
          (state.serverUrl ? ` at ${state.serverUrl}.` : '.'),
        note: `Details: ${LOG_DIR}/daemon.log`,
      };
    case 'noSession':
      return {
        title: 'Claude Code is not connected',
        text:
          'Firefox is ready. Either KitsuneMCP is not registered with Claude ' +
          'Code, or no Claude Code session is running. To register it:',
        command: state.registerCommand,
        note:
          'After registering, restart Claude Code. A running session shows ' +
          'up here within about 30 seconds.',
        // An older native host sends no command: point to the guide instead.
        link: state.registerCommand === undefined,
        notice: true,
      };
    case 'connecting':
    case 'ready':
      return null;
  }
}

function setHidden(id: string, hidden: boolean): void {
  const el = document.getElementById(id);
  if (el) el.hidden = hidden;
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function renderSetup(state: SetupState, os: string): void {
  switch (state.kind) {
    case 'connecting':
      updateStatus('starting', 'Connecting...');
      break;
    case 'noSession':
      updateStatus('notice', 'No session');
      break;
    case 'ready':
      updateStatus('connected', state.relays === 1 ? 'Connected' : `Connected (${state.relays})`);
      break;
    default:
      updateStatus('disconnected', 'Setup needed');
  }

  if ('serverUrl' in state && state.serverUrl) {
    setText('server-url', state.serverUrl.replace(/^https?:\/\//, ''));
  }

  const guide = guideFor(state, os);
  setHidden('setup', guide === null);
  if (guide === null) return;

  document.getElementById('setup')?.classList.toggle('notice', guide.notice === true);
  setText('setup-title', guide.title);
  setText('setup-text', guide.text);
  setHidden('setup-command', guide.command === undefined);
  setText('setup-command-text', guide.command ?? '');
  setHidden('setup-note', guide.note === undefined);
  setText('setup-note', guide.note ?? '');
  setHidden('setup-link', guide.link !== true);
}

async function queryStatus(recheck: boolean): Promise<SetupState> {
  try {
    const result = await browser.runtime.sendMessage({
      target: 'background',
      action: 'status',
      data: { recheck },
    }) as StatusResponse;
    return result?.setup ?? { kind: 'connecting' };
  } catch {
    return { kind: 'connecting' };
  }
}

/** Waits between polls while the background is still (re)connecting. */
const POLL_INTERVAL_MS = 1_000;
const MAX_POLLS = 4;

async function refreshStatus(os: string, recheck: boolean): Promise<void> {
  if (recheck) updateStatus('starting', 'Checking...');
  let state = await queryStatus(recheck);
  if (!recheck) renderSetup(state, os);
  // A recheck restarts the connection, so its own answer is stale: poll at
  // least once. Otherwise poll only while the background is still connecting.
  for (let i = 0; i < MAX_POLLS && ((recheck && i === 0) || state.kind === 'connecting'); i++) {
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
    state = await queryStatus(false);
  }
  renderSetup(state, os);
}

function showToast(message: string, type: ToastType = 'info'): void {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

document.addEventListener('DOMContentLoaded', async () => {
  const os = await browser.runtime.getPlatformInfo().then(info => info.os, () => '');

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const currentTab = tabs[0];

  if (currentTab) {
    const titleEl = document.querySelector('.tab-title');
    const urlEl = document.querySelector('.tab-url');
    if (titleEl) titleEl.textContent = currentTab.title || 'Untitled';
    if (urlEl) urlEl.textContent = currentTab.url || '-';
  }

  // Screenshot button
  const btnScreenshot = document.getElementById('btn-screenshot');
  if (btnScreenshot) {
    btnScreenshot.addEventListener('click', async () => {
      try {
        const result = await browser.runtime.sendMessage({
          target: 'background',
          action: 'screenshot',
        }) as ScreenshotResponse;

        if (result.success && result.imageData) {
          showToast('Screenshot captured!', 'success');
          const link = document.createElement('a');
          link.href = result.imageData;
          link.download = `screenshot-${Date.now()}.png`;
          link.click();
        } else {
          showToast(result.error || 'Screenshot failed', 'error');
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        showToast(msg, 'error');
      }
    });
  }

  // Page info button
  const btnPageinfo = document.getElementById('btn-pageinfo');
  if (btnPageinfo && currentTab) {
    btnPageinfo.addEventListener('click', async () => {
      try {
        const result = await browser.tabs.sendMessage(currentTab.id, {
          action: 'getPageInfo',
        }) as PageInfoResponse;

        console.log('Page Info:', result);
        const count = result.interactiveElements?.length ?? 0;
        showToast(`Found ${count} interactive elements`, 'success');

        await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
        showToast('Page info copied to clipboard!', 'success');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Unknown error';
        showToast(msg, 'error');
      }
    });
  }

  // Recheck button (retries the native host right away, e.g. after
  // running the installer)
  const btnTestConnection = document.getElementById('btn-test-connection');
  if (btnTestConnection) {
    btnTestConnection.addEventListener('click', () => {
      void refreshStatus(os, true);
    });
  }

  // Copy the setup command
  const btnCopyCommand = document.getElementById('btn-copy-command');
  if (btnCopyCommand) {
    btnCopyCommand.addEventListener('click', async () => {
      const command = document.getElementById('setup-command-text')?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(command);
        showToast('Copied!', 'success');
      } catch {
        showToast('Copy failed: select the command and copy it by hand', 'error');
      }
    });
  }

  void refreshStatus(os, false);
});
