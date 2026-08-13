import { Injectable } from '@nestjs/common';
import * as tls from 'tls';

export interface FetchOtpOptions {
  host?: string;
  port?: number;
  timeoutMs?: number;
  sinceTimestamp?: number;
  allowSelfSigned?: boolean;
}

@Injectable()
export class MailOtpService {
  /**
   * Auto detect IMAP host based on email domain
   */
  private getImapHost(email: string): string {
    const domain = email.split('@')[1]?.toLowerCase() || '';
    if (['hotmail.com', 'outlook.com', 'live.com', 'msn.com'].includes(domain)) {
      return 'outlook.office365.com';
    }
    if (domain === 'gmail.com') {
      return 'imap.gmail.com';
    }
    if (domain === 'yahoo.com') {
      return 'imap.mail.yahoo.com';
    }
    return 'outlook.office365.com';
  }

  /**
   * Mask email for safe console logging
   */
  private maskEmail(email: string): string {
    if (!email || !email.includes('@')) return '***';
    const [name, domain] = email.split('@');
    const maskedName = name.length <= 2 ? name[0] + '*' : name[0] + '***' + name[name.length - 1];
    return `${maskedName}@${domain}`;
  }

  /**
   * Format timestamp as IMAP search date (e.g. 10-Aug-2026)
   */
  private formatImapDate(timestamp: number): string {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const d = new Date(timestamp);
    const day = d.getDate();
    const month = months[d.getMonth()];
    const year = d.getFullYear();
    return `${day}-${month}-${year}`;
  }

  /**
   * Fetch TikTok 6-digit OTP code from mailbox with polling retry and strict TikTok verification
   */
  async fetchTikTokOtp(
    email: string,
    passMail: string,
    options: FetchOtpOptions = {}
  ): Promise<{ success: boolean; otp?: string; message?: string }> {
    if (!email || !passMail) {
      return { success: false, message: 'Email hoặc PassMail không được để trống.' };
    }

    const maxTimeoutMs = options.timeoutMs || 60000; // Poll for up to 60s
    const pollIntervalMs = 5000; // Check every 5s
    const startTime = Date.now();
    const masked = this.maskEmail(email);

    console.log(`[MailOtpService] Bắt đầu đọc OTP cho ${masked}... (Timeout: ${maxTimeoutMs / 1000}s)`);

    let lastErrorMsg = 'Không tìm thấy email xác minh mới từ TikTok.';

    while (Date.now() - startTime < maxTimeoutMs) {
      const result = await this.singleAttemptFetch(email, passMail, options);
      if (result.success && result.otp) {
        return result;
      }

      if (result.message && (result.message.includes('thất bại') || result.message.includes('không hợp lệ'))) {
        // Fatal login error (e.g. wrong password / app password required) -> return immediately
        return result;
      }

      lastErrorMsg = result.message || lastErrorMsg;

      // Wait before next poll iteration if timeout not reached
      const elapsed = Date.now() - startTime;
      if (elapsed + pollIntervalMs < maxTimeoutMs) {
        await new Promise(r => setTimeout(r, pollIntervalMs));
      } else {
        break;
      }
    }

    return {
      success: false,
      message: `Hết thời gian chờ (${maxTimeoutMs / 1000}s). ${lastErrorMsg}`,
    };
  }

