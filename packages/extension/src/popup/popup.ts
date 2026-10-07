/**
 * KitsuneMCP - Popup Script
 */

import { t } from '../i18n';
import { APPROVAL_MESSAGE, type ApprovalView } from '../approval';
import { TOP_FRAME_ID } from '../background/constants';
import type { ContentRequest } from '../content/types';
import type { SetupState } from '../types/setup';
import { setupStateOfReply, setupStateOfFailure } from './setup-status';

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
  return os === 'win'
    ? 'npm ci; npm run build; npm run setup'
    : 'npm ci && npm run build && npm run setup';
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
        // Pull, rebuild, and let the installer (scripts/install.mjs, which
        // does not build) rewrite the Native Host. Windows PowerShell 5.1 has no &&.
        command: `git pull${os === 'win' ? ';' : ' &&'} ${installerCommand(os)}`,
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
    case 'hostMissing':
    case 'hostError':
    case 'daemonDown':
      updateStatus('disconnected', t('statusSetupNeeded'));
      break;
    default: {
      // Every kind is handled above: a new one must be added here.
      const unhandled: never = state;
      void unhandled;
    }
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
    }) as StatusResponse | undefined;
    return setupStateOfReply(result);
  } catch (error: unknown) {
    return setupStateOfFailure(error);
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

/** How long a toast stays. */
const TOAST_MS = 3_000;

function showToast(message: string, type: ToastType = 'info'): void {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), TOAST_MS);
}

// ---------------------------------------------------------------------------
// Approval requests
// ---------------------------------------------------------------------------
//
// The background keeps approval requests (request_approval commands) until
// they are answered here. Pages and content scripts cannot reach this popup,
// so a decision made here is the human's. ApprovalView / APPROVAL_MESSAGE:
// approval.ts.

interface ApprovalListResponse {
  success: boolean;
  approvals?: ApprovalView[];
}

const APPROVAL_POLL_MS = 1_000;
const MS_PER_SECOND = 1_000;

/** Whole seconds until the background stops waiting for `view` (0 once past). */
function secondsLeft(view: ApprovalView): string {
  return String(Math.max(0, Math.round((view.deadline - Date.now()) / MS_PER_SECOND)));
}

/** The countdown line under a request. */
function approvalNoteText(view: ApprovalView): string {
  return view.kind === 'protected_action'
    ? t('approvalProtectedNote', secondsLeft(view))
    : t('approvalMessageNote', secondsLeft(view));
}

function approvalRow(label: string, value: string, mono = false): HTMLElement {
  const row = document.createElement('div');
  row.className = 'approval-row';
  const key = document.createElement('span');
  key.className = 'approval-key';
  key.textContent = label;
  const val = document.createElement(mono ? 'pre' : 'span');
  val.className = mono ? 'approval-value mono' : 'approval-value';
  val.textContent = value;
  row.append(key, val);
  return row;
}

function approvalCard(view: ApprovalView, onDecide: (id: string, approved: boolean) => void): HTMLElement {
  const card = document.createElement('div');
  card.className = `approval-card ${view.kind}`;

  const title = document.createElement('p');
  title.className = 'approval-title';
  title.textContent = view.kind === 'protected_action' ? t('approvalProtectedTitle') : t('approvalMessageTitle');
  card.appendChild(title);

  if (view.kind === 'protected_action') {
    card.appendChild(approvalRow(t('approvalSite'), view.host ?? ''));
    card.appendChild(approvalRow(t('approvalTool'), view.toolName ?? ''));
    if (view.url) card.appendChild(approvalRow(t('approvalPage'), view.url));
    if (view.matchedPattern) card.appendChild(approvalRow(t('approvalPattern'), view.matchedPattern));
    if (view.summary) card.appendChild(approvalRow(t('approvalArgs'), view.summary, true));
  } else {
    const message = document.createElement('p');
    message.className = 'approval-message';
    message.textContent = view.message || t('notifyApprovalDefault');
    card.appendChild(message);
    if (view.detail) {
      const detail = document.createElement('p');
      detail.className = 'approval-detail';
      detail.textContent = view.detail;
      card.appendChild(detail);
    }
  }

  const note = document.createElement('p');
  note.className = 'approval-note';
  note.textContent = approvalNoteText(view);
  card.appendChild(note);

  const buttons = document.createElement('div');
  buttons.className = 'approval-buttons';
  const approve = document.createElement('button');
  approve.className = 'btn-approve';
  approve.textContent = t('approvalApprove');
  approve.addEventListener('click', () => onDecide(view.id, true));
  const deny = document.createElement('button');
  deny.className = 'btn-deny';
  deny.textContent = t('approvalDeny');
  deny.addEventListener('click', () => onDecide(view.id, false));
  buttons.append(deny, approve);
  card.appendChild(buttons);
  return card;
}

/**
 * Buttons of a newly shown request stay disabled this long, so a click
 * meant for the previous request (or made while the card changes) cannot
 * land on a different one.
 */
const APPROVAL_ARM_DELAY_MS = 800;

