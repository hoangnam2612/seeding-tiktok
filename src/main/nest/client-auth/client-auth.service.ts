import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app } from 'electron';
import { ensurePersistentDataDir } from '../../data-dir';
import { decryptSecret, encryptSecret } from '../../secret-json';
import { ClientAuthApiResult, ClientAuthState, PublicClientAuthState } from './client-auth.interface';

const AUTH_BASE_URL = 'https://voting-registry-produce.ngrok-free.dev';
const APP_CODE = 'TIKMAX';
const AUTH_STATE_FILE = 'client-auth.json';

type RequestOptions = {
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  accessToken?: string;
  retryOnUnauthorized?: boolean;
};

@Injectable()
export class ClientAuthService {
  private dataDir = ensurePersistentDataDir();
  private authFilePath = path.join(this.dataDir, AUTH_STATE_FILE);

  private ensurePaths() {
    this.dataDir = ensurePersistentDataDir();
    this.authFilePath = path.join(this.dataDir, AUTH_STATE_FILE);
  }

  getPublicState(): PublicClientAuthState {
    const state = this.readState();
    const pub = this.toPublicState(state);
    // [TẠM THỜI BYPASS LICENSE MKT TIKMAX ĐỂ TEST]
    return {
      ...pub,
      authenticated: true,
      licensed: true,
      blocked: false,
      user: pub.user || { id: 'admin_test', username: 'test_admin', email: 'test@local.dev', role: 'admin' },
      appCode: 'TIKMAX',
      expiresAt: '2099-12-31T23:59:59.000Z',
      isExpired: false,
      lastCheckedAt: new Date().toISOString(),
    };
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
        appCode: APP_CODE,
      },
      retryOnUnauthorized: false,
    });

    if (!result.success || !result.data) return result;

    const data = result.data as any;
    this.saveState({
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      user: data.user,
      appCode: data.appCode || APP_CODE,
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

    const result = await this.request(`/api/auth/me?appCode=${encodeURIComponent(APP_CODE)}`, {
      method: 'GET',
      accessToken,
    });

    if (!result.success || !result.data) return { ...result, data: this.getPublicState() };

    const data = result.data as any;
    if (data.user?.status && data.user.status !== 'active') {
      this.saveState({
        ...this.readState(),
        user: data.user,
        appCode: data.appCode || APP_CODE,
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
      appCode: data.appCode || APP_CODE,
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
      appCode: data.appCode || APP_CODE,
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

  logout(): PublicClientAuthState {
    this.saveState({});
    return this.getPublicState();
  }

  async ensureLicensed(): Promise<{ ok: boolean; message?: string; auth: PublicClientAuthState }> {
    const checked = await this.getMe();
    const auth = this.getPublicState();
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
    const url = `${AUTH_BASE_URL}${pathname}`;
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
      appCode: state.appCode || APP_CODE,
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
