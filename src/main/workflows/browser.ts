import * as https from 'https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { chromium, BrowserContext, Page, Locator } from 'playwright-core';
import { createHash } from 'crypto';
import * as path from 'path';
import { screen } from 'electron';
import { BrowserSettings, Hooks } from './contracts';
import { TikTokAccount, ProxyEntry } from '../nest/accounts/account.interface';
import { check, until } from './control';

export type ProxyOptions = { server: string; username?: string; password?: string };
export function parseProxy(raw?: string, type = 'http', allowSocksAuth = false): ProxyOptions | undefined {
  if (!raw?.trim() || type === 'none') return undefined;
  if (!['http', 'socks5'].includes(type)) throw new Error('Chọn proxy HTTP/SOCKS5 tĩnh cho tác vụ này.');
  let input = raw.trim();
  if (!input.includes('://') && !input.includes('@')) {
    const pieces = input.split(':');
    if (pieces.length === 4) input = `${encodeURIComponent(pieces[2])}:${encodeURIComponent(pieces[3])}@${pieces[0]}:${pieces[1]}`;
  }
  const u = new URL(input.includes('://') ? input : `${type}://${input}`);
  const port = u.port || (u.protocol === 'http:' ? '80' : '');
  if (!['http:', 'socks5:'].includes(u.protocol) || !u.hostname || !port || Number(port) < 1 || Number(port) > 65535 || u.pathname !== '/' && u.pathname !== '' || u.search || u.hash) throw new Error('Proxy không hợp lệ.');
  if (u.protocol === 'socks5:' && !allowSocksAuth && (u.username || u.password)) throw new Error('Chrome không hỗ trợ SOCKS5 có mật khẩu; dùng proxy HTTP có xác thực.');
  return { server: `${u.protocol}//${u.host}`, ...(u.username || u.password ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : {}) };
}
export function parseCookies(raw?: string): Parameters<BrowserContext['addCookies']>[0] {
  if (!raw?.trim()) return [];
  if (raw.trim().startsWith('[')) {
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies)) throw new Error('Cookie JSON không hợp lệ.');
    return cookies.filter(c => typeof c.name === 'string' && typeof c.value === 'string' && (!c.domain || c.domain === 'tiktok.com' || c.domain === '.tiktok.com' || c.domain.endsWith('.tiktok.com'))).map(c => ({ name: c.name, value: c.value, domain: c.domain || '.tiktok.com', path: c.path || '/', secure: true, ...(typeof c.expirationDate === 'number' ? { expires: c.expirationDate } : {}) }));
  }
  return raw.split(';').map(pair => pair.trim()).filter(pair => pair.includes('=')).map(pair => {
    const eq = pair.indexOf('=');
    return { name: pair.slice(0, eq), value: pair.slice(eq + 1), domain: '.tiktok.com', path: '/', secure: true };
  });
}
export async function find(page: Page, selectors: string | string[], visible = true): Promise<Locator | undefined> {
  for (const frame of page.frames()) for (const selector of typeof selectors === 'string' ? [selectors] : selectors) {
    const matches = frame.locator(selector);
    const count = await matches.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const locator = matches.nth(i);
      if (!visible || await locator.isVisible().catch(() => false)) return locator;
    }
  }
}
export async function requireElement(page: Page, selectors: string | string[], signal: AbortSignal, message: string, timeout = 15000, visible = true): Promise<Locator> {
  return until(() => find(page, selectors, visible), signal, timeout, message);
}
export async function clickOptional(page: Page, selectors: string | string[], signal: AbortSignal): Promise<boolean> {
  check(signal);
  const target = await find(page, selectors);
  if (!target || !await target.isEnabled() || await target.getAttribute('aria-disabled') === 'true') return false;
  await target.click({ timeout: 5000 }); return true;
}
export function browserBounds(settings: BrowserSettings, slot: number, area: { x: number; y: number; width: number }) {
  // Match C# BrowserLayoutManager.CalculateSize/CalculatePosition. These are
  // Chrome coordinates; Chrome applies its device scale factor when displaying
  // the window. Do not multiply the size or position by scaleFactor again.
  const columns = Math.max(1, settings.columns), rows = Math.max(1, settings.rows);
  const rawWidth = settings.windowWidth > 0 ? settings.windowWidth : Math.floor(area.width / columns);
  const rawHeight = settings.windowHeight > 0 ? settings.windowHeight : Math.floor(rawWidth * 16 / 9);
  const width = Math.max(600, rawWidth), height = Math.min(700, rawHeight);
  const gridSlot = slot % (rows * columns);
  // The reference always places windows on the grid, including when autoArrangeGrid is false.
  return { width, height, left: area.x + gridSlot % columns * width, top: area.y + Math.floor(gridSlot / columns) * height };
}

export async function applyBrowserBounds(page: Page, bounds: ReturnType<typeof browserBounds>) {
  const session = await page.context().newCDPSession(page);
  try {
    const { windowId, bounds: current } = await session.send('Browser.getWindowForTarget');
    if (current.windowState !== 'normal') await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await session.send('Browser.setWindowBounds', { windowId, bounds });
  } finally { await session.detach(); }
}

