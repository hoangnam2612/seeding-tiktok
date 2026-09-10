import { addExtra } from 'puppeteer-extra';
import puppeteerCore, { Browser, Page } from 'puppeteer-core';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { findChromeExecutable } from './chrome-finder';
import { getAccountProfileDir } from './profile-storage';
import {
  calculateProfileWindowBounds,
  TIKTOK_INNER_CONTENT_ZOOM,
  WindowBounds,
} from './window-bounds';
import { getStoredAppSettings } from '../nest/app.service';
import { chromeViewBridge } from '../native/chrome-view-bridge';

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
 * Launch an independent Google Chrome browser instance in App Mode with 1920x1080 Screen Fingerprint
 */
export async function launchAccountBrowser(options: LaunchProfileOptions): Promise<{
  browser: Browser;
  page: Page;
  profileDir: string;
  bounds: WindowBounds;
}> {
  const chromePath = findChromeExecutable(options.customChromePath);
  const profileDir = getAccountProfileDir(options.accountId);
  const settings = getStoredAppSettings();

  const bounds = calculateProfileWindowBounds(options.windowSlot || 0);
  const scaleFactor = options.scaleFactor !== undefined ? options.scaleFactor : (settings.chromeScaleFactor ?? 0.65);

  const args: string[] = [
    // 1. App Mode: Launch directly as a clean standalone app window without address bar or tab bar
    '--app=https://www.tiktok.com',

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

    // Tối ưu tài nguyên & loại bỏ thanh công cụ thừa
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-features=Translate,OptimizationHints,MediaRouter',
  ];

  if (scaleFactor && scaleFactor > 0) {
    args.push(`--force-device-scale-factor=${scaleFactor}`);
  }

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

  // Inject Script: Fake Fingerprint 1920x1080 & Fullscreen Vertical Video CSS
  await page.evaluateOnNewDocument((zoomValue) => {
    // 1. Fake Screen Resolution & Display Properties to 1920x1080 (MKT TikPro Standard)
    try {
      const screenWidth = 1920;
      const screenHeight = 1080;
      const availWidth = 1920;
      const availHeight = 1040;
      const colorDepth = 24;
      const pixelDepth = 24;

      Object.defineProperties(window.screen, {
        width: { get: () => screenWidth, configurable: true, enumerable: true },
        height: { get: () => screenHeight, configurable: true, enumerable: true },
        availWidth: { get: () => availWidth, configurable: true, enumerable: true },
        availHeight: { get: () => availHeight, configurable: true, enumerable: true },
        colorDepth: { get: () => colorDepth, configurable: true, enumerable: true },
        pixelDepth: { get: () => pixelDepth, configurable: true, enumerable: true },
      });

      Object.defineProperty(window, 'devicePixelRatio', {
        get: () => 1,
        configurable: true,
        enumerable: true,
      });
    } catch { }

    // 2. Responsive CSS Fixes: Expand video to 100% full frame, remove sidebars & headers
    const applyResponsiveFixes = () => {
      try {
        document.documentElement.style.zoom = zoomValue;
        if (document.body) {
          document.body.style.zoom = zoomValue;
        }

        const style = document.createElement('style');
        style.innerHTML = `
          html, body, #root, #app, #main-content-homepage_hot, div[id*="app"] {
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
          header,
          nav,
          #header-container,
          [class*="DivHeaderContainer"],
          [data-e2e="download-app-bar"],
          div[class*="DivAppStoreDownload"],
          div[class*="DivDownload"] {
            display: none !important;
          }

          [data-e2e="feed-container"],
          [class*="DivBodyContainer"],
          [class*="DivContentContainer"],
          [class*="DivFeedContainer"],
          [class*="DivMainContainer"],
          [class*="DivItemContainer"],
          [class*="DivVideoWrapper"],
          [class*="DivVideoContainer"] {
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
            max-width: 100% !important;
            max-height: 100% !important;
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
  }, TIKTOK_INNER_CONTENT_ZOOM);

  // Đổi title cửa sổ và đăng ký vào Gom Cửa Sổ (Chrome View)
  const uniqueTag = `TT_${options.accountId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10)}`;
  const titleLabel = `[${uniqueTag}] TikTok @${options.username || options.accountId}`;
  await page.evaluate((title) => {
    try {
      document.title = title;
    } catch { }
  }, titleLabel).catch(() => { });

  // Nhúng vào cửa sổ Gom Cửa Sổ (Chrome View)
  try {
    chromeViewBridge.addChrome(uniqueTag, options.windowSlot || 0, bounds.width, bounds.height);
  } catch (viewErr) {
    console.warn('[ChromeViewBridge] Error embedding chrome:', viewErr);
  }

  return { browser, page, profileDir, bounds };
}
