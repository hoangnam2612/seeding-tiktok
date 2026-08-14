import { BrowserWindow, session, ipcMain, screen } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from './nest/automation/automation.interface';
import { MailOtpService } from './nest/accounts/mail-otp.service';
import { generateTotpToken } from './nest/accounts/totp.helper';

const mailOtpService = new MailOtpService();

// Map of active login windows
const loginWindows = new Map<string, BrowserWindow>();

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
const LIVESTREAM_INITIAL_COMMENT_DELAY_MS = 15000;

type AccountStatus = 'authenticated' | 'unauthenticated' | 'active' | 'error' | 'live' | 'die';
type AccountSessionUpdate = {
  cookie: string;
  status: 'authenticated';
  lastUsed: string;
};

let seedingInteractionQueue = Promise.resolve();
let sessionPreparationQueue = Promise.resolve();

async function runSeedingInteraction<T>(task: () => Promise<T>): Promise<T> {
  const previous = seedingInteractionQueue;
  let release!: () => void;
  seedingInteractionQueue = new Promise<void>(resolve => {
    release = resolve;
  });

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
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
    message: `${logPrefix}Đã lưu cookie TikTok mới cho @${accountUsername || accountId}.`,
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
      return { ready: false, reason: 'Cửa sổ đã đóng.' };
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
              '[data-e2e="like-icon"], [data-e2e="browse-like-icon"], [data-e2e="video-like-icon"], [data-e2e="feed-like"], [data-e2e="search-like-icon"], [data-e2e*="like"], button[aria-label*="like" i], button[aria-label*="thích" i], button[aria-label*="Thích" i], span[aria-label*="like" i], span[aria-label*="thích" i], [class*="LikeContainer"], [class*="ButtonLike"], [class*="ButtonActionItem"]'
            )).some(isVisible);

            const hasVideoComment = Array.from(document.querySelectorAll(
              '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], [data-e2e="comment-input"], [data-e2e="comment-input-area"], button[aria-label*="comment" i], button[aria-label*="bình luận" i], [role="textbox"], textarea'
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
                                  bodyText.includes('Đăng nhập');

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
      ? 'Đang ở màn hình đăng nhập.'
      : lastState?.reason || 'TikTok chưa render đủ UI trong thời gian chờ.',
  };
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
) {
  if (proxyStr && proxyStr.trim().length > 0) {
    try {
      let formattedProxy = proxyStr.trim();
      if (!formattedProxy.startsWith('http://') && !formattedProxy.startsWith('socks5://')) {
        const parts = formattedProxy.split(':');
        if (parts.length === 4) {
          const [ip, port, user, pass] = parts;
          formattedProxy = `http://${user}:${pass}@${ip}:${port}`;
        } else if (parts.length === 2) {
          formattedProxy = `${proxyType === 'socks5' ? 'socks5' : 'http'}://${parts[0]}:${parts[1]}`;
        } else {
          formattedProxy = `${proxyType === 'socks5' ? 'socks5' : 'http'}://${formattedProxy}`;
        }
      }
      await customSession.setProxy({ proxyRules: formattedProxy });
      console.log(`[Proxy] Configured proxy: ${formattedProxy}`);
    } catch (err) {
      console.error('[Proxy] Failed to set proxy:', err);
    }
  } else {
    await customSession.setProxy({ proxyRules: '' });
  }

  if (hasValidTikTokCookieString(cookieStr)) {
    const existingCookies = await customSession.cookies.get({}).catch(() => []);
    const hasExistingSession = hasTikTokSessionCookie(existingCookies);

    if (options.skipCookieInjectionIfSessionExists && hasExistingSession) {
      console.log('[Cookie] Session cookie already exists. Skipped reinjecting cookies for seeding.');
      return;
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
      console.warn(`[Cookie] Không inject được session cookie TikTok. Injected ${injectedCount}/${pairs.length}, skipped ${skippedCount}.`);
    }
  }
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
                     txt.includes('đăng nhập') ||
                     txt.includes('tiếp tục');
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
                   txt.includes('xác minh') ||
                   txt.includes('tiếp tục') ||
                   txt.includes('kế tiếp');
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


  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Monitor] Đã kích hoạt giám sát luồng đăng nhập cho @${acc.username}...`,
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
            const hasLogoutBtn = bodyText.includes('Log out') || bodyText.includes('Đăng xuất');

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
              bodyText.includes("Xác minh đó là bạn")
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
                                   lowerText.includes('hòm thư') ||
                                   lowerText.includes('thư điện tử');

            const hasEmailCodePrompt = lowerText.includes('enter code') ||
                                       lowerText.includes('enter the code') ||
                                       lowerText.includes('verification code') ||
                                       lowerText.includes('6-digit') ||
                                       lowerText.includes('six-digit') ||
                                       lowerText.includes('sent to email') ||
                                       lowerText.includes('sent to your email') ||
                                       lowerText.includes('code sent') ||
                                       lowerText.includes('mã xác minh') ||
                                       lowerText.includes('nhập mã') ||
                                       lowerText.includes('gửi đến email') ||
                                       lowerText.includes('gửi tới email');

            const emailOptionCandidate = Array.from(document.querySelectorAll('button, [role="button"], div, span, p')).find(el => {
              if (!isVisible(el)) return false;
              const txt = (el.innerText || el.textContent || '').toLowerCase();
              return (txt.includes('email') || txt.includes('@') || txt.includes('hòm thư')) &&
                     !txt.includes('enter code') &&
                     !txt.includes('verification code') &&
                     !txt.includes('nhập mã');
            });

            const resolvedEmailCodeInputScreen = isEmailCodeInputScreen ||
              (!hasCaptcha && !is2FA && hasEmailSignal && hasEmailCodePrompt && (visibleCodeInputs.length >= 1 || hasSixSingleDigitInputs));
            const resolvedEmailOptionSelectionScreen = !resolvedEmailCodeInputScreen &&
              (isEmailOptionSelectionScreen || ((isEmailCheckpoint || hasEmailSignal) && !!emailOptionCandidate));

            // Login Error Toast / Bad Credentials
            const hasError = bodyText.includes('Maximum number of attempts reached') ||
                             bodyText.includes('Incorrect password') ||
                             bodyText.includes('User does not exist');

            return {
              hasUserMenu,
              hasLogoutBtn,
              hasCaptcha,
              is2FA,
              isEmailOptionSelectionScreen: resolvedEmailOptionSelectionScreen,
              isEmailCodeInputScreen: resolvedEmailCodeInputScreen,
              hasError
            };
          } catch(e) {
            return {
              hasUserMenu: false,
              hasLogoutBtn: false,
              hasCaptcha: false,
              is2FA: false,
              isEmailOptionSelectionScreen: false,
              isEmailCodeInputScreen: false,
              hasError: false
            };
          }
        })();
      `);

      // A. STRICT LOGGED_IN CHECK (Requires Session Cookie OR strict User Menu/Logout button)
      if (hasSessionCookie || (pageState.hasUserMenu && pageState.hasLogoutBtn)) {
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
          message: `🎉 ĐĂNG NHẬP THÀNH CÔNG cho @${acc.username}! Session Cookie đã được xác nhận.`,
        });
        return { success: true, status: 'authenticated' };
      }

      // B. CAPTCHA DETECTED -> Log warning, wait, DO NOT spam OTP
      if (pageState.hasCaptcha) {
        if (!hasWarnedCaptcha) {
          hasWarnedCaptcha = true;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `⚠️ PHÁT HIỆN CAPTCHA/CHALLENGE cho @${acc.username}! Vui lòng kéo/giải Captcha thủ công trên màn hình Chrome. Đang tiếp tục chờ...`,
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
              message: `🔑 Đã phát hiện màn hình 2FA! Đã tự động sinh mã TOTP 6 số [ ${totpCode} ]. Đang điền...`,
            });

            // Fill TOTP using single safe strategy
            await fillSixDigitCodeSingleStrategy(win, totpCode);
          }
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `⚠️ Màn hình 2FA yêu cầu mã Authenticator nhưng tài khoản @${acc.username} chưa cài Khóa 2FA!`,
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
          message: `📬 Đã thấy màn hình chọn phương thức xác minh Email. Đang bấm chọn Email...`,
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
                return (txt.includes('email') || txt.includes('@') || txt.includes('hòm thư')) &&
                       !txt.includes('enter code') &&
                       !txt.includes('verification code') &&
                       !txt.includes('nhập mã');
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
            message: `📬 Màn hình nhập mã Email OTP đã sẵn sàng! Đang kết nối ngầm hòm thư ${acc.email} để bóc mã...`,
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
              message: `🎉 Đã đọc được mã OTP TikTok từ hòm thư: [ ${otpRes.otp} ]. Đang tự động điền...`,
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
              message: `⚠️ Kết quả đọc Email OTP: ${otpRes.message}`,
            });
          }
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `⚠️ Màn hình xác minh yêu cầu mã OTP Email nhưng tài khoản chưa nhập Email & PassMail!`,
          });
          hasFilledEmailOtp = true; // Prevent log spam
        }
      }

      // F. UNAUTHENTICATED HOMEPAGE / LOGIN FORM DETECTED -> Click "Log in" button or trigger Auto-fill
      if (!hasSessionCookie && acc.password) {
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
                       txt.includes('sử dụng điện thoại / email / tên người dùng') ||
                       txt.includes('sử dụng điện thoại') ||
                       txt.includes('sử dụng email');
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
                                    return txt === 'log in' || txt === 'đăng nhập';
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
            message: `🔑 Phát hiện ô đăng nhập trên TikTok! Đang tự động điền Username & Mật khẩu...`,
          });
          await autoFillTikTokLogin(win, acc.username, acc.password);
        } else if (loginCheck === 'CLICKED_TOP_LOGIN' || loginCheck === 'CLICKED_MODAL_OPTION') {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `🌐 Tài khoản chưa đăng nhập. Đang tự động bấm nút "Đăng nhập" trên TikTok...`,
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
          message: `❌ Phát hiện lỗi đăng nhập trên TikTok cho @${acc.username}: Mật khẩu không đúng hoặc tài khoản không tồn tại.`,
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
    message: `[Monitor] Kết thúc thời gian giám sát 90s cho @${acc.username}.`,
  });

  return { success: false, status: 'timeout' };
}

