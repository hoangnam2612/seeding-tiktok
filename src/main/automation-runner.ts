import { BrowserWindow, session, ipcMain, screen } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from './nest/automation/automation.interface';
import { MailOtpService } from './nest/accounts/mail-otp.service';
import { generateTotpToken } from './nest/accounts/totp.helper';
import * as fs from 'fs';
import * as path from 'path';
import { ensurePersistentDataDir } from './data-dir';

const mailOtpService = new MailOtpService();

// Map of active login windows
const loginWindows = new Map<string, BrowserWindow>();
const seedingWindows = new Set<BrowserWindow>();

const TILED_LOGIN_TARGET_WIDTH = 430;
const TILED_LOGIN_TARGET_HEIGHT = 320;
const TILED_LOGIN_MIN_WIDTH = 420;
const TILED_LOGIN_MIN_HEIGHT = 300;
const TILED_LOGIN_GAP = 6;
const TILED_LOGIN_OVERFLOW_OFFSET = 24;
const TILED_SEEDING_TARGET_WIDTH = 430;
const TILED_SEEDING_TARGET_HEIGHT = 320;
const TILED_SEEDING_MIN_WIDTH = 420;
const TILED_SEEDING_MIN_HEIGHT = 300;
const TIKTOK_SEEDING_ZOOM = 0.52;
const TIKTOK_SURFACE_READY_TIMEOUT_MS = 25000;
const TIKTOK_SURFACE_READY_POLL_MS = 600;
const TIKTOK_PAGE_LOAD_TIMEOUT_MS = 30000;
const SEEDING_POST_ACTION_STABILIZE_MS = 12000;
const SEEDING_ACTION_CONCURRENCY = 3;
const LIVESTREAM_INITIAL_COMMENT_DELAY_MS = 15000;
const OMOCAPTCHA_CREATE_TASK_URL = 'https://api.omocaptcha.com/v2/createTask';
const OMOCAPTCHA_GET_TASK_RESULT_URL = 'https://api.omocaptcha.com/v2/getTaskResult';

type OmoTikTokWebTaskType =
  | 'TiktokSliderWebTask'
  | 'TiktokRotateWebTask'
  | 'TiktokSelectObjectWebTask'
  | 'Tiktok3DSelectObjectWebTask';

type AccountStatus = 'authenticated' | 'unauthenticated' | 'active' | 'error' | 'live' | 'die';
type AccountSessionUpdate = {
  cookie: string;
  status: 'authenticated';
  lastUsed: string;
};
type ProxyAuthCredentials = {
  username: string;
  password: string;
};
type ParsedProxyConfig = {
  proxyRules: string;
  auth?: ProxyAuthCredentials;
};

let activeSeedingInteractions = 0;
const pendingSeedingInteractions: Array<() => void> = [];
let sessionPreparationQueue = Promise.resolve();
let currentSeedingRun: { cancelRequested: boolean; reason?: string } | null = null;

class SeedingCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedingCancelledError';
  }
}

function requestSeedingCancel(reason: string) {
  if (currentSeedingRun && !currentSeedingRun.cancelRequested) {
    currentSeedingRun.cancelRequested = true;
    currentSeedingRun.reason = reason;
  }
}

function isSeedingCancelRequested(): boolean {
  return !!currentSeedingRun?.cancelRequested;
}

function throwIfSeedingCancelled(win?: BrowserWindow) {
  if (isSeedingCancelRequested()) {
    throw new SeedingCancelledError(currentSeedingRun?.reason || 'Seeding task was cancelled.');
  }
  if (win?.isDestroyed()) {
    throw new SeedingCancelledError('Seeding browser window was closed.');
  }
}

function waitForSeedingDelay(ms: number, win?: BrowserWindow): Promise<void> {
  throwIfSeedingCancelled(win);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(cleanupAndResolve, ms);

    const onClosed = () => {
      cleanup();
      reject(new SeedingCancelledError('Seeding browser window was closed.'));
    };

    function cleanup() {
      clearTimeout(timer);
      win?.removeListener('closed', onClosed);
    }

    function cleanupAndResolve() {
      cleanup();
      try {
        throwIfSeedingCancelled(win);
        resolve();
      } catch (err) {
        reject(err);
      }
    }

    win?.once('closed', onClosed);
  });
}

async function runSeedingInteraction<T>(task: () => Promise<T>): Promise<T> {
  if (activeSeedingInteractions >= SEEDING_ACTION_CONCURRENCY) {
    await new Promise<void>(resolve => pendingSeedingInteractions.push(resolve));
  }
  activeSeedingInteractions++;
  try {
    return await task();
  } finally {
    activeSeedingInteractions = Math.max(0, activeSeedingInteractions - 1);
    const next = pendingSeedingInteractions.shift();
    if (next) next();
  }
}

function getTiledLoginWindowBounds(slotIndex: number) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const columns = Math.max(1, Math.floor((workArea.width + TILED_LOGIN_GAP) / (TILED_LOGIN_TARGET_WIDTH + TILED_LOGIN_GAP)));
  const rows = Math.max(1, Math.floor((workArea.height + TILED_LOGIN_GAP) / (TILED_LOGIN_TARGET_HEIGHT + TILED_LOGIN_GAP)));
  const width = Math.max(
    TILED_LOGIN_MIN_WIDTH,
    Math.floor((workArea.width - TILED_LOGIN_GAP * (columns + 1)) / columns)
  );
  const height = Math.max(
    TILED_LOGIN_MIN_HEIGHT,
    Math.floor((workArea.height - TILED_LOGIN_GAP * (rows + 1)) / rows)
  );
  const visibleSlots = Math.max(1, columns * rows);
  const wrappedIndex = slotIndex % visibleSlots;
  const overflowRound = Math.floor(slotIndex / visibleSlots);
  const col = wrappedIndex % columns;
  const row = Math.floor(wrappedIndex / columns);
  const overflowOffset = overflowRound * TILED_LOGIN_OVERFLOW_OFFSET;
  const rawX = workArea.x + TILED_LOGIN_GAP + col * (width + TILED_LOGIN_GAP) + overflowOffset;
  const rawY = workArea.y + TILED_LOGIN_GAP + row * (height + TILED_LOGIN_GAP) + overflowOffset;
  const maxX = workArea.x + workArea.width - width - TILED_LOGIN_GAP;
  const maxY = workArea.y + workArea.height - height - TILED_LOGIN_GAP;

  return {
    width,
    height,
    x: Math.min(Math.max(rawX, workArea.x + TILED_LOGIN_GAP), maxX),
    y: Math.min(Math.max(rawY, workArea.y + TILED_LOGIN_GAP), maxY),
  };
}

function getTiledSeedingWindowBounds(slotIndex: number) {
  const workArea = screen.getPrimaryDisplay().workArea;
  const columns = Math.max(1, Math.floor((workArea.width + TILED_LOGIN_GAP) / (TILED_SEEDING_TARGET_WIDTH + TILED_LOGIN_GAP)));
  const rows = Math.max(1, Math.floor((workArea.height + TILED_LOGIN_GAP) / (TILED_SEEDING_TARGET_HEIGHT + TILED_LOGIN_GAP)));
  const width = Math.max(
    TILED_SEEDING_MIN_WIDTH,
    Math.floor((workArea.width - TILED_LOGIN_GAP * (columns + 1)) / columns)
  );
  const height = Math.max(
    TILED_SEEDING_MIN_HEIGHT,
    Math.floor((workArea.height - TILED_LOGIN_GAP * (rows + 1)) / rows)
  );
  const visibleSlots = Math.max(1, columns * rows);
  const wrappedIndex = slotIndex % visibleSlots;
  const overflowRound = Math.floor(slotIndex / visibleSlots);
  const col = wrappedIndex % columns;
  const row = Math.floor(wrappedIndex / columns);
  const overflowOffset = overflowRound * TILED_LOGIN_OVERFLOW_OFFSET;
  const rawX = workArea.x + TILED_LOGIN_GAP + col * (width + TILED_LOGIN_GAP) + overflowOffset;
  const rawY = workArea.y + TILED_LOGIN_GAP + row * (height + TILED_LOGIN_GAP) + overflowOffset;
  const maxX = workArea.x + workArea.width - width - TILED_LOGIN_GAP;
  const maxY = workArea.y + workArea.height - height - TILED_LOGIN_GAP;

  return {
    width,
    height,
    x: Math.min(Math.max(rawX, workArea.x + TILED_LOGIN_GAP), maxX),
    y: Math.min(Math.max(rawY, workArea.y + TILED_LOGIN_GAP), maxY),
  };
}

function hasValidTikTokCookieString(cookieStr?: string): boolean {
  if (!cookieStr) return false;
  const lowerCookie = cookieStr.toLowerCase();
  return lowerCookie.includes('sessionid=') ||
         lowerCookie.includes('sessionid_ss=') ||
         lowerCookie.includes('sid_tt=');
}

function isTikTokCookie(cookie: Electron.Cookie): boolean {
  const domain = (cookie.domain || '').toLowerCase();
  return domain === 'tiktok.com' ||
         domain === '.tiktok.com' ||
         domain.endsWith('.tiktok.com') ||
         domain.includes('tiktok.com');
}

function hasTikTokSessionCookie(cookies: Electron.Cookie[]): boolean {
  return cookies
    .filter(isTikTokCookie)
    .some(cookie => cookie.name === 'sessionid' || cookie.name === 'sessionid_ss' || cookie.name === 'sid_tt');
}

function serializeCookieString(cookies: Electron.Cookie[]): string {
  const priorityNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'uid_tt_ss', 'sid_guard']);
  const uniqueCookies = new Map<string, Electron.Cookie>();

  cookies
    .filter(cookie => isTikTokCookie(cookie) && cookie.name && typeof cookie.value === 'string')
    .sort((a, b) => {
      const aPriority = priorityNames.has(a.name) ? 0 : 1;
      const bPriority = priorityNames.has(b.name) ? 0 : 1;
      return aPriority - bPriority || a.name.localeCompare(b.name);
    })
    .forEach(cookie => {
      uniqueCookies.set(cookie.name, cookie);
    });

  return Array.from(uniqueCookies.values())
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

async function collectTikTokCookieString(customSession: Electron.Session): Promise<string> {
  const cookies = await customSession.cookies.get({});
  return serializeCookieString(cookies);
}

async function persistTikTokSessionCookies(
  accountId: string,
  accountUsername: string | undefined,
  customSession: Electron.Session,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  logPrefix = ''
): Promise<boolean> {
  const cookieString = await collectTikTokCookieString(customSession);

  if (!hasValidTikTokCookieString(cookieString)) {
    return false;
  }

  onAccountSessionUpdate(accountId, {
    cookie: cookieString,
    status: 'authenticated',
    lastUsed: new Date().toISOString(),
  });

  onLog({
    accountId,
    accountUsername,
    level: 'success',
    message: `${logPrefix}ÄÃ£ lÆ°u cookie TikTok má»›i cho @${accountUsername || accountId}.`,
  });

  return true;
}

