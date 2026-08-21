const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

const TARGET_URL = process.env.E2E_TIKTOK_URL || 'https://www.tiktok.com/@misspiggsy/video/7658119499597532430?is_from_webapp=1&sender_device=pc';
const WAIT_MS = Number(process.env.E2E_WAIT_MS || 16000);
const LOAD_TIMEOUT_MS = Number(process.env.E2E_LOAD_TIMEOUT_MS || 30000);
const INSPECT_TIMEOUT_MS = Number(process.env.E2E_INSPECT_TIMEOUT_MS || 8000);
const SHOW_WINDOWS = process.env.E2E_SHOW_WINDOWS !== '0';
const INJECT_ACCOUNT_COOKIES = process.env.E2E_INJECT_ACCOUNT_COOKIES === '1';

const appUserData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'electron-nest-react')
  : undefined;
if (appUserData) app.setPath('userData', appUserData);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, fallback) {
  return Promise.race([
    promise,
    delay(ms).then(() => fallback),
  ]);
}

function getAccounts() {
  const accountsPath = process.env.E2E_ACCOUNTS_FILE ||
    path.join(app.getPath('userData'), 'data', 'accounts.json');
  if (!fs.existsSync(accountsPath)) return [];
  return JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
}

function normalizeProxyProtocol(raw) {
  const value = String(raw || 'http').toLowerCase().replace(':', '');
  if (value === 'socks5' || value === 'socks4' || value === 'https' || value === 'http') return value;
  return 'http';
}

function parseProxy(rawProxy, proxyType) {
  const raw = String(rawProxy || '').trim();
  if (!raw || proxyType === 'none') return null;

  const protocol = normalizeProxyProtocol(proxyType);
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `${protocol}://${raw}`;

  try {
    const url = new URL(withScheme);
    return {
      proxyRules: `${normalizeProxyProtocol(url.protocol)}://${url.hostname}:${url.port}`,
      credentials: url.username ? {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password || ''),
      } : null,
    };
  } catch (_) {
    const parts = raw.replace(/^[a-z]+:\/\//i, '').split(':');
    if (parts.length >= 4) {
      const [host, port, username, ...passParts] = parts;
      return {
        proxyRules: `${protocol}://${host}:${port}`,
        credentials: { username, password: passParts.join(':') },
      };
    }
    if (parts.length >= 2) {
      const [host, port] = parts;
      return { proxyRules: `${protocol}://${host}:${port}`, credentials: null };
    }
  }
  return null;
}

function parseCookieString(cookieStr) {
  return String(cookieStr || '')
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const eq = part.indexOf('=');
      if (eq <= 0) return null;
      return { name: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() };
    })
    .filter(cookie => cookie?.name && cookie?.value && !/[\r\n;]/.test(cookie.name) && !/[\r\n;]/.test(cookie.value));
}

function isAuthCookie(cookie) {
  return ['sessionid', 'sessionid_ss', 'sid_tt'].includes(cookie.name);
}

async function countSessionCookies(ses) {
  const cookies = await ses.cookies.get({}).catch(() => []);
  return cookies.filter(cookie => {
    const domain = String(cookie.domain || '').toLowerCase();
    return domain.includes('tiktok.com') && isAuthCookie(cookie);
  }).length;
}

async function injectTikTokCookies(ses, cookieStr) {
  const cookies = parseCookieString(cookieStr);
  let injected = 0;

  for (const cookie of cookies) {
    const base = {
      url: 'https://www.tiktok.com',
      name: cookie.name,
      value: cookie.value,
      path: '/',
      secure: true,
    };
    const candidates = cookie.name.startsWith('__Host-')
      ? [base]
      : [{ ...base, domain: '.tiktok.com', sameSite: 'no_restriction' }, base];

    for (const candidate of candidates) {
      try {
        await ses.cookies.set(candidate);
        injected++;
        break;
      } catch (_) {}
    }
  }

  return { parsed: cookies.length, injected };
}

