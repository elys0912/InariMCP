/**
 * KitsuneMCP - Popup Script
 */

interface StatusResponse {
  success: boolean;
  status?: string;
  version?: string;
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

function updateStatus(connected: boolean, customText: string | null = null): void {
  const statusEl = document.getElementById('status');
  if (!statusEl) return;
  const statusText = statusEl.querySelector('.status-text');
  if (!statusText) return;

  statusEl.classList.remove('connected', 'disconnected', 'starting');

  if (customText) {
    statusEl.classList.add('starting');
    statusText.textContent = customText;
  } else if (connected) {
    statusEl.classList.add('connected');
    statusText.textContent = 'Connected';
  } else {
    statusEl.classList.add('disconnected');
    statusText.textContent = 'Disconnected';
  }
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

async function checkConnection(): Promise<void> {
  try {
    const result = await browser.runtime.sendMessage({
      target: 'background',
      action: 'status',
    }) as StatusResponse;

    if (result && result.success) {
      updateStatus(true);
    } else {
      updateStatus(false);
      tryAutoStart();
    }
  } catch {
    updateStatus(false);
    tryAutoStart();
  }
}

async function tryAutoStart(): Promise<void> {
  try {
    updateStatus(false, 'Starting...');

    await browser.runtime.sendMessage({
      target: 'background',
      action: 'status',
    });

    await new Promise(resolve => setTimeout(resolve, 2500));

    const result = await browser.runtime.sendMessage({
      target: 'background',
      action: 'status',
    }) as StatusResponse;

    if (result && result.success) {
      updateStatus(true);
    } else {
      updateStatus(false);
    }
  } catch {
    updateStatus(false);
    console.log('Auto-start failed');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
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

  // Test connection button
  const btnTestConnection = document.getElementById('btn-test-connection');
  if (btnTestConnection) {
    btnTestConnection.addEventListener('click', async () => {
      showToast('Checking MCP server...', 'info');

      try {
        const result = await browser.runtime.sendMessage({
          target: 'background',
          action: 'status',
        }) as StatusResponse;

        if (result && result.success) {
          updateStatus(true);
          const ver = result.version ? ` v${result.version}` : '';
          showToast(`Connected!${ver}`, 'success');
        } else {
          throw new Error('Server not responding');
        }
      } catch {
        showToast('Starting MCP server via native host...', 'info');
        updateStatus(false, 'Starting...');

        try {
          await browser.runtime.sendMessage({
            target: 'background',
            action: 'status',
          });

          await new Promise(resolve => setTimeout(resolve, 2000));

          const retryResult = await browser.runtime.sendMessage({
            target: 'background',
            action: 'status',
          }) as StatusResponse;

          if (retryResult && retryResult.success) {
            updateStatus(true);
            showToast('Server started!', 'success');
          } else {
            updateStatus(false);
            showToast('Server started but not responding yet', 'warning');
          }
        } catch (nativeError: unknown) {
          updateStatus(false);
          showToast('Failed to start server. Check native host.', 'error');
          console.error('Native host error:', nativeError);
        }
      }
    });
  }

  checkConnection();
});
