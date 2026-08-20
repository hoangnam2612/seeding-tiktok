const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const path = require('path');

if (process.env.E2E_VIDEO_COMMENT_RUN !== '1') {
  app.whenReady().then(() => app.quit());
  return;
}

const appUserData = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'electron-nest-react')
  : undefined;
if (appUserData) app.setPath('userData', appUserData);

const TARGET_URL = process.env.E2E_TIKTOK_URL ||
  'https://www.tiktok.com/@nhannai79/video/7645912264507198740?is_from_webapp=1&sender_device=pc';
const COMMENT_PREFIX = process.env.E2E_COMMENT_PREFIX || 'Hay qua';
const MAX_CONCURRENT = Number(process.env.E2E_MAX_THREADS || 3);
const ONLY_INDEX = process.env.E2E_ACCOUNT_INDEX ? Number(process.env.E2E_ACCOUNT_INDEX) : null;
const ONLY_INDEXES = process.env.E2E_ACCOUNT_INDEXES
  ? process.env.E2E_ACCOUNT_INDEXES.split(',').map(value => Number(value.trim())).filter(Number.isInteger)
  : null;
const ZOOM = 0.52;
const RUN_ID = Date.now().toString(36);
const FULL_DEBUG = process.env.E2E_DEBUG_FULL === '1';
const LOAD_URL_TIMEOUT_MS = Number(process.env.E2E_LOAD_URL_TIMEOUT_MS || 30000);

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
  const accountsPath = path.join(process.cwd(), 'data', 'accounts.json');
  if (!fs.existsSync(accountsPath)) return [];
  return JSON.parse(fs.readFileSync(accountsPath, 'utf-8'));
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
    .filter(Boolean);
}

function normalizeProxyProtocol(raw) {
  const value = String(raw || 'http').toLowerCase().replace(':', '');
  if (value === 'socks5' || value === 'socks4' || value === 'https' || value === 'http') return value;
  return 'http';
}

function parseProxy(proxy, proxyType) {
  const raw = String(proxy || '').trim();
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
  } catch {
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

async function configureAccountProxy(ses, account) {
  const proxy = parseProxy(account.proxy, account.proxyType);
  if (!proxy || account.proxyType === 'none') return null;
  await ses.setProxy({ proxyRules: proxy.proxyRules });
  return proxy;
}

async function injectTikTokCookies(ses, cookieStr) {
  const cookies = parseCookieString(cookieStr);
  for (const cookie of cookies) {
    try {
      await ses.cookies.set({
        url: 'https://www.tiktok.com',
        domain: '.tiktok.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'no_restriction',
        name: cookie.name,
        value: cookie.value,
      });
    } catch {}
  }
  return cookies.length;
}

async function cdpClick(win, x, y) {
  if (!win.webContents.debugger.isAttached()) {
    try { win.webContents.debugger.attach('1.3'); } catch {}
  }
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }).catch(() => {});
  await delay(60);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  }).catch(() => {});
  await delay(80);
  await win.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    buttons: 0,
  }).catch(() => {});
  await delay(250);
}

