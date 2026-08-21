import { BrowserWindow } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from '../nest/automation/automation.interface';
import { ParsedProxyConfig, isTikTokCookie } from './session-profile';
import { AccountStatus } from './types';

const TIKTOK_SURFACE_READY_TIMEOUT_MS = 25000;
const TIKTOK_PAGE_LOAD_TIMEOUT_MS = 30000;

export async function waitForTikTokSurfaceReady(
  win: BrowserWindow,
  targetType: SeedingTaskConfig['targetType'],
  timeoutMs = 18000
): Promise<{
  ready: boolean;
  readyState?: string;
  hasVideo?: boolean;
  hasVideoLike?: boolean;
  hasVideoComment?: boolean;
  hasLiveChat?: boolean;
  hasLiveLike?: boolean;
  reason?: string;
}> {
  const deadline = Date.now() + timeoutMs;
  let lastState: any = null;

  while (Date.now() < deadline) {
    if (win.isDestroyed()) {
      return { ready: false, reason: 'Cửa sổ đã đóng.' };
    }

    try {
      lastState = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const videoEls = Array.from(document.querySelectorAll('video'));
            const hasVideo = videoEls.some(isVisible) || videoEls.length > 0 || !!document.querySelector('[data-e2e="browse-video"], [data-e2e="video-detail-container"], div[class*="VideoContainer"]');

            const hasVideoLike = Array.from(document.querySelectorAll(
              '[data-e2e="like-icon"], [data-e2e="browse-like-icon"], [data-e2e="video-like-icon"], [data-e2e="feed-like"], button[aria-label*="like" i], button[aria-label*="thích" i], button[aria-label*="Thích" i], [class*="LikeContainer"], [class*="ButtonLike"]'
            )).some(isVisible);

            const hasVideoComment = Array.from(document.querySelectorAll(
              '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], [data-e2e="comment-input"], [data-e2e="comment-input-area"], div[contenteditable="true"], [role="textbox"], textarea'
            )).some(isVisible);

            const readyState = document.readyState;
            const ready = readyState === 'complete' && (hasVideo || hasVideoLike || hasVideoComment);

            return {
              ready,
              readyState,
              hasVideo,
              hasVideoLike,
              hasVideoComment,
            };
          } catch(e) {
            return { ready: false, reason: e.toString() };
          }
        })();
      `);

      if (lastState?.ready) {
        return lastState;
      }
    } catch (err: any) {
      lastState = { ready: false, reason: err.message || String(err) };
    }

    await new Promise(res => setTimeout(res, 800));
  }

  return {
    ready: !!(lastState?.hasVideo || lastState?.hasVideoLike || lastState?.hasVideoComment),
    readyState: lastState?.readyState,
    hasVideo: lastState?.hasVideo,
    hasVideoLike: lastState?.hasVideoLike,
    hasVideoComment: lastState?.hasVideoComment,
    reason: lastState?.reason || 'TikTok chưa render đủ UI trong thời gian chờ.',
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function showBrowserLoadProblem(
  win: BrowserWindow,
  title: string,
  details: string[],
  hasProxy = false
): Promise<void> {
  if (win.isDestroyed()) return;

  const recommendation = hasProxy
    ? 'Hãy thử proxy khác hoặc kiểm tra lại IP, port, user, pass và loại HTTP/SOCKS5.'
    : 'Hãy kiểm tra lại kết nối mạng internet, kiểm tra DNS/tường lửa, hoặc xoá cache và session để thử lại.';

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
            background: #0f172a;
            color: #e5e7eb;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
          }
          main {
            width: min(760px, calc(100vw - 48px));
            border: 1px solid #334155;
            background: #111827;
            border-radius: 8px;
            padding: 24px;
            box-sizing: border-box;
          }
          h1 {
            margin: 0 0 14px;
            font-size: 20px;
            color: #f87171;
          }
          p {
            margin: 8px 0;
            line-height: 1.5;
            color: #cbd5e1;
          }
          code {
            color: #93c5fd;
            word-break: break-all;
          }
        </style>
      </head>
      <body>
        <main>
          <h1>${escapeHtml(title)}</h1>
          ${details.map(detail => `<p>${escapeHtml(detail)}</p>`).join('')}
          <p>${escapeHtml(recommendation)}</p>
        </main>
      </body>
    </html>
  `;

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch(() => undefined);
}

