const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const appUserData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'electron-nest-react')
  : undefined;
if (appUserData) app.setPath('userData', appUserData);

const targetUrl = process.env.E2E_TIKTOK_URL || 'https://www.tiktok.com/@ldngo83/live';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getAccount() {
  try {
    const accounts = require(path.join(process.cwd(), 'data', 'accounts.json'));
    return accounts[0] || { id: 'probe', username: 'probe' };
  } catch (_) {
    return { id: 'probe', username: 'probe' };
  }
}

app.whenReady().then(async () => {
  const account = getAccount();
  const ses = session.fromPartition(`persist:tiktok_${account.id}`);
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const win = new BrowserWindow({
    width: 960,
    height: 620,
    show: true,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });

  await win.loadURL(targetUrl).catch(err => {
    const msg = err?.message || String(err);
    if (!msg.includes('ERR_ABORTED')) throw err;
  });

  await delay(18000);

  const snapshot = await win.webContents.executeJavaScript(`
    (() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const bodyText = (document.body?.innerText || '').trim();
      return {
        href: location.href,
        title: document.title,
        readyState: document.readyState,
        bodyHtmlLength: document.body?.innerHTML?.length || 0,
        bodyTextLength: bodyText.length,
        hasVideo: Array.from(document.querySelectorAll('video, canvas')).some(isVisible),
        hasLiveChat: Array.from(document.querySelectorAll('[data-e2e="room-chat-input-field"], [data-e2e*="room-chat"], [role="textbox"], div[contenteditable]')).some(isVisible),
        hasLiveLike: Array.from(document.querySelectorAll('[data-e2e="room-chat-like-btn"], [aria-label*="like" i], [data-e2e*="like"]')).some(isVisible),
        sampleText: bodyText.slice(0, 300)
      };
    })();
  `);

  process.stdout.write(`REAL_LIVE_PROBE ${JSON.stringify(snapshot, null, 2)}\\n`);
  await delay(12000);
  win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
