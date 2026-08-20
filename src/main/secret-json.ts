import { safeStorage } from 'electron';

const SECRET_PREFIX = 'enc:v1:';

export function encryptSecret(value?: string): string {
  if (!value) return '';
  if (value.startsWith(SECRET_PREFIX)) return value;

  try {
    if (!safeStorage.isEncryptionAvailable()) return value;
    return SECRET_PREFIX + safeStorage.encryptString(value).toString('base64');
  } catch {
    return value;
  }
}

export function decryptSecret(value?: string): string {
  if (!value) return '';
  if (!value.startsWith(SECRET_PREFIX)) return value;

  try {
    if (!safeStorage.isEncryptionAvailable()) return value;
    return safeStorage.decryptString(Buffer.from(value.slice(SECRET_PREFIX.length), 'base64'));
  } catch {
    return value;
  }
}

export function hasEncryptedSecret(value?: string): boolean {
  return !!value && value.startsWith(SECRET_PREFIX);
}