async function waitForTikTokSurfaceReady(
  win: BrowserWindow,
  targetType: SeedingTaskConfig['targetType'],
  timeoutMs = TIKTOK_SURFACE_READY_TIMEOUT_MS
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
      return { ready: false, reason: 'Cá»­a sá»• Ä‘Ã£ Ä‘Ã³ng.' };
    }

    try {
      lastState = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const targetType = ${JSON.stringify(targetType)};
            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 &&
                     rect.height > 0 &&
                     style.visibility !== 'hidden' &&
                     style.display !== 'none';
            };

            const hasUsefulVideoRect = (el) => {
              if (!isVisible(el)) return false;
              const rect = el.getBoundingClientRect();
              return rect.width >= 50 && rect.height >= 50;
            };

            const videoEls = Array.from(document.querySelectorAll('video'));
            const videoContainers = Array.from(document.querySelectorAll(
              '[data-e2e="browse-video"], [data-e2e="video-detail-container"], [data-e2e="user-post-item"], div[class*="VideoContainer"], div[class*="VideoWrapper"], div[class*="DivPlayerContainer"], div[class*="div-article"]'
            ));

            const hasVideo = videoEls.some(hasUsefulVideoRect) ||
                             videoEls.some(isVisible) ||
                             videoEls.length > 0 ||
                             videoContainers.some(isVisible);

            const hasVideoLike = Array.from(document.querySelectorAll(
              '[data-e2e="like-icon"], [data-e2e="browse-like-icon"], [data-e2e="video-like-icon"], [data-e2e="feed-like"], [data-e2e="search-like-icon"], [data-e2e*="like"], button[aria-label*="like" i], button[aria-label*="thÃ­ch" i], button[aria-label*="ThÃ­ch" i], span[aria-label*="like" i], span[aria-label*="thÃ­ch" i], [class*="LikeContainer"], [class*="ButtonLike"], [class*="ButtonActionItem"]'
            )).some(isVisible);

            const hasVideoComment = Array.from(document.querySelectorAll(
              '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], [data-e2e="comment-input"], [data-e2e="comment-input-area"], button[aria-label*="comment" i], button[aria-label*="bÃ¬nh luáº­n" i], [role="textbox"], textarea'
            )).some(isVisible);

            const hasLiveChat = Array.from(document.querySelectorAll(
              '[data-e2e="room-chat-input-field"], [data-e2e="room-chat-send-btn"], [data-e2e*="room-chat"], div[contenteditable], [role="textbox"]'
            )).some(isVisible);

            const hasLiveLike = Array.from(document.querySelectorAll(
              '[data-e2e="room-chat-like-btn"]'
            )).some(isVisible);

            const isVideoUrl = location.href.includes('/video/') ||
                               location.href.includes('/v/') ||
                               location.href.includes('/photo/') ||
                               location.href.includes('/t/');

            const bodyText = document.body?.innerText || '';
            const isLoginScreen = bodyText.includes('Log in to TikTok') ||
                                  bodyText.includes('Use phone or email') ||
                                  bodyText.includes('ÄÄƒng nháº­p');

            const readyState = document.readyState;
            const hasVideoSurface = hasVideo || hasVideoLike || hasVideoComment || isVideoUrl;
            const commonReady = readyState !== 'loading' && !isLoginScreen;

            const ready = targetType === 'livestream'
              ? commonReady && (hasLiveChat || hasLiveLike || bodyText.includes('LIVE') || location.href.includes('/live'))
              : commonReady && hasVideoSurface;

            return {
              ready,
              readyState,
              hasVideo,
              hasVideoLike,
              hasVideoComment,
              hasLiveChat,
              hasLiveLike,
              isLoginScreen
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

    await new Promise(res => setTimeout(res, TIKTOK_SURFACE_READY_POLL_MS));
  }

  return {
    ready: false,
    readyState: lastState?.readyState,
    hasVideo: lastState?.hasVideo,
    hasVideoLike: lastState?.hasVideoLike,
    hasVideoComment: lastState?.hasVideoComment,
    hasLiveChat: lastState?.hasLiveChat,
    hasLiveLike: lastState?.hasLiveLike,
    reason: lastState?.isLoginScreen
      ? 'Äang á»Ÿ mÃ n hÃ¬nh Ä‘Äƒng nháº­p.'
      : lastState?.reason || 'TikTok chÆ°a render Ä‘á»§ UI trong thá»i gian chá».',
  };
}

function normalizeProxyProtocol(proxyType?: string): 'http' | 'socks5' {
  return proxyType === 'socks5' ? 'socks5' : 'http';
}

function parseProxyConfig(proxyStr?: string, proxyType: string = 'http'): ParsedProxyConfig | null {
  const rawProxy = proxyStr?.trim();
  if (!rawProxy) return null;

  const defaultProtocol = normalizeProxyProtocol(proxyType);
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawProxy)
    ? rawProxy
    : `${defaultProtocol}://${rawProxy}`;
  const parsed = new URL(withProtocol);
  const protocol = parsed.protocol.replace(':', '') === 'socks5' ? 'socks5' : 'http';
  const hostname = parsed.hostname;
  const port = parsed.port;

  if (!hostname || !port) {
    throw new Error(`Proxy thieu host/port: ${proxyStr}`);
  }

  const auth = parsed.username || parsed.password
    ? {
        username: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
      }
    : undefined;

  return {
    proxyRules: `${protocol}://${hostname}:${port}`,
    auth,
  };
}

function parseLegacyProxyConfig(proxyStr: string, proxyType: string = 'http'): ParsedProxyConfig | null {
  const formattedProxy = proxyStr.trim();
  const parts = formattedProxy.split(':');

  if (parts.length === 4 && !formattedProxy.includes('@')) {
    const [ip, port, user, pass] = parts;
    return parseProxyConfig(`${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${ip}:${port}`, proxyType);
  }

  return parseProxyConfig(proxyStr, proxyType);
}

function attachProxyAuthHandler(win: BrowserWindow, auth?: ProxyAuthCredentials) {
  if (!auth) return;

  win.webContents.on('login', (event, _request, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    event.preventDefault();
    callback(auth.username, auth.password);
  });
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

async function loadLoginStartPage(
  win: BrowserWindow,
  customSession: Electron.Session,
  url: string,
  acc: { id: string; username?: string },
  proxyStr: string | undefined,
  proxyConfig: ParsedProxyConfig | null,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
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

async function detectTikTokLoggedOutState(win: BrowserWindow): Promise<{
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

async function clearTikTokAuthCookies(customSession: Electron.Session): Promise<void> {
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

async function ensureAuthenticatedForSeeding(
  win: BrowserWindow,
  customSession: Electron.Session,
  acc: AccountInfo,
  targetUrl: string,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
): Promise<boolean> {
  const loggedOutState = await detectTikTokLoggedOutState(win);
  if (!loggedOutState.loggedOut) return true;

  onAccountStatusChange(acc.id, 'unauthenticated');
  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'warning',
    message: `[Auth] @${acc.username} bi out session khi seeding: ${loggedOutState.reason || 'TikTok hien trang thai chua dang nhap.'}`,
  });

  if (!acc.password) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `[Auth] @${acc.username} chua co mat khau trong app nen khong the tu login lai. Vui long mo Chrome/Login thu cong de lay session moi.`,
    });
    return false;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Auth] Dang tu login lai cho @${acc.username} truoc khi tiep tuc seeding...`,
  });

  await clearTikTokAuthCookies(customSession).catch(() => undefined);
  await win.loadURL('https://www.tiktok.com/login/phone-or-email/email').catch((err: any) => {
    const errMsg = err?.message || String(err);
    if (!errMsg.includes('ERR_ABORTED') && err?.code !== 'ERR_ABORTED' && err?.errno !== -3) {
      throw err;
    }
  });

  const loginResult = await monitorLoginFlow(
    win,
    customSession,
    acc,
    onLog,
    onAccountStatusChange,
    onAccountSessionUpdate
  );

  if (!loginResult?.success) {
    onAccountStatusChange(acc.id, 'unauthenticated');
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[Auth] Login lai that bai cho @${acc.username}: ${loginResult?.status || 'unknown'}. Bo qua tai khoan nay.`,
    });
    return false;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'success',
    message: `[Auth] Login lai thanh cong cho @${acc.username}. Dang tai lai URL seeding...`,
  });

  await loadTikTokUrlForSeeding(win, customSession, targetUrl, acc, onLog);
  return true;
}

/**
 * Helper to inject Proxy and Cookie string into an Electron Session
 */
async function configureSessionProxyAndCookies(
  customSession: Electron.Session,
  cookieStr?: string,
  proxyStr?: string,
  proxyType: string = 'http',
  options: { skipCookieInjectionIfSessionExists?: boolean } = {}
): Promise<ParsedProxyConfig | null> {
  let proxyConfig: ParsedProxyConfig | null = null;

  if (proxyStr && proxyStr.trim().length > 0) {
    try {
      proxyConfig = parseLegacyProxyConfig(proxyStr, proxyType);
      await customSession.setProxy({ proxyRules: proxyConfig?.proxyRules || '' });
      console.log(`[Proxy] Configured proxy: ${proxyConfig?.proxyRules || 'direct'}${proxyConfig?.auth ? ' [auth]' : ''}`);
    } catch (err) {
      console.error('[Proxy] Failed to set proxy:', err);
      await customSession.setProxy({ proxyRules: '' }).catch(() => undefined);
      proxyConfig = null;
    }
  } else {
    await customSession.setProxy({ proxyRules: '' });
  }

  if (hasValidTikTokCookieString(cookieStr)) {
    const existingCookies = await customSession.cookies.get({}).catch(() => []);
    const hasExistingSession = hasTikTokSessionCookie(existingCookies);

    if (options.skipCookieInjectionIfSessionExists && hasExistingSession) {
      console.log('[Cookie] Session cookie already exists. Skipped reinjecting cookies for seeding.');
      return proxyConfig;
    }

    const pairs = cookieStr.split(';').map(p => p.trim()).filter(p => p.length > 0);
    let injectedCount = 0;
    let skippedCount = 0;

    for (const pair of pairs) {
      const eqIdx = pair.indexOf('=');
      if (eqIdx <= 0) {
        skippedCount++;
        continue;
      }

      const name = pair.substring(0, eqIdx).trim();
      const value = pair.substring(eqIdx + 1).trim();
      if (!name || !value || /[\r\n;]/.test(name) || /[\r\n;]/.test(value)) {
        skippedCount++;
        continue;
      }

      const cookieBase = {
        url: 'https://www.tiktok.com',
        name,
        value,
        path: '/',
        secure: true,
      };

      const candidates: Electron.CookiesSetDetails[] = name.startsWith('__Host-')
        ? [cookieBase]
        : [
            {
              ...cookieBase,
              domain: '.tiktok.com',
              sameSite: 'no_restriction',
            },
            cookieBase,
          ];

      let injected = false;
      for (const candidate of candidates) {
        try {
          await customSession.cookies.set(candidate);
          injected = true;
          injectedCount++;
          break;
        } catch (err) {
          // Try the next compatible shape. Some Chromium cookies reject domain/sameSite.
        }
      }

      if (!injected) {
        skippedCount++;
      }
    }

    const hasInjectedSession = hasTikTokSessionCookie(await customSession.cookies.get({}));

    if (hasInjectedSession) {
      console.log(`[Cookie] Injected ${injectedCount}/${pairs.length} cookie keys into session. Skipped ${skippedCount}.`);
    } else {
      console.warn(`[Cookie] KhÃ´ng inject Ä‘Æ°á»£c session cookie TikTok. Injected ${injectedCount}/${pairs.length}, skipped ${skippedCount}.`);
    }
  }

  return proxyConfig;
}

async function runSessionPreparation<T>(task: () => Promise<T>): Promise<T> {
  const previous = sessionPreparationQueue;
  let release!: () => void;
  sessionPreparationQueue = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
  }
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

