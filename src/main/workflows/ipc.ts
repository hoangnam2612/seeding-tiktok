import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ensurePersistentDataDir } from '../data-dir';
import { AccountsService } from '../nest/accounts/accounts.service';
import { AutomationService } from '../nest/automation/automation.service';
import { ClientAuthService } from '../nest/client-auth/client-auth.service';
import { generateTotpToken } from '../nest/accounts/totp.helper';
import { browserDefaults, Command } from './contracts';
import { validateBrowser, validateConfig, isTikTokUrl } from './validation';
import { parseProxy } from './browser';
import { NativeWorkflowService as WorkflowService } from './native-service';
import { parseAccounts, formatAccounts, exportAccounts } from './account-transfer';
import { pooled, check } from './control';

export function setupWorkflowIPC(accounts: AccountsService, logs: AutomationService, auth: ClientAuthService, mainWindow: () => BrowserWindow | null) {
  const root = path.join(ensurePersistentDataDir(), 'workflows');
  fs.mkdirSync(root, { recursive: true });
  const settingsPath = path.join(root, 'settings.json');
  let settings = { ...browserDefaults };
  try { settings = validateBrowser(JSON.parse(fs.readFileSync(settingsPath, 'utf8'))); } catch {}
  let state: any = { isRunning: false, command: '', events: [], results: [], deviceCodes: {}, message: '' };
  let busy = false, cancelRequested = false;
  let proxyController: AbortController | undefined;
  const service = new WorkflowService(root, {
    update: (id, patch) => { accounts.updateAccount(id, patch); },
    emit: event => {
      if (event.type === 'device-code') { state.deviceCodes[event.accountId] = event.code; return; }
      const value = { ...event, at: new Date().toISOString() };
      state.events.push(value);
      if (state.events.length > 2000) state.events.shift();
      if (event.type === 'item') state.results.push(value);
      logs.addLog({ accountId: event.accountId, accountUsername: accounts.getAccountById(event.accountId)?.username, level: event.type === 'item' ? event.success ? 'success' : 'error' : 'info', message: event.message || '' });
    },
  });
  const idle = () => { if (busy) throw new Error('Một tác vụ đang chạy. Hãy đợi hoặc dừng tác vụ.'); };
  const selected = (ids: unknown) => {
    if (!Array.isArray(ids) || !ids.length) throw new Error('Chọn ít nhất một tài khoản.');
    return [...new Set(ids)].map(id => {
      const account = accounts.getAccountById(String(id));
      if (!account) throw new Error('Tài khoản đã bị xóa; tải lại danh sách.');
      return account;
    });
  };
  ipcMain.handle('workflows', async (event, action: string, payload: any = {}) => {
    if (event.sender !== mainWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error('Yêu cầu IPC không hợp lệ.');
    switch (action) {
      case 'state': return { ...state, available: true, engine: 'csharp', settings };
      case 'cancel': cancelRequested = true; proxyController?.abort(); await service.cancel(); return { success: true };
      case 'settings': {
        idle(); const next = validateBrowser(payload);
        fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2)); settings = next; return { success: true };
      }
      case 'files': {
        const kind = payload.kind;
        const picked = await dialog.showOpenDialog(mainWindow()!, { properties: kind === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections'], filters: kind === 'video' ? [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'm4v', 'avi'] }] : kind === 'image' ? [{ name: 'Ảnh', extensions: ['png', 'jpg', 'jpeg', 'webp'] }] : [] });
        return picked.canceled ? [] : picked.filePaths.map(file => ({ path: file, title: path.basename(file, path.extname(file)), description: path.basename(file, path.extname(file)), size: String(fs.statSync(file).size) }));
      }
      case 'microsoft': await shell.openExternal('https://microsoft.com/devicelogin'); return { success: true };
      case 'open-result': if (!isTikTokUrl(String(payload.url))) throw new Error('URL không hợp lệ.'); await shell.openExternal(payload.url); return { success: true };
      case 'start': {
        idle(); busy = true; cancelRequested = false;
        try {
          if (!['video', 'live', 'profile', 'upload', 'login', 'outlook'].includes(payload.command)) throw new Error('Tác vụ không được hỗ trợ.');
          const command = payload.command as Command;
          const runSettings = payload.browserOverrides
            ? validateBrowser({ ...settings, maxThreads: payload.browserOverrides.maxThreads ?? settings.maxThreads, disableAudio: payload.browserOverrides.disableAudio ?? settings.disableAudio })
            : settings;
          const list = selected(payload.accountIds).map(a => ({ ...a }));
          const config = validateConfig(command, payload.config, list.length);
          if (command !== 'outlook') list.forEach(a => parseProxy(a.proxy, a.proxyType));
          const license = await auth.ensureLicensed();
          if (!license.ok) throw new Error(license.message || 'Bản quyền chưa hợp lệ.');
          if (cancelRequested) throw new Error('Đã hủy khởi chạy.');
          state = { isRunning: true, command, events: [], results: [], deviceCodes: {}, message: 'Đang chạy…' };
          void service.run(command, list, config, runSettings).then(result => Object.assign(state, result))
            .catch(error => {
              state.success = false; state.message = error.message;
              for (const account of list) {
                const message = `Không chạy được C# engine: ${error.message}`;
                accounts.updateAccount(account.id, { message, status: 'error' });
                logs.addLog({ accountId: account.id, accountUsername: account.username, level: 'error', message });
                state.events.push({ type: 'item', accountId: account.id, success: false, message, at: new Date().toISOString() });
              }
            })
            .finally(() => { busy = false; state.isRunning = false; state.deviceCodes = {}; });
          return { success: true };
        } catch (error) { busy = false; throw error; }
      }
      case 'close-browsers': idle(); await service.browsers.close(payload.accountIds?.length ? selected(payload.accountIds).map(a => a.id) : undefined); return { success: true };
      case 'copy-accounts': { const list = selected(payload.accountIds); clipboard.writeText(formatAccounts(list, String(payload.format || ''))); return { success: true, count: list.length }; }
      case 'copy-totp': {
        const code = generateTotpToken(selected(payload.accountIds)[0].twoFactor || '');
        if (!code) throw new Error('Tài khoản chưa có khóa 2FA hợp lệ.');
        clipboard.writeText(code); return { success: true, remaining: 30 - Math.floor(Date.now() / 1000) % 30 };
      }
      case 'copy-proxies': {
        const list = accounts.getAllProxies().filter(p => payload.proxyIds?.includes(p.id));
        if (!list.length) throw new Error('Chọn ít nhất một proxy.');
        clipboard.writeText(list.map(p => p.value).join('\n')); return { success: true, count: list.length };
      }
      case 'import-text': {
        idle(); const items = parseAccounts(String(payload.text || ''), String(payload.format || ''));
        let added = 0, updated = 0;
        for (const item of items) {
          const existing = accounts.getAllAccounts().find(a => (!!item.username && a.username === item.username) || (!!item.uid && a.uid === item.uid));
          if (existing) { accounts.updateAccount(existing.id, Object.fromEntries(Object.entries(item).filter(([, v]) => v !== ''))); updated++; }
          else { accounts.addAccount({ ...item, categoryId: payload.categoryId }); added++; }
        }
        return { success: true, added, updated };
      }
      case 'export': {
        idle(); busy = true;
        try {
          const list = selected(payload.accountIds), excel = payload.excel === true;
          const picked = await dialog.showSaveDialog(mainWindow()!, { defaultPath: excel ? 'accounts.xlsx' : 'accounts.txt', filters: [{ name: excel ? 'Excel' : 'Text', extensions: [excel ? 'xlsx' : 'txt'] }] });
          if (picked.canceled || !picked.filePath) return { canceled: true };
          await exportAccounts(picked.filePath, list, String(payload.format || ''), excel, id => accounts.getAllCategories().find(c => c.id === id)?.name || '');
          return { success: true };
        } finally { busy = false; }
      }
      case 'check-proxies': {
        idle(); const list = accounts.getAllProxies().filter(p => payload.proxyIds?.includes(p.id));
        if (!list.length) throw new Error('Chọn proxy để kiểm tra.');
        list.forEach(p => { if (!['http', 'socks5'].includes(p.proxyType)) throw new Error('Kiểm tra hỗ trợ proxy HTTP/SOCKS5 tĩnh.'); parseProxy(p.value, p.proxyType, true); });
        busy = true; proxyController = new AbortController(); const signal = proxyController.signal;
        state = { isRunning: true, command: 'check-proxies', events: [], results: [], deviceCodes: {}, message: 'Đang kiểm tra proxy…' };
        try {
          await pooled(list, settings.maxThreads, signal, async p => {
            let result;
            try { result = await service.browsers.checkProxy(p, signal); }
            catch (error) { check(signal); result = { success: false, message: (error as Error).message }; }
            const checkedAt = new Date().toISOString();
            accounts.updateProxy(p.id, { status: result.success ? 'active' : 'error', lastChecked: checkedAt });
            state.results.push({ ...result, id: p.id, checkedAt });
          });
          state.message = 'Đã kiểm tra proxy.'; return { success: true, results: state.results };
        } finally { if (signal.aborted) state.message = 'Đã dừng kiểm tra proxy.'; busy = false; state.isRunning = false; proxyController = undefined; }
      }
      default: throw new Error('Thao tác không được hỗ trợ.');
    }
  });
  let quitting = false;
  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault(); quitting = true; proxyController?.abort();
    void service.shutdown().catch(() => {}).finally(() => app.quit());
  });
}
