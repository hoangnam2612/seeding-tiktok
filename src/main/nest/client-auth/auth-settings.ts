import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export function loadAuthSettings(defaultUrl: string) {
  const file = path.join(app.isPackaged ? path.dirname(app.getPath('exe')) : process.cwd(), 'settings', 'auth_config.json');
  let config: { authBaseUrl?: string; appCode?: string } = {};
  if (fs.existsSync(file)) {
    let value: unknown;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error('File settings/auth_config.json không đúng định dạng JSON.'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('File settings/auth_config.json phải là một đối tượng JSON.');
    const fields = Object.fromEntries(Object.entries(value).map(([key, item]) => [key.toLowerCase(), item]));
    if (fields.authbaseurl !== undefined && typeof fields.authbaseurl !== 'string' || fields.appcode !== undefined && typeof fields.appcode !== 'string') throw new Error('AuthBaseUrl và AppCode phải là chuỗi.');
    config = { authBaseUrl: fields.authbaseurl as string | undefined, appCode: fields.appcode as string | undefined };
  }
  const url = new URL(process.env.AUTH_BASE_URL || config.authBaseUrl || defaultUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('AUTH_BASE_URL không hợp lệ.');
  const appCode = (process.env.AUTH_APP_CODE || config.appCode || 'TIKMAX').trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(appCode)) throw new Error('AUTH_APP_CODE không hợp lệ.');
  return { baseUrl: url.href.replace(/\/$/, ''), appCode };
}