export function setupAutomationIPC(
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
) {
  // 1. Open Interactive Login Window for a TikTok Account (Single Chrome)
  ipcMain.handle(
    'open-account-login-window',
    async (
      _event,
      accountId: string,
      username: string,
      cookie?: string,
      proxy?: string,
      password?: string,
      email?: string,
      passMail?: string,
      twoFactor?: string
    ) => {
      if (loginWindows.has(accountId)) {
        const existingWin = loginWindows.get(accountId)!;
        if (!existingWin.isDestroyed()) {
          existingWin.focus();
          return { success: true, message: 'Window focused' };
        }
      }

      const partition = `persist:tiktok_${accountId}`;
      const customSession = session.fromPartition(partition);

      customSession.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      await runSessionPreparation(() =>
        configureSessionProxyAndCookies(customSession, cookie, proxy, 'http', {
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
      if (!hasCookie && password) {
        win.loadURL('https://www.tiktok.com/login/phone-or-email/email');
      } else {
        win.loadURL('https://www.tiktok.com');
      }


      onLog({
        accountId,
        accountUsername: username,
        level: 'info',
        message: `🌐 Đã mở Chrome Profile cho @${username || accountId} ${proxy ? '[Proxy Active]' : ''}`,
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
              message: `✅ Session Cookie đã được xác nhận thành công cho @${username || accountId}!`,
            });
          }
        } catch (err: any) {
          console.error('Failed to check cookies:', err);
        }
      });

      return { success: true };
    }
  );

  // 2. Open Multi-Thread Account Chromes (Đa Luồng)
  ipcMain.handle(
    'open-multi-account-chromes',
    async (_event, accountIds: string[], maxThreads: number = 10, accountsData: any[]) => {
      const selectedAccounts = accountsData.filter(a => accountIds.includes(a.id));
      if (selectedAccounts.length === 0) {
        return { success: false, message: 'No valid accounts selected' };
      }
      const effectiveMaxThreads = maxThreads > 0 ? Math.min(maxThreads, selectedAccounts.length) : selectedAccounts.length;

      onLog({
        level: 'info',
        message: `🚀 Bắt đầu khởi chạy ${selectedAccounts.length} cửa sổ Chrome đa luồng (Tối đa ${effectiveMaxThreads} luồng song song)...`,
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
          message: `[Multi-Thread] Mở cửa sổ Chrome cho @${acc.username}...`,
        });

        const partition = `persist:tiktok_${acc.id}`;
        const customSession = session.fromPartition(partition);

        customSession.setUserAgent(
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await runSessionPreparation(() =>
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

        if (!hasCookie && acc.password) {
          win.loadURL('https://www.tiktok.com/login/phone-or-email/email');
        } else {
          win.loadURL('https://www.tiktok.com');
        }

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
                  message: `✅ [Multi-Thread] Session Cookie đã được xác nhận thành công cho @${acc.username}!`,
                });
              } else {
                onLog({
                  accountId: acc.id,
                  accountUsername: acc.username,
                  level: 'info',
                  message: `Đã đóng cửa sổ Chrome của @${acc.username}`,
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
    async (_event, config: SeedingTaskConfig, accounts: { id: string; username: string; cookie?: string; proxy?: string; proxyType?: string }[]) => {
      onLog({
        level: 'info',
        message: `🚀 Bắt đầu tác vụ Seeding trên ${config.targetType.toUpperCase()}: ${config.targetUrl}`,
      });

      const selectedAccounts = accounts.filter(a => config.accountIds.includes(a.id));

      if (selectedAccounts.length === 0) {
        onLog({
          level: 'error',
          message: 'Không có tài khoản nào được chọn để thực hiện tác vụ.',
        });
        return { success: false, message: 'No accounts selected' };
      }

      const effectiveMaxThreads = config.maxThreads && config.maxThreads > 0
        ? Math.min(config.maxThreads, selectedAccounts.length)
        : selectedAccounts.length;
      const queue = selectedAccounts.map((acc, index) => ({ acc, index }));
      let completedCount = 0;

      onLog({
        level: 'info',
        message: `🚀 Seeding đa luồng: mở ${effectiveMaxThreads}/${selectedAccounts.length} tài khoản cùng lúc...`,
      });

      const runSeedingWorker = async (workerIndex: number) => {
        if (workerIndex > 0) {
          await new Promise(res => setTimeout(res, workerIndex * 800));
        }

        while (queue.length > 0) {
          const item = queue.shift();
          if (!item) return;
          const { acc, index } = item;

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[Worker ${workerIndex + 1}] [${index + 1}/${selectedAccounts.length}] Đang khởi tạo seeding cho @${acc.username}...`,
          });

          try {
            await executeTaskForAccount(acc, config, onLog, onAccountSessionUpdate, loginWindows.size + index);
            completedCount++;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: `[Worker ${workerIndex + 1}] Hoàn thành @${acc.username} (${completedCount}/${selectedAccounts.length}).`,
            });
          } catch (err: any) {
            completedCount++;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: `Lỗi thực hiện tác vụ cho @${acc.username}: ${err.message || err}`,
            });
          }

          if (queue.length > 0 && effectiveMaxThreads < selectedAccounts.length) {
            const delayMs = Math.max(1, config.delaySeconds || 1) * 1000;
            await new Promise(res => setTimeout(res, delayMs));
          }
        }
      };

      const workers = Array.from(
        { length: effectiveMaxThreads },
        (_, workerIndex) => runSeedingWorker(workerIndex)
      );

      await Promise.all(workers);

      onLog({
        level: 'success',
        message: `🎉 Tác vụ Seeding đã hoàn thành toàn bộ ${selectedAccounts.length} tài khoản!`,
      });

      return { success: true };
    }
  );
}

/**
 * Execute automation actions for a single account on TikTok Video / Live
 */
async function executeTaskForAccount(
  acc: { id: string; username: string; cookie?: string; proxy?: string; proxyType?: string },
  config: SeedingTaskConfig,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  windowSlot: number = 0
) {
  const partition = `persist:tiktok_${acc.id}`;
  const customSession = session.fromPartition(partition);
  customSession.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  await runSessionPreparation(() =>
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

  try {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Đang tải URL trang TikTok: ${config.targetUrl}...`,
    });

    await loadTikTokUrlForSeeding(win, customSession, config.targetUrl, acc, onLog);
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
    await new Promise(res => setTimeout(res, 800));

    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `Đang đợi TikTok render ổn định trước khi thao tác...`,
    });

    const surfaceReady = await waitForTikTokSurfaceReady(win, config.targetType);
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: surfaceReady.ready ? 'info' : 'warning',
      message: surfaceReady.ready
        ? `TikTok đã sẵn sàng: video=${surfaceReady.hasVideo ? 'có' : 'không'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'có' : 'không'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'có' : 'không'}.`
        : `TikTok chưa ổn định sau ${Math.round(TIKTOK_SURFACE_READY_TIMEOUT_MS / 1000)}s (${surfaceReady.reason || 'không rõ'}). Trạng thái: readyState=${surfaceReady.readyState || 'unknown'}, video=${surfaceReady.hasVideo ? 'có' : 'không'}, like=${surfaceReady.hasVideoLike || surfaceReady.hasLiveLike ? 'có' : 'không'}, chat/comment=${surfaceReady.hasVideoComment || surfaceReady.hasLiveChat ? 'có' : 'không'}.`,
    });

    if (config.targetType === 'video') {
      await runSeedingInteraction(async () => {
        if (!win.isDestroyed()) {
          win.focus();
          win.webContents.focus();
          await new Promise(res => setTimeout(res, 250));
        }

      if (config.likeEnabled) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `Đang thực hiện thả tim (Like) video...`,
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
                'button[aria-label*="thích" i]',
                'button[aria-label*="Thích" i]',
                '[role="button"][aria-label*="like" i]',
                '[role="button"][aria-label*="thích" i]',
                '[role="button"][aria-label*="Thích" i]',
                'span[aria-label*="like" i]',
                'span[aria-label*="thích" i]',
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
                       label.includes('đã thích') ||
                       label.includes('bỏ thích') ||
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
                         label.includes('đã thích') ||
                         label.includes('bỏ thích') ||
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

                const triggerDomClick = (el) => {
                  if (!el) return;
                  try {
                    if (typeof el.click === 'function') el.click();
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                  } catch (e) {}
                };

                const triggerDomDblClick = (el) => {
                  if (!el) return;
                  try {
                    triggerDomClick(el);
                    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
                  } catch (e) {}
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
                  'button[aria-label*="thích" i]',
                  'button[aria-label*="Thích" i]',
                  '[role="button"][aria-label*="like" i]',
                  '[role="button"][aria-label*="thích" i]',
                  '[role="button"][aria-label*="Thích" i]',
                  'span[aria-label*="like" i]',
                  'span[aria-label*="thích" i]',
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
                  if (!alreadyLiked) {
                    triggerDomClick(target);
                    if (node !== target) triggerDomClick(node);
                  }

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
                    triggerDomDblClick(video);
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

          if (likeTarget.target === 'video-dblclick') {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: likeTarget.x, y: likeTarget.y, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: likeTarget.x, y: likeTarget.y, button: 'left', clickCount: 1 });
            await new Promise(res => setTimeout(res, 80));
            win.webContents.sendInputEvent({ type: 'mouseDown', x: likeTarget.x, y: likeTarget.y, button: 'left', clickCount: 2 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: likeTarget.x, y: likeTarget.y, button: 'left', clickCount: 2 });
          } else {
            win.webContents.sendInputEvent({ type: 'mouseDown', x: likeTarget.x, y: likeTarget.y, button: 'left', clickCount: 1 });
            win.webContents.sendInputEvent({ type: 'mouseUp', x: likeTarget.x, y: likeTarget.y, button: 'left', clickCount: 1 });
          }

          await new Promise(res => setTimeout(res, 900));
          const likeStateAfterClick = await readVideoLikeState();
          if (likeStateAfterClick?.liked) {
            likeResult = { attempted: true, verified: true, alreadyLiked: false, target: likeTarget.target, attempt };
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
            message: `❤️ Video đã được thả tim sẵn, bỏ qua để tránh bấm lại thành bỏ tim.`,
          });
        } else if (likeResult?.attempted) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: likeResult?.verified ? 'success' : 'warning',
            message: likeResult?.verified
              ? `❤️ Đã xác nhận video được thả tim qua ${likeResult.target}.`
              : `Đã thử thả tim video qua ${likeResult.target} nhưng chưa thấy icon đổi sang màu tim sau ${likeResult.attempt || 0} lần thử.`,
          });
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `Không tìm thấy nút/vùng video để thả tim cho @${acc.username}.`,
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
            message: `Đang tự động gõ bình luận: "${commentText}"...`,
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
            await new Promise(res => setTimeout(res, 600));

            for (const char of commentText) {
              win.webContents.sendInputEvent({ type: 'char', keyCode: char });
              await new Promise(res => setTimeout(res, 40 + Math.random() * 40));
            }

            await new Promise(res => setTimeout(res, 1000));

            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });

            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `💬 Đã nhập và gửi yêu cầu bình luận video: "${commentText}". TikTok chưa xác nhận bình luận đã hiển thị.`,
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
        message: `Đang giữ livestream ${liveDurationSeconds}s cho @${acc.username}${config.likeEnabled ? ' và tap live liên tục...' : '...'}`,
      });

      if (config.comments && config.comments.length > 0) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `⏳ Vừa vào Livestream, đang chờ ${Math.round(LIVESTREAM_INITIAL_COMMENT_DELAY_MS / 1000)}s trước khi bắt đầu bình luận cho @${acc.username}...`,
        });
        await new Promise(res => setTimeout(res, LIVESTREAM_INITIAL_COMMENT_DELAY_MS));
        if (win.isDestroyed()) return;
      }

      await runSeedingInteraction(async () => {
        if (!win.isDestroyed()) {
          win.focus();
          win.webContents.focus();
          await new Promise(res => setTimeout(res, 250));
        }

      if (config.comments && config.comments.length > 0) {
        const liveCommentText = config.comments[Math.floor(Math.random() * config.comments.length)].trim();
        if (liveCommentText) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `Đang tìm ô bình luận Live để gửi: "${liveCommentText}"...`,
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
                           label.includes('bình luận') ||
                           label.includes('nhắn') ||
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

                clickByText(['comment', 'chat', 'bình luận', 'message']);
                await new Promise(r => setTimeout(r, 500));

                let input = findInput();
                if (!input) {
                  scrollHorizontally('right');
                  await new Promise(r => setTimeout(r, 500));
                  clickByText(['comment', 'chat', 'bình luận', 'message']);
                  await new Promise(r => setTimeout(r, 500));
                  input = findInput();
                }
                if (!input) {
                  scrollHorizontally('left');
                  await new Promise(r => setTimeout(r, 300));
                  input = findInput();
                }

                const totalInputs = document.querySelectorAll('textarea, input, div[contenteditable], [role="textbox"]').length;
                if (!input) return { success: false, reason: 'Không thấy ô chat/comment Live. Tổng input/textbox trên DOM: ' + totalInputs };

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
              win.webContents.sendInputEvent({ type: 'char', keyCode: char });
              await new Promise(res => setTimeout(res, 35 + Math.random() * 35));
            }
            await new Promise(res => setTimeout(res, 500));
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
                return { clicked: false, error: 'Không kiểm tra được nút gửi Live.' };
              })();
            `);

            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: liveSendResult?.clicked ? 'info' : 'warning',
              message: liveSendResult?.clicked
                ? `💬 Đã click nút gửi bình luận Live: "${liveCommentText}". TikTok chưa xác nhận bình luận đã hiển thị.`
                : `Không click được nút gửi Live cho @${acc.username}. Nút gửi: ${liveSendResult?.sendBtnVisible ? 'có hiện' : 'không hiện'}, trạng thái: ${liveSendResult?.isProbablyDisabled ? 'chưa sẵn sàng' : 'không rõ'}, text trong ô: ${liveSendResult?.inputTextLength ?? 0} ký tự.`,
            });
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'warning',
              message: `Không gửi được bình luận Live cho @${acc.username}: ${focusLiveComment?.reason || 'không tìm thấy ô bình luận'}`,
            });
          }
        }
      }
      });

      if (config.likeEnabled) {
        const endAt = Date.now() + liveDurationSeconds * 1000;
        let tapCount = 0;

        while (Date.now() < endAt && !win.isDestroyed()) {
          const tapPoint = await win.webContents.executeJavaScript(`
            (() => {
              try {
                const isVisible = (el) => {
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };

                // Priority 1: Exact room-chat-like-btn (heart button)
                const roomLikeBtn = document.querySelector('[data-e2e="room-chat-like-btn"]');
                if (roomLikeBtn && isVisible(roomLikeBtn)) {
                  const rect = roomLikeBtn.getBoundingClientRect();
                  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'room-like-btn' };
                }

                // Priority 2: Generic like button match
                const video = Array.from(document.querySelectorAll('video')).find(isVisible);
                const liveLikeButton = Array.from(document.querySelectorAll('button, [role="button"], [aria-label], [data-e2e]')).find(el => {
                  if (!isVisible(el)) return false;
                  const label = [
                    el.getAttribute('aria-label'),
                    el.getAttribute('data-e2e'),
                    el.getAttribute('title'),
                    el.textContent
                  ].join(' ').toLowerCase();
                  return label.includes('like') ||
                         label.includes('heart') ||
                         label.includes('thích') ||
                         label.includes('tap');
                });

                if (liveLikeButton) {
                  const rect = liveLikeButton.getBoundingClientRect();
                  return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'button' };
                }

                // Priority 3: Fallback double-tap video/screen center
                const target = video || document.body;
                const rect = target.getBoundingClientRect();
                if (!rect.width || !rect.height) return null;
                return { x: Math.round(rect.left + rect.width * 0.5), y: Math.round(rect.top + rect.height * 0.58), target: video ? 'video' : 'body' };
              } catch(e) {
                return null;
              }
            })();
          `);

          if (tapPoint && typeof tapPoint.x === 'number' && typeof tapPoint.y === 'number') {
            if (tapPoint.target === 'room-like-btn') {
              win.webContents.sendInputEvent({ type: 'mouseDown', x: tapPoint.x, y: tapPoint.y, button: 'left', clickCount: 1 });
              win.webContents.sendInputEvent({ type: 'mouseUp', x: tapPoint.x, y: tapPoint.y, button: 'left', clickCount: 1 });
            } else {
              win.webContents.sendInputEvent({ type: 'mouseDown', x: tapPoint.x, y: tapPoint.y, button: 'left', clickCount: 1 });
              win.webContents.sendInputEvent({ type: 'mouseUp', x: tapPoint.x, y: tapPoint.y, button: 'left', clickCount: 1 });
              await new Promise(res => setTimeout(res, 80));
              win.webContents.sendInputEvent({ type: 'mouseDown', x: tapPoint.x, y: tapPoint.y, button: 'left', clickCount: 2 });
              win.webContents.sendInputEvent({ type: 'mouseUp', x: tapPoint.x, y: tapPoint.y, button: 'left', clickCount: 2 });
            }
            tapCount++;
          }
          await new Promise(res => setTimeout(res, 450 + Math.random() * 450));
        }

        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: tapCount > 0 ? 'success' : 'warning',
          message: tapCount > 0
            ? `Đã tap live ${tapCount} lần trong ${liveDurationSeconds}s.`
            : `Không tìm thấy vùng live/nút tim để tap cho @${acc.username}.`,
        });
      } else {
        await new Promise(res => setTimeout(res, liveDurationSeconds * 1000));
      }
    }

    await new Promise(res => setTimeout(res, SEEDING_POST_ACTION_STABILIZE_MS));
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
      win.close();
    }
  }
}
