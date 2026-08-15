const { app, BrowserWindow, session } = require('electron');
const path = require('path');

const appUserData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'electron-nest-react')
  : undefined;
if (appUserData) app.setPath('userData', appUserData);

const targetUrl = process.env.E2E_TIKTOK_URL || 'https://www.tiktok.com/@saraiqballl/video/7653276096569396513?is_from_webapp=1&sender_device=pc';

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function clickLikeOnce(win) {
  const target = await win.webContents.executeJavaScript(`
    (() => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
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
        '[data-e2e="browse-like-icon"]',
        '[data-e2e="like-icon"]',
        'button[aria-label*="like" i]',
        '[data-e2e*="like"]'
      ];
      for (const selector of selectors) {
        const node = Array.from(document.querySelectorAll(selector)).find(isVisible);
        if (!node) continue;
        const button = getClickableParent(node);
        const rect = button.getBoundingClientRect();
        return {
          found: true,
          x: Math.round(rect.left + rect.width / 2),
          y: Math.round(rect.top + rect.height / 2)
        };
      }
      return { found: false };
    })();
  `);
  if (!target.found) throw new Error('fixture like target not found');
  const zoomFactor = win.webContents.getZoomFactor();
  const x = Math.round(target.x * zoomFactor);
  const y = Math.round(target.y * zoomFactor);
  win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
  win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await delay(400);
}

async function getLiveTapTarget(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const el = document.querySelector('[data-e2e="live-player"], video, canvas, [data-e2e="room-chat-like-btn"]');
      if (!el) return { found: false };
      const rect = el.getBoundingClientRect();
      return {
        found: rect.width > 0 && rect.height > 0,
        x: Math.round(rect.left + rect.width * 0.5),
        y: Math.round(rect.top + rect.height * 0.52),
        target: el.getAttribute('data-e2e') || el.tagName.toLowerCase()
      };
    })();
  `);
}

async function clickLiveLikeRepeatedly(win, count) {
  for (let i = 0; i < count; i++) {
    const target = await getLiveTapTarget(win);
    if (!target.found) throw new Error('fixture live like target not found');
    const zoomFactor = win.webContents.getZoomFactor();
    const x = Math.round(target.x * zoomFactor);
    const y = Math.round(target.y * zoomFactor);
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await delay(120);
  }
}

async function runLocalActionFixture() {
  const win = new BrowserWindow({
    width: 640,
    height: 480,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
  });
  await win.loadFile(path.join(__dirname, 'fixtures', 'e2e-like-comment.html'));
  win.webContents.setZoomFactor(0.52);

  await clickLikeOnce(win);
  const likeState = await win.webContents.executeJavaScript(`({
    pressed: document.getElementById('like-button').getAttribute('aria-pressed'),
    clicks: window.__likeClicks
  })`);
  if (likeState.pressed !== 'true' || likeState.clicks !== 1) {
    throw new Error(`like fixture failed: ${JSON.stringify(likeState)}`);
  }

  await win.webContents.executeJavaScript(`
    (() => {
      const input = document.querySelector('[data-e2e="comment-input"]');
      input.value = 'E2E comment OK';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('[data-e2e="comment-post"]').click();
    })();
  `);
  const posted = await win.webContents.executeJavaScript('window.__postedComment');
  if (posted !== 'E2E comment OK') throw new Error(`comment fixture failed: ${posted}`);

  await clickLiveLikeRepeatedly(win, 6);
  const liveLikeClicks = await win.webContents.executeJavaScript('window.__liveLikeClicks');
  const liveScreenTaps = await win.webContents.executeJavaScript('window.__liveScreenTaps');
  if (liveScreenTaps !== 6 || liveLikeClicks !== 0) {
    throw new Error(`live screen tap fixture failed: surface=${liveScreenTaps}, button=${liveLikeClicks}`);
  }

  win.destroy();
}

async function runSixWindowRenderProbe() {
  let accounts = [];
  try {
    accounts = require(path.join(process.cwd(), 'data', 'accounts.json'));
  } catch (_) {}
  const selected = accounts.slice(0, 6);
  if (selected.length === 0) return { skipped: true, reason: 'No accounts found' };

  const windows = selected.map((account, index) => {
    const ses = session.fromPartition(`persist:tiktok_${account.id}`);
    ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    return {
      username: account.username,
      win: new BrowserWindow({
        width: 430,
        height: 320,
        x: 20 + (index % 3) * 450,
        y: 20 + Math.floor(index / 3) * 350,
        show: false,
        webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
      }),
    };
  });

  await Promise.all(windows.map(({ win }) => win.loadURL(targetUrl).catch(() => undefined)));
  await delay(12000);
  const results = [];
  for (const { username, win } of windows) {
    const snapshot = await win.webContents.executeJavaScript(`
      (() => {
        const bodyText = (document.body?.innerText || '').trim();
        return {
          href: location.href,
          title: document.title,
          readyState: document.readyState,
          bodyHtmlLength: document.body?.innerHTML?.length || 0,
          bodyTextLength: bodyText.length,
          videoCount: document.querySelectorAll('video').length,
          buttonCount: document.querySelectorAll('button').length
        };
      })();
    `).catch(err => ({ error: err.message || String(err) }));
    results.push({ username, snapshot });
    if ((snapshot.bodyHtmlLength || 0) < 1000 || (snapshot.videoCount || 0) < 1) {
      throw new Error(`TikTok render probe failed for ${username}: ${JSON.stringify(snapshot)}`);
    }
  }
  windows.forEach(({ win }) => !win.isDestroyed() && win.destroy());
  return { skipped: false, results };
}

app.whenReady().then(async () => {
  try {
    await runLocalActionFixture();
    const render = await runSixWindowRenderProbe();
    process.stdout.write('E2E like/comment fixture passed\n');
    if (render.skipped) {
      process.stdout.write(`E2E six-window render skipped: ${render.reason}\n`);
    } else {
      process.stdout.write(`E2E six-window TikTok render passed for ${render.results.length} accounts\n`);
    }
    app.quit();
  } catch (error) {
    console.error(error);
    app.exit(1);
  }
});
