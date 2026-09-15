import { app } from 'electron';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { BrowserSettings, Command, Config, Hooks } from './contracts';
import { TikTokAccount } from '../nest/accounts/account.interface';
import { BrowserPool, parseProxy } from './browser';

type Result = { success: boolean; canceled?: boolean; failures: number; remaining: number; message: string };
export class NativeWorkflowService {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private sequence = 0;
  private runPromise?: Promise<Result>;
  private ids: Record<string, number>;
  readonly browsers: { close: (ids?: string[]) => Promise<void>; checkProxy: BrowserPool['checkProxy'] };
  constructor(private root: string, private hooks: Hooks) {
    fs.mkdirSync(root, { recursive: true });
    const file = path.join(root, 'engine-ids.json');
    this.ids = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const checker = new BrowserPool(root, hooks);
    this.browsers = { close: async ids => { if (this.child) await this.request('close', { ids: ids?.map(id => this.ids[id]).filter(Boolean) || [] }); }, checkProxy: checker.checkProxy.bind(checker) };
  }
  private engineId(id: string) {
    if (!Object.hasOwn(this.ids, id)) {
      this.ids[id] = Math.max(0, ...Object.values(this.ids)) + 1;
      fs.writeFileSync(path.join(this.root, 'engine-ids.json'), JSON.stringify(this.ids));
    }
    return this.ids[id];
  }
  private start() {
    if (this.child) return;
    const file = app.isPackaged ? path.join(process.resourcesPath, 'native-engine', 'TikTokEngine.exe') : path.resolve('native-engine', 'publish', 'TikTokEngine.exe');
    if (!fs.existsSync(file)) throw new Error('Chưa có C# engine. Chạy npm run build:engine rồi mở lại ứng dụng.');
    const data = path.join(this.root, 'csharp'); fs.mkdirSync(data, { recursive: true });
    const child = this.child = spawn(file, [], { cwd: data, windowsHide: true, env: { ...process.env, TIKTOK_ENGINE_DATA: data }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume(); // Driver diagnostics can contain sensitive data; never forward raw stderr.
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
      try {
        const value = JSON.parse(line);
        if (value.kind === 'event') this.hooks.emit(value.value);
        else if (value.kind === 'account') this.update(value.accountId, value.value);
        else if (this.pending.has(value.id)) { const pending = this.pending.get(value.id)!; this.pending.delete(value.id); value.error ? pending.reject(new Error(value.error)) : pending.resolve(value.result); }
      } catch { /* Non-protocol driver output is never exposed. */ }
    });
    const failed = () => {
      if (this.child !== child) return;
      this.child = undefined; reader.close();
      for (const pending of this.pending.values()) pending.reject(new Error('C# engine đã dừng hoặc không khởi động được.'));
      this.pending.clear();
    };
    child.once('error', failed); child.once('exit', failed); child.stdin.on('error', failed);
  }
  private request(action: string, payload: unknown = {}) {
    this.start(); const id = String(++this.sequence);
    return new Promise<any>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.child!.stdin.write(JSON.stringify({ id, action, payload }) + '\n'); });
  }
  private update(id: string, value: any) {
    const status = /checkpoint|verify|xác minh/i.test(value.status || '') ? 'checkpoint' : /die|banned|khóa/i.test(value.status || '') ? 'die' : /live|success|authenticated|active/i.test(value.status || '') && value.status !== 'unauthenticated' ? 'authenticated' : value.status === 'unauthenticated' ? 'unauthenticated' : 'error';
    const patch = { uid: value.uid, username: value.username, displayName: value.name, cookie: value.cookies, bio: value.bio, avatarUrl: value.avatar, message: value.message, lastAction: value.lastAction, lastActionAt: value.lastTimeAction, status };
    this.hooks.update(id, Object.fromEntries(Object.entries(patch).filter(([, data]) => data !== null && data !== undefined)));
  }
  async run(command: Command, accounts: TikTokAccount[], config: Config, settings: BrowserSettings): Promise<Result> {
    if (this.runPromise) throw new Error('Một tác vụ đang chạy.');
    const mapped = accounts.map(account => {
      const proxy = parseProxy(account.proxy, account.proxyType);
      if (proxy && !proxy.server.startsWith('http:')) throw new Error('C# engine hiện dùng proxy HTTP; hãy chọn proxy HTTP cho tài khoản.');
      const address = proxy ? new URL(proxy.server) : undefined;
      // Map the engine contract explicitly: Electron category IDs are strings and
      // counters are numbers, whereas the native model expects int/string respectively.
      return { externalId: account.id, id: this.engineId(account.id), categoryId: 0,
        uid: account.uid, username: account.username, name: account.displayName,
        password: account.password, cookies: account.cookie, twoFA: account.twoFactor,
        email: account.email, passmail: account.passMail, recoveryMail: account.recoveryMail,
        token: account.token, userAgent: account.userAgent, bio: account.bio,
        note: account.notes, avatar: account.avatarUrl, status: account.status,
        followerCount: String(account.followerCount ?? 0), followingCount: String(account.followingCount ?? 0), likesCount: String(account.likesCount ?? 0),
        proxy: address ? `${address.hostname}:${address.port || 80}${proxy!.username || proxy!.password ? ':' + (proxy!.username || '') + ':' + (proxy!.password || '') : ''}` : null };
    });
    const pending = this.runPromise = this.request('run', { command, accounts: mapped, config, settings });
    try { return await pending; } finally { this.runPromise = undefined; }
  }
  async cancel() {
    if (!this.child) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.request('cancel').then(() => this.runPromise), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Engine không phản hồi dừng.')), 15000); })]);
    } catch (error) { await this.terminate(); throw error; }
    finally { clearTimeout(timer); }
  }
  private async terminate() {
    const child = this.child; if (!child?.pid) return;
    await new Promise<void>(resolve => { const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); killer.once('exit', () => resolve()); killer.once('error', () => { child.kill(); resolve(); }); });
  }
  async shutdown() { try { await this.cancel(); } finally { this.child?.stdin.end(); } }
}