async function zoomAwareClick(win, x, y) {
  const zoom = win.webContents.getZoomFactor() || 1;
  const clickX = Math.max(1, Math.round(x * zoom));
  const clickY = Math.max(1, Math.round(y * zoom));
  win.webContents.sendInputEvent({ type: 'mouseMove', x: clickX, y: clickY });
  win.webContents.sendInputEvent({ type: 'mouseDown', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  win.webContents.sendInputEvent({ type: 'mouseUp', x: clickX, y: clickY, button: 'left', clickCount: 1 });
  await delay(300);
}

async function reliableClick(win, x, y) {
  await zoomAwareClick(win, x, y).catch(() => {});
}

async function cdpInsertText(win, text) {
  if (!win.webContents.debugger.isAttached()) {
    try { win.webContents.debugger.attach('1.3'); } catch {}
  }
  await win.webContents.debugger.sendCommand('Input.insertText', { text });
}

async function ensureCommentTextInInput(win, text) {
  return win.webContents.executeJavaScript(`
    (() => {
      const expectedText = ${JSON.stringify(text)};
      const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const selectors = [
        '[data-e2e="comment-input"] [contenteditable]',
        '[data-e2e="comment-input"] [role="textbox"]',
        '[data-e2e="comment-input-area"] [contenteditable]',
        'div[contenteditable="true"]',
        'div[contenteditable="plaintext-only"]',
        '[role="textbox"]',
        'textarea'
      ];
      const inputs = selectors
        .flatMap(sel => Array.from(document.querySelectorAll(sel)))
        .filter(isVisible);
      const target = inputs[inputs.length - 1];
      if (!target) return { success: false, reason: 'no-visible-editable' };
      const current = normalize(target.value || target.innerText || target.textContent);
      if (current.includes(expectedText)) return { success: true, method: 'already-present' };
      target.focus();
      target.click();
      if ('value' in target) {
        target.value = expectedText;
      } else {
        target.textContent = expectedText;
      }
      let after = normalize(target.value || target.innerText || target.textContent);
      if (!after.includes(expectedText)) {
        if ('value' in target) {
          target.value = expectedText;
        } else {
          target.textContent = expectedText;
        }
      }
      try { window.getSelection()?.removeAllRanges(); } catch {}
      for (const eventName of ['beforeinput', 'input', 'change', 'keyup']) {
        try {
          if (eventName === 'beforeinput' || eventName === 'input') {
            target.dispatchEvent(new InputEvent(eventName, {
              bubbles: true,
              cancelable: true,
              inputType: 'insertText',
              data: expectedText
            }));
          } else {
            target.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
          }
        } catch {
          target.dispatchEvent(new Event(eventName, { bubbles: true, cancelable: true }));
        }
      }
      after = normalize(target.value || target.innerText || target.textContent);
      return { success: after.includes(expectedText), method: 'dom-inputevent', after };
    })();
  `);
}

async function focusCommentInput(win) {
  return win.webContents.executeJavaScript(`
    (async () => {
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const getCommentPane = () => {
        const selectors = [
          '[data-e2e="video-detail-container"]',
          'div[class*="DivRightContainer"]',
          'div[class*="DivContentContainer"]',
          'div[class*="DivCommentContainer"]',
          'div[class*="CommentContainer"]',
          'div[class*="CommentListContainer"]'
        ];
        return selectors
          .flatMap(sel => Array.from(document.querySelectorAll(sel)))
          .filter(isVisible)
          .map(el => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width >= 180 && rect.left > window.innerWidth * 0.45)
          .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.el || null;
      };
      const clickCommentsTab = (allowDocumentFallback = false) => {
        const pane = getCommentPane();
        if (!pane && !allowDocumentFallback) return false;
        const scope = pane || document;
        const tab = Array.from(scope.querySelectorAll('button, [role="tab"], [role="button"], div, span, p'))
          .filter(isVisible)
          .find(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 320 || rect.height > 90) return false;
            if (!pane && rect.left < window.innerWidth * 0.45) return false;
            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
            return text === 'comments' || text === 'comment' || text === 'bình luận' || text === 'binh luan' || text.includes('comments') || text.includes('bình luận');
          });
        if (!tab) return false;
        (tab.closest('button') || tab.closest('[role="tab"]') || tab.closest('[role="button"]') || tab).click();
        return true;
      };
      const openFeedCommentDrawer = async () => {
        const isFeedLayout = Array.from(document.querySelectorAll(
          '[data-e2e="feed-video"], [data-e2e="recommend-list-item-container"], [class*="DivFeedVideo"], [class*="FeedVideo"]'
        )).some(isVisible);
        if (!isFeedLayout || getCommentPane()) return false;
        const getClickableParent = (el) => {
          let cur = el;
          for (let i = 0; i < 8 && cur; i++) {
            const tag = cur.tagName?.toLowerCase();
            const role = cur.getAttribute?.('role');
            const style = window.getComputedStyle(cur);
            if (tag === 'button' || role === 'button' || typeof cur.onclick === 'function' || style.cursor === 'pointer') return cur;
            cur = cur.parentElement;
          }
          return el;
        };
        const iconSelectors = [
          '[data-e2e="comment-icon"]',
          '[data-e2e="browse-comment-icon"]',
          '[data-e2e="feed-comment-icon"]',
          '[data-e2e="video-comment-icon"]',
          'button[aria-label*="comment" i]',
          'button[aria-label*="bình luận" i]',
          '[role="button"][aria-label*="comment" i]',
          '[role="button"][aria-label*="bình luận" i]',
          'strong[data-e2e*="comment-count"]'
        ];
        const candidates = iconSelectors
          .flatMap(sel => Array.from(document.querySelectorAll(sel)))
          .filter(isVisible)
          .map(getClickableParent)
          .filter(Boolean)
          .filter((el, index, arr) => arr.indexOf(el) === index)
          .map(el => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width <= 130 && rect.height <= 130 && rect.left > window.innerWidth * 0.45)
          .sort((a, b) => b.rect.left - a.rect.left);
        if (candidates.length === 0) return false;
        candidates[0].el.click();
        await new Promise(r => setTimeout(r, 1200));
        clickCommentsTab(true);
        await new Promise(r => setTimeout(r, 700));
        return true;
      };
      const findInput = () => {
        const selectors = [
          '[data-e2e="comment-input"]',
          'div[contenteditable="true"]',
          'div[contenteditable="plaintext-only"]',
          'div[contenteditable]',
          '[role="textbox"]',
          '[data-e2e="comment-input-area"]',
          'div[class*="BottomCommentContainer"]',
          'div[class*="DivCommentInput"]',
          'div[class*="InputArea"]',
          'div[class*="CommentInput"]',
          'textarea'
        ];
        for (const sel of selectors) {
          const matches = Array.from(document.querySelectorAll(sel)).filter(isVisible);
          if (matches.length > 0) return matches[matches.length - 1];
        }
        return null;
      };

      const debug = () => ({
        title: document.title,
        url: location.href,
        bodyText: (document.body?.innerText || '').slice(0, ${FULL_DEBUG ? 900 : 300}),
        inputLike: Array.from(document.querySelectorAll('input, textarea, div[contenteditable], [role="textbox"], [placeholder], [data-placeholder], [aria-label]'))
          .filter(isVisible)
          .slice(0, ${FULL_DEBUG ? 80 : 18})
          .map(el => ({
            tag: el.tagName,
            e2e: el.getAttribute('data-e2e') || '',
            role: el.getAttribute('role') || '',
            ce: el.getAttribute('contenteditable') || '',
            ph: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '',
            text: (el.value || el.innerText || el.textContent || '').trim().slice(0, 80),
            rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()
          })),
        commentTabCandidates: Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span, p'))
          .filter(isVisible)
          .filter(el => {
            const rect = el.getBoundingClientRect();
            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
            return rect.left > window.innerWidth * 0.4 && rect.width <= 360 && rect.height <= 110 && (text.includes('comments') || text.includes('comment') || text.includes('bình luận'));
          })
          .slice(0, ${FULL_DEBUG ? 40 : 12})
          .map(el => ({
            tag: el.tagName,
            role: el.getAttribute('role') || '',
            text: (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 80),
            rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()
          })),
        e2e: Array.from(document.querySelectorAll('[data-e2e]')).slice(0, ${FULL_DEBUG ? 80 : 25}).map(el => ({
          e2e: el.getAttribute('data-e2e'),
          text: (el.innerText || el.textContent || '').trim().slice(0, 80),
          rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()
        }))
      });
      const pane = getCommentPane();
      if (!pane) {
        const openedFeedDrawer = await openFeedCommentDrawer();
        if (!openedFeedDrawer) {
          return { success: false, reason: 'missing-right-comment-pane', width: window.innerWidth, height: window.innerHeight, debug: debug() };
        }
      } else {
        clickCommentsTab();
        await new Promise(r => setTimeout(r, 800));
      }
      const scrollers = document.querySelectorAll('[data-e2e="video-detail-container"], div[class*="CommentContainer"], div[class*="DivCommentListContainer"], div[class*="DivRightContainer"], div[class*="DivContentContainer"]');
      scrollers.forEach(el => { try { el.scrollTop = el.scrollHeight; } catch {} });
      let input = findInput();
      const inputDeadline = Date.now() + 8000;
      while (!input && Date.now() < inputDeadline) {
        await new Promise(r => setTimeout(r, 500));
        input = findInput();
      }
      if (!input) return { success: false, reason: 'missing-comment-input', width: window.innerWidth, height: window.innerHeight, debug: debug() };
      input.scrollIntoView({ behavior: 'instant', block: 'center' });
      await new Promise(r => setTimeout(r, 150));
      const editable = input.getAttribute('contenteditable') ? input : (input.querySelector('[contenteditable], [role="textbox"], textarea, input') || input);
      editable.click();
      editable.focus();
      try { window.getSelection()?.removeAllRanges(); } catch {}
      const rect = editable.getBoundingClientRect();
      return {
        success: true,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + Math.max(12, Math.min(rect.height / 2, rect.height - 8))),
        width: window.innerWidth,
        height: window.innerHeight
      };
    })();
  `);
}

async function getFeedCommentClickTarget(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const hasCommentPane = Array.from(document.querySelectorAll(
          '[data-e2e="video-detail-container"], div[class*="DivRightContainer"], div[class*="DivContentContainer"], div[class*="DivCommentContainer"], div[class*="CommentContainer"], div[class*="CommentListContainer"]'
        )).filter(isVisible).some(el => {
          const rect = el.getBoundingClientRect();
          return rect.width >= 180 && rect.left > window.innerWidth * 0.45;
        });
        if (hasCommentPane) return null;
        const isFeedLayout = Array.from(document.querySelectorAll(
          '[data-e2e="feed-video"], [data-e2e="recommend-list-item-container"], [class*="DivFeedVideo"], [class*="FeedVideo"]'
        )).some(isVisible);
        if (!isFeedLayout) return null;
        const selectors = [
          '[data-e2e="comment-icon"]',
          '[data-e2e="browse-comment-icon"]',
          '[data-e2e="feed-comment-icon"]',
          '[data-e2e="video-comment-icon"]',
          'button[aria-label*="comment" i]',
          'button[aria-label*="bình luận" i]',
          '[role="button"][aria-label*="comment" i]',
          '[role="button"][aria-label*="bình luận" i]'
        ];
        const candidates = selectors
          .flatMap(sel => Array.from(document.querySelectorAll(sel)))
          .filter(isVisible)
          .map(el => {
            const clickable = el.closest('button') || el.closest('[role="button"]') || el;
            const rect = clickable.getBoundingClientRect();
            return { rect };
          })
          .filter(({ rect }) => rect.width <= 130 && rect.height <= 130 && rect.left > window.innerWidth * 0.45 && rect.top >= 0 && rect.top < window.innerHeight)
          .sort((a, b) => a.rect.top - b.rect.top);
        const target = candidates[0];
        if (!target) return null;
        return {
          x: Math.round(target.rect.left + target.rect.width / 2),
          y: Math.round(target.rect.top + target.rect.height / 2)
        };
      } catch {
        return null;
      }
    })();
  `);
}

async function getVisibleCommentsTabTarget(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      try {
        const isVisible = (el) => {
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
        };
        const candidates = Array.from(document.querySelectorAll('button, [role="tab"], [role="button"], div, span, p'))
          .filter(isVisible)
          .map(el => {
            const text = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
            const rect = el.getBoundingClientRect();
            const clickable = el.closest('button') || el.closest('[role="tab"]') || el.closest('[role="button"]') || el;
            const clickableRect = clickable.getBoundingClientRect();
            return { text, rect, clickableRect };
          })
          .filter(({ text, rect }) => {
            if (rect.width > 360 || rect.height > 110) return false;
            if (rect.left < window.innerWidth * 0.4) return false;
            return text === 'comments' ||
              text === 'comment' ||
              text === 'bình luận' ||
              text === 'binh luan' ||
              text.includes('comments') ||
              text.includes('bình luận');
          })
          .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left);
        const target = candidates[0];
        if (!target) return null;
        return {
          x: Math.round(target.clickableRect.left + target.clickableRect.width / 2),
          y: Math.round(target.clickableRect.top + target.clickableRect.height / 2),
          text: target.text
        };
      } catch {
        return null;
      }
    })();
  `);
}

