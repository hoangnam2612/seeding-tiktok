import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import { ensurePersistentDataDir } from '../../data-dir';
import { decryptSecret, encryptSecret } from '../../secret-json';
import { ClientAuthApiResult, ClientAuthState, PublicClientAuthState } from './client-auth.interface';
import { loadAuthSettings } from './auth-settings';

const AUTH_BASE_URL = 'https://walker-unobsequious-vertebrally.ngrok-free.dev';
const AUTH_STATE_FILE = 'client-auth.json';

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  accessToken?: string;
  retryOnUnauthorized?: boolean;
};

@Injectable()
export class ClientAuthService {
  private readonly settings = loadAuthSettings(AUTH_BASE_URL);
  private dataDir = ensurePersistentDataDir();
  private authFilePath = path.join(this.dataDir, AUTH_STATE_FILE);

  private ensurePaths() {
    this.dataDir = ensurePersistentDataDir();
    this.authFilePath = path.join(this.dataDir, AUTH_STATE_FILE);
  }

  getPublicState(): PublicClientAuthState {
    const state = this.readState();
    return this.toPublicState(state);
  }

  async resetPassword(payload: { email: string; otpCode: string; newPassword: string }) {
    return this.request('/api/auth/reset-password', { method: 'POST', body: { email: payload.email.trim(), otpCode: payload.otpCode.trim(), newPassword: payload.newPassword }, retryOnUnauthorized: false });
  }

