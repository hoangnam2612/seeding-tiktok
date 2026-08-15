const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const appUserData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'electron-nest-react')
  : undefined;
if (appUserData) app.setPath('userData', appUserData);

const targetUrl = process.env.E2E_TIKTOK_URL || 'https://www.tiktok.com/@ldngo83/live';
const tapSeconds = Number(process.env.E2E_LIVE_TAP_SECONDS || 30);

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

async function activateLiveUi(win) {
  await win.webContents.executeJavaScript(`
    (() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const input = Array.from(document.querySelectorAll(
        '[data-e2e="room-chat-input-field"], [data-e2e*="room-chat"], [role="textbox"], div[contenteditable], textarea, input[type="text"]'
      )).find(isVisible);
      if (input) {
        input.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        input.click();
        input.focus?.();
      }
    })();
  `).catch(() => undefined);
  await delay(300);
  await win.webContents.executeJavaScript(`
    (() => {
      try {
        const active = document.activeElement;
        if (active && active.blur) active.blur();
      } catch(e) {}
    })();
  `).catch(() => undefined);
}

async function getLiveTapPoint(win, preferButton = false) {
  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const preferButton = ${preferButton ? 'true' : 'false'};
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
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
                   label.includes('thích') ||
                   label.includes('tap');
          });
        };
        if (preferButton) {
          const button = findRoomLikeButton();
          if (button) {
            const rect = button.getBoundingClientRect();
            return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'room-like-btn' };
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
            found: true,
            x: Math.round(rect.left + rect.width * 0.5),
            y: Math.round(rect.top + rect.height * 0.52),
            target: surface.tagName?.toLowerCase() === 'video' ? 'live-video' : 'live-surface'
          };
        }
        const button = findRoomLikeButton();
        if (button) {
          const rect = button.getBoundingClientRect();
          return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), target: 'room-like-btn' };
        }
        const width = window.innerWidth || document.documentElement.clientWidth || 800;
        const height = window.innerHeight || document.documentElement.clientHeight || 600;
        return { found: true, x: Math.round(width * 0.42), y: Math.round(height * 0.5), target: 'screen-fallback' };
      } catch(e) {
        return { found: false, error: String(e) };
      }
    })();
  `);
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

  await delay(15000);
  await activateLiveUi(win);

  const endAt = Date.now() + tapSeconds * 1000;
  let tapCount = 0;
  const targets = {};

  while (Date.now() < endAt && !win.isDestroyed()) {
    const point = await getLiveTapPoint(win, tapCount % 4 === 3);
    if (point && point.found) {
      const zoom = win.webContents.getZoomFactor();
      const x = Math.max(1, Math.round(point.x * zoom));
      const y = Math.max(1, Math.round(point.y * zoom));
      win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
      win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
      win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
      targets[point.target || 'unknown'] = (targets[point.target || 'unknown'] || 0) + 1;
      tapCount++;
    }
    await delay(90 + Math.random() * 60);
  }

  process.stdout.write(`REAL_LIVE_TAP_DONE ${JSON.stringify({ targetUrl, tapSeconds, tapCount, targets }, null, 2)}\\n`);
  await delay(5000);
  win.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
