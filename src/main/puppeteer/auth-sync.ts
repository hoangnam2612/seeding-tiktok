import { Page } from 'puppeteer-core';
import { AccountSessionUpdate } from '../automation/session-profile';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { AccountStatus } from '../automation/types';

export interface TikTokPassportUserInfo {
  isLoggedIn: boolean;
  username?: string;
  nickname?: string;
  avatarUrl?: string;
  userId?: string;
  secUid?: string;
}

/**
 * Parse a raw cookie header string into Puppeteer cookie objects
 */
export function parseCookieStringToPuppeteer(cookieStr: string, defaultDomain = '.tiktok.com'): Array<{
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly?: boolean;
  secure?: boolean;
}> {
  if (!cookieStr || typeof cookieStr !== 'string') return [];

  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    httpOnly?: boolean;
    secure?: boolean;
  }> = [];

  const pairs = cookieStr.split(';');
  for (const rawPair of pairs) {
    const trimmed = rawPair.trim();
    if (!trimmed) continue;

    const equalIndex = trimmed.indexOf('=');
    if (equalIndex <= 0) continue;

    const name = trimmed.substring(0, equalIndex).trim();
    const value = trimmed.substring(equalIndex + 1).trim();

    if (!name) continue;

    cookies.push({
      name,
      value,
      domain: defaultDomain,
      path: '/',
      secure: true,
    });
  }

  return cookies;
}

/**
 * Inject cookies into Puppeteer Page
 */
export async function injectCookiesIntoPuppeteerPage(page: Page, cookieStr: string): Promise<boolean> {
  if (!cookieStr) return false;

  try {
    const cookies = parseCookieStringToPuppeteer(cookieStr);
    if (cookies.length > 0) {
      await page.setCookie(...(cookies as any));
      return true;
    }
  } catch (err) {
    console.error('[PuppeteerAuth] Failed to set cookies:', err);
  }
  return false;
}

/**
 * Extract all TikTok cookies from the browser session and serialize into a standard cookie string.
 */
export async function extractTikTokCookieString(page: Page): Promise<string> {
  try {
    const cookies = await page.cookies('https://www.tiktok.com', 'https://tiktok.com');
    const priorityNames = new Set(['sessionid', 'sessionid_ss', 'sid_tt', 'uid_tt', 'uid_tt_ss', 'sid_guard']);

    const validCookies = cookies.filter(c => {
      const dom = (c.domain || '').toLowerCase();
      return dom.includes('tiktok.com');
    });

    validCookies.sort((a, b) => {
      const aP = priorityNames.has(a.name) ? 0 : 1;
      const bP = priorityNames.has(b.name) ? 0 : 1;
      return aP - bP || a.name.localeCompare(b.name);
    });

    const uniqueMap = new Map<string, string>();
    for (const c of validCookies) {
      if (c.name && typeof c.value === 'string') {
        uniqueMap.set(c.name, c.value);
      }
    }

    return Array.from(uniqueMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  } catch (err) {
    console.error('[PuppeteerAuth] Failed to extract cookies:', err);
    return '';
  }
}

/**
 * Checks if current page/session is logged into TikTok using TikTok's internal passport API (same as MKT TIKPRO)
 */
export async function checkTikTokLoginStatusViaApi(page: Page): Promise<TikTokPassportUserInfo> {
  if (page.isClosed()) {
    return { isLoggedIn: false };
  }

  try {
    const result = await page.evaluate(async () => {
      try {
        const url =
          'https://www.tiktok.com/passport/web/account/info/?aid=1459&app_language=vi-VN&app_name=tiktok_web&battery_info=1&browser_language=vi-VN&browser_name=Mozilla&browser_online=true&browser_platform=Win32&channel=tiktok_web&cookie_enabled=true&device_platform=web_pc&focus_state=true&from_page=fyp&history_len=13&is_fullscreen=false&is_page_visible=true&os=windows';
        const res = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
          credentials: 'include',
        });
        const json = await res.json();
        if (json && (json.message === 'success' || json.data?.user_id)) {
          return {
            isLoggedIn: true,
            username: json.data?.username || '',
            nickname: json.data?.screen_name || '',
            avatarUrl: json.data?.avatar_url || '',
            userId: json.data?.user_id || '',
            secUid: json.data?.sec_user_id || '',
          };
        }
      } catch {}

      // Fallback: check DOM elements indicative of logged in state
      try {
        const hasUserAvatar = !!document.querySelector(
          '[data-e2e="profile-icon"], #header-more-menu-avatar, [class*="AvatarContainer"], [class*="DivAvatar"]'
        );
        const hasUploadBtn = !!document.querySelector('[data-e2e="upload-icon"], a[href*="/upload"]');
        if (hasUserAvatar || hasUploadBtn) {
          return { isLoggedIn: true };
        }
      } catch {}

      return { isLoggedIn: false };
    });

    return result || { isLoggedIn: false };
  } catch {
    return { isLoggedIn: false };
  }
}

/**
 * Start a background monitoring loop that watches for login success or cookie updates while the Chrome window is open.
 */
export function startLoginMonitor(
  page: Page,
  accountId: string,
  accountUsername: string | undefined,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
) {
  let isChecking = false;
  let alreadyNotifiedSuccess = false;

  const interval = setInterval(async () => {
    if (page.isClosed() || isChecking) return;
    isChecking = true;

    try {
      const loginInfo = await checkTikTokLoginStatusViaApi(page);

      if (loginInfo.isLoggedIn) {
        const newCookies = await extractTikTokCookieString(page);
        const hasSessionId = newCookies.includes('sessionid=') || newCookies.includes('sid_tt=');

        if (hasSessionId) {
          onAccountSessionUpdate(accountId, {
            cookie: newCookies,
            status: 'authenticated',
            lastUsed: new Date().toISOString(),
          });
          onAccountStatusChange(accountId, 'authenticated');

          if (!alreadyNotifiedSuccess) {
            alreadyNotifiedSuccess = true;
            onLog({
              accountId,
              accountUsername: loginInfo.username || accountUsername,
              level: 'success',
              message: `✅ @${loginInfo.username || accountUsername || accountId} đã đăng nhập thành công! Cookie đã được lưu.`,
            });
          }
        }
      }
    } catch {
      // Ignore background check errors
    } finally {
      isChecking = false;
    }
  }, 4000);

  page.on('close', () => {
    clearInterval(interval);
  });
}
