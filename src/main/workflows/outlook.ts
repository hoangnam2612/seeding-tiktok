import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { check, delay } from './control';

const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0/';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CLIENT_ID = '8550482d-40af-4c22-8996-aebd9c59b88a';
const SCOPE = 'https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access';
type Credential = { accessToken: string; refreshToken: string; expiresAt: number };
export function supportsOutlook(email: string) { return /^[^@\s]+@(hotmail|outlook|live|msn)\.[a-z.]+$/i.test(email); }
export function trustedMicrosoftUrl(input: string, allowLanding = false): boolean {
  try { const u = new URL(input); return u.protocol === 'https:' && !u.port && !u.username && !u.password && ['login.microsoftonline.com', 'login.live.com', ...(allowLanding ? ['microsoft.com', 'www.microsoft.com'] : [])].includes(u.hostname); } catch { return false; }
}
export function extractMailCode(message: any, email: string, since: number, now = Date.now()): string | undefined {
  if (String(message?.from?.emailAddress?.address).toLowerCase() !== 'noreply@account.tiktok.com') return;
  const received = Date.parse(message.receivedDateTime);
  if (!Number.isFinite(received) || received < since || received > now + 60000) return;
  if (!Array.isArray(message.toRecipients) || !message.toRecipients.some((r: any) => r?.emailAddress?.address?.toLowerCase() === email.trim().toLowerCase())) return;
  const body = String(message.body?.content || '').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')
    .replace(/&#(x[\da-f]+|\d+);/gi, (_, n) => { const code = n[0].toLowerCase() === 'x' ? parseInt(n.slice(1), 16) : Number(n); return code <= 0x10ffff ? String.fromCodePoint(code) : ''; }).replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  const text = `${message.subject || ''} ${body}`;
  if (!/code|verification|verify|mã|xác minh/i.test(text)) return;
  const codes = [...new Set(text.match(/(?<!\d)\d{6}(?!\d)/g) || [])];
  return codes.length === 1 ? codes[0] : undefined;
}
export class OutlookService {
  private locks = new Map<string, Promise<unknown>>();
  constructor(private root: string, private fetcher: typeof fetch = fetch) {}
  private file(email: string) { return path.join(this.root, 'outlook', createHash('sha256').update(CLIENT_ID + '|' + email.trim().toLowerCase()).digest('hex') + '.dat'); }
  private load(email: string): Credential | undefined {
    const file = this.file(email);
    if (!fs.existsSync(file)) return;
    try { return JSON.parse(safeStorage.decryptString(fs.readFileSync(file))); } catch { throw new Error('Không giải mã được kết nối Outlook. Kết nối lại hộp thư.'); }
  }
  private save(email: string, credential: Credential) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Không thể lưu kết nối Outlook an toàn trên máy này.');
    const file = this.file(email); fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = file + '.tmp'; fs.writeFileSync(temporary, safeStorage.encryptString(JSON.stringify(credential))); fs.renameSync(temporary, file);
  }
  private async serial<T>(email: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const key = email.trim().toLowerCase(); const previous = this.locks.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => { check(signal); return work(); });
    this.locks.set(key, next);
    try { return await next; } finally { if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private async request(url: string, init: RequestInit, signal: AbortSignal) {
    check(signal);
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 25000);
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      // Consume the body before releasing the timeout and cancellation handlers.
      const body = await response.text();
      return { ok: response.ok, status: response.status, headers: response.headers, json: async () => JSON.parse(body) };
    }
    finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
  private async post(endpoint: string, fields: Record<string, string>, signal: AbortSignal): Promise<any> {
    const response = await this.request(AUTHORITY + endpoint, { method: 'POST', body: new URLSearchParams(fields) }, signal);
    const result = await response.json();
    if (!response.ok && !result.error) throw new Error(`Microsoft không phản hồi thành công (${response.status}).`);
    return result;
  }
  private parse(value: any, previous = ''): Credential {
    if (typeof value.access_token !== 'string' || !Number.isFinite(value.expires_in)) throw new Error('Microsoft không trả token hợp lệ.');
    return { accessToken: value.access_token, refreshToken: value.refresh_token || previous, expiresAt: Date.now() + value.expires_in * 1000 };
  }
  async connect(email: string, signal: AbortSignal, showCode: (code: string) => void, browserStep?: (code: string, url: string, signal: AbortSignal) => Promise<void>) {
    if (!supportsOutlook(email)) throw new Error('Kết nối này hỗ trợ Outlook/Hotmail cá nhân.');
    return this.serial(email, signal, async () => {
      const device = await this.post('devicecode', { client_id: CLIENT_ID, scope: SCOPE }, signal);
      if (!device.user_code || !device.device_code || !trustedMicrosoftUrl(device.verification_uri || '', true)) throw new Error('Không nhận được mã kết nối Microsoft hợp lệ.');
      const deadline = Date.now() + Math.min(900, device.expires_in || 900) * 1000;
      let interval = Math.max(5, device.interval || 5); showCode(device.user_code);
      const browserController = new AbortController();
      const abortBrowser = () => browserController.abort(); signal.addEventListener('abort', abortBrowser, { once: true });
      let browserError: unknown;
      const browserTask = browserStep ? Promise.resolve().then(() => browserStep(device.user_code, device.verification_uri, browserController.signal)).catch(error => { if (!browserController.signal.aborted) browserError = error; }) : undefined;
      try {
      while (Date.now() < deadline) {
        await delay(interval * 1000, signal);
        if (browserError) throw browserError;
        const result = await this.post('token', { client_id: CLIENT_ID, device_code: device.device_code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }, signal);
        if (result.error === 'authorization_pending') continue;
        if (result.error === 'slow_down') { interval += 5; continue; }
        if (result.error) throw new Error('Kết nối Outlook bị từ chối hoặc hết hạn.');
        const credential = this.parse(result);
        const response = await this.request(GRAPH + '/me?$select=mail,userPrincipalName,otherMails', { headers: { Authorization: `Bearer ${credential.accessToken}` } }, signal);
        if (!response.ok) throw new Error('Không xác minh được email Outlook đã cấp quyền.');
        const profile = await response.json();
        if (![profile.mail, profile.userPrincipalName, ...(profile.otherMails || [])].some((v: unknown) => typeof v === 'string' && v.toLowerCase() === email.trim().toLowerCase())) throw new Error('Bạn đã cấp quyền cho email khác. Hãy đăng nhập đúng hộp thư.');
        this.save(email, credential); return;
      }
      throw new Error('Mã kết nối Outlook đã hết hạn.');
      } finally { abortBrowser(); await browserTask; signal.removeEventListener('abort', abortBrowser); }
    });
  }
  async accessToken(email: string, signal: AbortSignal, force = false): Promise<string> {
    return this.serial(email, signal, async () => {
      const saved = this.load(email); if (!saved) throw new Error('Chưa kết nối Outlook.');
      if (!force && saved.expiresAt > Date.now() + 120000) return saved.accessToken;
      const result = await this.post('token', { client_id: CLIENT_ID, refresh_token: saved.refreshToken, grant_type: 'refresh_token', scope: SCOPE }, signal);
      if (result.error) throw new Error('Outlook yêu cầu kết nối lại.');
      const next = this.parse(result, saved.refreshToken); this.save(email, next); return next.accessToken;
    });
  }
  async connected(email: string, signal: AbortSignal) { try { await this.accessToken(email, signal); return true; } catch { check(signal); return false; } }
  async waitForCode(email: string, since: number, signal: AbortSignal): Promise<string> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 120000);
    const abort = () => controller.abort(); signal.addEventListener('abort', abort, { once: true });
    try { check(signal); return await this.readCode(email, since, controller.signal); }
    catch (error) { check(signal); if (controller.signal.aborted) throw new Error('Hết 120 giây chờ mã email mới.'); throw error; }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  private async readCode(email: string, since: number, signal: AbortSignal): Promise<string> {
    if (!supportsOutlook(email)) throw new Error('Lấy mã email hiện hỗ trợ Outlook/Hotmail cá nhân.');
    let token = await this.accessToken(email, signal); let refreshed = false;
    const deadline = Date.now() + 120000;
    const query = new URLSearchParams({ $top: '50', $orderby: 'receivedDateTime desc', $filter: `receivedDateTime ge ${new Date(since).toISOString()} and from/emailAddress/address eq 'noreply@account.tiktok.com'`, $select: 'id,from,toRecipients,receivedDateTime,subject,body' });
    while (Date.now() < deadline) {
      check(signal);
      const response = await this.request(GRAPH + '/me/messages?' + query, { headers: { Authorization: `Bearer ${token}` } }, signal);
      if (response.status === 401 && !refreshed) { token = await this.accessToken(email, signal, true); refreshed = true; continue; }
      if (response.status === 429 || response.status >= 500) { const raw = response.headers.get('retry-after'); const retry = raw && /^\d+$/.test(raw) ? Number(raw) * 1000 : raw ? Date.parse(raw) - Date.now() : 8000; await delay(Number.isFinite(retry) && retry > 0 ? retry : 8000, signal); continue; }
      if (!response.ok) throw new Error(`Không đọc được Outlook (${response.status}). Kết nối lại hộp thư.`);
      const messages = await response.json();
      for (const message of messages.value || []) { const code = extractMailCode(message, email, since); if (code) return code; }
      await delay(5000, signal);
    }
    throw new Error('Hết 120 giây chờ mã email mới.');
  }
}
