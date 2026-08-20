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

function applyTikTokSeedingZoom(win: BrowserWindow) {
  if (win.isDestroyed()) return;

  try {
    const currentZoom = win.webContents.getZoomFactor();
    if (Math.abs(currentZoom - TIKTOK_SEEDING_ZOOM) > 0.001) {
      win.webContents.setZoomFactor(TIKTOK_SEEDING_ZOOM);
    }
  } catch {}
}

function keepTikTokSeedingZoom(win: BrowserWindow) {
  const contents = win.webContents;
  const reapplyZoom = () => {
    setTimeout(() => applyTikTokSeedingZoom(win), 0);
    setTimeout(() => applyTikTokSeedingZoom(win), 500);
  };

  applyTikTokSeedingZoom(win);
  contents.on('did-start-navigation', reapplyZoom);
  contents.on('dom-ready', reapplyZoom);
  contents.on('did-finish-load', reapplyZoom);
  contents.on('did-navigate-in-page', reapplyZoom);

  win.on('closed', () => {
    try {
      if (contents.isDestroyed()) return;
      contents.removeListener('did-start-navigation', reapplyZoom);
      contents.removeListener('dom-ready', reapplyZoom);
      contents.removeListener('did-finish-load', reapplyZoom);
      contents.removeListener('did-navigate-in-page', reapplyZoom);
    } catch {}
  });
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
  if (process.env.OMOCAPTCHA_API_KEY && process.env.OMOCAPTCHA_API_KEY.trim()) {
    return process.env.OMOCAPTCHA_API_KEY.trim();
  }
  const candidatePaths = [
    path.join(ensurePersistentDataDir(), 'settings.json'),
    path.join(process.cwd(), 'data', 'settings.json'),
    path.join(process.env.APPDATA || '', 'electron-nest-react', 'data', 'settings.json'),
    path.join(process.env.APPDATA || '', 'Seeding TikTok', 'data', 'settings.json'),
  ];
  for (const p of candidatePaths) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (parsed.omocaptchaApiKey && String(parsed.omocaptchaApiKey).trim()) {
          return String(parsed.omocaptchaApiKey).trim();
        }
      }
    } catch {}
  }
  return '';
}

async function postOmoCaptcha(payload: any): Promise<any> {
  const res = await fetch(payload.task ? OMOCAPTCHA_CREATE_TASK_URL : OMOCAPTCHA_GET_TASK_RESULT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json();
}

async function performCdpDrag(
  win: BrowserWindow,
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  steps = 35
) {
  let needDetach = false;
  if (!win.webContents.debugger.isAttached()) {
    try {
      win.webContents.debugger.attach('1.3');
      needDetach = true;
    } catch {}
  }

  try {
    // 1. Move cursor to slider center
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: startX,
      y: startY,
    });
    await new Promise(r => setTimeout(r, 60));

    // 2. Mouse Press
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: startX,
      y: startY,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await new Promise(r => setTimeout(r, 80));

    // 3. Humanized curve movement
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = 1 - Math.pow(1 - t, 3);
      const curX = Math.round(startX + (endX - startX) * ease + (Math.random() * 2 - 1));
      const curY = Math.round(startY + (endY - startY) * t + (Math.random() * 2 - 1));
      await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: curX,
        y: curY,
        button: 'left',
        buttons: 1,
      });
      await new Promise(r => setTimeout(r, 14 + Math.random() * 16));
    }

    await new Promise(r => setTimeout(r, 80));

    // 4. Mouse Release
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: endX,
      y: endY,
      button: 'left',
      buttons: 0,
    });
  } catch (err) {
    // Fallback to sendInputEvent if CDP fails
    try {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: startX, y: startY });
      win.webContents.sendInputEvent({ type: 'mouseDown', x: startX, y: startY, button: 'left', clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const curX = Math.round(startX + (endX - startX) * (i / steps));
        win.webContents.sendInputEvent({ type: 'mouseMove', x: curX, y: startY });
        await new Promise(r => setTimeout(r, 15));
      }
      win.webContents.sendInputEvent({ type: 'mouseUp', x: endX, y: endY, button: 'left', clickCount: 1 });
    } catch {}
  }
}

async function performCdpClick(win: BrowserWindow, x: number, y: number) {
  let needDetach = false;
  if (!win.webContents.debugger.isAttached()) {
    try {
      win.webContents.debugger.attach('1.3');
      needDetach = true;
    } catch {}
  }

  try {
    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x,
      y,
    });
    await new Promise(r => setTimeout(r, 60));

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await new Promise(r => setTimeout(r, 80));

    await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
    });
    await new Promise(r => setTimeout(r, 300));
  } catch {
    try {
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    } catch {}
  }
}

