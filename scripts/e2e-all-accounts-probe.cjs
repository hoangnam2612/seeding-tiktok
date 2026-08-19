const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const TARGET_URL = process.env.E2E_TIKTOK_URL || 'https://www.tiktok.com/@misspiggsy/video/7658119499597532430?is_from_webapp=1&sender_device=pc';
const ZOOM = Number(process.env.E2E_ZOOM || 0.52);
const WAIT_MS = Number(process.env.E2E_WAIT_MS || 18000);
const LOAD_TIMEOUT_MS = Number(process.env.E2E_LOAD_TIMEOUT_MS || 25000);
const INSPECT_TIMEOUT_MS = Number(process.env.E2E_INSPECT_TIMEOUT_MS || 5000);

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

function normalizeProxyProtocol(raw) {
  const value = String(raw || 'http').toLowerCase().replace(':', '');
  if (value === 'socks5' || value === 'socks4' || value === 'https' || value === 'http') return value;
  return 'http';
}

function parseProxy(rawProxy, proxyType) {
  const raw = String(rawProxy || '').trim();
  if (!raw) return null;

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

async function inspectWindow(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const bodyText = (document.body?.innerText || '').trim();
      const sampleText = bodyText.slice(0, 160).replace(/\\s+/g, ' ');
      const hasCaptcha = !!document.querySelector('iframe[src*="captcha"], iframe[src*="sec"], #captcha-verify-container, .sec-captcha-container, .captcha-modal') ||
        /drag the slider|fit the puzzle|rotate|verify to continue|security verification|captcha/i.test(bodyText);
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyHtmlLength: document.body?.innerHTML?.length || 0,
        bodyTextLength: bodyText.length,
        videoCount: document.querySelectorAll('video').length,
        buttonCount: document.querySelectorAll('button').length,
        hasVideo: Array.from(document.querySelectorAll('video, canvas')).some(isVisible),
        hasLike: Array.from(document.querySelectorAll('[data-e2e*="like"], button[aria-label*="like" i], span[aria-label*="like" i]')).some(isVisible),
        hasComment: Array.from(document.querySelectorAll('[data-e2e*="comment"], div[contenteditable], [role="textbox"], textarea')).some(isVisible),
        hasCaptcha,
        sampleText
      };
    })();
  `).catch(err => ({ error: err.message || String(err) }));
}

app.whenReady().then(async () => {
  const accounts = require(path.join(process.cwd(), 'data', 'accounts.json'));
  const windows = [];
  const results = [];

  console.log(`E2E_ALL_ACCOUNTS_START accounts=${accounts.length} url=${TARGET_URL}`);

  for (const [index, account] of accounts.entries()) {
    const ses = session.fromPartition(`persist:tiktok_${account.id}`);
    ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    const parsedProxy = parseProxy(account.proxy, account.proxyType);
    if (parsedProxy) {
      await ses.setProxy({ proxyRules: parsedProxy.proxyRules });
      if (parsedProxy.credentials) {
        ses.on('login', (event, _webContents, _authInfo, callback) => {
          event.preventDefault();
          callback(parsedProxy.credentials.username, parsedProxy.credentials.password);
        });
      }
    }

    const win = new BrowserWindow({
      width: 460,
      height: 340,
      x: 20 + (index % 3) * 480,
      y: 20 + Math.floor(index / 3) * 360,
      show: true,
      title: `E2E ${index + 1} ${account.username}`,
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setAudioMuted(true);
    win.webContents.setZoomFactor(ZOOM);

    windows.push({ account, win, hasProxy: !!parsedProxy });
  }

  await Promise.all(windows.map(async ({ account, win, hasProxy }) => {
    let loadError = null;
    const loadResult = await withTimeout(win.loadURL(TARGET_URL).then(() => 'loaded').catch(err => {
      const msg = err?.message || String(err);
      if (!msg.includes('ERR_ABORTED')) return msg;
      return 'aborted';
    }), LOAD_TIMEOUT_MS, 'timeout');
    if (loadResult !== 'loaded' && loadResult !== 'aborted') loadError = loadResult;
    results.push({ username: account.username, hasProxy, phase: 'loaded', loadError });
  }));

  await delay(WAIT_MS);

  for (const item of windows) {
    const snapshot = await withTimeout(inspectWindow(item.win), INSPECT_TIMEOUT_MS, { error: 'inspect-timeout' });
    const blank = !snapshot.error && (snapshot.bodyHtmlLength || 0) < 1000 && (snapshot.videoCount || 0) < 1;
    console.log(`E2E_ACCOUNT_RESULT ${JSON.stringify({
      username: item.account.username,
      hasProxy: item.hasProxy,
      blank,
      snapshot,
    })}`);
  }

  await delay(3000);
  windows.forEach(({ win }) => {
    if (!win.isDestroyed()) win.destroy();
  });
  console.log('E2E_ALL_ACCOUNTS_DONE');
  app.quit();
}).catch(error => {
  console.error('E2E_ALL_ACCOUNTS_FAILED', error);
  app.exit(1);
});
