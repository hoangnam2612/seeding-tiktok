import { addExtra } from 'puppeteer-extra';
import puppeteerCore, { Browser, Page } from 'puppeteer-core';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { findChromeExecutable } from './chrome-finder';
import { getAccountProfileDir } from './profile-storage';
import {
  calculateProfileWindowBounds,
  WindowBounds,
} from './window-bounds';

// Apply Stealth Plugin to puppeteer-core via addExtra
const puppeteer = addExtra(puppeteerCore as any);
puppeteer.use(StealthPlugin());

export interface LaunchProfileOptions {
  accountId: string;
  username?: string;
  proxy?: string;
  proxyType?: string;
  muteAudio?: boolean;
  windowSlot?: number;
  scaleFactor?: number;
  customChromePath?: string;
  hostBounds?: WindowBounds;
  layoutWindowCount?: number;
}

export interface ParsedProxy {
  server: string;
  username?: string;
  password?: string;
}

export async function applyChromeWindowBounds(page: Page, bounds: WindowBounds): Promise<void> {
  const cdpSession = await page.target().createCDPSession();
  try {
    const { windowId } = (await cdpSession.send('Browser.getWindowForTarget')) as any;
    if (windowId) {
      await cdpSession.send('Browser.setWindowBounds', {
        windowId,
        bounds: {
          left: bounds.x,
          top: bounds.y,
          width: bounds.width,
          height: bounds.height,
          windowState: 'normal',
        },
      });
    }
  } finally {
    await cdpSession.detach().catch(() => { });
  }
}

export function parseProxyString(rawProxy?: string, proxyType = 'http'): ParsedProxy | null {
  if (!rawProxy || typeof rawProxy !== 'string') return null;
  const trimmed = rawProxy.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.includes('://')) {
      const url = new URL(trimmed);
      const protocol = url.protocol.replace(':', '') || proxyType;
      const host = url.hostname;
      const port = url.port || (protocol === 'socks5' ? '1080' : '80');
      const username = url.username ? decodeURIComponent(url.username) : undefined;
      const password = url.password ? decodeURIComponent(url.password) : undefined;
      return {
        server: `${protocol}://${host}:${port}`,
        username,
        password,
      };
    }

    const parts = trimmed.split(':');
    if (parts.length >= 4) {
      const [host, port, username, password] = parts;
      const protocol = proxyType === 'socks5' ? 'socks5' : 'http';
      return {
        server: `${protocol}://${host}:${port}`,
        username,
        password,
      };
    }

    if (parts.length === 2) {
      const [host, port] = parts;
      const protocol = proxyType === 'socks5' ? 'socks5' : 'http';
      return {
        server: `${protocol}://${host}:${port}`,
      };
    }
  } catch (err) {
    console.error('[ProxyParser] Failed to parse proxy string:', rawProxy, err);
  }

  return null;
}

/**
 * Launch an independent Google Chrome browser instance for a specific TikTok account profile
 */
export async function launchAccountBrowser(options: LaunchProfileOptions): Promise<{
  browser: Browser;
  page: Page;
  profileDir: string;
  bounds: WindowBounds;
}> {
  const chromePath = findChromeExecutable(options.customChromePath);
  const profileDir = getAccountProfileDir(options.accountId);

  const bounds = calculateProfileWindowBounds(
    options.windowSlot || 0,
    options.hostBounds
  );

  const args: string[] = [
    // 1. Dùng about:blank để inject script CSS trước khi TikTok load
    '--app=about:blank',

    `--window-position=${bounds.x},${bounds.y}`,
    `--window-size=${bounds.width},${bounds.height}`,

    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-infobars',
    '--disable-notifications',
    '--autoplay-policy=no-user-gesture-required',
    '--disable-blink-features=AutomationControlled',
    '--test-type',
    '--no-first-run',
    '--no-default-browser-check',

    // Tối ưu tài nguyên
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-extensions',
    '--disable-component-update',
  ];

  if (options.muteAudio !== false) {
    args.push('--mute-audio');
  }

  const parsedProxy = parseProxyString(options.proxy, options.proxyType);
  if (parsedProxy) {
    args.push(`--proxy-server=${parsedProxy.server}`);
  }

  const browser = (await (puppeteer as any).launch({
    headless: false,
    executablePath: chromePath,
    userDataDir: profileDir,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args,
  })) as Browser;

  const pages = await browser.pages();
  const page = pages.length > 0 ? pages[0] : await browser.newPage();

  // Ép tọa độ và kích cỡ qua CDP
  try {
    await applyChromeWindowBounds(page, bounds);
  } catch (cdpErr) {
    console.warn('[WindowBounds] Could not apply CDP window bounds:', cdpErr);
  }

  if (parsedProxy?.username && parsedProxy?.password) {
    await page.authenticate({
      username: parsedProxy.username,
      password: parsedProxy.password,
    });
  }

  // Đăng ký script can thiệp layout trước khi mở TikTok
  await page.evaluateOnNewDocument(() => {
    const applyResponsiveFixes = () => {
      try {
        const style = document.createElement('style');
        style.innerHTML = `
          html, body, #root, #app {
            width: 100% !important;
            height: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            overflow: hidden !important;
            background: #000 !important;
          }

          [data-e2e="sidebar-container"],
          [class*="DivSideNavContainer"],
          [class*="DivSidebarContainer"],
          [data-e2e="nav-bar"],
          header {
            display: none !important;
          }

          [data-e2e="feed-container"],
          [class*="DivBodyContainer"],
          [class*="DivContentContainer"],
          [class*="DivFeedContainer"],
          [class*="DivMainContainer"] {
            width: 100% !important;
            height: 100% !important;
            max-width: 100% !important;
            max-height: 100% !important;
            margin: 0 !important;
            padding: 0 !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
          }

          video {
            width: 100% !important;
            height: 100% !important;
            object-fit: cover !important;
          }
        `;
        document.head.appendChild(style);
      } catch { }
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', applyResponsiveFixes);
    } else {
      applyResponsiveFixes();
    }
  });

  // Điều hướng vào TikTok sau khi đã thiết lập xong CSS và Proxy
  await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' }).catch(() => { });

  // Đổi title cửa sổ
  const titleLabel = `[Chrome @${options.username || options.accountId}]`;
  await page.evaluate((title) => {
    try {
      document.title = title;
    } catch { }
  }, titleLabel).catch(() => { });

  return { browser, page, profileDir, bounds };
}