async function waitForTikTokSurface(win) {
  const deadline = Date.now() + 55000;
  let lastState = null;
  let reloadAt = Date.now() + 18000;
  while (Date.now() < deadline) {
    lastState = await withTimeout(
      win.webContents.executeJavaScript(`
        (() => {
          const text = (document.body?.innerText || '').trim();
          const hasFeed = !!document.querySelector('[data-e2e="feed-video"], [data-e2e="recommend-list-item-container"]');
          const hasCommentIcon = !!document.querySelector('[data-e2e="comment-icon"], [aria-label*="comment" i], [aria-label*="bình luận" i]');
          const needsLogin = /\\bLog in\\b|Đăng nhập|to comment/i.test(text);
          return {
            title: document.title || '',
            url: location.href,
            bodyText: text.slice(0, 120),
            hasFeed,
            hasCommentIcon,
            needsLogin
          };
        })();
      `).catch(error => ({ error: String(error) })),
      5000,
      { error: 'surface-inspect-timeout' }
    );

    if (lastState?.hasCommentIcon || (lastState?.hasFeed && lastState.bodyText.length > 80)) {
      return { success: true, state: lastState };
    }
    if (lastState?.needsLogin) return { success: false, reason: 'login-required', state: lastState };

    if (Date.now() >= reloadAt) {
      await win.webContents.reloadIgnoringCache();
      reloadAt = Date.now() + 18000;
    }
    await delay(1000);
  }
  return { success: false, reason: 'surface-timeout', state: lastState };
}

