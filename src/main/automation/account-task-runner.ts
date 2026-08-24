import { BrowserWindow, session } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from '../nest/automation/automation.interface';
import { AccountInfo, AccountStatus, SeedingStateChange } from './types';
import {
  AccountSessionUpdate,
  attachProxyAuthHandler,
  configureSessionProxyAndCookies,
  hasTikTokSessionCookie,
  isTikTokCookie,
  persistTikTokSessionCookies,
} from './session-profile';
import {
  SeedingCancelledError,
  getSeedingCancelReason,
  isSeedingCancelRequested,
  performVideoSeeding,
  runSessionPreparation,
  throwIfSeedingCancelled,
  waitForSeedingDelay,
} from './seeding-control';
import {
  applyTikTokSeedingZoom,
  getTiledSeedingWindowBounds,
  keepTikTokSeedingZoom,
  TIKTOK_SEEDING_ZOOM,
  TILED_VIDEO_COMMENT_MIN_HEIGHT,
  TILED_VIDEO_COMMENT_MIN_WIDTH,
} from './window-layout';
import {
  getTikTokPageSnapshot,
  loadTikTokUrlForSeeding,
  waitForTikTokSurfaceReady,
  TIKTOK_SURFACE_READY_TIMEOUT_MS,
} from './tiktok-page';
import { solveTikTokWebCaptchaWithOmo } from './captcha-solver';
import { performLivestreamSeeding } from './tiktok-live-actions';
import { ensureAuthenticatedForSeeding, renewTikTokSessionForSeeding } from './tiktok-login-flow';
import { runWithAutomationRetry } from './retry-policy';

export const seedingWindows = new Set<BrowserWindow>();

const SEEDING_POST_ACTION_STABILIZE_MS = 12000;

/**
 * Execute automation actions for a single account on TikTok Video / Live
 */