  getRememberedLogin(): { username: string; password: string } | null {
    this.ensurePaths();
    try { const value = JSON.parse(fs.readFileSync(path.join(this.dataDir, 'remembered-login.json'), 'utf8')); return { username: value.username, password: safeStorage.decryptString(Buffer.from(value.encryptedPassword, 'base64')) }; } catch { return null; }
  }
  rememberLogin(username: string, password: string, remember: boolean) {
    this.ensurePaths(); const file = path.join(this.dataDir, 'remembered-login.json');
    if (!remember) { if (fs.existsSync(file)) fs.unlinkSync(file); return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Không thể ghi nhớ mật khẩu an toàn trên máy này.');
    fs.writeFileSync(file, JSON.stringify({ username, encryptedPassword: safeStorage.encryptString(password).toString('base64') }));
  }

  async bootstrap(): Promise<ClientAuthApiResult<{ auth: PublicClientAuthState; update: any }>> {
    const update = await this.checkUpdate().catch(error => ({
      success: false,
      message: error?.message || 'Không kiểm tra được cập nhật.',
      data: null,
    }));
    const auth = await this.getMe();
    return {
      success: auth.success,
      message: auth.message,
      data: {
        auth: this.getPublicState(),
        update: update.data || update,
      },
    };
  }

  async sendOtp(email: string, purpose: 'register' | 'forgot-password' = 'register'): Promise<ClientAuthApiResult> {
    return this.request('/api/auth/send-otp', {
      method: 'POST',
      body: { email: email.trim(), purpose },
      retryOnUnauthorized: false,
    });
  }

  async register(payload: { username: string; email: string; password: string; otpCode: string }): Promise<ClientAuthApiResult> {
    return this.request('/api/auth/register', {
      method: 'POST',
      body: {
        username: payload.username.trim(),
        email: payload.email.trim(),
        password: payload.password,
        otpCode: payload.otpCode.trim(),
      },
      retryOnUnauthorized: false,
    });
  }

  async login(username: string, password: string): Promise<ClientAuthApiResult<PublicClientAuthState>> {
    const result = await this.request('/api/auth/login', {
      method: 'POST',
      body: {
        username: username.trim(),
        password,
        hwid: this.getMachineHwid(),
        deviceName: os.hostname(),
        appCode: this.settings.appCode,
      },
      retryOnUnauthorized: false,
    });

    if (!result.success || !result.data) return result;

    const data = result.data as any;
    if (!data.accessToken || !data.refreshToken || data.appCode !== this.settings.appCode) return { success: false, message: 'Server trả về phiên không hợp lệ hoặc sai mã sản phẩm.' };
    this.saveState({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
      appCode: data.appCode || this.settings.appCode,
      expiresAt: data.expiresAt ?? null,
      isExpired: !!data.isExpired,
      lastCheckedAt: new Date().toISOString(),
    });

    return {
      success: true,
      message: data.isExpired || !data.expiresAt
        ? 'Đăng nhập thành công nhưng bản quyền chưa kích hoạt hoặc đã hết hạn.'
        : 'Đăng nhập thành công.',
      data: this.getPublicState(),
    };
  }

  async getMe(): Promise<ClientAuthApiResult<PublicClientAuthState>> {
    const state = this.readState();
    if (!state.accessToken && !state.refreshToken) {
      return { success: false, message: 'Chưa đăng nhập.', data: this.toPublicState(state) };
    }

    let accessToken = state.accessToken;
    if (!accessToken && state.refreshToken) {
      const refreshed = await this.refreshToken(state.refreshToken);
      if (!refreshed.success) return { ...refreshed, data: this.getPublicState() };
      accessToken = this.readState().accessToken;
    }

    const result = await this.request(`/api/auth/me?appCode=${encodeURIComponent(this.settings.appCode)}`, {
      method: 'GET',
      accessToken,
    });

    if (!result.success || !result.data) return { ...result, data: this.getPublicState() };

    const data = result.data as any;
    if (data.appCode !== this.settings.appCode) return { success: false, message: 'Phiên không thuộc sản phẩm này.' };
    if (data.user?.status && data.user.status !== 'active') {
      this.saveState({
        ...this.readState(),
        user: data.user,
        appCode: data.appCode || this.settings.appCode,
        expiresAt: data.expiresAt ?? null,
        isExpired: true,
        lastCheckedAt: new Date().toISOString(),
      });
      return {
        success: false,
        message: 'Tài khoản đã bị khóa hoặc không còn hoạt động.',
        data: this.getPublicState(),
      };
    }

    this.saveState({
      ...this.readState(),
      user: data.user,
      appCode: data.appCode || this.settings.appCode,
      expiresAt: data.expiresAt ?? null,
      isExpired: !!data.isExpired,
      lastCheckedAt: new Date().toISOString(),
    });

    return { success: true, data: this.getPublicState() };
  }

  async activateLicense(keyCode: string): Promise<ClientAuthApiResult<PublicClientAuthState>> {
    const state = this.readState();
    const result = await this.request('/api/licenses/activate', {
      method: 'POST',
      accessToken: state.accessToken,
      body: { keyCode: keyCode.trim() },
    });

    if (!result.success || !result.data) return { ...result, data: this.getPublicState() };

    const data = result.data as any;
    this.saveState({
      ...this.readState(),
      appCode: data.appCode || this.settings.appCode,
      expiresAt: data.expiresAt ?? null,
      isExpired: false,
      lastCheckedAt: new Date().toISOString(),
    });

    return {
      success: true,
      message: data.message || 'Kích hoạt bản quyền thành công.',
      data: this.getPublicState(),
    };
  }

  async checkUpdate(): Promise<ClientAuthApiResult> {
    return this.request(`/api/update/${encodeURIComponent(process.platform)}/${encodeURIComponent(app.getVersion())}`, {
      method: 'GET',
      retryOnUnauthorized: false,
    });
  }

  async reportTelemetry(actionType: string, details: string): Promise<ClientAuthApiResult> {
    const state = this.readState();
    if (!state.accessToken) return { success: false, message: 'Chưa đăng nhập.' };
    return this.request('/api/telemetry/report', {
      method: 'POST',
      accessToken: state.accessToken,
      body: {
        actionType,
        hwid: this.getMachineHwid(),
        details,
      },
    });
  }

  async saveWebhookConfig(payload: {
    name?: string;
    webhookUrl: string;
    secretKey?: string;
    isEnabled: boolean;
    events: string[];
  }): Promise<ClientAuthApiResult> {
    const state = this.readState();
    if (!state.accessToken) return { success: false, message: 'Chưa đăng nhập.' };
    return this.request('/api/admin/webhooks/config', {
      method: 'POST',
      accessToken: state.accessToken,
      body: {
        name: payload.name?.trim() || 'Tikmax Client Webhook',
        webhookUrl: payload.webhookUrl.trim(),
        secretKey: payload.secretKey?.trim() || undefined,
        isEnabled: payload.isEnabled,
        events: payload.events,
      },
    });
  }

  async getWebhookConfig(): Promise<ClientAuthApiResult> {
    const state = this.readState();
    if (!state.accessToken) return { success: false, message: 'Chưa đăng nhập.' };
    return this.request('/api/admin/webhooks/config', {
      method: 'GET',
      accessToken: state.accessToken,
    });
  }

  async testWebhook(): Promise<ClientAuthApiResult> {
    const state = this.readState();
    if (!state.accessToken) return { success: false, message: 'Chưa đăng nhập.' };
    return this.request('/api/admin/webhooks/test', {
      method: 'POST',
      accessToken: state.accessToken,
    });
  }

  async logout(): Promise<PublicClientAuthState> {
    const state = this.readState();
    try {
      if (state.accessToken) await this.request('/api/auth/logout', { method: 'POST', accessToken: state.accessToken, body: { refreshToken: state.refreshToken }, retryOnUnauthorized: false });
    } finally { this.saveState({}); }
    return this.getPublicState();
  }

  async ensureLicensed(): Promise<{ ok: boolean; message?: string; auth: PublicClientAuthState }> {
    const checked = await this.getMe();
    const auth = this.getPublicState();
    if (!checked.success) return { ok: false, message: checked.message || 'Không xác minh được quyền sử dụng với server.', auth };
    if (!auth.authenticated) {
      return { ok: false, message: checked.message || 'Vui lòng đăng nhập để sử dụng phần mềm.', auth };
    }
    if (auth.blocked) {
      return { ok: false, message: auth.message || 'Tài khoản đã bị khóa hoặc không còn hoạt động.', auth };
    }
    if (!auth.licensed) {
      return { ok: false, message: 'Bản quyền TIKMAX chưa kích hoạt hoặc đã hết hạn.', auth };
    }
    return { ok: true, auth };
  }

  private async refreshToken(refreshToken?: string): Promise<ClientAuthApiResult> {
    if (!refreshToken) return { success: false, message: 'Không có refresh token.' };
    const result = await this.request('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken },
      retryOnUnauthorized: false,
    });

    if (!result.success || !result.data) {
      this.saveState({});
      return result;
    }

    const data = result.data as any;
    this.saveState({
      ...this.readState(),
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      lastCheckedAt: new Date().toISOString(),
    });
    return { success: true };
  }

