import { SeedingTaskConfig, TaskLogItem } from '../nest/automation/automation.interface';
import { AccountStatus, SeedingStateChange } from '../automation/types';
import { AccountSessionUpdate } from '../automation/session-profile';
import { launchAccountBrowser } from './browser-launcher';
import { injectCookiesIntoPuppeteerPage, extractTikTokCookieString, checkTikTokLoginStatusViaApi } from './auth-sync';
import { autoFillTikTokLoginCredentials } from './auto-login';
import { performPuppeteerVideoSeeding } from './video-seeding';
import { performPuppeteerLiveSeeding } from './live-seeding';
import { windowSlotManager } from './window-bounds';

export interface SeedingAccountData {
  id: string;
  username: string;
  cookie?: string;
  proxy?: string;
  proxyType?: string;
  password?: string;
  email?: string;
  passMail?: string;
  twoFactor?: string;
}

export class PuppeteerSeedingEngine {
  private static instance: PuppeteerSeedingEngine;
  private isRunning = false;
  private cancelRequested = false;

  public static getInstance(): PuppeteerSeedingEngine {
    if (!PuppeteerSeedingEngine.instance) {
      PuppeteerSeedingEngine.instance = new PuppeteerSeedingEngine();
    }
    return PuppeteerSeedingEngine.instance;
  }

  public requestCancel() {
    this.cancelRequested = true;
  }

  public isCancelled(): boolean {
    return this.cancelRequested;
  }

  /**
   * Execute multi-threaded seeding tasks across selected accounts using real Google Chrome profiles
   */
  public async executeSeedingTasks(
    config: SeedingTaskConfig,
    accounts: SeedingAccountData[],
    onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
    onAccountStatusChange: (id: string, status: AccountStatus) => void,
    onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
    onStateChange?: (state: SeedingStateChange) => void
  ): Promise<{ success: boolean; completedCount: number; message: string }> {
    if (this.isRunning) {
      return { success: false, completedCount: 0, message: 'Seeding is already running' };
    }

    this.isRunning = true;
    this.cancelRequested = false;
    onStateChange?.({ isRunning: true });

    const selectedAccounts = accounts.filter(a => config.accountIds.includes(a.id));
    if (selectedAccounts.length === 0) {
      this.isRunning = false;
      onStateChange?.({ isRunning: false });
      return { success: false, completedCount: 0, message: 'No accounts selected' };
    }

    const effectiveMaxThreads = config.maxThreads && config.maxThreads > 0
      ? Math.min(config.maxThreads, selectedAccounts.length)
      : Math.min(6, selectedAccounts.length);

    onLog({
      level: 'info',
      message: `🚀 [Puppeteer Chrome] Bắt đầu chiến dịch Seeding ${config.targetType.toUpperCase()}: ${config.targetUrl}`,
    });
    onLog({
      level: 'info',
      message: `⚙️ Chạy đa luồng: ${effectiveMaxThreads} luồng song song trên ${selectedAccounts.length} tài khoản...`,
    });

    const queue = selectedAccounts.map((acc, index) => ({ acc, index }));
    let completedCount = 0;

    const runWorker = async (workerId: number): Promise<void> => {
      while (queue.length > 0 && !this.cancelRequested) {
        const item = queue.shift();
        if (!item) break;
        const { acc, index } = item;

        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `[Luồng ${workerId + 1}] [${index + 1}/${selectedAccounts.length}] Đang chuẩn bị Chrome cho @${acc.username}...`,
        });

        const slot = windowSlotManager.acquireSlot(acc.id);
        let browserInstance: any = null;

        try {
          // 1. Launch real Google Chrome instance with Stealth Plugin
          const { browser, page, profileDir } = await launchAccountBrowser({
            accountId: acc.id,
            username: acc.username,
            proxy: acc.proxy,
            proxyType: acc.proxyType || 'http',
            muteAudio: true,
            windowSlot: slot,
            layoutWindowCount: effectiveMaxThreads,
          });
          browserInstance = browser;

          // 2. Inject Cookies if available
          if (acc.cookie && (acc.cookie.includes('sessionid=') || acc.cookie.includes('sid_tt='))) {
            await injectCookiesIntoPuppeteerPage(page, acc.cookie);
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `[Luồng ${workerId + 1}] 🍪 Đã nạp Cookie phiên cho @${acc.username}.`,
            });
          }