async function submitAndVerifyComment(win, commentText) {
  return win.webContents.executeJavaScript(`
    (async () => {
      const expectedText = ${JSON.stringify(commentText)};
      const normalize = (text) => (text || '').replace(/\\s+/g, ' ').trim();
      const expected = normalize(expectedText);
      const isVisible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const active = document.activeElement;
      const activeText = normalize(active?.value || active?.innerText || active?.textContent);
      if (!activeText.includes(expected)) {
        const inputs = Array.from(document.querySelectorAll(
          '[data-e2e="comment-input"], [data-e2e="comment-input-area"], div[contenteditable], [role="textbox"], textarea, input'
        )).filter(isVisible).map(el => ({
          tag: el.tagName,
          e2e: el.getAttribute('data-e2e') || '',
          role: el.getAttribute('role') || '',
          ce: el.getAttribute('contenteditable') || '',
          text: normalize(el.value || el.innerText || el.textContent).slice(0, 160),
          rect: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; })()
        }));
        if (!inputs.some(input => input.text.includes(expected))) {
          return { success: false, reason: 'typed-text-not-visible-in-input', activeText, inputs };
        }
      }
      const postSelectors = [
        '[data-e2e="comment-post"]',
        'div[data-e2e="comment-post"]',
        'button[data-e2e="comment-post"]',
        '[aria-label*="Post" i]',
        '[aria-label*="Đăng" i]',
        '[aria-label*="Send" i]',
        '[aria-label*="Gửi" i]',
        '[class*="DivPostButton"]',
        '[class*="PostBtn"]',
        '[class*="ButtonPost"]',
        '[class*="ButtonSend"]'
      ];
      let submitted = false;
      for (const sel of postSelectors) {
        const btn = document.querySelector(sel);
        if (btn && isVisible(btn) && btn.getAttribute('aria-disabled') !== 'true' && !btn.disabled) {
          btn.click();
          submitted = true;
          break;
        }
      }
      if (!submitted) {
        active.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        active.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        active.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      }

      const getCommentPane = () => {
        const selectors = [
          '[data-e2e="video-detail-container"]',
          'div[class*="DivRightContainer"]',
          'div[class*="DivContentContainer"]',
          'div[class*="DivCommentContainer"]',
          'div[class*="CommentContainer"]',
          'div[class*="CommentListContainer"]'
        ];
        return selectors
          .flatMap(sel => Array.from(document.querySelectorAll(sel)))
          .filter(isVisible)
          .map(el => ({ el, rect: el.getBoundingClientRect() }))
          .filter(({ rect }) => rect.width >= 180 && rect.left > window.innerWidth * 0.45)
          .sort((a, b) => (b.rect.width * b.rect.height) - (a.rect.width * a.rect.height))[0]?.el || document;
      };
      const isInputLike = (el) => !!el?.closest?.('[data-e2e="comment-input"], [data-e2e="comment-input-area"], [data-e2e="comment-post"], div[contenteditable], [role="textbox"], textarea, input');
      const commentSelectors = [
        '[data-e2e*="comment-level"]',
        '[data-e2e*="comment-item"]',
        '[data-e2e*="comment-text"]',
        '[class*="CommentItem"]',
        '[class*="CommentText"]',
        '[class*="DivCommentContent"]',
        '[class*="DivCommentItem"]',
        'p',
        'span'
      ];
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        const pane = getCommentPane();
        const found = commentSelectors
          .flatMap(sel => Array.from(pane.querySelectorAll(sel)))
          .filter(el => isVisible(el) && !isInputLike(el))
          .find(el => normalize(el.innerText || el.textContent).includes(expected));
        if (found) return { success: true, submitted, verified: true };
        await new Promise(r => setTimeout(r, 600));
      }
      return { success: false, submitted, verified: false, reason: 'comment-not-visible-after-submit' };
    })();
  `);
}

