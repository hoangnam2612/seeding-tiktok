import { Workbook } from 'exceljs';
import * as fs from 'fs';
import { TikTokAccount } from '../nest/accounts/account.interface';

const columns: Record<string, keyof TikTokAccount> = { UID: 'uid', ID: 'uid', PASS: 'password', PASSWORD: 'password', '2FA': 'twoFactor', TWOFA: 'twoFactor', PRIVATEKEY: 'twoFactor', COOKIE: 'cookie', COOKIES: 'cookie', TOKEN: 'token', MAIL: 'email', EMAIL: 'email', PASSMAIL: 'passMail', PASSEMAIL: 'passMail', RECOVERYMAIL: 'recoveryMail', MAILRECOVERY: 'recoveryMail', PROXY: 'proxy', USERAGENT: 'userAgent', NOTE: 'notes' };
function tokens(format: string): string[] {
  const keys = format.split(/[|:,]/).map(t => t.trim().toUpperCase()).filter(Boolean);
  if (!keys.length || keys.some(k => !columns[k])) throw new Error('Định dạng cột không hợp lệ.');
  return keys;
}
export function parseAccounts(text: string, format: string): Partial<TikTokAccount>[] {
  const keys = tokens(format);
  return text.split(/\r\n|\n|\r/).map((line, index) => ({ line, index })).filter(({ line }) => line.trim()).map(({ line, index }) => {
    const parts = line.includes('|') ? line.split('|') : line.split(':');
    if (keys.join('|') === 'UID|PASS|MAIL|PASSMAIL' && parts.length !== 4) throw new Error(`Dòng ${index + 1}: cần đủ UID|PASS|MAIL|PASSMAIL.`);
    const result: Partial<TikTokAccount> = {};
    keys.forEach((key, i) => { if (i < parts.length) (result as any)[columns[key]] = parts[i].trim(); });
    if (keys.join('|') === 'UID|PASS|MAIL|PASSMAIL' && (parts.some(p => !p.trim()) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email || ''))) throw new Error(`Dòng ${index + 1}: cần UID|Pass|Mail|PassMail với email hợp lệ.`);
    if (result.uid) result.username = result.uid.replace(/^@/, '');
    else if (result.email) result.username = result.email;
    return result;
  }).filter(result => !!(result.uid || result.email || result.cookie));
}
export function formatAccounts(accounts: TikTokAccount[], format: string): string {
  const keys = tokens(format);
  return accounts.map(a => keys.map(k => columns[k] === 'uid' ? a.uid || a.username : a[columns[k]] || '').join('|')).join('\n');
}
export async function exportAccounts(file: string, accounts: TikTokAccount[], format: string, excel: boolean, category: (id?: string) => string) {
  if (!excel) { await fs.promises.writeFile(file, formatAccounts(accounts, format), 'utf8'); return; }
  const workbook = new Workbook();
  const sheet = workbook.addWorksheet('Accounts');
  sheet.addRow(['STT', 'UID/Username', 'Mật khẩu', '2FA Key', 'Cookies', 'Email', 'Pass Mail', 'Proxy', 'Trạng thái', 'Danh mục', 'Ghi chú']);
  accounts.forEach((a, i) => sheet.addRow([i + 1, a.uid || a.username, a.password || '', a.twoFactor || '', a.cookie || '', a.email || '', a.passMail || '', a.proxy || '', a.status, category(a.categoryId), a.notes || '']));
  sheet.getRow(1).font = { bold: true }; sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.columns.forEach((column, i) => { column.width = i === 0 ? 8 : i === 4 ? 45 : 24; });
  await workbook.xlsx.writeFile(file);
}
