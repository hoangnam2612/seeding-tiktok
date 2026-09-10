import { ipcMain } from 'electron';
import { SeedingTaskConfig, TaskLogItem } from './nest/automation/automation.interface';
import { AccountSessionUpdate } from './automation/session-profile';
import { AccountInfo, AccountStatus, SeedingStateChange } from './automation/types';
import { chromeProfileManager, puppeteerSeedingEngine } from './puppeteer';

export function setupAutomationIPC(
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  onSeedingStateChange?: (state: SeedingStateChange) => void,
  ensureClientLicensed?: () => Promise<{ ok: boolean; message?: string }>
) {
  const assertClientLicensed = async () => {
    if (!ensureClientLicensed) return;
    const res = await ensureClientLicensed();
    if (!res.ok) {
      throw new Error(res.message || 'Chưa có bản quyền hợp lệ.');
    }
  };

  // 1. Open Interactive Login Window for a TikTok Account (real Google Chrome profile)
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

      return await chromeProfileManager.openProfile(
        {
          accountId,
          username,
          cookie,
          proxy,
          proxyType,
          password,
          email,
          passMail,
          twoFactor,
          muteBrowserAudio,
        },
        onLog,
        onAccountStatusChange,
        onAccountSessionUpdate
      );
    }
  );

  // 2. Open Multi-Thread Account Chromes (real Google Chrome profiles)
  ipcMain.handle(
    'open-multi-account-chromes',
    async (_event, accountIds: string[], maxThreads: number = 10, accountsData: any[], muteBrowserAudio: boolean = true) => {
      await assertClientLicensed();

      const selectedAccounts = accountsData.filter(a => accountIds.includes(a.id));
      if (selectedAccounts.length === 0) {
        return { success: false, message: 'Chưa chọn tài khoản hợp lệ' };
      }
      const effectiveMaxThreads = maxThreads > 0 ? Math.min(maxThreads, selectedAccounts.length) : selectedAccounts.length;

      onLog({
        level: 'info',
        message: `🚀 Bắt đầu khởi chạy ${selectedAccounts.length} Chrome Profiles đa luồng (Tối đa ${effectiveMaxThreads} luồng song song)...`,
      });

      const queue = [...selectedAccounts];

      const runNextWorker = async (): Promise<void> => {
        while (queue.length > 0) {
          const acc = queue.shift();
          if (!acc) break;

          try {
            await chromeProfileManager.openProfile(
              {
                accountId: acc.id,
                username: acc.username,
                cookie: acc.cookie,
                proxy: acc.proxy,
                proxyType: acc.proxyType || 'http',
                password: acc.password,
                email: acc.email,
                passMail: acc.passMail,
                twoFactor: acc.twoFactor,
                muteBrowserAudio,
              },
              onLog,
              onAccountStatusChange,
              onAccountSessionUpdate
            );
          } catch (err: any) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: `[Multi-Thread] Lỗi khi mở Chrome cho @${acc.username}: ${err?.message || err}`,
            });
          }
        }
      };

      const workers = Array.from({ length: effectiveMaxThreads }, () => runNextWorker());
      Promise.all(workers).catch(err => {
        console.error('[OpenMultiChromes] Error running workers:', err);
      });

      return { success: true, count: selectedAccounts.length };
    }
  );

  // 3. Close All Browser Windows
  ipcMain.handle('close-all-browser-windows', async () => {
    const closedChromes = await chromeProfileManager.closeAllProfiles();
    onLog({
      level: 'info',
      message: `🚪 Đã đóng toàn bộ ${closedChromes} cửa sổ trình duyệt Chrome.`,
    });
    return { success: true, count: closedChromes };
  });

  // 4. Realign / Tile all active Chrome windows (Chrome View)
  ipcMain.handle('realign-active-chromes', async () => {
    const count = await chromeProfileManager.relayoutActiveProfiles();
    onLog({
      level: 'info',
      message: `📐 Đã gom và sắp xếp lại lưới cho ${count} cửa sổ Chrome.`,
    });
    return { success: true, count };
  });

  // 5. Get active Chromes count
  ipcMain.handle('get-active-chromes-count', async () => {
    return { count: chromeProfileManager.getActiveCount() };
  });

  // 6. Execute Seeding Task across accounts (real Google Chrome / Puppeteer engine)
  ipcMain.handle(
    'execute-seeding-task',
    async (_event, config: SeedingTaskConfig, accounts: Array<AccountInfo & { proxy?: string; proxyType?: string }>) => {
      await assertClientLicensed();

      return await puppeteerSeedingEngine.executeSeedingTasks(
        config,
        accounts,
        onLog,
        onAccountStatusChange,
        onAccountSessionUpdate,
        onSeedingStateChange
      );
    }
  );
}