  /**
   * Single IMAP socket connection attempt to search & parse TikTok OTP
   */
  private async singleAttemptFetch(
    email: string,
    passMail: string,
    options: FetchOtpOptions
  ): Promise<{ success: boolean; otp?: string; message?: string }> {
    const imapHost = options.host || this.getImapHost(email);
    const port = options.port || 993;
    const sinceTimestamp = options.sinceTimestamp || (Date.now() - 5 * 60 * 1000); // Default to last 5 minutes
    const rejectUnauthorized = options.allowSelfSigned === true ? false : true; // Secure TLS by default

    return new Promise((resolve) => {
      let socket: tls.TLSSocket | null = null;
      let buffer = '';
      let tagCount = 1;
      let step = 'CONNECT';
      let msgIds: string[] = [];
      let currentMsgIndex = 0;
      let isResolved = false;

      const finish = (success: boolean, otp?: string, message?: string) => {
        if (isResolved) return;
        isResolved = true;
        if (socket && !socket.destroyed) {
          try {
            socket.write(`A${tagCount++} LOGOUT\r\n`);
            socket.end();
          } catch {}
        }
        resolve({ success, otp, message });
      };

      const timer = setTimeout(() => {
        finish(false, undefined, `Timeout kết nối socket IMAP ${imapHost}:${port}`);
      }, 12000);

      try {
        socket = tls.connect(
          {
            host: imapHost,
            port,
            rejectUnauthorized,
          },
          () => {}
        );

        socket.setEncoding('utf-8');

        socket.on('data', (data: string) => {
          buffer += data;

          if (step === 'CONNECT' && buffer.includes('* OK')) {
            step = 'LOGIN';
            buffer = '';
            // DO NOT log passMail or credentials
            const cmd = `A${tagCount} LOGIN "${email}" "${passMail}"\r\n`;
            socket!.write(cmd);
          } else if (step === 'LOGIN') {
            if (buffer.includes(`A${tagCount} OK`)) {
              tagCount++;
              step = 'SELECT';
              buffer = '';
              const cmd = `A${tagCount} SELECT INBOX\r\n`;
              socket!.write(cmd);
            } else if (buffer.includes(`A${tagCount} NO`) || buffer.includes(`A${tagCount} BAD`)) {
              clearTimeout(timer);
              if (buffer.includes('Application-specific password required')) {
                finish(
                  false,
                  undefined,
                  `Google yêu cầu "Mật khẩu ứng dụng" (App Password 16 ký tự). Đăng nhập thất bại cho ${this.maskEmail(email)}.`
                );
              } else if (imapHost.includes('office365') || imapHost.includes('outlook')) {
                finish(
                  false,
                  undefined,
                  `Hotmail/Outlook từ chối đăng nhập IMAP bằng mật khẩu thường cho ${this.maskEmail(email)}. Cần App Password hoặc OAuth2.`
                );
              } else {
                finish(false, undefined, `Đăng nhập IMAP thất bại cho ${this.maskEmail(email)}. Kiểm tra mật khẩu hòm thư.`);
              }
            }
          } else if (step === 'SELECT') {
            if (buffer.includes(`A${tagCount} OK`)) {
              tagCount++;
              step = 'SEARCH';
              buffer = '';
              // Try SEARCH SINCE date
              const imapDate = this.formatImapDate(sinceTimestamp);
              const cmd = `A${tagCount} SEARCH SINCE ${imapDate}\r\n`;
              socket!.write(cmd);
            }
          } else if (step === 'SEARCH') {
            if (buffer.includes(`A${tagCount} OK`)) {
              const searchLines = buffer.split('\r\n').filter(l => l.startsWith('* SEARCH'));
              if (searchLines.length > 0) {
                const ids = searchLines[0].replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
                if (ids.length > 0) {
                  // Take up to last 30 message IDs (newest first)
                  msgIds = ids.slice(-30).reverse();
                }
              }
              tagCount++;
              buffer = '';

              if (msgIds.length > 0) {
                step = 'FETCH_MSG';
                currentMsgIndex = 0;
                const cmd = `A${tagCount} FETCH ${msgIds[currentMsgIndex]} (BODY[HEADER.FIELDS (DATE FROM SUBJECT)] BODY[TEXT])\r\n`;
                socket!.write(cmd);
              } else {
                // If SEARCH SINCE returned empty, fallback to SEARCH ALL
                step = 'SEARCH_ALL';
                const cmd = `A${tagCount} SEARCH ALL\r\n`;
                socket!.write(cmd);
              }
            }
          } else if (step === 'SEARCH_ALL') {
            if (buffer.includes(`A${tagCount} OK`)) {
              const searchLines = buffer.split('\r\n').filter(l => l.startsWith('* SEARCH'));
              if (searchLines.length > 0) {
                const ids = searchLines[0].replace('* SEARCH', '').trim().split(/\s+/).filter(Boolean);
                if (ids.length > 0) {
                  // Take up to last 30 message IDs
                  msgIds = ids.slice(-30).reverse();
                }
              }
              tagCount++;
              buffer = '';

              if (msgIds.length > 0) {
                step = 'FETCH_MSG';
                currentMsgIndex = 0;
                const cmd = `A${tagCount} FETCH ${msgIds[currentMsgIndex]} (BODY[HEADER.FIELDS (DATE FROM SUBJECT)] BODY[TEXT])\r\n`;
                socket!.write(cmd);
              } else {
                clearTimeout(timer);
                finish(false, undefined, 'Hòm thư rỗng, chưa tìm thấy thư TikTok nào.');
              }
            }
          } else if (step === 'FETCH_MSG') {
            if (buffer.includes(`A${tagCount} OK`)) {
              const currentContent = buffer;
              tagCount++;
              buffer = '';

              // Extract header fields
              const fromMatch = currentContent.match(/From:\s*([^\r\n]+)/i);
              const subjectMatch = currentContent.match(/Subject:\s*([^\r\n]+)/i);
              const dateMatch = currentContent.match(/Date:\s*([^\r\n]+)/i);

              const fromStr = fromMatch ? fromMatch[1].toLowerCase() : '';
              const subjectStr = subjectMatch ? subjectMatch[1].toLowerCase() : '';
              const bodyStr = currentContent.toLowerCase();

              // STRICT TikTok Mail Verification:
              // Must have explicit TikTok sender domain/name OR TikTok in subject/body
              const isTikTokSender =
                fromStr.includes('tiktok.com') ||
                fromStr.includes('bytedance') ||
                fromStr.includes('tiktok') ||
                fromStr.includes('no-reply@tiktok.com');

              const isTikTokSubjectOrBody =
                subjectStr.includes('tiktok') ||
                (bodyStr.includes('tiktok') && (bodyStr.includes('code') || bodyStr.includes('xác minh')));

              const isVerifiedTikTokMail = isTikTokSender || isTikTokSubjectOrBody;

              // Parse Date header
              let msgTime: number | null = null;
              if (dateMatch) {
                const parsed = Date.parse(dateMatch[1]);
                if (!isNaN(parsed)) {
                  msgTime = parsed;
                }
              }

              // Allow 60s tolerance for server clock drift
              // If msgTime is null (unparseable), DO NOT assume Date.now() unless TikTok sender is explicit
              const isRecentEnough = msgTime !== null ? (msgTime >= (sinceTimestamp - 60000)) : isTikTokSender;

              if (isVerifiedTikTokMail && isRecentEnough) {
                // Priority OTP Regex matching near "verification code" / "mã xác minh"
                let otpCode: string | null = null;

                const p1 = currentContent.match(/\b(\d{6})\b\s+is\s+your\s+verification\s+code/i);
                const p2 = currentContent.match(/verification\s+code[:\s]+(\d{6})/i);
                const p3 = currentContent.match(/mã\s+xác\s+minh[:\s]+(\d{6})/i);
                const p4 = currentContent.match(/code[:\s]+(\d{6})/i);
                const pFallback = currentContent.match(/\b(\d{6})\b/);

                if (p1) otpCode = p1[1];
                else if (p2) otpCode = p2[1];
                else if (p3) otpCode = p3[1];
                else if (p4) otpCode = p4[1];
                else if (pFallback) otpCode = pFallback[1];

                if (otpCode) {
                  clearTimeout(timer);
                  finish(true, otpCode, `Đã đọc thành công mã OTP TikTok: ${otpCode}`);
                  return;
                }
              }

              // Try next message if available
              currentMsgIndex++;
              if (currentMsgIndex < msgIds.length) {
                const cmd = `A${tagCount} FETCH ${msgIds[currentMsgIndex]} (BODY[HEADER.FIELDS (DATE FROM SUBJECT)] BODY[TEXT])\r\n`;
                socket!.write(cmd);
              } else {
                clearTimeout(timer);
                finish(false, undefined, 'Chưa tìm thấy mã OTP TikTok mới phù hợp.');
              }
            }
          }
        });

        socket.on('error', (err) => {
          clearTimeout(timer);
          finish(false, undefined, `Lỗi kết nối socket IMAP: ${err.message}`);
        });
      } catch (err: any) {
        clearTimeout(timer);
        finish(false, undefined, `Lỗi khởi tạo IMAP: ${err.message}`);
      }
    });
  }
}
