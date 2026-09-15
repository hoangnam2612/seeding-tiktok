export const ACCOUNT_IMPORT_FORMATS = [
  'User | Pass | Mail | PassMail',
  'User', 'User | Pass', 'User | Pass | 2FA', 'User | Pass | Cookie',
  'User | Pass | Cookie | Proxy', 'User | Pass | 2FA | Proxy',
  'User | Pass | Cookie | Email | PassMail', 'User | Pass | 2FA | Email | PassMail',
  'User | Pass | Cookie | Email | PassMail | 2FA',
  'User | Pass | 2FA | Email | PassMail | Proxy',
  'User | Pass | Cookie | Email | PassMail | 2FA | Proxy',
];

type ImportField = 'username' | 'password' | 'email' | 'passMail' | 'cookie' | 'twoFactor' | 'proxy';
const fields: Record<string, ImportField> = {
  user: 'username', username: 'username', uid: 'username',
  pass: 'password', password: 'password', mail: 'email', email: 'email',
  passmail: 'passMail', cookie: 'cookie', '2fa': 'twoFactor', proxy: 'proxy',
};

export function parseImportFormat(format: string): ImportField[] | null {
  if (format === 'auto') return null;
  const columns = format.split('|').map(column => column.trim().toLowerCase());
  if (columns.some(column => !Object.prototype.hasOwnProperty.call(fields, column))) {
    throw new Error('Định dạng chỉ hỗ trợ User, Pass, Mail (Email), PassMail, Cookie, 2FA, Proxy; phân cách bằng dấu |.');
  }
  const mapped = columns.map(column => fields[column]);
  if (!mapped.includes('username')) throw new Error('Định dạng phải có cột User.');
  if (new Set(mapped).size !== mapped.length) throw new Error('Định dạng không được lặp lại cột.');
  return mapped;
}
