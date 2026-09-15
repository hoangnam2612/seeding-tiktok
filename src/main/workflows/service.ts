import { Page } from 'playwright-core';
import { BrowserPool } from './browser';
import { BrowserSettings, Command, Config, Hooks, LiveConfig, ProfileConfig, UploadConfig, VideoConfig } from './contracts';
import { OutlookService } from './outlook';
import { ensureLogin, ensureReady } from './login';
import { check, pooled } from './control';
import { allocateProfile, createUploadQueue } from './validation';
import { updateProfile, openProfile } from './profile';
import { uploadVideo } from './upload';
import { seedLive, seedVideo } from './seeding';
import { openSeedingTarget } from './navigation';
import { TikTokAccount } from '../nest/accounts/account.interface';

export class WorkflowService {
  readonly browsers: BrowserPool;
  readonly outlook: OutlookService;
  private controller?: AbortController;
  constructor(root: string, private hooks: Hooks) { this.browsers = new BrowserPool(root, hooks); this.outlook = new OutlookService(root); }
  async cancel() { this.controller?.abort(); await this.browsers.close(); }
  async run(command: Command, accounts: TikTokAccount[], config: Config, settings: BrowserSettings): Promise<{ success: boolean; canceled?: boolean; failures: number; remaining: number; message: string }> {
    if (this.controller) throw new Error('Một tác vụ đang chạy.');
    const queue = command === 'upload' ? createUploadQueue(config as UploadConfig) : [];
    const profileAssignments = command === 'profile' ? new Map(accounts.map(a => [a.id, allocateProfile(config as ProfileConfig)])) : undefined;
    const controller = this.controller = new AbortController(); const signal = controller.signal;
    let next = 0, failures = 0;
    try {
      await pooled(accounts, settings.maxThreads, signal, async (account, slot) => {
        const log = (message: string) => this.hooks.emit({ type: 'progress', accountId: account.id, message });
        const device = (code: string) => this.hooks.emit({ type: 'device-code', accountId: account.id, code });
        const result = (success: boolean, message: string, file?: string, url?: string) => { if (!success) failures++; this.hooks.update(account.id, { message, lastAction: command, lastActionAt: new Date().toISOString(), ...(!success ? { status: 'error' as const } : {}) }); this.hooks.emit({ type: 'item', accountId: account.id, success, message, file, url }); };
        let page: Page | undefined;
        try {
          if (command === 'outlook') { await this.outlook.connect(account.email || '', signal, device); result(true, 'Đã kết nối Outlook.'); return; }
          if (command === 'upload') {
            while (!signal.aborted && next < queue.length) {
              const item = queue[next++];
              try {
                page = await this.browsers.open(account, settings, slot, signal);
                await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' });
                await ensureLogin(page, account, this.outlook, signal, log, device); await this.browsers.persist(account, page);
                await page.goto('https://www.tiktok.com/upload?lang=en', { waitUntil: 'domcontentloaded' });
                const uploaded = await uploadVideo(page, item, config as UploadConfig, signal, log, account.username || account.uid);
                result(true, uploaded.message, item.path, uploaded.url);
              } catch (error) { check(signal); result(false, (error as Error).message, item.path); break; }
              finally { await this.browsers.close([account.id]); }
            }
            return;
          }
          log('Đang mở trình duyệt.'); page = await this.browsers.open(account, settings, slot, signal);
          await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' });
          await ensureLogin(page, account, this.outlook, signal, log, device, command === 'video' || command === 'live' ? 3 : 1); await this.browsers.persist(account, page);
          if (command === 'login') { result(true, 'Đăng nhập thành công.'); return; }
          if (command === 'profile') {
            await openProfile(page, account.username || account.uid || '', signal);
            const patch = await updateProfile(page, config as ProfileConfig, profileAssignments!.get(account.id)!, signal, log);
            this.hooks.update(account.id, patch); result(true, patch.message || 'Đã cập nhật hồ sơ.');
          }
          if (command === 'video' || command === 'live') {
            const urls = command === 'video' ? (config as VideoConfig).videoUrls : (config as LiveConfig).liveUrls;
            for (const url of urls) {
              check(signal); log('Đang mở ' + url); await openSeedingTarget(page, url, signal, log);
              const ready = async () => { await ensureReady(page!, account, this.outlook, signal, log, device, url); if (command === 'live') await page!.evaluate(zoom => { document.documentElement.style.setProperty('zoom', String(zoom)); document.body?.style.setProperty('zoom', String(zoom)); }, settings.livePageZoom); };
              await ready();
              if (command === 'live') { const errors = await seedLive(page, config as LiveConfig, signal, log, ready); result(errors === 0, errors ? `${errors} thao tác live chưa hoàn tất: ${url}` : `Đã xử lý live: ${url}`); }
              else { const errors = await seedVideo(page, config as VideoConfig, signal, log, ready); result(errors === 0, errors ? `${errors} thao tác chưa hoàn tất: ${url}` : `Đã tương tác: ${url}`); }
            }
            log('Đã xử lý các URL đã chọn.');
          }
          await this.browsers.persist(account, page);
        } catch (error) { if (!signal.aborted) result(false, (error as Error).message); else this.hooks.update(account.id, { message: 'Đã dừng tác vụ.', lastAction: command, lastActionAt: new Date().toISOString() }); }
        finally { if (command !== 'login' || signal.aborted) await this.browsers.close([account.id]); }
      });
      return { success: failures === 0 && next >= queue.length, failures, remaining: queue.length - next, message: next < queue.length ? `Còn ${queue.length - next} video chưa xử lý.` : 'Đã kết thúc tác vụ.' };
    } catch (error) {
      if (signal.aborted) return { success: false, canceled: true, failures, remaining: queue.length - next, message: 'Đã dừng tác vụ.' };
      throw error;
    } finally { this.controller = undefined; }
  }
}