async function getTikTokPageSnapshot(win: BrowserWindow): Promise<{
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

async function clearTikTokRenderCache(customSession: Electron.Session): Promise<void> {
  await customSession.clearCache().catch(() => {});
  await customSession.clearStorageData({
    origin: 'https://www.tiktok.com',
    storages: ['serviceworkers', 'cachestorage'] as any,
  } as any).catch(() => {});
}

async function loadTikTokUrlForSeeding(
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

function getOmoCaptchaApiKey(): string {
  try {
    const settingsPath = path.join(ensurePersistentDataDir(), 'settings.json');
    if (!fs.existsSync(settingsPath)) return '';
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    return String(settings.omocaptchaApiKey || '').trim();
  } catch {
    return '';
  }
}

async function postOmoCaptcha(payload: any): Promise<any> {
  const res = await fetch(payload.task ? OMOCAPTCHA_CREATE_TASK_URL : OMOCAPTCHA_GET_TASK_RESULT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function solveTikTokWebCaptchaWithOmo(
  win: BrowserWindow,
  acc: { id: string; username: string },
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  const clientKey = getOmoCaptchaApiKey();
  if (!clientKey) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: '[Captcha] OmoCaptcha API key is empty. Manual TikTok captcha solving required.',
    });
    return false;
  }

  const captchaInfo = await win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 80 && rect.height > 60 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const detectTaskType = (root) => {
          const text = String((root?.innerText || '') + ' ' + (document.body?.innerText || '')).toLowerCase();
          if (/3d|three[- ]?d|same object|same shape|matching object|hai doi tuong|2 doi tuong/.test(text)) {
            return 'Tiktok3DSelectObjectWebTask';
          }
          if (/rotate|xoay|angle|match the shape|fit the shape/.test(text)) {
            return 'TiktokRotateWebTask';
          }
          if (/select|choose|pick|object|chon|doi tuong|vat the/.test(text)) {
            return 'TiktokSelectObjectWebTask';
          }
          return 'TiktokSliderWebTask';
        };

        const candidates = Array.from(document.querySelectorAll(
          '#captcha-verify-container, .sec-captcha-container, [class*="captcha" i], [id*="captcha" i], iframe[src*="captcha"], iframe[src*="sec"]'
        )).filter(isVisible);
        const captcha = candidates.sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        })[0];
        if (!captcha) return { found: false };

        const rect = captcha.getBoundingClientRect();
        const slider = Array.from(document.querySelectorAll(
          '[class*="slider" i], [class*="drag" i], [role="slider"], button, [role="button"]'
        )).filter(el => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 20 && r.height >= 20 && r.left >= rect.left - 20 && r.right <= rect.right + 20 && r.top >= rect.top - 20 && r.bottom <= rect.bottom + 60;
        }).sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return ar.left - br.left;
        })[0];
        const sliderRect = slider?.getBoundingClientRect();
        const track = Array.from(document.querySelectorAll(
          '[class*="track" i], [class*="slider" i], [class*="drag" i], [role="slider"]'
        )).filter(el => {
          if (!isVisible(el)) return false;
          const r = el.getBoundingClientRect();
          return r.width >= 80 && r.height >= 8 && r.left >= rect.left - 30 && r.right <= rect.right + 30 && r.top >= rect.top - 20 && r.bottom <= rect.bottom + 80;
        }).sort((a, b) => {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        })[0];
        const trackRect = track?.getBoundingClientRect();

        return {
          found: true,
          taskType: detectTaskType(captcha),
          rect: {
            x: Math.max(0, Math.round(rect.left)),
            y: Math.max(0, Math.round(rect.top)),
            width: Math.round(rect.width),
            height: Math.round(rect.height)
          },
          widthView: Math.round(rect.width),
          heightView: Math.round(rect.height),
          slider: sliderRect ? {
            x: Math.round(sliderRect.left + sliderRect.width / 2),
            y: Math.round(sliderRect.top + sliderRect.height / 2)
          } : null,
          track: trackRect ? {
            x: Math.round(trackRect.left),
            y: Math.round(trackRect.top),
            width: Math.round(trackRect.width),
            height: Math.round(trackRect.height)
          } : null
        };
      } catch(e) {
        return { found: false, error: String(e) };
      }
    })();
  `).catch(() => ({ found: false }));

  if (!captchaInfo?.found || !captchaInfo.rect) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: '[Captcha] Could not locate TikTok captcha panel for OmoCaptcha.',
    });
    return false;
  }

  const image = await win.webContents.capturePage(captchaInfo.rect);
  const imageBase64 = image.toDataURL().split(',')[1] || '';
  const taskType = ([
    'TiktokSliderWebTask',
    'TiktokRotateWebTask',
    'TiktokSelectObjectWebTask',
    'Tiktok3DSelectObjectWebTask',
  ].includes(captchaInfo.taskType) ? captchaInfo.taskType : 'TiktokSliderWebTask') as OmoTikTokWebTaskType;
  const taskPayload: {
    type: OmoTikTokWebTaskType;
    imageBase64: string;
    widthView: number;
    heightView?: number;
  } = {
    type: taskType,
    imageBase64,
    widthView: captchaInfo.widthView,
  };

  if (taskType !== 'TiktokSliderWebTask') {
    taskPayload.heightView = captchaInfo.heightView || captchaInfo.rect.height;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Captcha] Sending ${taskType} to OmoCaptcha. widthView=${taskPayload.widthView}, heightView=${taskPayload.heightView || 'n/a'}`,
  });

  const createRes = await postOmoCaptcha({
    clientKey,
    task: taskPayload,
  });

  if (createRes.errorId !== 0 || !createRes.taskId) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[Captcha] OmoCaptcha createTask failed: ${createRes.errorCode || ''} ${createRes.errorDescription || ''}`,
    });
    return false;
  }

  let solution: any = null;
  for (let i = 0; i < 12; i++) {
    await new Promise(res => setTimeout(res, i === 0 ? 1200 : 2000));
    const resultRes = await postOmoCaptcha({ clientKey, taskId: createRes.taskId });
    if (resultRes.errorId !== 0) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'error',
        message: `[Captcha] OmoCaptcha getTaskResult failed: ${resultRes.errorCode || ''} ${resultRes.errorDescription || ''}`,
      });
      return false;
    }
    if (resultRes.status === 'ready') {
      solution = resultRes.solution;
      break;
    }
    if (resultRes.status === 'fail') {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'error',
        message: '[Captcha] OmoCaptcha task failed.',
      });
      return false;
    }
  }

  const zoomFactor = win.webContents.getZoomFactor();
  const toAbsolutePoint = (point: any) => ({
    x: Math.round((captchaInfo.rect.x + Number(point.x || 0)) * zoomFactor),
    y: Math.round((captchaInfo.rect.y + Number(point.y || 0)) * zoomFactor),
  });
  const clickPoint = async (point: any) => {
    const { x, y } = toAbsolutePoint(point);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await new Promise(res => setTimeout(res, 80 + Math.random() * 80));
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    await new Promise(res => setTimeout(res, 70 + Math.random() * 80));
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await new Promise(res => setTimeout(res, 350 + Math.random() * 250));
  };
  const dragToPoint = async (end: any) => {
    const startX = Math.round((captchaInfo.slider?.x || (captchaInfo.rect.x + 38)) * zoomFactor);
    const startY = Math.round((captchaInfo.slider?.y || (captchaInfo.rect.y + captchaInfo.rect.height - 34)) * zoomFactor);
    const endPoint = toAbsolutePoint({
      x: Number(end.x || 0),
      y: typeof end.y === 'number' ? end.y : captchaInfo.rect.height - 34,
    });
    const steps = 28;

    win.webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY });
    win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 });
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 2);
      const x = Math.round(startX + (endPoint.x - startX) * ease + (Math.random() * 2 - 1));
      const y = Math.round(startY + (endPoint.y - startY) * t + (Math.random() * 2 - 1));
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      await new Promise(res => setTimeout(res, 18 + Math.random() * 20));
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', x: endPoint.x, y: endPoint.y, button: 'left', clickCount: 1 });
  };
  const dragByAngle = async (angle: number) => {
    const startX = Math.round((captchaInfo.slider?.x || (captchaInfo.rect.x + 38)) * zoomFactor);
    const startY = Math.round((captchaInfo.slider?.y || (captchaInfo.rect.y + captchaInfo.rect.height - 34)) * zoomFactor);
    const trackWidth = captchaInfo.track?.width || Math.max(120, captchaInfo.rect.width - 80);
    const clampedAngle = Math.max(-180, Math.min(180, Number(angle) || 0));
    const offset = Math.round((clampedAngle / 180) * (trackWidth * 0.45) * zoomFactor);
    const endX = startX + offset;
    await dragToPoint({
      x: (endX / zoomFactor) - captchaInfo.rect.x,
      y: (startY / zoomFactor) - captchaInfo.rect.y,
    });
  };

  let applied = false;
  if (solution?.pointA && solution?.pointB) {
    await clickPoint(solution.pointA);
    await clickPoint(solution.pointB);
    applied = true;
  } else if (Array.isArray(solution?.points) && solution.points.length) {
    for (const point of solution.points.slice(0, 6)) {
      await clickPoint(point);
    }
    applied = true;
  } else if (solution?.point && typeof solution.point.x === 'number') {
    await clickPoint(solution.point);
    applied = true;
  } else if (Array.isArray(solution?.objects) && solution.objects.length) {
    for (const objectIndex of solution.objects.slice(0, 6)) {
      const index = Math.max(0, Number(objectIndex) || 0);
      const col = index % 3;
      const row = Math.floor(index / 3);
      await clickPoint({
        x: captchaInfo.rect.width * (col + 0.5) / 3,
        y: captchaInfo.rect.height * (row + 0.5) / 2,
      });
    }
    applied = true;
  } else if (solution?.end && typeof solution.end.x === 'number') {
    await dragToPoint(solution.end);
    applied = true;
  } else {
    const angle = solution?.angle ?? solution?.degree ?? solution?.degrees ?? solution?.rotate;
    if (typeof angle === 'number' || typeof angle === 'string') {
      await dragByAngle(Number(angle));
      applied = true;
    }
  }

  if (!applied) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `[Captcha] OmoCaptcha returned unsupported ${taskType} solution shape: ${JSON.stringify(solution || {})}`,
    });
    return false;
  }

  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const texts = ['verify', 'confirm', 'submit', 'done', 'ok', 'continue', 'xac minh', 'xong', 'tiep tuc'];
        const isVisible = (el) => {
          const r = el.getBoundingClientRect();
          const s = window.getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
        };
        const button = Array.from(document.querySelectorAll('button, [role="button"]')).find(el => {
          if (!isVisible(el)) return false;
          const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
          return texts.some(t => text.includes(t));
        });
        button?.click();
      } catch(e) {}
    })();
  `).catch(() => undefined);
  await new Promise(res => setTimeout(res, 2500));

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'success',
    message: `[Captcha] OmoCaptcha ${taskType} solution submitted for @${acc.username}.`,
  });
  return true;
}

async function activateLiveUiForTapping(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;

  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
                 rect.height > 0 &&
                 style.visibility !== 'hidden' &&
                 style.display !== 'none';
        };

        const input = Array.from(document.querySelectorAll(
          '[data-e2e="room-chat-input-field"], [data-e2e*="room-chat"], [role="textbox"], div[contenteditable], textarea, input[type="text"]'
        )).find(isVisible);

        if (input) {
          input.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
          input.click();
          input.focus?.();
        }
      } catch(e) {}
    })();
  `).catch(() => undefined);

  await new Promise(res => setTimeout(res, 250));

  if (win.isDestroyed()) return;
  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      } catch(e) {}
    })();
  `).catch(() => undefined);
}

async function getLiveTapPoint(win: BrowserWindow, preferButton = false): Promise<{ x: number; y: number; target?: string } | null> {
  if (win.isDestroyed()) return null;

  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const preferButton = ${preferButton ? 'true' : 'false'};
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 &&
                 rect.height > 0 &&
                 style.visibility !== 'hidden' &&
                 style.display !== 'none';
        };

        const findRoomLikeButton = () => {
          const exact = document.querySelector('[data-e2e="room-chat-like-btn"]');
          if (exact && isVisible(exact)) return exact;
          return Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [data-e2e]')).find(el => {
            if (!isVisible(el)) return false;
            const label = [
              el.getAttribute('aria-label'),
              el.getAttribute('data-e2e'),
              el.getAttribute('title'),
              el.textContent
            ].join(' ').toLowerCase();
            return label.includes('like') ||
                   label.includes('heart') ||
                   label.includes('thÃ­ch') ||
                   label.includes('tap');
          });
        };

        if (preferButton) {
          const button = findRoomLikeButton();
          if (button) {
            const rect = button.getBoundingClientRect();
            return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'room-like-btn' };
          }
        }

        const scoreSurface = (el) => {
          const rect = el.getBoundingClientRect();
          const centerBias = Math.abs((rect.left + rect.width / 2) - window.innerWidth * 0.42);
          return (rect.width * rect.height) - centerBias * 20;
        };

        const surface = Array.from(document.querySelectorAll(
          'video, canvas, [data-e2e="live-player"], [data-e2e="live-room"], [data-e2e*="live-player"], [class*="LivePlayer"], [class*="live-player"], [class*="DivLive"], [class*="Player"]'
        )).filter(isVisible).sort((a, b) => scoreSurface(b) - scoreSurface(a))[0];

        if (surface) {
          const rect = surface.getBoundingClientRect();
          return {
            x: Math.round(rect.left + rect.width * 0.5),
            y: Math.round(rect.top + rect.height * 0.52),
            target: surface.tagName?.toLowerCase() === 'video' ? 'live-video' : 'live-surface'
          };
        }

        const button = findRoomLikeButton();
        if (button) {
          const rect = button.getBoundingClientRect();
          return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'room-like-btn' };
        }

        const width = window.innerWidth || document.documentElement.clientWidth || 800;
        const height = window.innerHeight || document.documentElement.clientHeight || 600;
        return { x: Math.round(width * 0.42), y: Math.round(height * 0.5), target: 'screen-fallback' };
      } catch(e) {
        return null;
      }
    })();
  `).catch(() => null);
}

async function tapLiveContinuously(
  win: BrowserWindow,
  acc: { id: string; username: string },
  liveDurationSeconds: number,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  label = 'live'
): Promise<number> {
  await activateLiveUiForTapping(win);

  const endAt = Date.now() + liveDurationSeconds * 1000;
  let tapCount = 0;
  const tapTargets: Record<string, number> = {};

  while (Date.now() < endAt && !win.isDestroyed()) {
    const tapPoint = await getLiveTapPoint(win, tapCount % 4 === 3);

    if (tapPoint && typeof tapPoint.x === 'number' && typeof tapPoint.y === 'number') {
      const zoomFactor = win.webContents.getZoomFactor();
      const tapX = Math.max(1, Math.round(tapPoint.x * zoomFactor));
      const tapY = Math.max(1, Math.round(tapPoint.y * zoomFactor));

      win.webContents.sendInputEvent({ type: 'mouseMove', x: tapX, y: tapY });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: tapX, y: tapY, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x: tapX, y: tapY, button: 'left', clickCount: 1 });
      tapTargets[tapPoint.target || 'unknown'] = (tapTargets[tapPoint.target || 'unknown'] || 0) + 1;
      tapCount++;
    }

    await new Promise(res => setTimeout(res, 90 + Math.random() * 60));
  }

  const targetSummary = Object.entries(tapTargets)
    .map(([target, count]) => `${target}:${count}`)
    .join(', ');

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: tapCount > 0 ? 'success' : 'warning',
    message: tapCount > 0
      ? `[Live Like:${label}] Tapped live ${tapCount} times in ${liveDurationSeconds}s${targetSummary ? ` (${targetSummary})` : ''}.`
      : `[Live Like:${label}] Khong tim thay vung live/nut tim de tap cho @${acc.username}.`,
  });

  return tapCount;
}

/**
 * Auto-Fill Username & Password on TikTok Login Page
 */
async function autoFillTikTokLogin(win: BrowserWindow, usernameOrEmail: string, password?: string): Promise<boolean> {
  if (!usernameOrEmail || !password || win.isDestroyed()) return false;

  try {
    await new Promise(r => setTimeout(r, 1500));
    if (win.isDestroyed()) return false;

    const filled = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const setReactInputValue = (inputEl, val) => {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) {
              nativeSetter.call(inputEl, val);
            } else {
              inputEl.value = val;
            }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            inputEl.dispatchEvent(new Event('blur', { bubbles: true }));
          };

          const emailInput = document.querySelector('input[name="username"]') ||
                             document.querySelector('input[placeholder*="Email" i]') ||
                             document.querySelector('input[placeholder*="phone" i]') ||
                             document.querySelector('input[type="text"]');

          const passInput = document.querySelector('input[type="password"]');

          if (emailInput && passInput) {
            emailInput.focus();
            setReactInputValue(emailInput, ${JSON.stringify(usernameOrEmail)});

            await new Promise(r => setTimeout(r, 400));

            passInput.focus();
            setReactInputValue(passInput, ${JSON.stringify(password)});

            await new Promise(r => setTimeout(r, 600));

            const isVisible = (el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const submitBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(btn => {
              if (!isVisible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
              const txt = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
              const e2e = (btn.getAttribute('data-e2e') || '').toLowerCase();
              return btn.type === 'submit' ||
                     e2e.includes('login') ||
                     txt === 'log in' ||
                     txt === 'login' ||
                     txt === 'continue' ||
                     txt.includes('Ä‘Äƒng nháº­p') ||
                     txt.includes('tiáº¿p tá»¥c');
            });

            if (submitBtn) {
              submitBtn.removeAttribute('disabled');
              submitBtn.disabled = false;
              submitBtn.classList.remove('disabled');
              submitBtn.click();
              return true;
            }
          }
          return false;
        } catch(e) {
          return false;
        }
      })();
    `);

    if (filled) {
      await new Promise(r => setTimeout(r, 400));
      if (!win.isDestroyed()) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
    }

    return filled;
  } catch (err) {
    console.error('[Auto-Fill Login Error]:', err);
    return false;
  }
}