export async function loadLoginStartPage(
  win: BrowserWindow,
  customSession: Electron.Session,
  url: string,
  acc: { id: string; username?: string },
  proxyStr: string | undefined,
  proxyConfig: ParsedProxyConfig | null,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  contextLabel: string
): Promise<boolean> {
  const hasProxy = Boolean(proxyStr || proxyConfig?.proxyRules);
  let loadFailed: { errorCode?: number; errorDescription?: string; validatedURL?: string } | null = null;

  const isAbortedError = (code?: number, desc?: string) => {
    if (code === -3) return true;
    if (!desc) return false;
    const lower = String(desc).toLowerCase();
    return lower.includes('err_aborted') || lower.includes('-3');
  };

  const onFail = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean
  ) => {
    if (!isMainFrame || isAbortedError(errorCode, errorDescription)) return;
    loadFailed = { errorCode, errorDescription, validatedURL };
  };

  win.webContents.on('did-fail-load', onFail);
  try {
    await win.loadURL(url).catch((err: any) => {
      const code = err?.errno || err?.code;
      const desc = err?.message || String(err);
      if (!isAbortedError(code, desc)) {
        loadFailed = {
          errorCode: typeof code === 'number' ? code : undefined,
          errorDescription: desc,
          validatedURL: url,
        };
      }
    });

    await new Promise(res => setTimeout(res, 5000));
    if (win.isDestroyed()) return false;

    if (!loadFailed) {
      let snapshot = await getTikTokPageSnapshot(win);
      if (snapshot.isBlank) {
        await clearTikTokRenderCache(customSession);
        await win.reload();
        await new Promise(res => setTimeout(res, 4000));
        if (win.isDestroyed()) return false;
        snapshot = await getTikTokPageSnapshot(win);
      }

      if (!snapshot.isBlank) return true;

      const logPrefix = hasProxy ? '[Proxy]' : '[Network]';
      const proxyInfo = hasProxy ? ` Proxy=${proxyConfig?.proxyRules || proxyStr}` : ' (Không dùng proxy)';
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `${logPrefix} ${contextLabel} @${acc.username || acc.id} render trang trắng sau khi load TikTok.${proxyInfo}.`,
      });
      onAccountStatusChange(acc.id, 'error');
      await showBrowserLoadProblem(
        win,
        'TikTok đang bị trắng trang',
        [
          `Account: @${acc.username || acc.id}`,
          hasProxy ? `Proxy: ${proxyConfig?.proxyRules || proxyStr}` : 'Proxy: Không sử dụng',
          'Đã reload và xoá cache nhưng TikTok vẫn không hiển thị nội dung.',
        ],
        hasProxy
      );
      return false;
    }

    const logPrefix = hasProxy ? '[Proxy]' : '[Network]';
    const failTitle = hasProxy ? 'Không load được TikTok qua proxy' : 'Không load được TikTok';
    const logMsg = hasProxy
      ? `${logPrefix} ${contextLabel} @${acc.username || acc.id} không load được TikTok qua proxy ${proxyConfig?.proxyRules || proxyStr}: ${loadFailed.errorDescription || loadFailed.errorCode || 'unknown error'}.`
      : `${logPrefix} ${contextLabel} @${acc.username || acc.id} không load được TikTok: ${loadFailed.errorDescription || loadFailed.errorCode || 'unknown error'}.`;

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: logMsg,
    });
    onAccountStatusChange(acc.id, 'error');

    const details = [
      `Account: @${acc.username || acc.id}`,
      hasProxy
        ? `Proxy: ${proxyConfig?.proxyRules || proxyStr}${proxyConfig?.auth ? ' (có user/pass)' : ''}`
        : 'Proxy: Không sử dụng',
      `Lỗi: ${loadFailed.errorDescription || loadFailed.errorCode || 'unknown error'}`,
    ];

    await showBrowserLoadProblem(win, failTitle, details, hasProxy);
    return false;
  } finally {
    win.webContents.removeListener('did-fail-load', onFail);
  }
}