export class BrowserPool {
  private contexts = new Map<string, BrowserContext>();
  private slots = new Map<string, number>();
  constructor(private root: string, private hooks: Hooks) {}
  async open(account: TikTokAccount, settings: BrowserSettings, slot: number, signal: AbortSignal): Promise<Page> {
    check(signal); await this.close([account.id]);
    slot = 0;
    while ([...this.slots.values()].includes(slot)) slot++;
    this.slots.set(account.id, slot);
    const area = screen.getPrimaryDisplay().workArea;
    const bounds = browserBounds(settings, slot, area);
    const { width, height, left, top } = bounds;
    const args = [`--window-size=${width},${height}`, `--window-position=${left},${top}`];
    // C# lets Chrome use the system DPI at 100%, and overrides it otherwise.
    if (Math.abs(settings.scaleFactor - 1) > .01) args.push(`--force-device-scale-factor=${Math.max(.5, Math.min(1, settings.scaleFactor))}`);
    if (settings.disableAudio) args.push('--mute-audio');
    const profilePath = path.join(this.root, 'profiles', createHash('sha256').update(account.id).digest('hex'));
    let context: BrowserContext;
    // Hide Chrome's automation infobar without removing other Playwright defaults.
    try { context = await chromium.launchPersistentContext(profilePath, { channel: 'chrome', headless: false, chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'], viewport: null, locale: 'vi-VN', proxy: parseProxy(account.proxy, account.proxyType), args, ...(account.userAgent ? { userAgent: account.userAgent } : {}) }); }
    catch (error) { this.slots.delete(account.id); throw error; }
    this.contexts.set(account.id, context);
    context.on('close', () => { if (this.contexts.get(account.id) === context) { this.contexts.delete(account.id); this.slots.delete(account.id); } });
    const onAbort = () => { void context.close().catch(() => {}); };
    signal.addEventListener('abort', onAbort, { once: true });
    context.on('close', () => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) { await context.close(); check(signal); }
    context.setDefaultTimeout(10000); context.setDefaultNavigationTimeout(30000);
    if (settings.disableImages) await context.route('**/*', route => route.request().resourceType() === 'image' ? route.abort() : route.continue());
    try {
      const existing = await context.cookies('https://www.tiktok.com');
      if (!existing.some(c => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name))) await context.addCookies(parseCookies(account.cookie));
    } catch (error) { await context.close(); throw new Error('Không nạp được cookie tài khoản.'); }
    const page = context.pages()[0] || await context.newPage();
    try { await applyBrowserBounds(page, bounds); }
    catch { check(signal); this.hooks.emit({ type: 'progress', accountId: account.id, message: 'Không đặt lại được kích thước/vị trí Chrome; đang dùng vị trí lúc mở.' }); }
    check(signal);
    return page;
  }
  async persist(account: TikTokAccount, page: Page) {
    if (page.isClosed()) return;
    const cookies = (await page.context().cookies('https://www.tiktok.com')).filter(c => c.domain === 'tiktok.com' || c.domain === '.tiktok.com' || c.domain.endsWith('.tiktok.com'));
    if (cookies.some(c => ['sessionid', 'sessionid_ss', 'sid_tt'].includes(c.name))) {
      account.cookie = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      this.hooks.update(account.id, { cookie: account.cookie, status: 'authenticated', lastUsed: new Date().toISOString() });
    }
  }
  async close(ids?: string[]) { await Promise.all([...this.contexts].filter(([id]) => !ids?.length || ids.includes(id)).map(async ([id, context]) => { this.contexts.delete(id); this.slots.delete(id); await context.close().catch(() => {}); })); }
  async checkProxy(proxy: ProxyEntry, signal: AbortSignal): Promise<{ success: boolean; message: string }> {
    check(signal);
    const parsed = parseProxy(proxy.value, proxy.proxyType, true)!;
    const address = new URL(parsed.server); address.username = parsed.username || ''; address.password = parsed.password || '';
    const agent = address.protocol === 'socks5:' ? new SocksProxyAgent(address) : new HttpsProxyAgent(address);
    const controller = new AbortController(), abort = () => controller.abort();
    const timer = setTimeout(abort, 12000); signal.addEventListener('abort', abort, { once: true });
    try {
      const ip = await new Promise<string>((resolve, reject) => {
        const request = https.get('https://api.ipify.org', { agent, signal: controller.signal }, response => {
          let body = ''; response.setEncoding('utf8');
          response.on('error', reject);
          response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(new Error('Phản hồi quá lớn.')); });
          response.on('end', () => response.statusCode === 200 ? resolve(body.trim()) : reject(new Error('Proxy không phản hồi thành công.')));
        }); request.on('error', reject);
      });
      const success = require('net').isIP(ip) !== 0;
      return { success, message: success ? ip : 'Proxy không trả về IP hợp lệ.' };
    } catch { check(signal); return { success: false, message: 'Không kết nối được proxy hoặc hết thời gian chờ.' }; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); agent.destroy(); }
  }
}
