import { Browser, Page } from 'puppeteer-core';
import {
  calculateProfileWindowBounds,
  TIKTOK_INNER_CONTENT_ZOOM,
  windowSlotManager,
} from './window-bounds';
import { applyChromeWindowBounds, launchAccountBrowser } from './browser-launcher';
import {
  checkTikTokLoginStatusViaApi,
  extractTikTokCookieString,
  injectCookiesIntoPuppeteerPage,
  startLoginMonitor,
} from './auth-sync';
import { autoFillTikTokLoginCredentials } from './auto-login';
import { AccountSessionUpdate } from '../automation/session-profile';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { AccountStatus } from '../automation/types';
import { chromeViewBridge } from '../native/chrome-view-bridge';

export interface ActiveProfileInstance {
  accountId: string;
  username?: string;
  browser: Browser;
  page: Page;
  profileDir: string;
  openedAt: number;
  windowSlot: number;
}

export interface OpenProfileRequest {
  accountId: string;
  username?: string;
  cookie?: string;
  proxy?: string;
  proxyType?: string;
  password?: string;
  email?: string;
  passMail?: string;
  twoFactor?: string;
  muteBrowserAudio?: boolean;
  windowSlot?: number;
}

export class ChromeProfileManager {
  private static instance: ChromeProfileManager;
  private activeProfiles = new Map<string, ActiveProfileInstance>();

  public static getInstance(): ChromeProfileManager {
    if (!ChromeProfileManager.instance) {
      ChromeProfileManager.instance = new ChromeProfileManager();
    }
    return ChromeProfileManager.instance;
  }

  public isProfileRunning(accountId: string): boolean {
    const active = this.activeProfiles.get(accountId);
    if (!active) return false;
    return active.browser.connected && !active.page.isClosed();
  }

  public getActiveCount(): number {
    return this.activeProfiles.size;
  }

  public getRunningAccountIds(): string[] {
    return Array.from(this.activeProfiles.keys());
  }

  /**
   * Gom và hiển thị cửa sổ Chrome View (Tiled Grid Form)
   */
  public async relayoutActiveProfiles(): Promise<number> {
    try {
      chromeViewBridge.showView();
    } catch {}

    let count = 0;
    for (const instance of this.activeProfiles.values()) {
      if (!instance.browser.connected || instance.page.isClosed()) continue;
      try {
        const bounds = calculateProfileWindowBounds(instance.windowSlot);
        await applyChromeWindowBounds(instance.page, bounds).catch(() => {});
        await instance.page.bringToFront().catch(() => {});
        count++;
      } catch {}
    }
    return count;
  }

  /**
   * Open or focus a dedicated Google Chrome profile for an account
   */
  public async openProfile(
    req: OpenProfileRequest,
    onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
    onAccountStatusChange: (id: string, status: AccountStatus) => void,
    onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
  ): Promise<{ success: boolean; message: string }> {
    const { accountId, username, cookie, proxy, proxyType, password, muteBrowserAudio } = req;

    // 1. If already open and connected, bring to front
    if (this.activeProfiles.has(accountId)) {
      const existing = this.activeProfiles.get(accountId)!;
      if (existing.browser.connected && !existing.page.isClosed()) {
        try {
          await existing.page.bringToFront();
          await this.relayoutActiveProfiles();
          onLog({
            accountId,
            accountUsername: username,
            level: 'info',
            message: `🔍 Cửa sổ Chrome của @${username || accountId} đang mở và đã được đưa lên trước.`,
          });
          return { success: true, message: 'Profile focused' };
        } catch {
          // If bringToFront failed, proceed to recreate
        }
      }
      this.activeProfiles.delete(accountId);
    }

    onLog({
      accountId,
      accountUsername: username,
      level: 'info',
      message: `🚀 Đang khởi chạy App Mode cho @${username || accountId} ${proxy ? '[Proxy: ' + proxy + ']' : ''}...`,
    });

    try {
      const windowSlot = windowSlotManager.acquireSlot(accountId, req.windowSlot);
      const nextLayoutWindowCount = Math.max(this.activeProfiles.size + 1, windowSlot + 1);
      const { browser, page, profileDir } = await launchAccountBrowser({
        accountId,
        username,
        proxy,
        proxyType,
        muteAudio: muteBrowserAudio !== false,
        windowSlot,
        layoutWindowCount: nextLayoutWindowCount,
      });

      const instance: ActiveProfileInstance = {
        accountId,
        username,
        browser,
        page,
        profileDir,
        openedAt: Date.now(),
        windowSlot,
      };
      this.activeProfiles.set(accountId, instance);
      await this.relayoutActiveProfiles();

      // Handle browser disconnect or manual window close
      const handleClose = async () => {
        if (!this.activeProfiles.has(accountId)) return;
        this.activeProfiles.delete(accountId);
        windowSlotManager.releaseSlot(accountId);

        try {
          chromeViewBridge.removeChrome(instance.windowSlot);
        } catch {}

        try {
          // Check final cookies before cleanup
          if (page && !page.isClosed()) {
            const finalCookies = await extractTikTokCookieString(page);
            if (finalCookies && (finalCookies.includes('sessionid=') || finalCookies.includes('sid_tt='))) {
              onAccountSessionUpdate(accountId, {
                cookie: finalCookies,
                status: 'authenticated',
                lastUsed: new Date().toISOString(),
              });
              onAccountStatusChange(accountId, 'authenticated');
            }
          }
        } catch {}

        onLog({
          accountId,
          accountUsername: username,
          level: 'info',
          message: `🚪 Trình duyệt Chrome của @${username || accountId} đã đóng.`,
        });
      };

      browser.on('disconnected', handleClose);
      page.on('close', handleClose);

      // Inject existing cookies if available
      const hasCookie = !!(cookie && (cookie.includes('sessionid=') || cookie.includes('sid_tt=')));
      if (hasCookie) {
        await injectCookiesIntoPuppeteerPage(page, cookie);
        onLog({
          accountId,
          accountUsername: username,
          level: 'info',
          message: `🍪 Đã nạp Cookie TikTok cho @${username || accountId}.`,
        });
      }

      // Navigate to TikTok Login or Homepage
      const targetUrl = !hasCookie && password
        ? 'https://www.tiktok.com/login/phone-or-email/email'
        : 'https://www.tiktok.com';

      try {
        await page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 35000,
        });
        await page.evaluate((zoomValue) => {
          try {
            (document.documentElement as HTMLElement).style.zoom = zoomValue;
            if (document.body) {
              (document.body as HTMLElement).style.zoom = zoomValue;
            }
          } catch {}
        }, TIKTOK_INNER_CONTENT_ZOOM).catch(() => {});
      } catch (err: any) {
        onLog({
          accountId,
          accountUsername: username,
          level: 'warning',
          message: `⚠️ Điều hướng trang TikTok: ${err?.message || 'Timeout'}. Bạn vẫn có thể thao tác bình thường.`,
        });
      }