  private async request(pathname: string, options: RequestOptions = {}): Promise<ClientAuthApiResult> {
    const url = `${this.settings.baseUrl}${pathname}`;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': '1',
    };
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

    const response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(25000),
    });

    let data: any = null;
    const text = await response.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }

    if (response.status === 401 && options.retryOnUnauthorized !== false) {
      const state = this.readState();
      if (state.refreshToken) {
        const refreshed = await this.refreshToken(state.refreshToken);
        if (refreshed.success) {
          return this.request(pathname, {
            ...options,
            accessToken: this.readState().accessToken,
            retryOnUnauthorized: false,
          });
        }
      }
    }

    if (!response.ok || data?.success === false) {
      return {
        success: false,
        statusCode: response.status,
        message: data?.message || `Yêu cầu thất bại (${response.status}).`,
        data,
      };
    }

    return { success: true, statusCode: response.status, message: data?.message, data };
  }

  private readState(): ClientAuthState {
    try {
      this.ensurePaths();
      if (!fs.existsSync(this.authFilePath)) return {};
      const raw = JSON.parse(fs.readFileSync(this.authFilePath, 'utf-8')) as ClientAuthState;
      return {
        ...raw,
        accessToken: decryptSecret(raw.accessToken),
        refreshToken: decryptSecret(raw.refreshToken),
      };
    } catch (err) {
      console.error('[ClientAuth] Failed to read auth state:', err);
      return {};
    }
  }

  private saveState(state: ClientAuthState) {
    this.ensurePaths();
    const storageState: ClientAuthState = {
      ...state,
      accessToken: state.accessToken ? encryptSecret(state.accessToken) : '',
      refreshToken: state.refreshToken ? encryptSecret(state.refreshToken) : '',
    };
    fs.writeFileSync(this.authFilePath, JSON.stringify(storageState, null, 2), 'utf-8');
  }

  private toPublicState(state: ClientAuthState): PublicClientAuthState {
    const expiresAt = state.expiresAt ?? null;
    const expiredByDate = expiresAt ? Date.parse(expiresAt) <= Date.now() : true;
    const userStatus = state.user?.status;
    const blocked = !!userStatus && userStatus !== 'active';
    const isExpired = state.isExpired !== false || expiredByDate || blocked;
    return {
      authenticated: !!state.accessToken,
      licensed: !!state.accessToken && !!expiresAt && !isExpired && !blocked,
      blocked,
      user: state.user,
      appCode: state.appCode || this.settings.appCode,
      expiresAt,
      isExpired,
      message: blocked ? 'Tài khoản đã bị khóa hoặc không còn hoạt động.' : undefined,
      lastCheckedAt: state.lastCheckedAt,
    };
  }

  private getMachineHwid(): string {
    const nets = os.networkInterfaces();
    const mac = Object.values(nets)
      .flat()
      .find(item => item && !item.internal && item.mac && item.mac !== '00:00:00:00:00:00')?.mac || '';
    return crypto
      .createHash('sha256')
      .update([os.hostname(), os.userInfo().username, os.platform(), os.arch(), mac].join('|'))
      .digest('hex')
      .slice(0, 48)
      .toUpperCase();
  }
}