          // Check if session is logged in, fallback to auto-login by Username/Password & 2FA
          const checkLogin = await checkTikTokLoginStatusViaApi(page);
          if (!checkLogin.isLoggedIn && acc.password && (acc.username || acc.email)) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `[Luồng ${workerId + 1}] 🔑 Chưa có phiên đăng nhập, đang tự động điền Username/Pass & 2FA cho @${acc.username}...`,
            });
            await page.goto('https://www.tiktok.com/login/phone-or-email/email', {
              waitUntil: 'domcontentloaded',
              timeout: 35000,
            }).catch(() => {});

            await autoFillTikTokLoginCredentials({
              page,
              accountId: acc.id,
              username: acc.username,
              email: acc.email,
              password: acc.password,
              twoFactor: acc.twoFactor,
              onLog,
              isCancelled: () => this.cancelRequested,
            });
          }

          if (this.cancelRequested) break;

          // 3. Execute Specific Seeding Action
          if (config.targetType === 'video') {
            await performPuppeteerVideoSeeding({
              page,
              videoUrl: config.targetUrl,
              accountId: acc.id,
              username: acc.username,
              like: config.likeEnabled !== false,
              comments: config.comments,
              followAuthor: false,
              watchSeconds: config.delaySeconds || 6,
              onLog,
              isCancelled: () => this.cancelRequested,
            });
          } else if (config.targetType === 'livestream') {
            await performPuppeteerLiveSeeding({
              page,
              liveUrl: config.targetUrl,
              accountId: acc.id,
              username: acc.username,
              likeCount: config.likeEnabled ? 20 : 0,
              comments: config.comments,
              durationMinutes: Math.max(1, Math.floor((config.liveDurationSeconds || 60) / 60)),
              onLog,
              isCancelled: () => this.cancelRequested,
            });
          }

          // 4. Extract and sync fresh cookies back to database
          try {
            const freshCookies = await extractTikTokCookieString(page);
            if (freshCookies && (freshCookies.includes('sessionid=') || freshCookies.includes('sid_tt='))) {
              onAccountSessionUpdate(acc.id, {
                cookie: freshCookies,
                status: 'authenticated',
                lastUsed: new Date().toISOString(),
              });
              onAccountStatusChange(acc.id, 'authenticated');
            }
          } catch {}

          completedCount++;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'success',
            message: `[Luồng ${workerId + 1}] 🎉 Hoàn thành Seeding cho @${acc.username} (${completedCount}/${selectedAccounts.length}).`,
          });
        } catch (err: any) {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'error',
            message: `[Luồng ${workerId + 1}] ❌ Lỗi khi seeding tài khoản @${acc.username}: ${err?.message || err}`,
          });
        } finally {
          // 5. Clean up Chrome browser and release window slot
          windowSlotManager.releaseSlot(acc.id);
          if (browserInstance) {
            try {
              if (browserInstance.connected) {
                await browserInstance.close();
              }
            } catch {}
          }
        }

        // Small delay between queue items
        await new Promise(r => setTimeout(r, 1200));
      }
    };

    const workers = Array.from({ length: effectiveMaxThreads }, (_, i) => runWorker(i));
    await Promise.all(workers);

    this.isRunning = false;
    windowSlotManager.clear();
    onStateChange?.({ isRunning: false });

    onLog({
      level: 'info',
      message: `🏁 Kết thúc chiến dịch Seeding: Đã hoàn tất ${completedCount}/${selectedAccounts.length} tài khoản.`,
    });

    return {
      success: true,
      completedCount,
      message: `Completed ${completedCount}/${selectedAccounts.length} accounts`,
    };
  }
}

export const puppeteerSeedingEngine = PuppeteerSeedingEngine.getInstance();
