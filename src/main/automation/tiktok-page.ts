import { BrowserWindow } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from '../nest/automation/automation.interface';
import { ParsedProxyConfig, isTikTokCookie } from './session-profile';

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
  details: string[]
): Promise<void> {
  if (win.isDestroyed()) return;

  const html = `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <style>
          body {
            margin: 0;
            font-family: Arial, sans-serif;
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
          <p>Hay thu proxy khac hoac kiem tra lai IP, port, user, pass va loai HTTP/SOCKS5.</p>
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
  onAccountStatusChange: (id: string, status: 'authenticated' | 'unauthenticated' | 'active' | 'error' | 'live' | 'die') => void,
  contextLabel: string
): Promise<void> {
  let loadFailed: { errorCode?: number; errorDescription?: string; validatedURL?: string } | null = null;
  const onFail = (
    _event: Electron.Event,
    errorCode: number,
    errorDescription: string,
    validatedURL: string,
    isMainFrame: boolean
  ) => {
    if (!isMainFrame || errorCode === -3) return;
    loadFailed = { errorCode, errorDescription, validatedURL };
  };

  win.webContents.on('did-fail-load', onFail);
  try {
    await win.loadURL(url).catch((err: any) => {
      loadFailed = {
        errorCode: err?.errno || err?.code,
        errorDescription: err?.message || String(err),
        validatedURL: url,
      };
    });

    await new Promise(res => setTimeout(res, 6000));
    if (win.isDestroyed()) return;

    if (!loadFailed) {
      let snapshot = await getTikTokPageSnapshot(win);
      if (snapshot.isBlank) {
        await clearTikTokRenderCache(customSession);
        await win.reload();
        await new Promise(res => setTimeout(res, 4500));
        if (win.isDestroyed()) return;
        snapshot = await getTikTokPageSnapshot(win);
      }

      if (!snapshot.isBlank) return;

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[Proxy] ${contextLabel} @${acc.username || acc.id} render trang trang sau khi load TikTok. Proxy=${proxyConfig?.proxyRules || proxyStr || 'none'}.`,
      });
      onAccountStatusChange(acc.id, 'error');
      await showBrowserLoadProblem(win, 'TikTok dang bi trang', [
        `Account: @${acc.username || acc.id}`,
        `Proxy: ${proxyConfig?.proxyRules || proxyStr || 'none'}`,
        'Da reload va clear cache nhung TikTok van khong render noi dung.',
      ]);
      return;
    }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[Proxy] ${contextLabel} @${acc.username || acc.id} khong load duoc TikTok qua proxy ${proxyConfig?.proxyRules || proxyStr || 'none'}: ${loadFailed.errorDescription || loadFailed.errorCode || 'unknown error'}.`,
    });
    onAccountStatusChange(acc.id, 'error');

    await showBrowserLoadProblem(win, 'Khong load duoc TikTok qua proxy', [
      `Account: @${acc.username || acc.id}`,
      `Proxy: ${proxyConfig?.proxyRules || proxyStr || 'none'}${proxyConfig?.auth ? ' (co user/pass)' : ''}`,
      `Loi: ${loadFailed.errorDescription || loadFailed.errorCode || 'unknown error'}`,
    ]);
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
        const hasLoginForm = Array.from(document.querySelectorAll('input[type="password"]')).some(isVisible) ||
                             bodyText.includes('log in to tiktok') ||
                             bodyText.includes('use phone or email') ||
                             bodyText.includes('use phone / email') ||
                             bodyText.includes('đăng nhập vào tiktok');
        const hasLoggedInSignal = !!document.querySelector('[data-e2e="profile-icon"]') ||
                                  buttons.some(el => {
                                    const txt = textOf(el);
                                    return txt.includes('log out') || txt.includes('đăng xuất') || txt.includes('dang xuat');
                                  });
        const loggedOut = !hasLoggedInSignal && (hasLoginButton || hasLoginToComment || hasLoginForm);
        const reason = hasLoginToComment
          ? 'TikTok yeu cau dang nhap de binh luan.'
          : hasLoginForm
            ? 'Dang o man hinh dang nhap TikTok.'
            : hasLoginButton
              ? 'TikTok hien nut Log in.'
              : undefined;
        return { loggedOut, reason, hasLoginButton, hasLoginToComment, hasLoginForm, hasLoggedInSignal };
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
  let timeoutHandle: NodeJS.Timeout | undefined;

  const loadPromise = win.loadURL(url).catch((err: any) => {
    const errMsg = err?.message || String(err);
    if (errMsg.includes('ERR_ABORTED') || err?.code === 'ERR_ABORTED' || err?.errno === -3) {
      return;
    }
    throw err;
  });

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

  await new Promise(res => setTimeout(res, 1500));
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
  await win.loadURL(retryUrl).catch((err: any) => {
    const errMsg = err?.message || String(err);
    if (!errMsg.includes('ERR_ABORTED') && err?.code !== 'ERR_ABORTED' && err?.errno !== -3) {
      throw err;
    }
  });
  await new Promise(res => setTimeout(res, 2500));

  snapshot = await getTikTokPageSnapshot(win);
  if (snapshot.isBlank) {
    throw new Error(`TikTok van trang/trong sau reload cho @${acc.username}: url=${snapshot.url || 'unknown'}, readyState=${snapshot.readyState || 'unknown'}, bodyHtml=${snapshot.bodyHtmlLength ?? 'unknown'}`);
  }
}

export { TIKTOK_SURFACE_READY_TIMEOUT_MS };