async function solveTikTokWebCaptchaWithOmo(
  win: BrowserWindow,
  acc: { id: string; username: string },
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  if (win.isDestroyed() || isSeedingCancelRequested()) return false;
  const originalZoomFactor = win.webContents.getZoomFactor() || 1;
  if (originalZoomFactor !== 1) {
    win.webContents.setZoomFactor(1);
    await waitForSeedingDelay(500, win).catch(() => undefined);
  }

  try {
    const clientKey = getOmoCaptchaApiKey();
    if (!clientKey) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: '[Captcha] ⚠️ API Key OmoCaptcha trống! Vui lòng cấu hình trong Cài Đặt để giải tự động.',
      });
      return false;
    }

    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (win.isDestroyed() || isSeedingCancelRequested()) return false;

    if (attempt > 1) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Captcha] 🔄 Thử giải lại CAPTCHA (Lần ${attempt}/${maxAttempts}) cho @${acc.username}...`,
      });
      await waitForSeedingDelay(1500, win);
    }

    const captchaData = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          };

          const normalize = (s) => String(s || '').toLowerCase()
            .normalize('NFD')
            .replace(/[\\u0300-\\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .trim();

          const isModalBox = (el) => {
            if (!isVisible(el)) return false;
            const r = el.getBoundingClientRect();
            return r.width >= 200 && r.height >= 160 && r.width <= 750 && r.height <= 750;
          };

          const specificSelectors = [
            '#captcha-verify-container',
            '.captcha-verify-container',
            '#captcha_verify_container',
            '.captcha_verify_container',
            '.sec-captcha-container',
            '.captcha-container',
            '.verify-wrap',
            '[class*="captcha-card" i]',
            '[class*="captcha-modal" i]',
            '[class*="captcha_card" i]',
            '[class*="captcha_modal" i]',
            'iframe[src*="captcha"]',
            'iframe[src*="sec"]',
            'iframe[src*="verify"]',
            'iframe[src*="challenge"]',
            '[id*="captcha" i]',
            '[class*="captcha" i]'
          ];

          const allCandidates = specificSelectors.flatMap(sel => Array.from(document.querySelectorAll(sel)));
          let captchaBox = allCandidates.find(isModalBox);
          if (!captchaBox) {
            captchaBox = allCandidates.find(isVisible) || Array.from(document.querySelectorAll('iframe')).find(isVisible);
          }

          if (!captchaBox) return { found: false };

          const boxRect = captchaBox.getBoundingClientRect();

          const collectModalText = (root) => {
            if (!root) return '';
            let txt = (root.innerText || root.textContent || '') + ' ';
            const textEls = Array.from(root.querySelectorAll('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="text" i], [class*="prompt" i], [class*="msg" i]')).filter(isVisible);
            textEls.forEach(el => { txt += ' ' + (el.innerText || el.textContent || ''); });
            const iframes = Array.from(root.querySelectorAll('iframe')).filter(isVisible);
            iframes.forEach(f => {
              txt += ' ' + (f.title || f.getAttribute('aria-label') || '');
            });
            return normalize(txt);
          };

          // Check if a slider button exists inside the captcha box
          const specificSliderSelectors = [
            '.captcha_verify_slide--slidebtn',
            '.sec-captcha-slider-btn',
            '[class*="slidebtn" i]',
            '[class*="slider-btn" i]',
            '[class*="drag-btn" i]',
            '[class*="sec-slider" i]',
            '[class*="slider-thumb" i]',
            '[role="slider"]',
            'div[class*="btn" i][class*="slide" i]',
            'div[class*="button" i][class*="slide" i]'
          ];
          let sliderEl = specificSliderSelectors
            .flatMap(sel => Array.from(captchaBox.querySelectorAll(sel)))
            .find(isVisible);

          if (!sliderEl) {
            const fallbackSliders = Array.from(captchaBox.querySelectorAll('div, span, button, [role="button"]')).filter(el => {
              if (!isVisible(el)) return false;
              const r = el.getBoundingClientRect();
              return r.width >= 24 && r.width <= 65 && r.height >= 24 && r.height <= 65 &&
                     r.top >= boxRect.bottom - 120 && r.bottom <= boxRect.bottom + 20;
            });
            sliderEl = fallbackSliders.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
          }

          const hasSlider = !!sliderEl;

          const detectTaskType = (root) => {
            const modalText = collectModalText(root);
            const allImgs = Array.from(root.querySelectorAll('img')).filter(isVisible);
            const hasTwoImages = allImgs.length >= 2;
            const hasCircleOrRotateImg = !!root.querySelector(
              '[class*="circle" i], [class*="round" i], [class*="rotate" i], img[class*="inner" i], img[class*="outer" i], div[style*="50%"], [id*="rotate" i]'
            );
            const hasRotateKeyword = /rotate|xoay|angle|upright|thang dung|dung chieu|goc quay|chieu dung|fit the shape|fit the puzzle|khop hinh/.test(modalText);

            // If there is a slider button: it is either Rotate or Slider puzzle
            if (hasSlider) {
              if (hasCircleOrRotateImg || hasRotateKeyword || (hasTwoImages && modalText.includes('puzzle'))) {
                return 'TiktokRotateWebTask';
              }
              return 'TiktokSliderWebTask';
            }

            // If there is NO slider button: it is a click/selection task (3D or Order)
            if (/3d|three[- ]?d|same object|same shape|matching object|2 doi tuong|hai doi tuong|cung hinh|cung doi tuong|giong nhau|khop vat the|2 vat the|vat the giong/.test(modalText)) {
              return 'Tiktok3DSelectObjectWebTask';
            }
            if (/select.*order|pick.*order|chon theo thu tu|chon doi tuong|chon vat the|chon hinh/.test(modalText)) {
              return 'TiktokSelectObjectWebTask';
            }
            if (/select|choose|pick|chon/.test(modalText) && /object|vat the|hinh|doi tuong/.test(modalText)) {
              return 'TiktokSelectObjectWebTask';
            }

            return 'Tiktok3DSelectObjectWebTask';
          };

          const taskType = detectTaskType(captchaBox);

          const imgSelectors = [
            '#captcha-verify-image',
            '.captcha-verify-image',
            '.captcha_verify_img--wrapper',
            'img[src*="byteoversea"]',
            'img[src*="tiktokcdn"]',
            'img[src*="captcha"]',
            'img[src*="verify"]',
            'canvas',
            'div[class*="img" i]',
            'div[class*="image" i]'
          ];
          const challengeImg = imgSelectors.flatMap(s => Array.from(captchaBox.querySelectorAll(s)))
            .concat(imgSelectors.flatMap(s => Array.from(document.querySelectorAll(s))))
            .find(el => {
              if (!isVisible(el)) return false;
              const r = el.getBoundingClientRect();
              return r.width >= 120 && r.height >= 80 && r.top >= boxRect.top - 50 && r.bottom <= boxRect.bottom + 50;
            });

          const targetEl = challengeImg || captchaBox;
          const targetRect = targetEl.getBoundingClientRect();

          // Slider button and track
          const sliderRect = sliderEl ? sliderEl.getBoundingClientRect() : null;

        // 2. Locate the EXACT track element directly hosting the slider button
        let trackEl = null;
        if (sliderEl) {
          // Check if parent or closest container is the track bar (height 20-55px, width > 150px)
          let parent = sliderEl.parentElement;
          while (parent && parent !== captchaBox && parent !== document.body) {
            const pr = parent.getBoundingClientRect();
            if (pr.width >= 160 && pr.height >= 20 && pr.height <= 65 && Math.abs(pr.top - (sliderRect?.top || 0)) <= 15) {
              trackEl = parent;
              break;
            }
            parent = parent.parentElement;
          }
        }

        if (!trackEl) {
          const specificTrackSelectors = [
            '.captcha_verify_slide--slidebar',
            '.sec-captcha-slider-track',
            '[class*="slidebar" i]',
            '[class*="slider-track" i]',
            '[class*="slider-bg" i]',
            '[class*="drag-bar" i]',
            '[class*="slide_bar" i]',
            '[class*="drag-track" i]',
            '[class*="rail" i]'
          ];
          trackEl = specificTrackSelectors
            .flatMap(sel => Array.from(captchaBox.querySelectorAll(sel)))
            .find(el => {
              if (!isVisible(el)) return false;
              const r = el.getBoundingClientRect();
              return r.width >= 160 && r.height >= 10 && r.height <= 65;
            });
        }

        const trackRect = trackEl ? trackEl.getBoundingClientRect() : (sliderRect ? {
          left: boxRect.left + 15,
          top: sliderRect.top,
          width: boxRect.width - 30,
          height: sliderRect.height
        } : null);

        const titleEl = document.querySelector('[class*="title" i], [class*="tip" i], [class*="header" i], [class*="instruction" i], [class*="prompt" i], [class*="msg" i]');
        const questionText = titleEl ? (titleEl.innerText || titleEl.textContent || '').trim() : 'Select 2 objects with the same shape';

          const getBase64FromImg = async (imgEl) => {
            if (!imgEl) return null;
            if (imgEl.src && imgEl.src.startsWith('data:image')) {
              return imgEl.src.split(',')[1];
            }
            try {
              const canvas = document.createElement('canvas');
              canvas.width = imgEl.naturalWidth || imgEl.width || 340;
              canvas.height = imgEl.naturalHeight || imgEl.height || 340;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(imgEl, 0, 0);
              const dataUrl = canvas.toDataURL('image/png');
              if (dataUrl && dataUrl.length > 100) return dataUrl.split(',')[1];
            } catch (e) {}

            try {
              const resp = await fetch(imgEl.src);
              const blob = await resp.blob();
              return new Promise((resolve) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve((reader.result || '').split(',')[1]);
                reader.readAsDataURL(blob);
              });
            } catch (e) {
              return null;
            }
          };

          const allImgs = Array.from(captchaBox.querySelectorAll('img')).filter(isVisible);
          let innerBase64 = null;
          let outerBase64 = null;
          let mainImgBase64 = null;

          if (taskType === 'TiktokRotateWebTask') {
            const innerImg = allImgs.find(i => {
              const c = (i.className + ' ' + (i.id || '')).toLowerCase();
              return c.includes('inner') || c.includes('inside') || c.includes('rotat') || c.includes('circle');
            }) || allImgs[0];

            const outerImg = allImgs.find(i => {
              const c = (i.className + ' ' + (i.id || '')).toLowerCase();
              return (c.includes('outer') || c.includes('outside') || c.includes('back') || c.includes('bg')) && i !== innerImg;
            }) || (allImgs.length > 1 ? allImgs[1] : null);

            if (innerImg) innerBase64 = await getBase64FromImg(innerImg);
            if (outerImg) outerBase64 = await getBase64FromImg(outerImg);
          } else {
            const mainImg = challengeImg?.tagName === 'IMG' ? challengeImg : allImgs[0];
            if (mainImg) mainImgBase64 = await getBase64FromImg(mainImg);
          }

          return {
            found: true,
            taskType,
            question: questionText,
            innerBase64,
            outerBase64,
            mainImgBase64,
            rect: {
              x: Math.max(0, Math.round(targetRect.left)),
              y: Math.max(0, Math.round(targetRect.top)),
              width: Math.round(targetRect.width),
              height: Math.round(targetRect.height)
            },
            widthView: Math.round(targetRect.width),
            heightView: Math.round(targetRect.height),
            slider: sliderRect ? {
              x: Math.round(sliderRect.left + sliderRect.width / 2),
              y: Math.round(sliderRect.top + sliderRect.height / 2),
              width: Math.round(sliderRect.width),
              height: Math.round(sliderRect.height)
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

    if (!captchaData?.found || !captchaData.rect) {
      if (attempt === 1) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'warning',
          message: '[Captcha] ⚠️ Không tìm thấy vị trí khung ảnh CAPTCHA để chụp gửi OmoCaptcha.',
        });
      }
      return false;
    }

    let fallbackBase64 = '';
    if (!captchaData.innerBase64 && !captchaData.mainImgBase64) {
      const captureRect = {
        x: Math.max(0, Math.round(captchaData.rect.x)),
        y: Math.max(0, Math.round(captchaData.rect.y)),
        width: Math.max(20, Math.round(captchaData.rect.width)),
        height: Math.max(20, Math.round(captchaData.rect.height)),
      };
      const image = await win.webContents.capturePage(captureRect);
      fallbackBase64 = image.toDataURL().split(',')[1] || '';
    }

    const taskType = ([
      'TiktokSliderWebTask',
      'TiktokRotateWebTask',
      'TiktokSelectObjectWebTask',
      'Tiktok3DSelectObjectWebTask',
    ].includes(captchaData.taskType) ? captchaData.taskType : 'TiktokSliderWebTask') as OmoTikTokWebTaskType;

    const taskLabelMap: Record<string, string> = {
      TiktokRotateWebTask: 'Xoay khớp hình tròn (Rotate Puzzle)',
      TiktokSliderWebTask: 'Kéo thanh trượt (Slider Puzzle)',
      Tiktok3DSelectObjectWebTask: 'Khớp 2 đối tượng 3D (3D Object Match)',
      TiktokSelectObjectWebTask: 'Chọn đối tượng theo thứ tự (Select in Order)'
    };
    const taskLabel = taskLabelMap[taskType] || taskType;

    let taskPayload: any = { type: taskType };

    if (taskType === 'TiktokRotateWebTask') {
      if (captchaData.innerBase64 && captchaData.outerBase64) {
        taskPayload.imageBase64s = [captchaData.innerBase64, captchaData.outerBase64];
      } else if (captchaData.innerBase64) {
        taskPayload.imageBase64s = [captchaData.innerBase64, captchaData.innerBase64];
      } else {
        taskPayload.imageBase64s = [fallbackBase64, fallbackBase64];
      }
    } else if (taskType === 'Tiktok3DSelectObjectWebTask') {
      taskPayload.imageBase64 = captchaData.mainImgBase64 || fallbackBase64;
      taskPayload.widthView = captchaData.widthView;
      taskPayload.heightView = captchaData.heightView || captchaData.rect.height;
      taskPayload.question = captchaData.question || 'Select 2 objects with the same shape';
    } else if (taskType === 'TiktokSliderWebTask') {
      taskPayload.imageBase64 = captchaData.mainImgBase64 || fallbackBase64;
      taskPayload.widthView = captchaData.widthView;
    } else {
      taskPayload.imageBase64 = captchaData.mainImgBase64 || fallbackBase64;
      taskPayload.widthView = captchaData.widthView;
      taskPayload.heightView = captchaData.heightView || captchaData.rect.height;
    }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `[Captcha] 📸 Đã gửi bài toán ${taskLabel} (${taskType}) lên OmoCaptcha AI...`,
    });
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `[Captcha] Tọa độ CDP dùng CSS viewport px, không nhân zoom. zoom=${win.webContents.getZoomFactor() || 1}, rect=${JSON.stringify(captchaData.rect)}, slider=${JSON.stringify(captchaData.slider || null)}.`,
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
        message: `[Captcha] ❌ Tạo bài toán OmoCaptcha thất bại: ${createRes.errorCode || ''} - ${createRes.errorDescription || ''}`,
      });
      continue;
    }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `[Captcha] ⏳ Đã nhận Task ID: ${createRes.taskId}, đang đợi AI giải...`,
    });

    let solution: any = null;
    for (let i = 0; i < 15; i++) {
      if (win.isDestroyed() || isSeedingCancelRequested()) return false;
      await waitForSeedingDelay(i === 0 ? 1200 : 2000, win).catch(() => {});
      if (win.isDestroyed() || isSeedingCancelRequested()) return false;

      const resultRes = await postOmoCaptcha({ clientKey, taskId: createRes.taskId });
      if (resultRes.errorId !== 0) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'error',
          message: `[Captcha] ❌ Lỗi nhận kết quả từ OmoCaptcha: ${resultRes.errorCode || ''} ${resultRes.errorDescription || ''}`,
        });
        break;
      }
      if (resultRes.status === 'ready') {
        solution = resultRes.solution;
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `[Captcha] 📥 OmoCaptcha đã giải xong: ${JSON.stringify(solution)}. Đang thực hiện thao tác chuột CDP...`,
        });
        break;
      }
      if (resultRes.status === 'fail') {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'warning',
          message: '[Captcha] ⚠️ OmoCaptcha báo không giải được bài toán này. Đang chuẩn bị thử lại...',
        });
        break;
      }
    }

    if (!solution) {
      continue;
    }

    const sliderWidth = captchaData.slider?.width || 40;
    const trackWidth = captchaData.track?.width || (captchaData.rect.width - 30);
    const startX = Math.round(captchaData.slider?.x || (captchaData.rect.x + sliderWidth / 2 + 10));
    const startY = Math.round(captchaData.slider?.y || (captchaData.rect.y + captchaData.rect.height - 35));
    // Exact travel length of the slider button inside the track
    const maxTravel = Math.max(40, trackWidth - sliderWidth);

    const dragByRatio = async (ratio: number) => {
      const clampedRatio = Math.max(0, Math.min(1, ratio));
      const travel = Math.round(maxTravel * clampedRatio);
      const endX = startX + travel;
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Captcha] 🖱️ Đang kéo slider: Tỷ lệ ${(clampedRatio * 100).toFixed(1)}% (Từ ${startX}px đến ${endX}px, cự ly ${travel}px/${maxTravel}px)...`,
      });
      await performCdpDrag(win, startX, startY, endX, startY);
    };

    let applied = false;
    if (solution?.pointA && solution?.pointB) {
      await performCdpClick(win, captchaData.rect.x + Number(solution.pointA.x || 0), captchaData.rect.y + Number(solution.pointA.y || 0));
      await performCdpClick(win, captchaData.rect.x + Number(solution.pointB.x || 0), captchaData.rect.y + Number(solution.pointB.y || 0));
      applied = true;
    } else if (solution?.point1 && solution?.point2) {
      await performCdpClick(win, captchaData.rect.x + Number(solution.point1.x || 0), captchaData.rect.y + Number(solution.point1.y || 0));
      await performCdpClick(win, captchaData.rect.x + Number(solution.point2.x || 0), captchaData.rect.y + Number(solution.point2.y || 0));
      applied = true;
    } else if (Array.isArray(solution?.points) && solution.points.length > 0) {
      for (const pt of solution.points.slice(0, 6)) {
        await performCdpClick(win, captchaData.rect.x + Number(pt.x || 0), captchaData.rect.y + Number(pt.y || 0));
      }
      applied = true;
    } else if (Array.isArray(solution) && solution.length > 0 && typeof solution[0]?.x === 'number') {
      for (const pt of solution.slice(0, 6)) {
        await performCdpClick(win, captchaData.rect.x + Number(pt.x || 0), captchaData.rect.y + Number(pt.y || 0));
      }
      applied = true;
    } else if (solution?.point && typeof solution.point.x === 'number') {
      await performCdpClick(win, captchaData.rect.x + Number(solution.point.x || 0), captchaData.rect.y + Number(solution.point.y || 0));
      applied = true;
    } else if (Array.isArray(solution?.objects) && solution.objects.length > 0) {
      for (const objectIndex of solution.objects.slice(0, 6)) {
        const index = Math.max(0, Number(objectIndex) || 0);
        const col = index % 3;
        const row = Math.floor(index / 3);
        const clickX = captchaData.rect.x + (captchaData.rect.width * (col + 0.5) / 3);
        const clickY = captchaData.rect.y + (captchaData.rect.height * (row + 0.5) / 2);
        await performCdpClick(win, clickX, clickY);
      }
      applied = true;
    } else if (solution?.end && typeof solution.end.x === 'number') {
      // In Slider jigsaw puzzle, end.x is the target X position inside widthView
      const widthView = captchaData.widthView || captchaData.rect.width || 340;
      const sliderRatio = Math.max(0, Math.min(1, Number(solution.end.x) / widthView));
      await dragByRatio(sliderRatio);
      applied = true;
    } else if (typeof solution?.distance === 'number') {
      const widthView = captchaData.widthView || captchaData.rect.width || 340;
      const sliderRatio = Math.max(0, Math.min(1, solution.distance / widthView));
      await dragByRatio(sliderRatio);
      applied = true;
    } else if (typeof solution?.rotate === 'number' || typeof solution?.angle === 'number' || typeof solution?.degrees === 'number') {
      const val = Number(solution.rotate ?? solution.angle ?? solution.degrees);
      const rawRatio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 360);
      // In TikTok Rotate Captcha: TikTok slider drags right (clockwise), which is opposite to OmoCaptcha's counter-clockwise angle
      // Therefore, the required slider position to align is (1 - rawRatio)
      const ratio = (rawRatio > 0 && rawRatio < 1) ? (1 - rawRatio) : rawRatio;
      await dragByRatio(ratio);
      applied = true;
    } else if (typeof solution?.value === 'number' || typeof solution?.ratio === 'number' || typeof solution?.percent === 'number') {
      const val = Number(solution.value ?? solution.ratio ?? solution.percent);
      const rawRatio = Math.abs(val) <= 1 ? Math.abs(val) : (Math.abs(val) / 100);
      const ratio = (taskType === 'TiktokRotateWebTask' && rawRatio > 0 && rawRatio < 1) ? (1 - rawRatio) : rawRatio;
      await dragByRatio(ratio);
      applied = true;
    } else if (typeof solution === 'number') {
      const rawRatio = solution <= 1 ? solution : (solution / 360);
      const ratio = (taskType === 'TiktokRotateWebTask' && rawRatio > 0 && rawRatio < 1) ? (1 - rawRatio) : rawRatio;
      await dragByRatio(ratio);
      applied = true;
    }

    if (!applied) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[Captcha] ⚠️ Định dạng lời giải ${taskType} từ OmoCaptcha chưa được hỗ trợ: ${JSON.stringify(solution || {})}`,
      });
      continue;
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

    await waitForSeedingDelay(2500, win).catch(() => {});

    // Verify if Captcha modal is still visible
    const isStillPresent = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          };
          const selectors = [
            '#captcha-verify-container',
            '.captcha-verify-container',
            '#captcha_verify_container',
            '.captcha_verify_container',
            '.sec-captcha-container',
            '.captcha-container',
            '.verify-wrap',
            '[class*="captcha-card" i]',
            '[class*="captcha-modal" i]',
            '[class*="captcha_card" i]',
            '[class*="captcha_modal" i]',
            'iframe[src*="captcha"]',
            'iframe[src*="sec"]',
            'iframe[src*="verify"]',
            'iframe[src*="challenge"]'
          ];
          return selectors.some(s => Array.from(document.querySelectorAll(s)).some(isVisible));
        } catch(e) {
          return false;
        }
      })();
    `).catch(() => false);

    if (!isStillPresent) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'success',
        message: `[Captcha] 🎉 Đã tự động giải và vượt qua thành công CAPTCHA ${taskLabel} cho @${acc.username}! Đang đợi 4s để TikTok xác nhận phiên...`,
      });
      await waitForSeedingDelay(4000, win).catch(() => {});
      return true;
    } else {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'warning',
        message: `[Captcha] ⚠️ Thao tác lần ${attempt} chưa vượt qua được CAPTCHA, đang kiểm tra để thử lại...`,
      });
    }
  }

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[Captcha] ❌ Không thể vượt qua CAPTCHA cho @${acc.username} sau ${maxAttempts} lần thử.`,
    });
    return false;
  } finally {
    if (originalZoomFactor !== 1 && !win.isDestroyed()) {
      win.webContents.setZoomFactor(originalZoomFactor);
    }
  }
}

async function checkAndSolveAnyCaptcha(
  win: BrowserWindow,
  acc: { id: string; username: string },
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void
): Promise<boolean> {
  if (win.isDestroyed() || isSeedingCancelRequested()) return false;

  try {
    const hasCaptcha = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 20 && rect.height > 20 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          };

          const specificSelectors = [
            '#captcha-verify-container',
            '.captcha-verify-container',
            '#captcha_verify_container',
            '.captcha_verify_container',
            '.sec-captcha-container',
            '.captcha-container',
            '.verify-wrap',
            '[class*="captcha-card" i]',
            '[class*="captcha-modal" i]',
            '[class*="captcha_card" i]',
            '[class*="captcha_modal" i]',
            'iframe[src*="captcha"]',
            'iframe[src*="sec"]',
            'iframe[src*="verify"]',
            'iframe[src*="challenge"]',
            '[id*="captcha" i]',
            '[class*="captcha" i]'
          ];

          const hasModalElement = specificSelectors.some(sel => {
            const els = Array.from(document.querySelectorAll(sel));
            return els.some(isVisible);
          });

          if (hasModalElement) return true;

          const bodyText = document.body?.innerText || '';
          const normalize = (s) => String(s || '').toLowerCase()
            .normalize('NFD')
            .replace(/[\\u0300-\\u036f]/g, '')
            .replace(/đ/g, 'd')
            .replace(/Đ/g, 'D')
            .trim();
          const normBody = normalize(bodyText);

          return normBody.includes('drag the slider') ||
                 normBody.includes('keo thanh truot') ||
                 normBody.includes('fit the puzzle') ||
                 normBody.includes('fit the shape') ||
                 normBody.includes('select 2 objects') ||
                 normBody.includes('chon 2 doi tuong') ||
                 normBody.includes('hai doi tuong') ||
                 normBody.includes('same shape') ||
                 normBody.includes('rotate the image') ||
                 normBody.includes('rotate') ||
                 normBody.includes('xoay hinh') ||
                 normBody.includes('xoay anh') ||
                 normBody.includes('complete the puzzle') ||
                 normBody.includes('ghep hinh') ||
                 normBody.includes('verify to continue') ||
                 normBody.includes('xac minh de tiep tuc') ||
                 normBody.includes('xac minh bao mat') ||
                 normBody.includes('security verification');
        } catch(e) {
          return false;
        }
      })();
    `).catch(() => false);

    if (hasCaptcha) {
      onLog({
        accountId: acc.id,
        accountUsername: acc.username,
        level: 'info',
        message: `[Captcha] 🔍 Phát hiện CAPTCHA TikTok cho @${acc.username}, đang tiến hành giải tự động...`,
      });
      return await solveTikTokWebCaptchaWithOmo(win, acc, onLog);
    }
    return false;
  } catch (err) {
    return false;
  }
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
  keepTikTokSeedingZoom(win);
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
      applyTikTokSeedingZoom(win);
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
      if (config.likeEnabled) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: 'Đang thực hiện thả tim (Like) video...',
        });

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
                'button[aria-label*="like" i]',
                'button[aria-label*="thích" i]',
                'button[aria-label*="Thích" i]',
                '[role="button"][aria-label*="like" i]',
                '[class*="LikeContainer"]',
                '[class*="ButtonLike"]'
              ];
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
                       label.includes('đã thích') ||
                       label.includes('bỏ thích') ||
                       hasLikedColor(node)
              };
            } catch(e) {
              return { found: false, liked: false, error: e.toString() };
            }
          })();
        `);

        // Check if already liked first
        const initialState = await readVideoLikeState();
        if (initialState?.liked) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: '❤️ Video đã được thả tim sẵn, bỏ qua bấm lại.',
          });
        } else {
          let likedSuccess = false;
          for (let attempt = 1; attempt <= 2; attempt++) {
            const singleClickResult = await win.webContents.executeJavaScript(`
              (() => {
                try {
                  const isVisible = (el) => {
                    if (!el) return false;
                    const rect = el.getBoundingClientRect();
                    const style = window.getComputedStyle(el);
                    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                  };
                  const selectors = [
                    '[data-e2e="like-icon"]',
                    '[data-e2e="browse-like-icon"]',
                    '[data-e2e="video-like-icon"]',
                    '[data-e2e="feed-like"]',
                    'button[aria-label*="like" i]',
                    'button[aria-label*="thích" i]',
                    'button[aria-label*="Thích" i]',
                    '[role="button"][aria-label*="like" i]',
                    '[class*="LikeContainer"]',
                    '[class*="ButtonLike"]'
                  ];
                  for (const s of selectors) {
                    const el = Array.from(document.querySelectorAll(s)).find(isVisible);
                    if (el) {
                      const btn = el.closest('button') || el;
                      btn.click();
                      return { clicked: true, target: 'like-button' };
                    }
                  }
                  const video = document.querySelector('video');
                  if (video) {
                    video.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                    return { clicked: true, target: 'video-dblclick' };
                  }
                  return { clicked: false };
                } catch(e) { return { clicked: false, error: e.toString() }; }
              })()
            `);

            await waitForSeedingDelay(1000, win);
            const stateAfter = await readVideoLikeState();
            if (stateAfter?.liked) {
              likedSuccess = true;
              break;
            }
          }

          if (likedSuccess) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: '❤️ Đã xác nhận video được thả tim thành công.',
            });
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: '❤️ Đã gửi thao tác thả tim video.',
            });
          }
        }
      }

      await checkAndSolveAnyCaptcha(win, acc, onLog);
      throwIfSeedingCancelled(win);

      if (config.comments && config.comments.length > 0) {
        const commentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (commentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `Đang tự động gõ bình luận: "${commentText}"...`,
          });

          await waitForSeedingDelay(1000, win);

          // Step 1 & 2: Detect if input is already visible, or find the comment icon to open comment drawer
          const commentOpenResult = await win.webContents.executeJavaScript(`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                const inputSelectors = [
                  '[data-e2e="comment-input"]',
                  'div[contenteditable="true"]',
                  'div[contenteditable="plaintext-only"]',
                  'div[contenteditable]',
                  '[role="textbox"]',
                  '[data-e2e="comment-input-area"]',
                  'div[class*="BottomCommentContainer"]',
                  'div[class*="DivCommentInput"]',
                  'div[class*="InputArea"]',
                  'textarea'
                ];

                let input = inputSelectors.map(sel => document.querySelector(sel)).find(isVisible);
                if (input) return { inputAlreadyVisible: true };

                // If input is not visible, find the comment icon on the video action bar
                const iconSelectors = [
                  '[data-e2e="comment-icon"]',
                  '[data-e2e="browse-comment-icon"]',
                  '[data-e2e="feed-comment-icon"]',
                  '[data-e2e="video-comment-icon"]',
                  'button[aria-label*="comment" i]',
                  'button[aria-label*="bình luận" i]',
                  'button[aria-label*="Bình luận" i]',
                  'span[aria-label*="comment" i]',
                  'span[aria-label*="bình luận" i]',
                  '[role="button"][aria-label*="comment" i]',
                  'strong[data-e2e*="comment-count"]',
                  '[class*="CommentButton"]',
                  '[class*="ButtonActionItem"]'
                ];

                let iconEl = null;
                for (const sel of iconSelectors) {
                  const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
                  if (matches.length > 0) {
                    iconEl = matches[0].closest('button') || matches[0].closest('[role="button"]') || matches[0];
                    break;
                  }
                }

                // If still not found, check next sibling of the Like button
                if (!iconEl) {
                  const likeEl = document.querySelector('[data-e2e="like-icon"], [data-e2e="browse-like-icon"], button[aria-label*="like" i]');
                  if (likeEl) {
                    const likeContainer = likeEl.closest('button')?.parentElement || likeEl.parentElement;
                    const nextContainer = likeContainer?.nextElementSibling;
                    const btn = nextContainer?.querySelector('button, [role="button"]') || nextContainer;
                    if (btn && isVisible(btn)) {
                      iconEl = btn;
                    }
                  }
                }

                if (iconEl) {
                  iconEl.click();
                  const rect = iconEl.getBoundingClientRect();
                  return {
                    inputAlreadyVisible: false,
                    openedIcon: true,
                    clickX: Math.round(rect.left + rect.width / 2),
                    clickY: Math.round(rect.top + rect.height / 2)
                  };
                }

                return { inputAlreadyVisible: false, openedIcon: false, reason: 'Không tìm thấy ô nhập hoặc biểu tượng bình luận' };
              } catch(e) {
                return { inputAlreadyVisible: false, openedIcon: false, error: e.toString() };
              }
            })();
          `);

          if (!commentOpenResult?.inputAlreadyVisible && commentOpenResult?.openedIcon) {
            if (commentOpenResult.clickX && commentOpenResult.clickY) {
              await performCdpClick(win, commentOpenResult.clickX, commentOpenResult.clickY).catch(() => {});
            }
            await waitForSeedingDelay(1500, win);
          }

          // Step 3 & 4: Focus input, type comment, and click Post
          const commentResult = await win.webContents.executeJavaScript(`
            (async () => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                const inputSelectors = [
                  '[data-e2e="comment-input"]',
                  'div[contenteditable="true"]',
                  'div[contenteditable="plaintext-only"]',
                  'div[contenteditable]',
                  '[role="textbox"]',
                  '[data-e2e="comment-input-area"]',
                  'div[class*="BottomCommentContainer"]',
                  'div[class*="DivCommentInput"]',
                  'div[class*="InputArea"]',
                  'textarea'
                ];

                // Scroll right sidebar to bottom to reveal comment box
                const commentContainers = document.querySelectorAll(
                  '[data-e2e="video-detail-container"], div[class*="CommentContainer"], div[class*="DivCommentListContainer"], div[class*="DivRightContainer"], div[class*="DivContentContainer"]'
                );
                commentContainers.forEach(c => {
                  try { c.scrollTop = c.scrollHeight; } catch(e) {}
                });

                let input = inputSelectors.map(sel => document.querySelector(sel)).find(isVisible);
                if (!input) {
                  const allTextBoxes = Array.from(document.querySelectorAll('div, p, span, textarea, input')).filter(el => {
                    if (!isVisible(el)) return false;
                    const placeholder = (el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
                    return placeholder.includes('comment') || placeholder.includes('bình luận') || placeholder.includes('add comment') || placeholder.includes('thêm bình luận');
                  });
                  input = allTextBoxes[0];
                }

                if (!input) {
                  return { success: false, reason: 'Không tìm thấy ô nhập bình luận sau khi mở tab' };
                }

                input.scrollIntoView({ behavior: 'instant', block: 'center' });
                await new Promise(r => setTimeout(r, 200));

                input.click();
                input.focus();
                await new Promise(r => setTimeout(r, 200));

                const editable = input.getAttribute('contenteditable') ? input :
                  (input.querySelector('[contenteditable], [role="textbox"], textarea, input') || input);

                editable.focus();

                // Select existing content if any and insert text
                try {
                  const selection = window.getSelection();
                  const range = document.createRange();
                  range.selectNodeContents(editable);
                  selection.removeAllRanges();
                  selection.addRange(range);
                } catch(e) {}

                document.execCommand('insertText', false, ${JSON.stringify(commentText)});
                editable.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                editable.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));

                try {
                  editable.dispatchEvent(new InputEvent('input', {
                    bubbles: true,
                    cancelable: true,
                    inputType: 'insertText',
                    data: ${JSON.stringify(commentText)}
                  }));
                } catch(e) {}

                await new Promise(r => setTimeout(r, 600));

                // Click Post button
                const sendBtns = [
                  '[data-e2e="comment-post"]',
                  'div[data-e2e="comment-post"]',
                  'button[data-e2e="comment-post"]',
                  '[aria-label*="Post" i]',
                  '[aria-label*="Đăng" i]',
                  '[class*="DivPostButton"]',
                  '[class*="PostBtn"]',
                  '[class*="ButtonPost"]'
                ];

                let posted = false;
                for (const sel of sendBtns) {
                  const btn = document.querySelector(sel);
                  if (btn && isVisible(btn)) {
                    btn.click();
                    posted = true;
                    break;
                  }
                }

                if (!posted) {
                  editable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  editable.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                  editable.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
                }

                return { success: true };
              } catch(e) {
                return { success: false, error: e.toString() };
              }
            })();
          `);

          // Send Enter key as final confirmation
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: commentResult?.success ? 'info' : 'warning',
            message: commentResult?.success
              ? `💬 Đã nhập và gửi yêu cầu bình luận video: "${commentText}".`
              : `💬 Không nhập được bình luận video cho @${acc.username}: ${commentResult?.reason || commentResult?.error || commentOpenResult?.reason || 'không rõ lỗi'}.`,
          });
        }
      }
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

      if (config.likeEnabled) {
        await tapLiveContinuously(win, acc, liveDurationSeconds, onLog, 'main');
      } else {
        await waitForSeedingDelay(liveDurationSeconds * 1000, win);
      }
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
      await waitForSeedingDelay(3000, win).catch(() => {});
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
  } finally {
    if (!win.isDestroyed()) {
      closedByAutomation = true;
      win.close();
    }
  }
}
