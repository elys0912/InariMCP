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
        title: t('setupHostMissingTitle'),
        text: t('setupHostMissingText'),
        command: installerCommand(os),
        note: t('setupHostMissingNote'),
        link: true,
      };
    case 'hostError':
      return {
        title: t('setupHostErrorTitle'),
        text: t('setupHostErrorText', state.error),
        command: installerCommand(os),
        note: t('setupDetails', `${LOG_DIR}/native-host.log`),
        link: true,
      };
    case 'hostOutdated':
      return {
        title: t('setupHostOutdatedTitle'),
        text: t('setupHostOutdatedText'),
        // Windows PowerShell 5.1 has no &&
        command: os === 'win' ? 'git pull; npm run build' : 'git pull && npm run build',
        note: t('setupHostOutdatedNote'),
        notice: true,
      };
    case 'daemonDown':
      return {
        title: t('setupDaemonDownTitle'),
        text: state.serverUrl
          ? t('setupDaemonDownTextAt', state.serverUrl)
          : t('setupDaemonDownText'),
        note: t('setupDetails', `${LOG_DIR}/daemon.log`),
      };
    case 'noSession':
      return {
        title: t('setupNoSessionTitle'),
        text: t('setupNoSessionText'),
        command: state.registerCommand,
        note: t('setupNoSessionNote'),
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
      updateStatus('starting', t('statusConnecting'));
      break;
    case 'noSession':
      updateStatus('notice', t('statusNoSession'));
      break;
    case 'hostOutdated':
      updateStatus('notice', t('statusUpdateNeeded'));
      break;
    case 'ready':
      updateStatus(
        'connected',
        state.relays === 1 ? t('statusConnected') : t('statusConnectedN', String(state.relays)),
      );
      break;
    default:
      updateStatus('disconnected', t('statusSetupNeeded'));
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
  if (recheck) updateStatus('starting', t('statusChecking'));
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

/** Fill every [data-i18n] element with its localized message. */
function localizePage(): void {
  document.documentElement.lang = browser.i18n.getUILanguage();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  localizePage();
  const os = await browser.runtime.getPlatformInfo().then(info => info.os, () => '');

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const currentTab = tabs[0];

  if (currentTab) {
    const titleEl = document.querySelector('.tab-title');
    const urlEl = document.querySelector('.tab-url');
    if (titleEl) titleEl.textContent = currentTab.title || t('popupUntitled');
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
          showToast(t('toastScreenshotCaptured'), 'success');
          const link = document.createElement('a');
          link.href = result.imageData;
          link.download = `screenshot-${Date.now()}.png`;
          link.click();
        } else {
          showToast(result.error || t('toastScreenshotFailed'), 'error');
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : t('toastUnknownError');
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
        showToast(t('toastFoundElements', String(count)), 'success');

        await navigator.clipboard.writeText(JSON.stringify(result, null, 2));
        showToast(t('toastPageInfoCopied'), 'success');
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : t('toastUnknownError');
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
        showToast(t('toastCopied'), 'success');
      } catch {
        showToast(t('toastCopyFailed'), 'error');
      }
    });
  }

  void refreshStatus(os, false);
});
