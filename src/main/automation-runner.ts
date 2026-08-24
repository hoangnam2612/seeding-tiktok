import { BrowserWindow, session, ipcMain } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from './nest/automation/automation.interface';
import { monitorLoginFlow } from './automation/tiktok-login-flow';
import { getTiledLoginWindowBounds } from './automation/window-layout';
import {
  AccountSessionUpdate,
  attachProxyAuthHandler,
  configureSessionProxyAndCookies,
  hasValidTikTokCookieString,
  persistTikTokSessionCookies,
} from './automation/session-profile';
import {
  SeedingCancelledError,
  finishSeedingRun,
  getSeedingCancelReason,
  isSeedingCancelRequested,
  requestSeedingCancel,
  runSessionPreparation,
  startSeedingRun,
  throwIfSeedingCancelled,
  waitForSeedingDelay,
} from './automation/seeding-control';
import { AccountInfo, AccountStatus, SeedingStateChange } from './automation/types';
import { loadLoginStartPage } from './automation/tiktok-page';
import { executeTaskForAccount, seedingWindows } from './automation/account-task-runner';

// Map of active login windows
const loginWindows = new Map<string, BrowserWindow>();
const SEEDING_WINDOW_CLOSED_MESSAGE = 'Seeding browser window was closed.';

export function setupAutomationIPC(
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  onSeedingStateChange?: (state: SeedingStateChange) => void,
  ensureClientLicensed?: () => Promise<{ ok: boolean; message?: string }>
) {
  const assertClientLicensed = async () => {
    if (!ensureClientLicensed) return;
    const result = await ensureClientLicensed();
    if (!result.ok) {
      throw new Error(result.message || 'Bản quyền chưa hợp lệ.');
    }
  };

  ipcMain.handle('close-all-browser-windows', async () => {
    let closedCount = 0;
    const windows = new Set<BrowserWindow>([
      ...Array.from(loginWindows.values()),
      ...Array.from(seedingWindows.values()),
    ]);
    requestSeedingCancel('Nguoi dung da dong tat ca trinh duyet seeding.');
    onSeedingStateChange?.({
      isRunning: false,
      canceled: true,
      reason: 'Nguoi dung da dong tat ca trinh duyet seeding.',
    });

    windows.forEach(win => {
      if (!win.isDestroyed()) {
        closedCount++;
        win.close();
      }
    });
    loginWindows.clear();
    seedingWindows.clear();

    onLog({
      level: 'info',
      message: `[Browser] Closed ${closedCount} browser window(s).`,
    });

    return { success: true, closedCount };
  });

  // 1. Open Interactive Login Window for a TikTok Account (Single Chrome)
  ipcMain.handle(
    'open-account-login-window',
    async (
      _event,
      accountId: string,
      username: string,
      cookie?: string,
      proxy?: string,
      proxyType: string = 'http',
      password?: string,
      email?: string,
      passMail?: string,
      twoFactor?: string,
      muteBrowserAudio: boolean = true
    ) => {
      await assertClientLicensed();

      if (loginWindows.has(accountId)) {
        const existingWin = loginWindows.get(accountId)!;
        if (!existingWin.isDestroyed()) {
          existingWin.webContents.setAudioMuted(muteBrowserAudio !== false);
          existingWin.focus();
          return { success: true, message: 'Window focused' };
        }
      }

      const partition = `persist:tiktok_${accountId}`;
      const customSession = session.fromPartition(partition);

      customSession.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      );

      const proxyConfig = await runSessionPreparation(() =>
        configureSessionProxyAndCookies(customSession, cookie, proxy, proxyType, {
          skipCookieInjectionIfSessionExists: true,
        })
      );

      const win = new BrowserWindow({
        ...getTiledLoginWindowBounds(loginWindows.size),
        title: `Chrome Profile [@${username || accountId}] ${proxy ? '(Proxy: ' + proxy + ')' : ''}`,
        autoHideMenuBar: true,
        webPreferences: {
          session: customSession,
          nodeIntegration: false,
          contextIsolation: true,
          backgroundThrottling: false,
        },
      });

      loginWindows.set(accountId, win);
      win.webContents.setAudioMuted(muteBrowserAudio !== false);
      attachProxyAuthHandler(win, proxyConfig?.auth);

      const accInfo: AccountInfo = {
        id: accountId,
        username,
        password,
        email,
        passMail,
        twoFactor,
        cookie,
      };

      const hasCookie = hasValidTikTokCookieString(cookie);

      // LOAD URL (Try direct login URL if unauthenticated with password, or TikTok homepage)
      const startUrl = !hasCookie && password
        ? 'https://www.tiktok.com/login/phone-or-email/email'
        : 'https://www.tiktok.com';

      onLog({
        accountId,
        accountUsername: username,
        level: 'info',
        message: `🌐 Đang mở Chrome Profile cho @${username || accountId} ${proxy ? '[Proxy Active]' : ''}${muteBrowserAudio !== false ? ' [Muted]' : ''}...`,
      });

      const loaded = await loadLoginStartPage(
        win,
        customSession,
        startUrl,
        { id: accountId, username },
        proxy,
        proxyConfig,
        onLog,
        onAccountStatusChange,
        'Mo Chrome'
      ).catch(err => {
        console.error('[Proxy] Failed to diagnose login window load:', err);
        return false;
      });

      if (!win.isDestroyed() && loaded !== false) {
        // ALWAYS launch monitorLoginFlow for background status & auto-login checking after initial load completes
        monitorLoginFlow(win, customSession, accInfo, onLog, onAccountStatusChange, onAccountSessionUpdate);
      }


      win.on('closed', async () => {
        loginWindows.delete(accountId);

        try {
          const cookies = await customSession.cookies.get({ domain: '.tiktok.com' });
          const hasSessionCookie = cookies.some(
            c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt'
          );

          if (hasSessionCookie) {
            const savedCookie = await persistTikTokSessionCookies(
              accountId,
              username,
              customSession,
              onLog,
              onAccountSessionUpdate
            );
            if (!savedCookie) {
              onAccountStatusChange(accountId, 'authenticated');
            }
            onLog({
              accountId,
              accountUsername: username,
              level: 'success',
              message: `✅ Session Cookie đã được xác nhận thành công cho @${username || accountId}!`,
            });
          }
        } catch (err: any) {
          console.error('Failed to check cookies:', err);
        }
      });

      return { success: true };
    }
  );

  // 2. Open Multi-Thread Account Chromes (Đa Luồng)
  ipcMain.handle(
    'open-multi-account-chromes',
    async (_event, accountIds: string[], maxThreads: number = 10, accountsData: any[], muteBrowserAudio: boolean = true) => {
      await assertClientLicensed();

      const selectedAccounts = accountsData.filter(a => accountIds.includes(a.id));
      if (selectedAccounts.length === 0) {
        return { success: false, message: 'No valid accounts selected' };
      }
      const effectiveMaxThreads = maxThreads > 0 ? Math.min(maxThreads, selectedAccounts.length) : selectedAccounts.length;

      onLog({
        level: 'info',
        message: `🚀 Bắt đầu khởi chạy ${selectedAccounts.length} cửa sổ Chrome đa luồng (Tối đa ${effectiveMaxThreads} luồng song song)...`,
      });

      const queue = [...selectedAccounts];
      const activeWorkers: Promise<void>[] = [];

      const runNextWorker = async (): Promise<void> => {
        while (queue.length > 0) {
          const acc = queue.shift();
          if (!acc) break;

          try {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `[Multi-Thread] Mở cửa sổ Chrome cho @${acc.username}...`,
            });

            const partition = `persist:tiktok_${acc.id}`;
            const customSession = session.fromPartition(partition);

            customSession.setUserAgent(
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            );

            const proxyConfig = await runSessionPreparation(() =>
              configureSessionProxyAndCookies(customSession, acc.cookie, acc.proxy, acc.proxyType, {
                skipCookieInjectionIfSessionExists: true,
              })
            );

            const win = new BrowserWindow({
              ...getTiledLoginWindowBounds(loginWindows.size),
              title: `Chrome Multi-Thread [@${acc.username}]`,
              autoHideMenuBar: true,
              webPreferences: {
                session: customSession,
                nodeIntegration: false,
                contextIsolation: true,
                backgroundThrottling: false,
              },
            });

            loginWindows.set(acc.id, win);
            win.webContents.setAudioMuted(muteBrowserAudio !== false);
            attachProxyAuthHandler(win, proxyConfig?.auth);

            const accInfo: AccountInfo = {
              id: acc.id,
              username: acc.username,
              password: acc.password,
              email: acc.email,
              passMail: acc.passMail,
              twoFactor: acc.twoFactor,
              cookie: acc.cookie,
            };

            const hasCookie = hasValidTikTokCookieString(acc.cookie);

            const startUrl = !hasCookie && acc.password
              ? 'https://www.tiktok.com/login/phone-or-email/email'
              : 'https://www.tiktok.com';

            const loaded = await loadLoginStartPage(
              win,
              customSession,
              startUrl,
              acc,
              acc.proxy,
              proxyConfig,
              onLog,
              onAccountStatusChange,
              'Mo Chrome da luong'
            ).catch(err => {
              console.error(`[Proxy] Failed to diagnose multi-login window load for @${acc.username}:`, err);
              onLog({
                accountId: acc.id,
                accountUsername: acc.username,
                level: 'warning',
                message: `[Multi-Thread] Cảnh báo tải trang cho @${acc.username}: ${err?.message || err}`,
              });
              return false;
            });

            // Launch monitorLoginFlow after initial load completes
            if (!win.isDestroyed() && loaded !== false) {
              monitorLoginFlow(win, customSession, accInfo, onLog, onAccountStatusChange, onAccountSessionUpdate);
            }

            await new Promise<void>((resolve) => {
              win.on('closed', async () => {
                loginWindows.delete(acc.id);

                try {
                  const cookies = await customSession.cookies.get({ domain: '.tiktok.com' });
                  const hasSessionCookie = cookies.some(
                    c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt'
                  );

                  if (hasSessionCookie) {
                    const savedCookie = await persistTikTokSessionCookies(
                      acc.id,
                      acc.username,
                      customSession,
                      onLog,
                      onAccountSessionUpdate,
                      '[Multi-Thread] '
                    );
                    if (!savedCookie) {
                      onAccountStatusChange(acc.id, 'authenticated');
                    }
                    onLog({
                      accountId: acc.id,
                      accountUsername: acc.username,
                      level: 'success',
                      message: `✅ [Multi-Thread] Session Cookie đã được xác nhận thành công cho @${acc.username}!`,
                    });
                  } else {
                    onLog({
                      accountId: acc.id,
                      accountUsername: acc.username,
                      level: 'info',
                      message: `Đã đóng cửa sổ Chrome của @${acc.username}`,
                    });
                  }
                } catch (err: any) {
                  console.error('Failed to check cookies for multi-thread:', err);
                } finally {
                  resolve();
                }
              });
            });
          } catch (err: any) {
            console.error(`[Multi-Thread] Error opening Chrome for @${acc.username}:`, err);
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: `❌ [Multi-Thread] Lỗi khi mở Chrome cho @${acc.username}: ${err?.message || err}`,
            });
          }
        }
      };

      const initialBatchSize = Math.min(effectiveMaxThreads, queue.length);
      for (let i = 0; i < initialBatchSize; i++) {
        activeWorkers.push(runNextWorker());
      }

      Promise.allSettled(activeWorkers).then((results) => {
        const rejected = results.filter(r => r.status === 'rejected');
        if (rejected.length > 0) {
          console.error('[Multi-Thread] Some worker promises were rejected:', rejected);
        }
      }).catch(err => {
        console.error('[Multi-Thread] Worker supervisor error:', err);
      });

      return { success: true, message: `Multi-thread launcher started for ${selectedAccounts.length} accounts` };
    }
  );

  // 3. Execute Seeding Task across accounts
  ipcMain.handle(
    'execute-seeding-task',
    async (_event, config: SeedingTaskConfig, accounts: Array<AccountInfo & { proxy?: string; proxyType?: string }>) => {
      await assertClientLicensed();

      onLog({
        level: 'info',
        message: `🚀 Bắt đầu tác vụ Seeding trên ${config.targetType.toUpperCase()}: ${config.targetUrl}`,
      });

      const selectedAccounts = accounts.filter(a => config.accountIds.includes(a.id));

      if (selectedAccounts.length === 0) {
        onLog({
          level: 'error',
          message: 'Không có tài khoản nào được chọn để thực hiện tác vụ.',
        });
        return { success: false, message: 'No accounts selected' };
      }

      const effectiveMaxThreads = config.maxThreads && config.maxThreads > 0
        ? Math.min(config.maxThreads, selectedAccounts.length)
        : selectedAccounts.length;
      const queue = selectedAccounts.map((acc, index) => ({ acc, index }));
      let completedCount = 0;
      startSeedingRun();
      onSeedingStateChange?.({ isRunning: true });

      onLog({
        level: 'info',
        message: `🚀 Seeding đa luồng: mở ${effectiveMaxThreads}/${selectedAccounts.length} tài khoản cùng lúc...`,
      });

      const runSeedingWorker = async (workerIndex: number) => {
        if (workerIndex > 0) {
          await waitForSeedingDelay(workerIndex * 800);
        }

        while (queue.length > 0 && !isSeedingCancelRequested()) {
          const item = queue.shift();
          if (!item) return;
          const { acc, index } = item;

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[Worker ${workerIndex + 1}] [${index + 1}/${selectedAccounts.length}] Đang khởi tạo seeding cho @${acc.username}...`,
          });

          try {
            throwIfSeedingCancelled();
            await executeTaskForAccount(
              acc,
              config,
              onLog,
              onAccountStatusChange,
              onAccountSessionUpdate,
              loginWindows.size + index,
              onSeedingStateChange
            );
            completedCount++;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: `[Worker ${workerIndex + 1}] Hoàn thành @${acc.username} (${completedCount}/${selectedAccounts.length}).`,
            });
          } catch (err: any) {
            if (err instanceof SeedingCancelledError) {
              if (!isSeedingCancelRequested() && err.message === SEEDING_WINDOW_CLOSED_MESSAGE) {
                completedCount++;
                onLog({
                  accountId: acc.id,
                  accountUsername: acc.username,
                  level: 'warning',
                  message: `[Worker ${workerIndex + 1}] Dung worker cho @${acc.username}: cua so seeding da dong. Tiep tuc tai khoan ke tiep (${completedCount}/${selectedAccounts.length}).`,
                });
                continue;
              }

              requestSeedingCancel(err.message);
              onLog({
                accountId: acc.id,
                accountUsername: acc.username,
                level: 'warning',
                message: `[Worker ${workerIndex + 1}] Da dung seeding cho @${acc.username}: ${err.message}`,
              });
              return;
            }

            completedCount++;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: `Lỗi thực hiện tác vụ cho @${acc.username}: ${err.message || err}`,
            });
          }

          if (queue.length > 0 && effectiveMaxThreads < selectedAccounts.length && !isSeedingCancelRequested()) {
            const delayMs = Math.max(1, config.delaySeconds || 1) * 1000;
            await waitForSeedingDelay(delayMs);
          }
        }
      };

      const workers = Array.from(
        { length: effectiveMaxThreads },
        (_, workerIndex) => runSeedingWorker(workerIndex)
      );

      try {
        await Promise.all(workers);
      } finally {
        if (isSeedingCancelRequested()) {
          const cancelReason = getSeedingCancelReason() || 'da huy';
          onLog({
            level: 'warning',
            message: `Tac vu Seeding da dung: ${cancelReason}`,
          });
          onSeedingStateChange?.({
            isRunning: false,
            canceled: true,
            reason: cancelReason,
          });
          finishSeedingRun();
          return { success: false, canceled: true };
        }

        finishSeedingRun();
        onSeedingStateChange?.({ isRunning: false });
      }

      onLog({
        level: 'success',
        message: `🎉 Tác vụ Seeding đã hoàn thành toàn bộ ${selectedAccounts.length} tài khoản!`,
      });

      return { success: true };
    }
  );
}