/**
 * Single Strategy helper to fill 6-digit OTP code into inputs without duplicating characters
 */
async function fillSixDigitCodeSingleStrategy(win: BrowserWindow, code: string): Promise<boolean> {
  if (!code || code.length < 6 || win.isDestroyed()) return false;

  try {
    const success = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const otpDigits = ${JSON.stringify(code)};
          const setNativeValue = (inputEl, val) => {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) {
              nativeSetter.call(inputEl, val);
            } else {
              inputEl.value = val;
            }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            inputEl.dispatchEvent(new Event('keyup', { bubbles: true }));
            inputEl.dispatchEvent(new Event('blur', { bubbles: true }));
          };

          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };

          const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[inputmode="numeric"], input[class*="Digit"]'))
            .filter(input => isVisible(input) && input.type !== 'password' && !input.disabled && !input.readOnly);

          if (inputs.length >= 6) {
            for (let i = 0; i < 6; i++) {
              if (inputs[i]) {
                inputs[i].focus();
                setNativeValue(inputs[i], otpDigits[i]);
              }
            }
          } else if (inputs.length > 0) {
            const singleInput = inputs[0];
            singleInput.focus();
            setNativeValue(singleInput, otpDigits);
          } else {
            return false;
          }

          await new Promise(r => setTimeout(r, 500));

          const submitBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(btn => {
            if (!isVisible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
            const txt = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
            const e2e = (btn.getAttribute('data-e2e') || '').toLowerCase();
            return e2e.includes('verify') ||
                   e2e.includes('two-step') ||
                   txt === 'verify' ||
                   txt === 'continue' ||
                   txt === 'next' ||
                   txt === 'submit' ||
                   txt.includes('xÃ¡c minh') ||
                   txt.includes('tiáº¿p tá»¥c') ||
                   txt.includes('káº¿ tiáº¿p');
          });

          if (submitBtn) {
            submitBtn.removeAttribute('disabled');
            submitBtn.disabled = false;
            submitBtn.click();
          }
          return true;
        } catch(e) {
          return false;
        }
      })();
    `);

    if (success) {
      await new Promise(r => setTimeout(r, 300));
      if (!win.isDestroyed()) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
    }
    return success;
  } catch (err) {
    console.error('[Fill 6-Digit Code Error]:', err);
    return false;
  }
}

interface AccountInfo {
  id: string;
  username: string;
  password?: string;
  email?: string;
  passMail?: string;
  twoFactor?: string;
  cookie?: string;
}

/**
 * Unified Login Flow Monitor (90 seconds) for both Single & Multi login
 */
async function monitorLoginFlow(
  win: BrowserWindow,
  customSession: Electron.Session,
  acc: AccountInfo,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
) {
  const maxMonitorMs = 90000; // 90 seconds monitoring
  const pollIntervalMs = 3000; // Poll every 3s
  const startTime = Date.now();

  let hasWarnedCaptcha = false;
  let hasAutoFilled = false;
  let hasFilledTotp = false;
  let hasClickedEmailOption = false;
  let emailOptionClickedAt = 0;
  let hasFilledEmailOtp = false;
  let requestedOtpTimestamp = 0;
  let isSolvingCaptcha = false;


  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Monitor] ÄÃ£ kÃ­ch hoáº¡t giÃ¡m sÃ¡t luá»“ng Ä‘Äƒng nháº­p cho @${acc.username}...`,
  });

  while (Date.now() - startTime < maxMonitorMs) {
    if (win.isDestroyed()) break;

    try {
      // 1. STRICT SESSION COOKIE CHECK FOR AUTHENTICATED STATUS
      const cookies = await customSession.cookies.get({ domain: '.tiktok.com' });
      const hasSessionCookie = cookies.some(
        c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt'
      );

      // DOM State Check
      const pageState = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const url = window.location.href;
            const bodyText = document.body.innerText || '';

            // STRICT Logged-In DOM Indicators (User Profile Avatar Menu / Logout Button)
            // DO NOT match generic a[href*="/@"]
            const hasUserMenu = !!document.querySelector('[data-e2e="profile-icon"]') &&
                                (!!document.querySelector('ul[class*="UserMenu"]') || !!document.querySelector('[aria-label*="Profile"]'));
            const hasLogoutBtn = bodyText.includes('Log out') || bodyText.includes('ÄÄƒng xuáº¥t');

            // Captcha / Challenge Indicators
            const hasCaptcha = !!document.querySelector('iframe[src*="captcha"]') ||
                               !!document.querySelector('iframe[src*="sec"]') ||
                               !!document.querySelector('#captcha-verify-container') ||
                               !!document.querySelector('.sec-captcha-container') ||
                               bodyText.includes('Drag the slider') ||
                               bodyText.includes('Select 2 objects') ||
                               bodyText.includes('Rotate the image') ||
                               bodyText.includes('Complete the puzzle') ||
                               bodyText.includes('Verify to continue');

            // Precise 2FA TOTP Indicators
            const is2FA = !hasCaptcha && (
              bodyText.includes('2-step verification') ||
              bodyText.includes('Authenticator app') ||
              bodyText.includes('Enter 6-digit code') ||
              bodyText.includes('Security code') ||
              bodyText.includes('Enter the code from authenticator app')
            );

            // Email Checkpoint: Option Selection Screen vs 6-Digit Code Input Screen
            const isEmailCheckpoint = !hasCaptcha && !is2FA && (
              bodyText.includes("Verify it's really you") ||
              bodyText.includes("XÃ¡c minh Ä‘Ã³ lÃ  báº¡n")
            );

            // Check if 6-digit inputs are active on screen for Email OTP
            const hasDigitInputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[class*="Digit"]')).length >= 1;

            const isEmailCodeInputScreen = isEmailCheckpoint && (hasDigitInputs || bodyText.includes('Enter code') || bodyText.includes('sent to email'));
            const isEmailOptionSelectionScreen = isEmailCheckpoint && !isEmailCodeInputScreen;

            const lowerText = bodyText.toLowerCase();
            const isVisible = (el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const visibleCodeInputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[inputmode="numeric"], input[class*="Digit"]'))
              .filter(input => isVisible(input) && input.type !== 'password' && !input.disabled && !input.readOnly);

            const hasSixSingleDigitInputs = visibleCodeInputs.length >= 6 && visibleCodeInputs.slice(0, 6).every(input => {
              const maxLength = Number(input.getAttribute('maxlength') || input.maxLength || 0);
              const inputMode = (input.getAttribute('inputmode') || '').toLowerCase();
              const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
              return input.type === 'number' || inputMode === 'numeric' || autocomplete === 'one-time-code' || maxLength === 1;
            });

            const hasEmailSignal = lowerText.includes('email') ||
                                   lowerText.includes('mail') ||
                                   lowerText.includes('@') ||
                                   lowerText.includes('hÃ²m thÆ°') ||
                                   lowerText.includes('thÆ° Ä‘iá»‡n tá»­');

            const hasEmailCodePrompt = lowerText.includes('enter code') ||
                                       lowerText.includes('enter the code') ||
                                       lowerText.includes('verification code') ||
                                       lowerText.includes('6-digit') ||
                                       lowerText.includes('six-digit') ||
                                       lowerText.includes('sent to email') ||
                                       lowerText.includes('sent to your email') ||
                                       lowerText.includes('code sent') ||
                                       lowerText.includes('mÃ£ xÃ¡c minh') ||
                                       lowerText.includes('nháº­p mÃ£') ||
                                       lowerText.includes('gá»­i Ä‘áº¿n email') ||
                                       lowerText.includes('gá»­i tá»›i email');

            const emailOptionCandidate = Array.from(document.querySelectorAll('button, [role="button"], div, span, p')).find(el => {
              if (!isVisible(el)) return false;
              const txt = (el.innerText || el.textContent || '').toLowerCase();
              return (txt.includes('email') || txt.includes('@') || txt.includes('hÃ²m thÆ°')) &&
                     !txt.includes('enter code') &&
                     !txt.includes('verification code') &&
                     !txt.includes('nháº­p mÃ£');
            });

            const resolvedEmailCodeInputScreen = isEmailCodeInputScreen ||
              (!hasCaptcha && !is2FA && hasEmailSignal && hasEmailCodePrompt && (visibleCodeInputs.length >= 1 || hasSixSingleDigitInputs));
            const resolvedEmailOptionSelectionScreen = !resolvedEmailCodeInputScreen &&
              (isEmailOptionSelectionScreen || ((isEmailCheckpoint || hasEmailSignal) && !!emailOptionCandidate));

            // Login Error Toast / Bad Credentials
            const hasError = bodyText.includes('Maximum number of attempts reached') ||
                             bodyText.includes('Incorrect password') ||
                             bodyText.includes('User does not exist');

            const visibleButtons = Array.from(document.querySelectorAll('button, a, [role="button"], [data-e2e]')).filter(isVisible);
            const hasLoginButton = visibleButtons.some(el => {
              const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
              const e2e = (el.getAttribute('data-e2e') || '').toLowerCase();
              return e2e === 'top-login-button' ||
                     txt === 'log in' ||
                     txt === 'login' ||
                     txt.includes('dang nhap') ||
                     txt.includes('đăng nhập');
            });
            const hasLoginToComment = visibleButtons.some(el => {
              const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
              return txt.includes('log in to comment') ||
                     txt.includes('login to comment') ||
                     txt.includes('đăng nhập để bình luận') ||
                     txt.includes('dang nhap de binh luan');
            }) || lowerText.includes('log in to comment') || lowerText.includes('login to comment');
            const isLoginScreen = hasLoginButton ||
                                  hasLoginToComment ||
                                  bodyText.includes('Log in to TikTok') ||
                                  bodyText.includes('Use phone or email') ||
                                  bodyText.includes('Đăng nhập vào TikTok') ||
                                  bodyText.includes('Ã„ÂÃ„Æ’ng nhÃ¡ÂºÂ­p');

            return {
              hasUserMenu,
              hasLogoutBtn,
              hasCaptcha,
              is2FA,
              isEmailOptionSelectionScreen: resolvedEmailOptionSelectionScreen,
              isEmailCodeInputScreen: resolvedEmailCodeInputScreen,
              hasError,
              isLoginScreen,
              hasLoginButton,
              hasLoginToComment
            };
          } catch(e) {
            return {
              hasUserMenu: false,
              hasLogoutBtn: false,
              hasCaptcha: false,
              is2FA: false,
              isEmailOptionSelectionScreen: false,
              isEmailCodeInputScreen: false,
              hasError: false,
              isLoginScreen: false,
              hasLoginButton: false,
              hasLoginToComment: false
            };
          }
        })();
      `);

      // A. STRICT LOGGED_IN CHECK
      // A stale TikTok cookie can remain after the page has been logged out, so DOM logged-out signals win.
      if ((hasSessionCookie && !pageState.isLoginScreen) || (pageState.hasUserMenu && pageState.hasLogoutBtn)) {
        const savedCookie = await persistTikTokSessionCookies(
          acc.id,
          acc.username,
          customSession,
          onLog,
          onAccountSessionUpdate
        );
        if (!savedCookie) {
          onAccountStatusChange(acc.id, 'authenticated');
        }
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'success',
          message: `ðŸŽ‰ ÄÄ‚NG NHáº¬P THÃ€NH CÃ”NG cho @${acc.username}! Session Cookie Ä‘Ã£ Ä‘Æ°á»£c xÃ¡c nháº­n.`,
        });
        return { success: true, status: 'authenticated' };
      }

      // B. CAPTCHA DETECTED -> Try OmoCaptcha, then wait/manual fallback.
      if (pageState.hasCaptcha) {
        if (!isSolvingCaptcha) {
          isSolvingCaptcha = true;
          const solved = await solveTikTokWebCaptchaWithOmo(win, acc, onLog).catch(err => {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: `[Captcha] OmoCaptcha solve error: ${err?.message || err}`,
            });
            return false;
          });
          isSolvingCaptcha = false;
          if (solved) {
            hasWarnedCaptcha = false;
            await new Promise(r => setTimeout(r, pollIntervalMs));
            continue;
          }
        }

        if (!hasWarnedCaptcha) {
          hasWarnedCaptcha = true;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `âš ï¸ PHÃT HIá»†N CAPTCHA/CHALLENGE cho @${acc.username}! OmoCaptcha chÆ°a giáº£i Ä‘Æ°á»£c hoáº·c chÆ°a cÃ³ API key. Vui lÃ²ng kÃ©o/giáº£i thá»§ cÃ´ng náº¿u cáº§n.`,
          });
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
        continue;
      } else {
        hasWarnedCaptcha = false; // Reset if captcha solved
      }

      // C. PRECISE 2FA TOTP SCREEN DETECTED -> Only enter TOTP if strictly on 2FA screen
      if (pageState.is2FA && !hasFilledTotp) {
        if (acc.twoFactor && acc.twoFactor.trim().length >= 8) {
          const totpCode = generateTotpToken(acc.twoFactor);
          if (totpCode) {
            hasFilledTotp = true;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `ðŸ”‘ ÄÃ£ phÃ¡t hiá»‡n mÃ n hÃ¬nh 2FA! ÄÃ£ tá»± Ä‘á»™ng sinh mÃ£ TOTP 6 sá»‘ [ ${totpCode} ]. Äang Ä‘iá»n...`,
            });

            // Fill TOTP using single safe strategy
            await fillSixDigitCodeSingleStrategy(win, totpCode);
          }
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `âš ï¸ MÃ n hÃ¬nh 2FA yÃªu cáº§u mÃ£ Authenticator nhÆ°ng tÃ i khoáº£n @${acc.username} chÆ°a cÃ i KhÃ³a 2FA!`,
          });
          hasFilledTotp = true; // Prevent log spam
        }
      }

      // D. EMAIL OPTION SELECTION SCREEN -> Click Email card and wait for transition
      if (pageState.isEmailOptionSelectionScreen && (!hasClickedEmailOption || Date.now() - emailOptionClickedAt > 10000)) {
        hasClickedEmailOption = true;
        emailOptionClickedAt = Date.now();
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `ðŸ“¬ ÄÃ£ tháº¥y mÃ n hÃ¬nh chá»n phÆ°Æ¡ng thá»©c xÃ¡c minh Email. Äang báº¥m chá»n Email...`,
        });

        await win.webContents.executeJavaScript(`
          (() => {
            try {
              const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const emailCard = Array.from(document.querySelectorAll('button, [role="button"], div, span, p')).find(el => {
                if (!isVisible(el)) return false;
                const txt = (el.innerText || el.textContent || '').toLowerCase();
                return (txt.includes('email') || txt.includes('@') || txt.includes('hÃ²m thÆ°')) &&
                       !txt.includes('enter code') &&
                       !txt.includes('verification code') &&
                       !txt.includes('nháº­p mÃ£');
              });
              if (emailCard) emailCard.click();
            } catch(e) {}
          })();
        `);

        // Wait 2.5s for UI to transition to 6-digit code input screen
        await new Promise(r => setTimeout(r, 2500));
        continue;
      }

      // E. EMAIL CODE INPUT SCREEN DETECTED -> Strictly fetch OTP ONLY when input screen is ready
      if (pageState.isEmailCodeInputScreen && !hasFilledEmailOtp) {
        if (acc.email && acc.passMail) {
          hasFilledEmailOtp = true;
          requestedOtpTimestamp = Date.now();

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `ðŸ“¬ MÃ n hÃ¬nh nháº­p mÃ£ Email OTP Ä‘Ã£ sáºµn sÃ ng! Äang káº¿t ná»‘i ngáº§m hÃ²m thÆ° ${acc.email} Ä‘á»ƒ bÃ³c mÃ£...`,
          });

          // Fetch OTP with requestedAt timestamp
          const otpRes = await mailOtpService.fetchTikTokOtp(acc.email, acc.passMail, {
            sinceTimestamp: requestedOtpTimestamp - 30000,
            timeoutMs: 35000,
          });

          if (otpRes.success && otpRes.otp) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: `ðŸŽ‰ ÄÃ£ Ä‘á»c Ä‘Æ°á»£c mÃ£ OTP TikTok tá»« hÃ²m thÆ°: [ ${otpRes.otp} ]. Äang tá»± Ä‘á»™ng Ä‘iá»n...`,
            });

            if (!win.isDestroyed()) {
              // Fill Email OTP using single safe strategy
              await fillSixDigitCodeSingleStrategy(win, otpRes.otp);
            }
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'warning',
              message: `âš ï¸ Káº¿t quáº£ Ä‘á»c Email OTP: ${otpRes.message}`,
            });
          }
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `âš ï¸ MÃ n hÃ¬nh xÃ¡c minh yÃªu cáº§u mÃ£ OTP Email nhÆ°ng tÃ i khoáº£n chÆ°a nháº­p Email & PassMail!`,
          });
          hasFilledEmailOtp = true; // Prevent log spam
        }
      }

      // F. UNAUTHENTICATED HOMEPAGE / LOGIN FORM DETECTED -> Click "Log in" button or trigger Auto-fill
      if ((!hasSessionCookie || pageState.isLoginScreen || pageState.hasLoginButton || pageState.hasLoginToComment) && acc.password) {
        const loginCheck = await win.webContents.executeJavaScript(`
          (() => {
            try {
              const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };

              const emailInput = document.querySelector('input[name="username"]') ||
                                 document.querySelector('input[placeholder*="Email" i]') ||
                                 document.querySelector('input[placeholder*="phone" i]') ||
                                 document.querySelector('input[type="text"]');
              const passInput = document.querySelector('input[type="password"]');

              if (emailInput && passInput && isVisible(emailInput) && isVisible(passInput)) {
                return 'FORM_READY';
              }

              const clickCentered = (el) => {
                const rect = el.getBoundingClientRect();
                const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                (target || el).click();
              };

              // Check for 'Use phone or email' option in Login Modal
              const usePhoneEmailCard = Array.from(document.querySelectorAll('button, [role="button"], a, div')).find(el => {
                if (!isVisible(el)) return false;
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                const exactMethod = txt === 'use phone or email' ||
                       txt === 'use phone/email' ||
                       txt === 'use phone or email or username' ||
                       txt === 'use phone / email / username';
                const containsMethod = txt.includes('use phone or email') ||
                       txt.includes('use phone/email') ||
                       txt.includes('use phone or email or username') ||
                       txt.includes('use phone / email / username') ||
                       txt.includes('sá»­ dá»¥ng Ä‘iá»‡n thoáº¡i / email / tÃªn ngÆ°á»i dÃ¹ng') ||
                       txt.includes('sá»­ dá»¥ng Ä‘iá»‡n thoáº¡i') ||
                       txt.includes('sá»­ dá»¥ng email');
                const rect = el.getBoundingClientRect();
                return exactMethod || (containsMethod && rect.width <= 650 && rect.height <= 140);
              });
              if (usePhoneEmailCard) {
                clickCentered(usePhoneEmailCard);
                return 'CLICKED_MODAL_OPTION';
              }


              // Check for Top "Log in" button on TikTok homepage
              const topLoginBtn = document.querySelector('[data-e2e="top-login-button"]') ||
                                  document.querySelector('button[aria-label*="Log in" i]') ||
                                  Array.from(document.querySelectorAll('button, a')).find(el => {
                                    if (!isVisible(el)) return false;
                                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                    return txt === 'log in' || txt === 'Ä‘Äƒng nháº­p';
                                  });
              if (topLoginBtn) {
                topLoginBtn.click();
                return 'CLICKED_TOP_LOGIN';
              }

              return 'NONE';
            } catch(e) {
              return 'NONE';
            }
          })();
        `);

        if (loginCheck === 'FORM_READY' && !hasAutoFilled) {
          hasAutoFilled = true;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `ðŸ”‘ PhÃ¡t hiá»‡n Ã´ Ä‘Äƒng nháº­p trÃªn TikTok! Äang tá»± Ä‘á»™ng Ä‘iá»n Username & Máº­t kháº©u...`,
          });
          await autoFillTikTokLogin(win, acc.username, acc.password);
        } else if (loginCheck === 'CLICKED_TOP_LOGIN' || loginCheck === 'CLICKED_MODAL_OPTION') {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `ðŸŒ TÃ i khoáº£n chÆ°a Ä‘Äƒng nháº­p. Äang tá»± Ä‘á»™ng báº¥m nÃºt "ÄÄƒng nháº­p" trÃªn TikTok...`,
          });
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      // G. LOGIN ERROR DETECTED
      if (pageState.hasError) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'error',
          message: `âŒ PhÃ¡t hiá»‡n lá»—i Ä‘Äƒng nháº­p trÃªn TikTok cho @${acc.username}: Máº­t kháº©u khÃ´ng Ä‘Ãºng hoáº·c tÃ i khoáº£n khÃ´ng tá»“n táº¡i.`,
        });
        return { success: false, status: 'error' };
      }


    } catch (err: any) {
      // Ignore transient errors during navigation
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Monitor] Káº¿t thÃºc thá»i gian giÃ¡m sÃ¡t 90s cho @${acc.username}.`,
  });

  return { success: false, status: 'timeout' };
}