export async function detectTikTokLoggedOutState(win: BrowserWindow): Promise<{
  loggedOut: boolean;
  reason?: string;
  hasLoginButton?: boolean;
  hasLoginToComment?: boolean;
  hasLoginForm?: boolean;
  hasLoggedInSignal?: boolean;
}> {
  if (win.isDestroyed()) {
    return { loggedOut: false, reason: 'Window destroyed' };
  }

  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
                 rect.height > 0 &&
                 style.visibility !== 'hidden' &&
                 style.display !== 'none' &&
                 style.opacity !== '0';
        };
        const textOf = (el) => (el?.innerText || el?.textContent || el?.getAttribute?.('aria-label') || '').trim().toLowerCase();
        const bodyText = (document.body?.innerText || '').toLowerCase();
        const buttons = Array.from(document.querySelectorAll('button, a, [role="button"], [data-e2e]')).filter(isVisible);
        const hasLoginButton = buttons.some(el => {
          const txt = textOf(el);
          const e2e = (el.getAttribute?.('data-e2e') || '').toLowerCase();
          return e2e === 'top-login-button' ||
                 txt === 'log in' ||
                 txt === 'login' ||
                 txt === 'dang nhap' ||
                 txt.includes('dang nhap') ||
                 txt.includes('đăng nhập');
        });
        const hasLoginToComment = buttons.some(el => {
          const txt = textOf(el);
          return txt.includes('log in to comment') ||
                 txt.includes('login to comment') ||
                 txt.includes('đăng nhập để bình luận') ||
                 txt.includes('dang nhap de binh luan');
        }) || bodyText.includes('log in to comment') || bodyText.includes('login to comment');
        const hasLoginModal = !!document.querySelector(
          '[data-e2e="login-modal"], [data-e2e="login-title"], #loginModalContentContainer, #loginContainer, [data-e2e="channel-item"]'
        );
        const hasLoginForm = Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible) ||
                             hasLoginModal ||
                             bodyText.includes('log in to tiktok') ||
                             bodyText.includes('use phone or email') ||
                             bodyText.includes('use phone / email') ||
                             bodyText.includes('đăng nhập vào tiktok');
        const hasLoggedInSignal = !!document.querySelector('[data-e2e="profile-icon"]') ||
                                  buttons.some(el => {
                                    const txt = textOf(el);
                                    return txt.includes('log out') || txt.includes('đăng xuất') || txt.includes('dang xuat');
                                  });
        const loggedOut = !hasLoggedInSignal && (hasLoginButton || hasLoginToComment || hasLoginForm || hasLoginModal);
        const reason = hasLoginToComment
          ? 'TikTok yeu cau dang nhap de binh luan.'
          : (hasLoginForm || hasLoginModal)
            ? 'Dang o man hinh dang nhap TikTok (Login Modal/Form).'
            : hasLoginButton
              ? 'TikTok hien nut Log in.'
              : undefined;
        return { loggedOut, reason, hasLoginButton, hasLoginToComment, hasLoginForm, hasLoggedInSignal, hasLoginModal };
      } catch(e) {
        return { loggedOut: false, reason: String(e) };
      }
    })();
  `).catch(() => ({ loggedOut: false }));
}

export async function clearTikTokAuthCookies(customSession: Electron.Session): Promise<void> {
  const cookies = await customSession.cookies.get({});
  const authCookieNames = new Set([
    'sessionid',
    'sessionid_ss',
    'sid_tt',
    'sid_guard',
    'uid_tt',
    'uid_tt_ss',
    'sid_ucp_v1',
    'ssid_ucp_v1',
    'store-idc',
    'store-country-code',
  ]);

  await Promise.all(cookies
    .filter(cookie => isTikTokCookie(cookie) && authCookieNames.has(cookie.name))
    .map(cookie => {
      const protocol = cookie.secure ? 'https' : 'http';
      const domain = cookie.domain?.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
      if (!domain) return Promise.resolve();
      return customSession.cookies.remove(`${protocol}://${domain}${cookie.path || '/'}`, cookie.name).catch(() => undefined);
    }));
}

function getCanonicalTikTokUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname.endsWith('tiktok.com') && parsed.pathname) {
      return `${parsed.origin}${parsed.pathname}`;
    }
  } catch (_) {}
  return rawUrl;
}

