import { BrowserWindow } from 'electron';
import { TaskLogItem } from '../nest/automation/automation.interface';

export type AccountSessionUpdate = {
  cookie: string;
  status: 'authenticated';
  lastUsed: string;
};

export type ProxyAuthCredentials = {
  username: string;
  password: string;
};

export type ParsedProxyConfig = {
  proxyRules: string;
  auth?: ProxyAuthCredentials;
};

export function hasValidTikTokCookieString(cookieStr?: string): boolean {
  if (!cookieStr) return false;
  const lowerCookie = cookieStr.toLowerCase();
  return lowerCookie.includes('sessionid=') ||
         lowerCookie.includes('sessionid_ss=') ||
         lowerCookie.includes('sid_tt=');
}

export function isTikTokCookie(cookie: Electron.Cookie): boolean {
  const domain = (cookie.domain || '').toLowerCase();
  return domain === 'tiktok.com' ||
         domain === '.tiktok.com' ||
         domain.endsWith('.tiktok.com') ||
         domain.includes('tiktok.com');
}

export function hasTikTokSessionCookie(cookies: Electron.Cookie[]): boolean {
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

export async function persistTikTokSessionCookies(
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

export function attachProxyAuthHandler(win: BrowserWindow, auth?: ProxyAuthCredentials) {
  if (!auth) return;

  win.webContents.on('login', (event, _request, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    event.preventDefault();
    callback(auth.username, auth.password);
  });
}

export async function configureSessionProxyAndCookies(
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