export async function executeTaskForAccount(
  acc: AccountInfo & { proxy?: string; proxyType?: string },
  config: SeedingTaskConfig,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  windowSlot: number = 0,
  onSeedingStateChange?: (state: SeedingStateChange) => void
) {
  const partition = `persist:tiktok_${acc.id}`;
  const customSession = session.fromPartition(partition);
  customSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  const proxyConfig = await runSessionPreparation(() =>
    configureSessionProxyAndCookies(customSession, acc.cookie, acc.proxy, acc.proxyType, {
      skipCookieInjectionIfSessionExists: true,
    })
  );

  const cookies = await customSession.cookies.get({});
  const hasSession = hasTikTokSessionCookie(cookies) || cookies.some(c => isTikTokCookie(c) && c.name.includes('uid_tt'));

  if (!hasSession) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `⚠️ Tài khoản @${acc.username} CHƯA DỰNG SESSION ĐĂNG NHẬP! Bạn hãy gán Cookie hoặc đăng nhập thủ công.`,
    });
  }

  const needsVideoCommentLayout = config.targetType === 'video' && !!config.comments?.some(comment => comment.trim().length > 0);
  if (config.targetType === 'livestream') {
    // Intercept and abort heavy video stream chunks to save CPU/RAM while keeping WebSocket room chat & like buttons active
    customSession.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
      const url = details.url.toLowerCase();
      const isMediaStream =
        details.resourceType === 'media' ||
        url.includes('.flv') ||
        url.includes('.m3u8') ||
        url.includes('pull.tiktokcdn.com') ||
        url.includes('live-pull') ||
        url.includes('byteoversea.com/live/') ||
        url.includes('v16m-default.akamaized.net');

      if (isMediaStream) {
        return callback({ cancel: true });
      }
      callback({ cancel: false });
    });
  }

  const win = new BrowserWindow({
    ...getTiledSeedingWindowBounds(windowSlot, needsVideoCommentLayout),
    show: true,
    title: `[Seeding Worker] @${acc.username} - ${config.targetType}`,
    autoHideMenuBar: true,
    webPreferences: {
      session: customSession,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  win.webContents.on('dom-ready', () => {
    win.webContents.executeJavaScript(`
      try {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        if (window.chrome && !window.chrome.runtime) {
          window.chrome.runtime = {};
        }
      } catch(e) {}
    `).catch(() => undefined);
  });

  if (needsVideoCommentLayout) {
    win.setMinimumSize(TILED_VIDEO_COMMENT_MIN_WIDTH, TILED_VIDEO_COMMENT_MIN_HEIGHT);
  }
  seedingWindows.add(win);
  keepTikTokSeedingZoom(win);

  let isTaskRunning = true;
  let completedSuccessfully = false;
  let heldForDebugOnError = false;
  let closedByAutomation = false;

  win.on('closed', () => {
    seedingWindows.delete(win);

    // If closed by automation (e.g. successful task completion or close-all command):
    if (closedByAutomation) {
      return;
    }

    // If this window was already finished and held for debugging:
    if (heldForDebugOnError) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[WindowLifecycle] Đã đóng cửa sổ debug của @${acc.username}.`,
      });
      return;
    }

    // If closed manually by user while task was actively running:
    if (isTaskRunning) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[WindowLifecycle] Cửa sổ seeding của @${acc.username} đã đóng, chỉ dừng worker này và tiếp tục các tài khoản còn lại.`,
      });

      if (seedingWindows.size === 0 && isSeedingCancelRequested()) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'warning',
          message: 'Tất cả cửa sổ seeding đã đóng. Đang dừng task hiện tại...',
        });
        onSeedingStateChange?.({
          isRunning: false,
          canceled: true,
          reason: getSeedingCancelReason(),
        });
      }
    }
  });
  const muteBrowserAudio = config.muteBrowserAudio !== false;
  win.webContents.setAudioMuted(muteBrowserAudio);
  attachProxyAuthHandler(win, proxyConfig?.auth);

  try {
    if (muteBrowserAudio) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Audio] Muted browser audio for @${acc.username}.`,
      });
    }

    let renewSessionAttempted = false;

    const tryRenewSession = async (triggerReason: string): Promise<boolean> => {
      if (renewSessionAttempted || isSeedingCancelRequested()) return false;
      renewSessionAttempted = true;

      let snapshotInfo = '';
      try {
        if (!win.isDestroyed()) {
          const snap = await getTikTokPageSnapshot(win);
          snapshotInfo = ` [URL: ${snap.url || win.webContents.getURL()}] [ReadyState: ${snap.readyState || 'unknown'}] [BodyHtmlLen: ${snap.bodyHtmlLength ?? 0}] [BodyTextLen: ${snap.bodyTextLength ?? 0}] [Markers: ${snap.markerCount ?? 0}] [Proxy: ${acc.proxy || 'None'} (${acc.proxyType || 'http'})]`;
        }
      } catch (_) { }

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[RenewSession] Phát hiện ${triggerReason} cho @${acc.username}.${snapshotInfo} ➔ Tiến hành auto-renew session để lấy cookie mới...`,
      });

      const renewed = await renewTikTokSessionForSeeding(
        win,
        customSession,
        acc,
        config.targetUrl,
        onLog,
        onAccountStatusChange,
        onAccountSessionUpdate,
        triggerReason
      );

      return renewed;
    };

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Đang tải URL trang TikTok: ${config.targetUrl}...`,
    });

    try {
      await loadTikTokUrlForSeeding(win, customSession, config.targetUrl, acc, onLog);
    } catch (loadErr: any) {
      throwIfSeedingCancelled(win);
      const loadErrMsg = loadErr?.message || String(loadErr);
      const isBlankOrTimeout =
        loadErrMsg.includes('trang/trong') ||
        loadErrMsg.includes('trang bi trong') ||
        loadErrMsg.includes('blank') ||
        loadErrMsg.includes('timeout') ||
        loadErrMsg.includes('timed out');

      if (isBlankOrTimeout) {
        const renewed = await tryRenewSession('trang TikTok không tải được / trắng / timeout');
        if (!renewed) {
          throw loadErr;
        }
      } else {
        throw loadErr;
      }
    }

    throwIfSeedingCancelled(win);
    win.webContents.setZoomFactor(TIKTOK_SEEDING_ZOOM);
    await win.webContents.executeJavaScript(`
      (() => {
        try {
          document.documentElement.style.overflowX = 'auto';
          document.body.style.overflowX = 'auto';
          document.scrollingElement && (document.scrollingElement.scrollLeft = 0);
          const horizontalScrollers = Array.from(document.querySelectorAll('*')).filter(el => el.scrollWidth > el.clientWidth + 80);
          horizontalScrollers.slice(0, 6).forEach(el => {
            try { el.scrollLeft = 0; } catch(e) {}
          });
        } catch(e) {}
      })();
    `);
    await waitForSeedingDelay(800, win);

    const authReady = await ensureAuthenticatedForSeeding(
      win,
      customSession,
      acc,
      config.targetUrl,
      onLog,
      onAccountStatusChange,
      onAccountSessionUpdate
    );
    if (!authReady) {
      throw new Error(`@${acc.username} is logged out and could not be re-authenticated.`);
    }
    throwIfSeedingCancelled(win);

    win.webContents.setZoomFactor(TIKTOK_SEEDING_ZOOM);
    await win.webContents.executeJavaScript(`
      (() => {
        try {
          document.documentElement.style.overflowX = 'auto';
          document.body.style.overflowX = 'auto';
          document.scrollingElement && (document.scrollingElement.scrollLeft = 0);
          const horizontalScrollers = Array.from(document.querySelectorAll('*')).filter(el => el.scrollWidth > el.clientWidth + 80);
          horizontalScrollers.slice(0, 6).forEach(el => {
            try { el.scrollLeft = 0; } catch(e) {}
          });
        } catch(e) {}
      })();
    `);
    await waitForSeedingDelay(800, win);

    const hasInitialCaptcha = await win.webContents.executeJavaScript(`
      (() => {
        const bodyText = document.body?.innerText || '';
        return !!document.querySelector('iframe[src*="captcha"], iframe[src*="sec"], #captcha-verify-container, .sec-captcha-container') ||
               bodyText.includes('Drag the slider') ||
               bodyText.includes('Complete the puzzle') ||
               bodyText.includes('Verify to continue');
      })();
    `).catch(() => false);
    if (hasInitialCaptcha) {
      await solveTikTokWebCaptchaWithOmo(win, acc, onLog).catch(err => {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'error',
          message: `[Captcha] Initial OmoCaptcha solve error: ${err?.message || err}`,
        });
        return false;
      });
      applyTikTokSeedingZoom(win);
    }
    throwIfSeedingCancelled(win);

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Đang đợi TikTok render ổn định trước khi thao tác...`,
    });

    let surfaceReady = await waitForTikTokSurfaceReady(win, config.targetType);
    throwIfSeedingCancelled(win);

    if (
      !surfaceReady.ready &&
      !surfaceReady.hasVideo &&
      !surfaceReady.hasVideoLike &&
      !surfaceReady.hasVideoComment &&
      !surfaceReady.hasLiveChat &&
      !surfaceReady.hasLiveLike
    ) {
      const renewed = await tryRenewSession('TikTok surface chưa render được UI sau khi tải');
      if (renewed) {
        throwIfSeedingCancelled(win);
        applyTikTokSeedingZoom(win);
        surfaceReady = await waitForTikTokSurfaceReady(win, config.targetType);
      }
    }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: surfaceReady.ready ? 'info' : 'warning',
      message: surfaceReady.ready
        ? `TikTok đã sẵn sàng: video=${surfaceReady.hasVideo ? 'có' : 'không'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'có' : 'không'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'có' : 'không'}.`
        : `TikTok chưa ổn định sau ${Math.round(TIKTOK_SURFACE_READY_TIMEOUT_MS / 1000)}s (${surfaceReady.reason || 'không rõ'}). Trạng thái: readyState=${surfaceReady.readyState || 'unknown'}, video=${surfaceReady.hasVideo ? 'có' : 'không'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'có' : 'không'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'có' : 'không'}.`,
    });

    // Execute Seeding according to target type
    if (config.targetType === 'video') {
      await runWithAutomationRetry(
        win,
        acc,
        onLog,
        { label: 'Video seeding', maxAttempts: 3, baseDelayMs: 1800, maxDelayMs: 7000 },
        () => performVideoSeeding(win, acc, config, onLog)
      );
    } else if (config.targetType === 'livestream') {
      await runWithAutomationRetry(
        win,
        acc,
        onLog,
        { label: 'Livestream seeding', maxAttempts: 2, baseDelayMs: 2000, maxDelayMs: 7000 },
        () => performLivestreamSeeding(win, acc, config, onLog)
      );
    }

    await waitForSeedingDelay(SEEDING_POST_ACTION_STABILIZE_MS, win);
    throwIfSeedingCancelled(win);

    // Final safety check: if Captcha is still on screen, keep window open and solve before closing
    let safetyRetries = 0;
    while (safetyRetries < 3) {
      if (win.isDestroyed() || isSeedingCancelRequested()) break;
      const hasActiveCaptcha = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none';
            };
            const selectors = [
              '#captcha-verify-container', '.captcha-verify-container',
              '#captcha_verify_container', '.captcha_verify_container',
              '.sec-captcha-container', '.captcha-container', '.verify-wrap',
              '[class*="captcha-card" i]', '[class*="captcha-modal" i]',
              '[class*="captcha_card" i]', '[class*="captcha_modal" i]',
              'iframe[src*="captcha"]', 'iframe[src*="sec"]', 'iframe[src*="verify"]'
            ];
            return selectors.some(s => Array.from(document.querySelectorAll(s)).some(isVisible));
          } catch(e) { return false; }
        })();
      `).catch(() => false);

      if (!hasActiveCaptcha) break;

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[Captcha] ⏳ Phát hiện CAPTCHA vẫn đang hiển thị, giữ cửa sổ để tiếp tục giải cho @${acc.username}...`,
      });
      await solveTikTokWebCaptchaWithOmo(win, acc, onLog);
      safetyRetries++;
      await waitForSeedingDelay(3000, win).catch(() => { });
    }
    throwIfSeedingCancelled(win);

    await persistTikTokSessionCookies(
      acc.id,
      acc.username,
      customSession,
      onLog,
      onAccountSessionUpdate,
      '[Seeding] '
    );

    completedSuccessfully = true;
    isTaskRunning = false;
  } catch (err: any) {
    isTaskRunning = false;

    const isCancelled = isSeedingCancelRequested() || err instanceof SeedingCancelledError;
    if (isCancelled) {
      throw err;
    }

    heldForDebugOnError = true;

    const errMsg = err?.message || String(err);
    let category = 'General/Error';
    if (
      errMsg.includes('is logged out') ||
      errMsg.includes('chua co mat khau') ||
      errMsg.includes('out session') ||
      errMsg.includes('CHƯA DỰNG SESSION')
    ) {
      category = 'Auth/LoggedOut';
    } else if (
      errMsg.includes('Login lai that bai') ||
      errMsg.includes('login retry failed') ||
      errMsg.includes('could not be re-authenticated')
    ) {
      category = 'Auth/LoginRetryFailed';
    } else if (
      errMsg.includes('timeout') ||
      errMsg.includes('timed out') ||
      errMsg.includes('load qua') ||
      errMsg.includes('ERR_CONNECTION') ||
      errMsg.includes('ERR_PROXY') ||
      errMsg.includes('ERR_NAME_NOT_RESOLVED')
    ) {
      category = 'Network/LoadTimeout';
    } else if (
      errMsg.includes('trang bi trong') ||
      errMsg.includes('trang/trong') ||
      errMsg.includes('van trang') ||
      errMsg.includes('bodyHtml=0') ||
      errMsg.includes('blank') ||
      errMsg.includes('TikTok chưa ổn định')
    ) {
      category = 'Render/BlankPage';
    } else if (
      errMsg.includes('captcha') ||
      errMsg.includes('Captcha') ||
      errMsg.includes('CAPTCHA')
    ) {
      category = 'Captcha/SolveFailed';
    }

    let diagnosticDetails = '';
    try {
      if (!win.isDestroyed()) {
        const currentUrl = win.webContents.getURL();
        const pageSnapshot = await win.webContents.executeJavaScript(`
          (() => {
            try {
              const bodyText = (document.body?.innerText || '').trim();
              const hasCaptcha = !!document.querySelector('iframe[src*="captcha"], #captcha-verify-container, .sec-captcha-container, .captcha-verify-container');
              return {
                title: document.title,
                readyState: document.readyState,
                bodyLength: bodyText.length,
                url: window.location.href,
                hasCaptcha
              };
            } catch(e) { return null; }
          })();
        `).catch(() => null);

        diagnosticDetails = ` [URL: ${currentUrl || pageSnapshot?.url || 'unknown'}] [Title: "${pageSnapshot?.title || ''}"] [ReadyState: ${pageSnapshot?.readyState || 'unknown'}] [BodyLen: ${pageSnapshot?.bodyLength ?? 0}] [Captcha: ${pageSnapshot?.hasCaptcha ? 'Yes' : 'No'}]`;
      }
    } catch (_) { }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[SeedingWindow] [${category}] ⚠️ Tác vụ thất bại cho @${acc.username}: ${errMsg}.${diagnosticDetails} ➔ Giữ cửa sổ trình duyệt để quan sát và debug.`,
    });

    throw err;
  } finally {
    if (!win.isDestroyed()) {
      if (completedSuccessfully) {
        closedByAutomation = true;
        win.close();
      } else if (isSeedingCancelRequested()) {
        closedByAutomation = true;
        win.close();
      } else {
        // Kept open for debugging on error!
      }
    }
  }
}