function getDesktopTikTokUrl(rawUrl: string): string {
  try {
    const parsed = new URL(getCanonicalTikTokUrl(rawUrl));
    parsed.searchParams.set('is_from_webapp', '1');
    parsed.searchParams.set('sender_device', 'pc');
    return parsed.toString();
  } catch (_) {}
  return rawUrl;
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function getTikTokPageSnapshot(win: BrowserWindow): Promise<{
  isBlank: boolean;
  url?: string;
  title?: string;
  readyState?: string;
  bodyHtmlLength?: number;
  bodyTextLength?: number;
  markerCount?: number;
  error?: string;
}> {
  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const bodyText = (document.body?.innerText || '').trim();
        const bodyHtmlLength = document.body?.innerHTML?.length || 0;
        const markerCount = document.querySelectorAll('video, button, iframe, input, textarea, [data-e2e]').length;
        return {
          isBlank: bodyText.length === 0 && bodyHtmlLength < 1000 && markerCount === 0,
          url: location.href,
          title: document.title,
          readyState: document.readyState,
          bodyHtmlLength,
          bodyTextLength: bodyText.length,
          markerCount
        };
      } catch (e) {
        return { isBlank: false, error: String(e) };
      }
    })();
  `).catch((err: any) => ({ isBlank: false, error: err?.message || String(err) }));
}

export async function clearTikTokRenderCache(customSession: Electron.Session): Promise<void> {
  await customSession.clearCache().catch(() => {});
  await customSession.clearStorageData({
    origin: 'https://www.tiktok.com',
    storages: ['serviceworkers', 'cachestorage'] as any,
  } as any).catch(() => {});
}

export async function loadTikTokUrlForSeeding(
  win: BrowserWindow,
  customSession: Electron.Session,
  url: string,
  acc: { id: string; username: string },
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<void> {
  const loadUrlIgnoringAbort = async (nextUrl: string) => {
    await win.loadURL(nextUrl).catch((err: any) => {
      const errMsg = err?.message || String(err);
      if (errMsg.includes('ERR_ABORTED') || err?.code === 'ERR_ABORTED' || err?.errno === -3) {
        return;
      }
      throw err;
    });
  };

  const loadWithTimeout = async (nextUrl: string) => {
    let timeoutHandle: NodeJS.Timeout | undefined;
    const loadPromise = loadUrlIgnoringAbort(nextUrl);
    const timeoutPromise = new Promise<void>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        try {
          if (!win.isDestroyed()) win.webContents.stop();
        } catch (_) {}
        reject(new Error(`TikTok load qua ${Math.round(TIKTOK_PAGE_LOAD_TIMEOUT_MS / 1000)}s van chua xong.`));
      }, TIKTOK_PAGE_LOAD_TIMEOUT_MS);
    });

    try {
      await Promise.race([loadPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  };

  await loadWithTimeout(url);
  await wait(1500);
  let snapshot = await getTikTokPageSnapshot(win);
  if (!snapshot.isBlank) return;

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'warning',
    message: `[Load] TikTok dang trang/trong cho @${acc.username}. Clear cache/service worker va reload lai... url=${snapshot.url || 'unknown'}, bodyHtml=${snapshot.bodyHtmlLength ?? 'unknown'}`,
  });

  await clearTikTokRenderCache(customSession);
  const retryUrl = getCanonicalTikTokUrl(url);
  await loadUrlIgnoringAbort('about:blank');
  await wait(500);
  await loadWithTimeout(retryUrl);
  await wait(2500);

  snapshot = await getTikTokPageSnapshot(win);
  if (!snapshot.isBlank) return;

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'warning',
    message: `[Load] TikTok van trang/trong sau reload cho @${acc.username}. Thu hard reload qua TikTok home roi quay lai target... readyState=${snapshot.readyState || 'unknown'}, bodyHtml=${snapshot.bodyHtmlLength ?? 'unknown'}`,
  });

  await clearTikTokRenderCache(customSession);
  await loadWithTimeout('https://www.tiktok.com/');
  await wait(2500);
  await loadWithTimeout(getDesktopTikTokUrl(url));
  await wait(3500);

  snapshot = await getTikTokPageSnapshot(win);
  if (snapshot.isBlank) {
    throw new Error(`TikTok van trang/trong sau hard reload cho @${acc.username}: url=${snapshot.url || 'unknown'}, readyState=${snapshot.readyState || 'unknown'}, bodyHtml=${snapshot.bodyHtmlLength ?? 'unknown'}`);
  }
}

export { TIKTOK_SURFACE_READY_TIMEOUT_MS };