/** The request on screen, since when, and how many others are queued. */
let shownApproval: { id: string; more: number; shownAt: number } | null = null;

/**
 * Show the oldest pending request (one at a time: the buttons never move
 * under the cursor), with a count of the others. The card is rebuilt only
 * when the request on screen changes; otherwise just the countdown updates.
 */
async function refreshApprovals(): Promise<void> {
  let approvals: ApprovalView[] = [];
  try {
    const reply = await browser.runtime.sendMessage({ type: APPROVAL_MESSAGE.LIST }) as ApprovalListResponse;
    approvals = reply?.success && Array.isArray(reply.approvals) ? reply.approvals : [];
  } catch {
    approvals = [];
  }

  const list = document.getElementById('approval-list');
  setHidden('approvals', approvals.length === 0);
  if (!list) return;
  const view = approvals[0];
  if (!view) {
    shownApproval = null;
    list.replaceChildren();
    return;
  }

  const more = approvals.length - 1;
  if (shownApproval?.id === view.id && shownApproval.more === more) {
    const note = list.querySelector('.approval-note');
    if (note) note.textContent = approvalNoteText(view);
    return;
  }

  const shownAt = shownApproval?.id === view.id ? shownApproval.shownAt : Date.now();
  shownApproval = { id: view.id, more, shownAt };
  const card = approvalCard(view, (id, approved) => { void decide(id, approved); });
  const armIn = shownAt + APPROVAL_ARM_DELAY_MS - Date.now();
  if (armIn > 0) {
    const buttons = card.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    setTimeout(() => buttons.forEach((b) => { b.disabled = false; }), armIn);
  }
  const children: HTMLElement[] = [card];
  if (more > 0) {
    const queued = document.createElement('p');
    queued.className = 'approval-queued';
    queued.textContent = t('approvalMore', String(more));
    children.push(queued);
  }
  list.replaceChildren(...children);
}

async function decide(id: string, approved: boolean): Promise<void> {
  try {
    const reply = await browser.runtime.sendMessage({
      type: APPROVAL_MESSAGE.DECIDE,
      id,
      approved,
    }) as { success?: boolean; error?: string };
    if (!reply?.success) showToast(reply?.error || t('toastApprovalGone'), 'warning');
  } catch (error: unknown) {
    showToast(error instanceof Error ? error.message : t('toastUnknownError'), 'error');
  }
  await refreshApprovals();
}

/** Fill every [data-i18n] element with its localized message. */
function localizePage(): void {
  document.documentElement.lang = browser.i18n.getUILanguage();
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n;
    if (key) el.textContent = t(key);
  });
}

/** The active tab's title and URL at the top of the popup. */
function showCurrentTab(tab: browser.tabs.Tab): void {
  const titleEl = document.querySelector('.tab-title');
  const urlEl = document.querySelector('.tab-url');
  if (titleEl) titleEl.textContent = tab.title || t('popupUntitled');
  if (urlEl) urlEl.textContent = tab.url || '-';
}

/** Screenshot button: capture through the background and download the image. */
function setupScreenshotButton(): void {
  document.getElementById('btn-screenshot')?.addEventListener('click', async () => {
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

/** Page info button: copy the page info of `tab` (top frame) to the clipboard. */
function setupPageInfoButton(tab: browser.tabs.Tab): void {
  document.getElementById('btn-pageinfo')?.addEventListener('click', async () => {
    try {
      const result = await browser.tabs.sendMessage(
        tab.id,
        { action: 'getPageInfo' } satisfies ContentRequest,
        { frameId: TOP_FRAME_ID },
      ) as PageInfoResponse;

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

/** Copy button of the setup command. */
function setupCopyCommandButton(): void {
  document.getElementById('btn-copy-command')?.addEventListener('click', async () => {
    const command = document.getElementById('setup-command-text')?.textContent ?? '';
    try {
      await navigator.clipboard.writeText(command);
      showToast(t('toastCopied'), 'success');
    } catch {
      showToast(t('toastCopyFailed'), 'error');
    }
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  localizePage();
  const os = await browser.runtime.getPlatformInfo().then(info => info.os, () => '');

  // A failed query only leaves the tab line empty: the buttons and the
  // approval poll below must still be set up.
  const tabs = await browser.tabs
    .query({ active: true, currentWindow: true })
    .catch((): browser.tabs.Tab[] => []);
  const currentTab = tabs[0];

  if (currentTab) showCurrentTab(currentTab);
  setupScreenshotButton();
  if (currentTab) setupPageInfoButton(currentTab);
  // Recheck button: retries the native host right away (e.g. after running
  // the installer).
  document.getElementById('btn-test-connection')?.addEventListener('click', () => {
    void refreshStatus(os, true);
  });
  setupCopyCommandButton();

  void refreshStatus(os, false);

  // Pending approval requests: shown first, refreshed while the popup is open
  // (new requests arrive, others time out).
  void refreshApprovals();
  setInterval(() => { void refreshApprovals(); }, APPROVAL_POLL_MS);
});