async function inspectAuthState(win) {
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
        const body = (document.body?.innerText || '').trim();
        return {
          href: location.href,
          title: document.title,
          readyState: document.readyState,
          bodyHtmlLength: document.body?.innerHTML?.length || 0,
          bodyTextLength: body.length,
          videoCount: document.querySelectorAll('video').length,
          buttonCount: document.querySelectorAll('button').length,
          hasLoginButton,
          hasLoginToComment,
          hasLoginForm,
          hasLoginModal,
          hasLoggedInSignal,
          loggedOut,
          sampleText: body.slice(0, 220).replace(/\\s+/g, ' ')
        };
      } catch(e) {
        return { error: String(e) };
      }
    })();
  `);
}

app.whenReady().then(async () => {
  const accounts = getAccounts();
  console.log(`E2E_AUTH_STATE_START accounts=${accounts.length} url=${TARGET_URL}`);

  const windows = [];
  for (const [index, account] of accounts.entries()) {
    const ses = session.fromPartition(`persist:tiktok_${account.id}`);
    ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const proxy = parseProxy(account.proxy, account.proxyType);
    if (proxy) {
      await ses.setProxy({ proxyRules: proxy.proxyRules });
      if (proxy.credentials) {
        ses.on('login', (event, _webContents, authInfo, callback) => {
          if (authInfo.isProxy) {
            event.preventDefault();
            callback(proxy.credentials.username, proxy.credentials.password);
          }
        });
      }
    } else {
      await ses.setProxy({ proxyRules: '' }).catch(() => undefined);
    }

    const sessionCookiesBefore = await countSessionCookies(ses);
    const injected = INJECT_ACCOUNT_COOKIES
      ? await injectTikTokCookies(ses, account.cookie)
      : { parsed: parseCookieString(account.cookie).length, injected: 0 };
    const sessionCookiesAfterInject = await countSessionCookies(ses);

    const win = new BrowserWindow({
      width: 520,
      height: 390,
      x: 20 + (index % 3) * 540,
      y: 20 + Math.floor(index / 3) * 420,
      show: SHOW_WINDOWS,
      title: `Auth E2E ${index + 1} ${account.username}`,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setZoomFactor(0.52);
    windows.push({ account, win, proxy, sessionCookiesBefore, injected, sessionCookiesAfterInject });
  }

  await Promise.all(windows.map(async item => {
    const loadResult = await withTimeout(
      item.win.loadURL(TARGET_URL).then(() => 'loaded').catch(error => {
        const msg = error?.message || String(error);
        return msg.includes('ERR_ABORTED') ? 'aborted' : msg;
      }),
      LOAD_TIMEOUT_MS,
      'timeout'
    );
    item.loadResult = loadResult;
  }));

  await delay(WAIT_MS);

  let loggedOutCount = 0;
  for (const item of windows) {
    const snapshot = await withTimeout(inspectAuthState(item.win), INSPECT_TIMEOUT_MS, { error: 'inspect-timeout' });
    const sessionCookiesAfterLoad = await countSessionCookies(item.win.webContents.session);
    if (snapshot?.loggedOut) loggedOutCount++;

    console.log(`E2E_AUTH_STATE_RESULT ${JSON.stringify({
      username: item.account.username,
      status: item.account.status,
      hasProxy: !!item.proxy,
      loadResult: item.loadResult,
      sessionCookiesBefore: item.sessionCookiesBefore,
      accountCookieKeys: item.injected.parsed,
      injectedCookieKeys: item.injected.injected,
      sessionCookiesAfterInject: item.sessionCookiesAfterInject,
      sessionCookiesAfterLoad,
      snapshot,
    })}`);
  }

  windows.forEach(({ win }) => {
    if (!win.isDestroyed()) win.destroy();
  });

  console.log(`E2E_AUTH_STATE_DONE loggedOut=${loggedOutCount}/${windows.length}`);
  app.quit();
}).catch(error => {
  console.error('E2E_AUTH_STATE_FAILED', error);
  app.exit(1);
});