export function setupAutomationIPC(
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
) {
  ipcMain.handle('close-all-browser-windows', async () => {
    let closedCount = 0;
    const windows = new Set<BrowserWindow>([
      ...Array.from(loginWindows.values()),
      ...Array.from(seedingWindows.values()),
    ]);
    requestSeedingCancel('Nguoi dung da dong tat ca trinh duyet seeding.');

    windows.forEach(win => {
      if (!win.isDestroyed()) {
        closedCount++;
        win.close();
      }
    });
    loginWindows.clear();
    seedingWindows.clear();

    onLog({
      level: 'info',
      message: `[Browser] Closed ${closedCount} browser window(s).`,
    });

    return { success: true, closedCount };
  });

  // 1. Open Interactive Login Window for a TikTok Account (Single Chrome)
  ipcMain.handle(
    'open-account-login-window',
    async (
      _event,
      accountId: string,
      username: string,
      cookie?: string,
      proxy?: string,
      proxyType: string = 'http',
      password?: string,
      email?: string,
      passMail?: string,
      twoFactor?: string,
      muteBrowserAudio: boolean = true
    ) => {
      if (loginWindows.has(accountId)) {
        const existingWin = loginWindows.get(accountId)!;
        if (!existingWin.isDestroyed()) {
          existingWin.webContents.setAudioMuted(muteBrowserAudio !== false);
          existingWin.focus();
          return { success: true, message: 'Window focused' };
        }
      }

      const partition = `persist:tiktok_${accountId}`;
      const customSession = session.fromPartition(partition);

      customSession.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      const proxyConfig = await runSessionPreparation(() =>
        configureSessionProxyAndCookies(customSession, cookie, proxy, proxyType, {
          skipCookieInjectionIfSessionExists: true,
        })
      );

      const win = new BrowserWindow({
        ...getTiledLoginWindowBounds(loginWindows.size),
        title: `Chrome Profile [@${username || accountId}] ${proxy ? '(Proxy: ' + proxy + ')' : ''}`,
        autoHideMenuBar: true,
        webPreferences: {
          session: customSession,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });

      loginWindows.set(accountId, win);
      win.webContents.setAudioMuted(muteBrowserAudio !== false);
      attachProxyAuthHandler(win, proxyConfig?.auth);

      const accInfo: AccountInfo = {
        id: accountId,
        username,
        password,
        email,
        passMail,
        twoFactor,
        cookie,
      };

      const hasCookie = hasValidTikTokCookieString(cookie);

      // LOAD URL (Try direct login URL if unauthenticated with password, or TikTok homepage)
      const startUrl = !hasCookie && password
        ? 'https://www.tiktok.com/login/phone-or-email/email'
        : 'https://www.tiktok.com';
      loadLoginStartPage(win, customSession, startUrl, { id: accountId, username }, proxy, proxyConfig, onLog, onAccountStatusChange, 'Mo Chrome')
        .catch(err => console.error('[Proxy] Failed to diagnose login window load:', err));


      onLog({
        accountId,
        accountUsername: username,
        level: 'info',
        message: `ðŸŒ ÄÃ£ má»Ÿ Chrome Profile cho @${username || accountId} ${proxy ? '[Proxy Active]' : ''}${muteBrowserAudio !== false ? ' [Muted]' : ''}`,
      });

      // ALWAYS launch monitorLoginFlow for background status & auto-login checking
      monitorLoginFlow(win, customSession, accInfo, onLog, onAccountStatusChange, onAccountSessionUpdate);


      win.on('closed', async () => {
        loginWindows.delete(accountId);

        try {
          const cookies = await customSession.cookies.get({ domain: '.tiktok.com' });
          const hasSessionCookie = cookies.some(
            c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt'
          );

          if (hasSessionCookie) {
            const savedCookie = await persistTikTokSessionCookies(
              accountId,
              username,
              customSession,
              onLog,
              onAccountSessionUpdate
            );
            if (!savedCookie) {
              onAccountStatusChange(accountId, 'authenticated');
            }
            onLog({
              accountId,
              accountUsername: username,
              level: 'success',
              message: `âœ… Session Cookie Ä‘Ã£ Ä‘Æ°á»£c xÃ¡c nháº­n thÃ nh cÃ´ng cho @${username || accountId}!`,
            });
          }
        } catch (err: any) {
          console.error('Failed to check cookies:', err);
        }
      });

      return { success: true };
    }
  );

  // 2. Open Multi-Thread Account Chromes (Äa Luá»“ng)
  ipcMain.handle(
    'open-multi-account-chromes',
    async (_event, accountIds: string[], maxThreads: number = 10, accountsData: any[], muteBrowserAudio: boolean = true) => {
      const selectedAccounts = accountsData.filter(a => accountIds.includes(a.id));
      if (selectedAccounts.length === 0) {
        return { success: false, message: 'No valid accounts selected' };
      }
      const effectiveMaxThreads = maxThreads > 0 ? Math.min(maxThreads, selectedAccounts.length) : selectedAccounts.length;

      onLog({
        level: 'info',
        message: `ðŸš€ Báº¯t Ä‘áº§u khá»Ÿi cháº¡y ${selectedAccounts.length} cá»­a sá»• Chrome Ä‘a luá»“ng (Tá»‘i Ä‘a ${effectiveMaxThreads} luá»“ng song song)...`,
      });

      const queue = [...selectedAccounts];
      const activeWorkers: Promise<void>[] = [];

      const runNextWorker = async () => {
        if (queue.length === 0) return;
        const acc = queue.shift()!;

        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `[Multi-Thread] Má»Ÿ cá»­a sá»• Chrome cho @${acc.username}...`,
        });

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

        const win = new BrowserWindow({
          ...getTiledLoginWindowBounds(loginWindows.size),
          title: `Chrome Multi-Thread [@${acc.username}]`,
          autoHideMenuBar: true,
          webPreferences: {
            session: customSession,
            nodeIntegration: false,
            contextIsolation: true,
            backgroundThrottling: false,
          },
        });

        loginWindows.set(acc.id, win);
        win.webContents.setAudioMuted(muteBrowserAudio !== false);
        attachProxyAuthHandler(win, proxyConfig?.auth);

        const accInfo: AccountInfo = {
          id: acc.id,
          username: acc.username,
          password: acc.password,
          email: acc.email,
          passMail: acc.passMail,
          twoFactor: acc.twoFactor,
          cookie: acc.cookie,
        };

        const hasCookie = hasValidTikTokCookieString(acc.cookie);

        const startUrl = !hasCookie && acc.password
          ? 'https://www.tiktok.com/login/phone-or-email/email'
          : 'https://www.tiktok.com';
        loadLoginStartPage(win, customSession, startUrl, acc, acc.proxy, proxyConfig, onLog, onAccountStatusChange, 'Mo Chrome da luong')
          .catch(err => console.error('[Proxy] Failed to diagnose multi-login window load:', err));

        // ALWAYS launch monitorLoginFlow for multi-login windows
        monitorLoginFlow(win, customSession, accInfo, onLog, onAccountStatusChange, onAccountSessionUpdate);


        await new Promise<void>((resolve) => {
          win.on('closed', async () => {
            loginWindows.delete(acc.id);

            try {
              const cookies = await customSession.cookies.get({ domain: '.tiktok.com' });
              const hasSessionCookie = cookies.some(
                c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt'
              );

              if (hasSessionCookie) {
                const savedCookie = await persistTikTokSessionCookies(
                  acc.id,
                  acc.username,
                  customSession,
                  onLog,
                  onAccountSessionUpdate,
                  '[Multi-Thread] '
                );
                if (!savedCookie) {
                  onAccountStatusChange(acc.id, 'authenticated');
                }
                onLog({
                  accountId: acc.id,
                  accountUsername: acc.username,
                  level: 'success',
                  message: `âœ… [Multi-Thread] Session Cookie Ä‘Ã£ Ä‘Æ°á»£c xÃ¡c nháº­n thÃ nh cÃ´ng cho @${acc.username}!`,
                });
              } else {
                onLog({
                  accountId: acc.id,
                  accountUsername: acc.username,
                  level: 'info',
                  message: `ÄÃ£ Ä‘Ã³ng cá»­a sá»• Chrome cá»§a @${acc.username}`,
                });
              }
            } catch (err: any) {
              console.error('Failed to check cookies for multi-thread:', err);
            }

            resolve();
          });
        });

        if (queue.length > 0) {
          await runNextWorker();
        }
      };

      const initialBatchSize = Math.min(effectiveMaxThreads, queue.length);
      for (let i = 0; i < initialBatchSize; i++) {
        activeWorkers.push(runNextWorker());
      }

      return { success: true, message: `Multi-thread launcher started for ${selectedAccounts.length} accounts` };
    }
  );

  // 3. Execute Seeding Task across accounts
  ipcMain.handle(
    'execute-seeding-task',
    async (_event, config: SeedingTaskConfig, accounts: Array<AccountInfo & { proxy?: string; proxyType?: string }>) => {
      onLog({
        level: 'info',
        message: `ðŸš€ Báº¯t Ä‘áº§u tÃ¡c vá»¥ Seeding trÃªn ${config.targetType.toUpperCase()}: ${config.targetUrl}`,
      });

      const selectedAccounts = accounts.filter(a => config.accountIds.includes(a.id));

      if (selectedAccounts.length === 0) {
        onLog({
          level: 'error',
          message: 'KhÃ´ng cÃ³ tÃ i khoáº£n nÃ o Ä‘Æ°á»£c chá»n Ä‘á»ƒ thá»±c hiá»‡n tÃ¡c vá»¥.',
        });
        return { success: false, message: 'No accounts selected' };
      }

      const effectiveMaxThreads = config.maxThreads && config.maxThreads > 0
        ? Math.min(config.maxThreads, selectedAccounts.length)
        : selectedAccounts.length;
      const queue = selectedAccounts.map((acc, index) => ({ acc, index }));
      let completedCount = 0;
      currentSeedingRun = { cancelRequested: false };

      onLog({
        level: 'info',
        message: `ðŸš€ Seeding Ä‘a luá»“ng: má»Ÿ ${effectiveMaxThreads}/${selectedAccounts.length} tÃ i khoáº£n cÃ¹ng lÃºc...`,
      });

      const runSeedingWorker = async (workerIndex: number) => {
        if (workerIndex > 0) {
          await waitForSeedingDelay(workerIndex * 800);
        }

        while (queue.length > 0 && !isSeedingCancelRequested()) {
          const item = queue.shift();
          if (!item) return;
          const { acc, index } = item;

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[Worker ${workerIndex + 1}] [${index + 1}/${selectedAccounts.length}] Äang khá»Ÿi táº¡o seeding cho @${acc.username}...`,
          });

          try {
            throwIfSeedingCancelled();
            await executeTaskForAccount(acc, config, onLog, onAccountStatusChange, onAccountSessionUpdate, loginWindows.size + index);
            completedCount++;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: `[Worker ${workerIndex + 1}] HoÃ n thÃ nh @${acc.username} (${completedCount}/${selectedAccounts.length}).`,
            });
          } catch (err: any) {
            if (err instanceof SeedingCancelledError) {
              requestSeedingCancel(err.message);
              onLog({
                accountId: acc.id,
                accountUsername: acc.username,
                level: 'warning',
                message: `[Worker ${workerIndex + 1}] Da dung seeding cho @${acc.username}: ${err.message}`,
              });
              return;
            }

            completedCount++;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: `Lá»—i thá»±c hiá»‡n tÃ¡c vá»¥ cho @${acc.username}: ${err.message || err}`,
            });
          }

          if (queue.length > 0 && effectiveMaxThreads < selectedAccounts.length && !isSeedingCancelRequested()) {
            const delayMs = Math.max(1, config.delaySeconds || 1) * 1000;
            await waitForSeedingDelay(delayMs);
          }
        }
      };

      const workers = Array.from(
        { length: effectiveMaxThreads },
        (_, workerIndex) => runSeedingWorker(workerIndex)
      );

      try {
        await Promise.all(workers);
      } finally {
        if (currentSeedingRun?.cancelRequested) {
          onLog({
            level: 'warning',
            message: `Tac vu Seeding da dung: ${currentSeedingRun.reason || 'da huy'}`,
          });
          currentSeedingRun = null;
          return { success: false, canceled: true };
        }

        currentSeedingRun = null;
      }

      onLog({
        level: 'success',
        message: `ðŸŽ‰ TÃ¡c vá»¥ Seeding Ä‘Ã£ hoÃ n thÃ nh toÃ n bá»™ ${selectedAccounts.length} tÃ i khoáº£n!`,
      });

      return { success: true };
    }
  );
}

/**
 * Execute automation actions for a single account on TikTok Video / Live
 */
async function executeTaskForAccount(
  acc: AccountInfo & { proxy?: string; proxyType?: string },
  config: SeedingTaskConfig,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  windowSlot: number = 0
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
      message: `âš ï¸ TÃ i khoáº£n @${acc.username} CHÆ¯A Dá»°NG SESSION ÄÄ‚NG NHáº¬P! Báº¡n hÃ£y gÃ¡n Cookie hoáº·c Ä‘Äƒng nháº­p thá»§ cÃ´ng.`,
    });
  }

  const win = new BrowserWindow({
    ...getTiledSeedingWindowBounds(windowSlot),
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
  seedingWindows.add(win);
  let closedByAutomation = false;
  win.on('closed', () => {
    seedingWindows.delete(win);
    if (!closedByAutomation) {
      requestSeedingCancel(`Nguoi dung da dong cua so seeding cua @${acc.username}.`);
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

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Äang táº£i URL trang TikTok: ${config.targetUrl}...`,
    });

    await loadTikTokUrlForSeeding(win, customSession, config.targetUrl, acc, onLog);
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
    }
    throwIfSeedingCancelled(win);

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Äang Ä‘á»£i TikTok render á»•n Ä‘á»‹nh trÆ°á»›c khi thao tÃ¡c...`,
    });

    const surfaceReady = await waitForTikTokSurfaceReady(win, config.targetType);
    throwIfSeedingCancelled(win);
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: surfaceReady.ready ? 'info' : 'warning',
      message: surfaceReady.ready
        ? `TikTok Ä‘Ã£ sáºµn sÃ ng: video=${surfaceReady.hasVideo ? 'cÃ³' : 'khÃ´ng'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'cÃ³' : 'khÃ´ng'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'cÃ³' : 'khÃ´ng'}.`
        : `TikTok chÆ°a á»•n Ä‘á»‹nh sau ${Math.round(TIKTOK_SURFACE_READY_TIMEOUT_MS / 1000)}s (${surfaceReady.reason || 'khÃ´ng rÃµ'}). Tráº¡ng thÃ¡i: readyState=${surfaceReady.readyState || 'unknown'}, video=${surfaceReady.hasVideo ? 'cÃ³' : 'khÃ´ng'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'cÃ³' : 'khÃ´ng'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'cÃ³' : 'khÃ´ng'}.`,
    });

    if (config.targetType === 'video') {
      await runSeedingInteraction(async () => {
        if (!win.isDestroyed()) {
          await waitForSeedingDelay(150, win);
        }
        throwIfSeedingCancelled(win);

      if (config.likeEnabled) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `Äang thá»±c hiá»‡n tháº£ tim (Like) video...`,
        });

        let likeResult: any = { attempted: false, alreadyLiked: false, target: null };
        const readVideoLikeState = async () => win.webContents.executeJavaScript(`
          (() => {
            try {
              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const isLikedColor = (color) => {
                if (!color) return false;
                const normalized = color.replace(/\s+/g, '').toLowerCase();
                return normalized === 'rgb(255,59,92)' ||
                       normalized === 'rgba(255,59,92,1)' ||
                       normalized === 'rgb(254,44,85)' ||
                       normalized === 'rgba(254,44,85,1)' ||
                       normalized === 'rgb(255,42,91)' ||
                       normalized === 'rgba(255,42,91,1)' ||
                       normalized === 'rgb(235,32,73)' ||
                       normalized === 'rgba(235,32,73,1)' ||
                       normalized.includes('#fe2c55') ||
                       normalized.includes('#ff3b5c') ||
                       normalized.includes('#ff2a5b') ||
                       normalized === 'red';
              };
              const hasLikedColor = (el) => {
                if (!el) return false;
                const colorTargets = [
                  el,
                  el.querySelector?.('svg'),
                  el.querySelector?.('path'),
                  el.querySelector?.('[fill]'),
                  el.querySelector?.('[stroke]')
                ].filter(Boolean);
                return colorTargets.some(target => {
                  const style = window.getComputedStyle(target);
                  return isLikedColor(style.color) ||
                         isLikedColor(style.fill) ||
                         isLikedColor(style.stroke) ||
                         isLikedColor(target.getAttribute?.('fill')) ||
                         isLikedColor(target.getAttribute?.('stroke'));
                });
              };
              const selectors = [
                '[data-e2e="like-icon"]',
                '[data-e2e="browse-like-icon"]',
                '[data-e2e="video-like-icon"]',
                '[data-e2e="feed-like"]',
                '[data-e2e="search-like-icon"]',
                '[data-e2e*="like"]',
                'button[data-e2e*="like" i]',
                'button[aria-label*="like" i]',
                'button[aria-label*="thÃ­ch" i]',
                'button[aria-label*="ThÃ­ch" i]',
                '[role="button"][aria-label*="like" i]',
                '[role="button"][aria-label*="thÃ­ch" i]',
                '[role="button"][aria-label*="ThÃ­ch" i]',
                'span[aria-label*="like" i]',
                'span[aria-label*="thÃ­ch" i]',
                'div[class*="LikeContainer"]',
                'button[class*="ButtonLike"]',
                'div[class*="ButtonActionItem"]'
              ];

              const likedXPaths = [
                '//*[@data-e2e="browse-like-icon"]/ancestor::button[@aria-pressed="true"]',
                '//main //*[@data-e2e="like-icon"]/ancestor::button[@aria-pressed="true"]',
                '//*[@data-e2e="like-icon"]/ancestor::button[@aria-pressed="true"]',
                '//video/ancestor::*[@data-e2e="recommend-list-item-container"]//*[@data-e2e="like-icon"]/ancestor::button[@aria-pressed="true"]'
              ];
              const getByXPath = (xpath) => document.evaluate(
                xpath,
                document,
                null,
                XPathResult.FIRST_ORDERED_NODE_TYPE,
                null
              ).singleNodeValue;
              const likedByXPath = likedXPaths.map(getByXPath).find(isVisible);
              if (likedByXPath) return { found: true, liked: true };

              const node = selectors
                .flatMap(selector => Array.from(document.querySelectorAll(selector)))
                .find(isVisible);
              if (!node) return { found: false, liked: false };
              const label = [
                node.getAttribute?.('aria-label'),
                node.getAttribute?.('title'),
                node.getAttribute?.('class'),
                node.getAttribute?.('data-e2e')
              ].join(' ').toLowerCase();
              return {
                found: true,
                liked: node.getAttribute?.('aria-pressed') === 'true' ||
                       label.includes('liked') ||
                       label.includes('unlike') ||
                       label.includes('Ä‘Ã£ thÃ­ch') ||
                       label.includes('bá» thÃ­ch') ||
                       hasLikedColor(node)
              };
            } catch(e) {
              return { found: false, liked: false, error: e.toString() };
            }
          })();
        `);

        for (let attempt = 1; attempt <= 3; attempt++) {
          const likeTarget = await win.webContents.executeJavaScript(`
            (() => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                const getLabel = (el) => [
                  el?.getAttribute?.('aria-label'),
                  el?.getAttribute?.('title'),
                  el?.getAttribute?.('class'),
                  el?.getAttribute?.('data-e2e'),
                  el?.textContent
                ].join(' ').toLowerCase();

                const isLikedColor = (color) => {
                  if (!color) return false;
                  const normalized = color.replace(/\s+/g, '').toLowerCase();
                  return normalized === 'rgb(255,59,92)' ||
                         normalized === 'rgba(255,59,92,1)' ||
                         normalized === 'rgb(254,44,85)' ||
                         normalized === 'rgba(254,44,85,1)' ||
                         normalized === 'rgb(255,42,91)' ||
                         normalized === 'rgba(255,42,91,1)' ||
                         normalized === 'rgb(235,32,73)' ||
                         normalized === 'rgba(235,32,73,1)' ||
                         normalized.includes('#fe2c55') ||
                         normalized.includes('#ff3b5c') ||
                         normalized.includes('#ff2a5b') ||
                         normalized === 'red';
                };

                const hasLikedColor = (el) => {
                  if (!el) return false;
                  const colorTargets = [
                    el,
                    el.querySelector?.('svg'),
                    el.querySelector?.('path'),
                    el.querySelector?.('[fill]'),
                    el.querySelector?.('[stroke]')
                  ].filter(Boolean);

                  return colorTargets.some(target => {
                    const style = window.getComputedStyle(target);
                    return isLikedColor(style.color) ||
                           isLikedColor(style.fill) ||
                           isLikedColor(style.stroke) ||
                           isLikedColor(target.getAttribute?.('fill')) ||
                           isLikedColor(target.getAttribute?.('stroke'));
                  });
                };

                const isLikedControl = (el) => {
                  const label = getLabel(el);
                  return el?.getAttribute?.('aria-pressed') === 'true' ||
                         label.includes('liked') ||
                         label.includes('unlike') ||
                         label.includes('Ä‘Ã£ thÃ­ch') ||
                         label.includes('bá» thÃ­ch') ||
                         hasLikedColor(el);
                };

                const getClickableParent = (el) => {
                  let cur = el;
                  for (let i = 0; i < 6 && cur; i++) {
                    const tag = cur.tagName?.toLowerCase();
                    const role = cur.getAttribute?.('role');
                    if (tag === 'button' || role === 'button') return cur;
                    cur = cur.parentElement;
                  }
                  return el;
                };

                const selectors = [
                  { type: 'xpath', value: '//*[@data-e2e="browse-like-icon"]/ancestor::button[@aria-pressed="false"]' },
                  { type: 'xpath', value: '//main //*[@data-e2e="like-icon"]/ancestor::button[@aria-pressed="false"]' },
                  { type: 'xpath', value: '//*[@data-e2e="like-icon"]/ancestor::button[@aria-pressed="false"]' },
                  { type: 'xpath', value: '//video/ancestor::*[@data-e2e="recommend-list-item-container"]//*[@data-e2e="like-icon"]/ancestor::button[@aria-pressed="false"]' },
                  { type: 'xpath', value: '//strong[contains(@data-e2e,"like-count")]//parent::button' },
                  '[data-e2e="like-icon"]',
                  '[data-e2e="browse-like-icon"]',
                  '[data-e2e="video-like-icon"]',
                  '[data-e2e="feed-like"]',
                  '[data-e2e="search-like-icon"]',
                  '[data-e2e*="like"]',
                  'button[data-e2e*="like" i]',
                  'button[aria-label*="like" i]',
                  'button[aria-label*="thÃ­ch" i]',
                  'button[aria-label*="ThÃ­ch" i]',
                  '[role="button"][aria-label*="like" i]',
                  '[role="button"][aria-label*="thÃ­ch" i]',
                  '[role="button"][aria-label*="ThÃ­ch" i]',
                  'span[aria-label*="like" i]',
                  'span[aria-label*="thÃ­ch" i]',
                  'div[class*="LikeContainer"]',
                  'button[class*="ButtonLike"]',
                  'div[class*="ButtonActionItem"]'
                ];

                for (const selector of selectors) {
                  const node = typeof selector === 'object'
                    ? document.evaluate(
                        selector.value,
                        document,
                        null,
                        XPathResult.FIRST_ORDERED_NODE_TYPE,
                        null
                      ).singleNodeValue
                    : Array.from(document.querySelectorAll(selector)).find(isVisible);
                  if (!node) continue;
                  const target = getClickableParent(node);
                  const rect = target.getBoundingClientRect();
                  if (!rect.width || !rect.height) continue;

                  const alreadyLiked = isLikedControl(target) || isLikedControl(node);
                  return {
                    found: true,
                    alreadyLiked,
                    x: Math.round(rect.left + rect.width / 2),
                    y: Math.round(rect.top + rect.height / 2),
                    target: 'like-button',
                    label: getLabel(target) || getLabel(node)
                  };
                }

                const video = Array.from(document.querySelectorAll('video')).find(isVisible) ||
                              Array.from(document.querySelectorAll('[data-e2e="browse-video"], [data-e2e="video-detail-container"], div[class*="VideoContainer"], div[class*="DivPlayerContainer"], div[class*="VideoWrapper"]')).find(isVisible);
                if (video) {
                  const rect = video.getBoundingClientRect();
                  if (rect.width > 0 && rect.height > 0) {
                    return {
                      found: true,
                      alreadyLiked: false,
                      x: Math.round(rect.left + rect.width / 2),
                      y: Math.round(rect.top + rect.height * 0.56),
                      target: 'video-dblclick',
                      label: 'video'
                    };
                  }
                }

                return { found: false, alreadyLiked: false, target: null };
              } catch(e) {
                return { found: false, alreadyLiked: false, target: null, error: e.toString() };
              }
            })();
          `);

          if (likeTarget?.alreadyLiked) {
            likeResult = { attempted: false, alreadyLiked: true, target: likeTarget.target, attempt };
            break;
          }

          if (!likeTarget?.found || typeof likeTarget.x !== 'number' || typeof likeTarget.y !== 'number') {
            likeResult = { attempted: false, alreadyLiked: false, target: null, attempt, error: likeTarget?.error };
            await new Promise(res => setTimeout(res, 700));
            continue;
          }

          const zoomFactor = win.webContents.getZoomFactor();
          const clickX = Math.round(likeTarget.x * zoomFactor);
          const clickY = Math.round(likeTarget.y * zoomFactor);

          if (likeTarget.target === 'video-dblclick') {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            await new Promise(res => setTimeout(res, 80));
            win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 2 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 2 });
          } else {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
          }

          let likeStateAfterClick: any = { liked: false };
          for (const waitMs of [700, 900, 1200]) {
            await new Promise(res => setTimeout(res, waitMs));
            likeStateAfterClick = await readVideoLikeState();
            if (likeStateAfterClick?.liked) {
              likeResult = { attempted: true, verified: true, alreadyLiked: false, target: likeTarget.target, attempt };
              break;
            }
          }

          if (likeResult?.verified) {
            break;
          }

          likeResult = { attempted: true, verified: false, alreadyLiked: false, target: likeTarget.target, attempt };
          await new Promise(res => setTimeout(res, 700));
        }

        if (likeResult?.alreadyLiked) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `â¤ï¸ Video Ä‘Ã£ Ä‘Æ°á»£c tháº£ tim sáºµn, bá» qua Ä‘á»ƒ trÃ¡nh báº¥m láº¡i thÃ nh bá» tim.`,
          });
        } else if (likeResult?.attempted) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: likeResult?.verified ? 'success' : 'warning',
            message: likeResult?.verified
              ? `â¤ï¸ ÄÃ£ xÃ¡c nháº­n video Ä‘Æ°á»£c tháº£ tim qua ${likeResult.target}.`
              : `ÄÃ£ thá»­ tháº£ tim video qua ${likeResult.target} nhÆ°ng chÆ°a tháº¥y icon Ä‘á»•i sang mÃ u tim sau ${likeResult.attempt || 0} láº§n thá»­.`,
          });
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `KhÃ´ng tÃ¬m tháº¥y nÃºt/vÃ¹ng video Ä‘á»ƒ tháº£ tim cho @${acc.username}.`,
          });
        }
      }

      if (config.comments && config.comments.length > 0) {
        const commentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (commentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `Äang tá»± Ä‘á»™ng gÃµ bÃ¬nh luáº­n: "${commentText}"...`,
          });

          await new Promise(res => setTimeout(res, 2500));

          const focusResult = await win.webContents.executeJavaScript(`
            (async () => {
              try {
                const closeBtns = document.querySelectorAll('[aria-label="Close"], [data-e2e="modal-close-icon"]');
                closeBtns.forEach(btn => {
                  try { (btn).click(); } catch(e) {}
                });
                await new Promise(r => setTimeout(r, 500));

                const commentIcon = document.querySelector('[data-e2e="comment-icon"]') ||
                                    document.querySelector('span[aria-label*="comment" i]') ||
                                    document.querySelector('button[aria-label*="comment" i]');
                if (commentIcon) {
                  commentIcon.click();
                  await new Promise(r => setTimeout(r, 600));
                }

                window.scrollBy(0, 400);
                await new Promise(r => setTimeout(r, 800));

                const selectors = [
                  '[data-e2e="comment-input"]',
                  'div[contenteditable="true"]',
                  '[role="textbox"]',
                  '[data-e2e="comment-input-area"]'
                ];

                let input = null;
                for (const sel of selectors) {
                  const el = document.querySelector(sel);
                  if (el && el.offsetWidth > 0 && el.offsetHeight > 0) {
                    input = el;
                    break;
                  }
                }

                if (input) {
                  input.scrollIntoView({ behavior: 'smooth', block: 'center' });
                  await new Promise(r => setTimeout(r, 400));
                  input.click();
                  input.focus();
                  await new Promise(r => setTimeout(r, 500));
                  return { success: true };
                }

                return { success: false };
              } catch(e) {
                return { success: false, error: e.toString() };
              }
            })();
          `);

          if (focusResult && focusResult.success) {
            await waitForSeedingDelay(600, win);

            for (const char of commentText) {
              throwIfSeedingCancelled(win);
              win.webContents.sendInputEvent({ type: 'char', keyCode: char });
              await waitForSeedingDelay(40 + Math.random() * 40, win);
            }

            await waitForSeedingDelay(1000, win);

            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `ðŸ’¬ ÄÃ£ nháº­p vÃ  gá»­i yÃªu cáº§u bÃ¬nh luáº­n video: "${commentText}". TikTok chÆ°a xÃ¡c nháº­n bÃ¬nh luáº­n Ä‘Ã£ hiá»ƒn thá»‹.`,
            });
          }
        }
      }
      });
    } else if (config.targetType === 'livestream') {
      const liveDurationSeconds = Math.max(10, config.liveDurationSeconds || 60);

      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `Äang giá»¯ livestream ${liveDurationSeconds}s cho @${acc.username}${config.likeEnabled ? ' vÃ  tap live liÃªn tá»¥c...' : '...'}`,
      });

      const liveLikeWarmupPromise = config.likeEnabled && config.comments && config.comments.length > 0
        ? tapLiveContinuously(win, acc, Math.min(8, liveDurationSeconds), onLog, 'warmup')
        : Promise.resolve(0);

      if (config.comments && config.comments.length > 0) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `â³ Vá»«a vÃ o Livestream, Ä‘ang chá» ${Math.round(LIVESTREAM_INITIAL_COMMENT_DELAY_MS / 1000)}s trÆ°á»›c khi báº¯t Ä‘áº§u bÃ¬nh luáº­n cho @${acc.username}...`,
        });
        await waitForSeedingDelay(LIVESTREAM_INITIAL_COMMENT_DELAY_MS, win);
        await liveLikeWarmupPromise.catch(() => 0);
        throwIfSeedingCancelled(win);
      }

      await runSeedingInteraction(async () => {
        if (!win.isDestroyed()) {
          await waitForSeedingDelay(150, win);
        }
        throwIfSeedingCancelled(win);

      if (config.comments && config.comments.length > 0) {
        const liveCommentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (liveCommentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `Äang tÃ¬m Ã´ bÃ¬nh luáº­n Live Ä‘á»ƒ gá»­i: "${liveCommentText}"...`,
          });

          const focusLiveComment = await win.webContents.executeJavaScript(`
            (async () => {
              try {
                const isVisible = (el) => {
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                const clickByText = (patterns) => {
                  const target = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], div, span')).find(el => {
                    if (!isVisible(el)) return false;
                    const label = [
                      el.getAttribute('aria-label'),
                      el.getAttribute('data-e2e'),
                      el.getAttribute('title'),
                      el.textContent
                    ].join(' ').toLowerCase();
                    return patterns.some(pattern => label.includes(pattern));
                  });
                  if (target) {
                    target.click();
                    return true;
                  }
                  return false;
                };

                const scrollHorizontally = (side) => {
                  const maxed = [];
                  if (document.scrollingElement) {
                    document.scrollingElement.scrollLeft = side === 'right'
                      ? document.scrollingElement.scrollWidth
                      : 0;
                  }
                  Array.from(document.querySelectorAll('*'))
                    .filter(el => el.scrollWidth > el.clientWidth + 80)
                    .slice(0, 12)
                    .forEach(el => {
                      try {
                        el.scrollLeft = side === 'right' ? el.scrollWidth : 0;
                        maxed.push(el.tagName);
                      } catch(e) {}
                    });
                  return maxed.length;
                };

                const findInput = () => {
                  // Priority 1: Exact selector room-chat-input-field
                  const exactInput = document.querySelector('[data-e2e="room-chat-input-field"]');
                  if (exactInput && isVisible(exactInput)) return exactInput;

                  // Priority 2: General query with contenteditable="plaintext-only" and data-e2e
                  const allInputs = Array.from(document.querySelectorAll(
                    '[data-e2e="room-chat-input-field"], [data-e2e="comment-input"], textarea, input[type="text"], input:not([type]), div[contenteditable], [role="textbox"], [data-e2e*="comment"], [data-e2e*="chat"]'
                  )).filter(el => {
                    if (!isVisible(el) || el.disabled || el.readOnly) return false;
                    const label = [
                      el.getAttribute('placeholder'),
                      el.getAttribute('aria-label'),
                      el.getAttribute('data-e2e'),
                      el.getAttribute('class'),
                      el.textContent
                    ].join(' ').toLowerCase();
                    return label.includes('comment') ||
                           label.includes('chat') ||
                           label.includes('message') ||
                           label.includes('say') ||
                           label.includes('bÃ¬nh luáº­n') ||
                           label.includes('nháº¯n') ||
                           label.includes('write') ||
                           label.includes('input') ||
                           el.tagName === 'TEXTAREA' ||
                           el.hasAttribute('contenteditable') ||
                           el.getAttribute('role') === 'textbox';
                  });
                  return allInputs.sort((a, b) => {
                    const ar = a.getBoundingClientRect();
                    const br = b.getBoundingClientRect();
                    return (br.left + br.top) - (ar.left + ar.top);
                  })[0] || null;
                };

                clickByText(['comment', 'chat', 'bÃ¬nh luáº­n', 'message']);
                await new Promise(r => setTimeout(r, 500));

                let input = findInput();
                if (!input) {
                  scrollHorizontally('right');
                  await new Promise(r => setTimeout(r, 500));
                  clickByText(['comment', 'chat', 'bÃ¬nh luáº­n', 'message']);
                  await new Promise(r => setTimeout(r, 500));
                  input = findInput();
                }
                if (!input) {
                  scrollHorizontally('left');
                  await new Promise(r => setTimeout(r, 300));
                  input = findInput();
                }

                const totalInputs = document.querySelectorAll('textarea, input, div[contenteditable], [role="textbox"]').length;
                if (!input) return { success: false, reason: 'KhÃ´ng tháº¥y Ã´ chat/comment Live. Tá»•ng input/textbox trÃªn DOM: ' + totalInputs };

                input.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
                await new Promise(r => setTimeout(r, 250));
                input.click();
                input.focus();
                return { success: true };
              } catch(e) {
                return { success: false, reason: e.toString() };
              }
            })();
          `);

          if (focusLiveComment && focusLiveComment.success) {
            for (const char of liveCommentText) {
              throwIfSeedingCancelled(win);
              win.webContents.sendInputEvent({ type: 'char', keyCode: char });
              await waitForSeedingDelay(35 + Math.random() * 35, win);
            }
            await waitForSeedingDelay(500, win);
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

            // Send via room-chat-send-btn if present
            const liveSendResult = await win.webContents.executeJavaScript(`
              (() => {
                try {
                  const sendBtn = document.querySelector('[data-e2e="room-chat-send-btn"]');
                  const input = document.querySelector('[data-e2e="room-chat-input-field"]');
                  const inputText = (input?.textContent || input?.innerText || '').trim();
                  const sendBtnVisible = !!sendBtn && sendBtn.offsetWidth > 0 && sendBtn.offsetHeight > 0;
                  const sendBtnClass = sendBtn?.getAttribute('class') || '';
                  const isProbablyDisabled = sendBtnClass.includes('invisible') ||
                                            sendBtnClass.includes('cursor-not-allowed') ||
                                            sendBtn?.getAttribute('aria-disabled') === 'true';

                  if (sendBtnVisible && !isProbablyDisabled) {
                    sendBtn.click();
                    return {
                      clicked: true,
                      sendBtnVisible,
                      isProbablyDisabled,
                      inputTextLength: inputText.length
                    };
                  }

                  return {
                    clicked: false,
                    sendBtnVisible,
                    isProbablyDisabled,
                    inputTextLength: inputText.length
                  };
                } catch(e) {}
                return { clicked: false, error: 'KhÃ´ng kiá»ƒm tra Ä‘Æ°á»£c nÃºt gá»­i Live.' };
              })();
            `);

            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: liveSendResult?.clicked ? 'info' : 'warning',
              message: liveSendResult?.clicked
                ? `ðŸ’¬ ÄÃ£ click nÃºt gá»­i bÃ¬nh luáº­n Live: "${liveCommentText}". TikTok chÆ°a xÃ¡c nháº­n bÃ¬nh luáº­n Ä‘Ã£ hiá»ƒn thá»‹.`
                : `KhÃ´ng click Ä‘Æ°á»£c nÃºt gá»­i Live cho @${acc.username}. NÃºt gá»­i: ${liveSendResult?.sendBtnVisible ? 'cÃ³ hiá»‡n' : 'khÃ´ng hiá»‡n'}, tráº¡ng thÃ¡i: ${liveSendResult?.isProbablyDisabled ? 'chÆ°a sáºµn sÃ ng' : 'khÃ´ng rÃµ'}, text trong Ã´: ${liveSendResult?.inputTextLength ?? 0} kÃ½ tá»±.`,
            });
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'warning',
              message: `KhÃ´ng gá»­i Ä‘Æ°á»£c bÃ¬nh luáº­n Live cho @${acc.username}: ${focusLiveComment?.reason || 'khÃ´ng tÃ¬m tháº¥y Ã´ bÃ¬nh luáº­n'}`,
            });
          }
        }
      }
      });

      if (config.likeEnabled) {
        await tapLiveContinuously(win, acc, liveDurationSeconds, onLog, 'main');
      } else {
        await waitForSeedingDelay(liveDurationSeconds * 1000, win);
      }
    }

    await waitForSeedingDelay(SEEDING_POST_ACTION_STABILIZE_MS, win);
    throwIfSeedingCancelled(win);
    await persistTikTokSessionCookies(
      acc.id,
      acc.username,
      customSession,
      onLog,
      onAccountSessionUpdate,
      '[Seeding] '
    );
  } finally {
    if (!win.isDestroyed()) {
      closedByAutomation = true;
      win.close();
    }
  }
}
