import * as crypto from 'crypto';

/**
 * Generate 6-digit TOTP Token (RFC 6238) from Base32 Secret Key (2FA)
 * Exactly matches Google Authenticator, Authy, and OtpNet in MKT TikPro
 */
export function generateTotpToken(secretKey: string): string {
  if (!secretKey || secretKey.trim().length === 0) return '';

  try {
    const cleanSecret = secretKey.replace(/[\s-]/g, '').toUpperCase();
    const base32chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';

    for (let i = 0; i < cleanSecret.length; i++) {
      const val = base32chars.indexOf(cleanSecret.charAt(i));
      if (val !== -1) {
        bits += val.toString(2).padStart(5, '0');
      }
    }

    const bytes = new Uint8Array(Math.floor(bits.length / 8));
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(bits.substring(i * 8, i * 8 + 8), 2);
    }

    // 30-second time step window
    const epoch = Math.floor(Date.now() / 1000 / 30);
    const timeBuffer = Buffer.alloc(8);
    timeBuffer.writeBigInt64BE(BigInt(epoch), 0);

    // HMAC-SHA1 calculation
    const hmac = crypto.createHmac('sha1', Buffer.from(bytes));
    hmac.update(timeBuffer);
    const hmacResult = hmac.digest();

    // Dynamic truncation
    const offset = hmacResult[hmacResult.length - 1] & 0xf;
    const code =
      ((hmacResult[offset] & 0x7f) << 24) |
      ((hmacResult[offset + 1] & 0xff) << 16) |
      ((hmacResult[offset + 2] & 0xff) << 8) |
      (hmacResult[offset + 3] & 0xff);

    const otp = (code % 1000000).toString().padStart(6, '0');
    return otp;
  } catch (err) {
    console.error('[TOTP Generator Error]:', err);
    return '';
  }
}