      // Start background login monitoring
      startLoginMonitor(page, accountId, username, onLog, onAccountStatusChange, onAccountSessionUpdate);

      // Initial check login status
      const initialLogin = await checkTikTokLoginStatusViaApi(page);
      if (initialLogin.isLoggedIn) {
        onAccountStatusChange(accountId, 'authenticated');
        onLog({
          accountId,
          accountUsername: initialLogin.username || username,
          level: 'success',
          message: `🎉 @${initialLogin.username || username || accountId} đã sẵn sàng trong trạng thái Đăng nhập!`,
        });
      } else {
        if (password && (username || req.email)) {
          // If not currently on login page, navigate to login page
          if (!page.url().includes('/login')) {
            await page.goto('https://www.tiktok.com/login/phone-or-email/email', {
              waitUntil: 'domcontentloaded',
              timeout: 35000,
            }).catch(() => {});
          }

          // Auto-fill Username, Password and 2FA TOTP
          await autoFillTikTokLoginCredentials({
            page,
            accountId,
            username,
            email: req.email,
            password: req.password,
            twoFactor: req.twoFactor,
            onLog,
          });
        } else if (!hasCookie) {
          onLog({
            accountId,
            accountUsername: username,
            level: 'info',
            message: `👉 Vui lòng đăng nhập trên cửa sổ Chrome. Phần mềm sẽ tự động nhận diện và lưu Cookie.`,
          });
        }
      }

      return { success: true, message: 'Profile opened successfully' };
    } catch (err: any) {
      this.activeProfiles.delete(accountId);
      const errMsg = err?.message || String(err);
      onLog({
        accountId,
        accountUsername: username,
        level: 'error',
        message: `❌ Lỗi khi mở Chrome Profile cho @${username || accountId}: ${errMsg}`,
      });
      return { success: false, message: errMsg };
    }
  }

  /**
   * Close a specific account's Chrome profile
   */
  public async closeProfile(accountId: string): Promise<boolean> {
    const instance = this.activeProfiles.get(accountId);
    if (!instance) return false;

    this.activeProfiles.delete(accountId);
    windowSlotManager.releaseSlot(accountId);
    try {
      chromeViewBridge.removeChrome(instance.windowSlot);
    } catch {}

    try {
      if (instance.browser.connected) {
        await instance.browser.close();
      }
      return true;
    } catch (err) {
      console.error(`[ChromeProfileManager] Error closing browser for ${accountId}:`, err);
      return false;
    }
  }

  /**
   * Close all actively running Chrome profiles
   */
  public async closeAllProfiles(): Promise<number> {
    let closedCount = 0;
    const instances = Array.from(this.activeProfiles.values());
    this.activeProfiles.clear();
    windowSlotManager.clear();

    try {
      chromeViewBridge.clear();
    } catch {}

    for (const inst of instances) {
      try {
        if (inst.browser.connected) {
          closedCount++;
          await inst.browser.close();
        }
      } catch (err) {
        console.error(`[ChromeProfileManager] Error closing profile ${inst.accountId}:`, err);
      }
    }

    return closedCount;
  }
}

export const chromeProfileManager = ChromeProfileManager.getInstance();