async function getSelectionState(win) {
  return win.webContents.executeJavaScript(`
    (() => {
      const selection = window.getSelection();
      return {
        text: selection?.toString?.() || '',
        rangeCount: selection?.rangeCount || 0,
        isCollapsed: selection?.isCollapsed ?? true
      };
    })();
  `).catch(error => ({ error: String(error) }));
}

async function runAccount(account, index, total) {
  const ses = session.fromPartition(`persist:e2e_video_comment_${RUN_ID}_${account.id}`);
  ses.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  const proxy = await configureAccountProxy(ses, account);
  const injectedCookies = await injectTikTokCookies(ses, account.cookie);
  const win = new BrowserWindow({
    width: 900,
    height: 520,
    x: 20 + (index % MAX_CONCURRENT) * 330,
    y: 30 + Math.floor(index % 6 / MAX_CONCURRENT) * 260,
    show: true,
    title: `[E2E Comment ${index + 1}/${total}] @${account.username}`,
    autoHideMenuBar: true,
    webPreferences: {
      session: ses,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  if (proxy?.credentials) {
    ses.on('login', (event, _webContents, authInfo, callback) => {
      if (authInfo.isProxy) {
        event.preventDefault();
        callback(proxy.credentials.username, proxy.credentials.password);
      }
    });
  }
  win.webContents.setAudioMuted(true);
  win.webContents.setZoomFactor(ZOOM);

  const commentText = `${COMMENT_PREFIX} ${account.username || account.id} ${Date.now()}`;
  try {
    console.log(`[${index + 1}/${total}] @${account.username}: load ${TARGET_URL} cookies=${injectedCookies}`);
    await withTimeout(
      win.loadURL(TARGET_URL).then(() => ({ loaded: true })).catch(error => ({ loaded: false, error: String(error) })),
      LOAD_URL_TIMEOUT_MS,
      { loaded: false, timeout: true }
    );
    const surface = await waitForTikTokSurface(win);
    if (!surface.success) {
      throw new Error(`surface failed: ${JSON.stringify(surface)}`);
    }
    win.webContents.setZoomFactor(ZOOM);

    const feedClick = await getFeedCommentClickTarget(win);
    if (feedClick?.x && feedClick?.y) {
      await reliableClick(win, feedClick.x, feedClick.y);
      await delay(1800);
    }

    const commentsTab = await getVisibleCommentsTabTarget(win);
    if (commentsTab?.x && commentsTab?.y) {
      await reliableClick(win, commentsTab.x, commentsTab.y);
      await delay(1400);
    }

    const focus = await focusCommentInput(win);
    if (!focus.success) {
      throw new Error(`focus failed: ${JSON.stringify(focus)}`);
    }
    console.log(`[${index + 1}/${total}] @${account.username}: focus ${JSON.stringify(focus)}`);
    win.focus();
    win.webContents.focus();
    await zoomAwareClick(win, focus.x, focus.y);
    await delay(300);
    await cdpInsertText(win, commentText);
    await delay(700);
    const ensured = await ensureCommentTextInInput(win, commentText);
    console.log(`[${index + 1}/${total}] @${account.username}: typed ${JSON.stringify(ensured)}`);
    const selection = await getSelectionState(win);
    if (selection?.text) {
      throw new Error(`unexpected text selection after typing: ${JSON.stringify(selection)}`);
    }
    const result = await submitAndVerifyComment(win, commentText);
    if (!result.success || !result.verified) {
      throw new Error(`verify failed: ${JSON.stringify(result)}`);
    }
    console.log(`[${index + 1}/${total}] @${account.username}: VERIFIED "${commentText}"`);
    return { username: account.username, success: true, commentText };
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

app.on('window-all-closed', event => event.preventDefault());

app.whenReady().then(async () => {
  let accounts = getAccounts();
  if (ONLY_INDEXES?.length) {
    accounts = ONLY_INDEXES.map(index => accounts[index]).filter(Boolean);
  } else if (Number.isInteger(ONLY_INDEX)) {
    accounts = accounts.slice(ONLY_INDEX, ONLY_INDEX + 1);
  }
  if (accounts.length === 0) {
    console.error('No accounts found in data/accounts.json');
    app.exit(1);
    return;
  }

  console.log(`E2E_VIDEO_COMMENT_ALL_START accounts=${accounts.length} maxConcurrent=${MAX_CONCURRENT} url=${TARGET_URL}`);
  const results = [];
  for (let i = 0; i < accounts.length; i += MAX_CONCURRENT) {
    const batch = accounts.slice(i, i + MAX_CONCURRENT);
    const settled = await Promise.allSettled(batch.map((account, offset) => runAccount(account, i + offset, accounts.length)));
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        results.push(item.value);
      } else {
        results.push({ success: false, error: item.reason?.message || String(item.reason) });
        console.error(item.reason);
      }
    }
    await delay(1000);
  }

  const successCount = results.filter(result => result.success).length;
  console.log(`E2E_VIDEO_COMMENT_ALL_DONE success=${successCount}/${accounts.length}`);
  if (successCount !== accounts.length) {
    console.log(JSON.stringify(results, null, 2));
    app.exit(1);
    return;
  }
  app.quit();
});
