import { safeStorage } from 'electron';

const SECRET_PREFIX = 'enc:v1:';

export function encryptSecret(value?: string): string {
  if (!value) return '';
  if (value.startsWith(SECRET_PREFIX)) return value;

  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Không có mã hóa hệ điều hành.');
    return SECRET_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch {
    throw new Error('Không thể mã hóa dữ liệu bí mật. Chưa lưu thay đổi; kiểm tra tài khoản Windows và thử lại.');
  }
}

export function decryptSecret(value?: string): string {
  if (!value) return '';
  if (!value.startsWith(SECRET_PREFIX)) return value;

  try {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Không có mã hóa hệ điều hành.');
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'));
  } catch {
    throw new Error('Không giải mã được dữ liệu bí mật. Hãy mở bằng tài khoản Windows đã lưu dữ liệu.');
  }
}

export function hasEncryptedSecret(value?: string): boolean {
  return !!value && value.startsWith(SECRET_PREFIX);
}
