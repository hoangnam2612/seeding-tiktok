import { BrowserWindow } from 'electron';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { MailOtpService } from '../nest/accounts/mail-otp.service';
import { generateTotpToken } from '../nest/accounts/totp.helper';
import { AccountInfo, AccountStatus } from './types';
import { AccountSessionUpdate, persistTikTokSessionCookies } from './session-profile';
import {
  clearTikTokAuthCookies,
  detectTikTokLoggedOutState,
  loadTikTokUrlForSeeding,
} from './tiktok-page';
import { solveTikTokWebCaptchaWithOmo } from './captcha-solver';

const mailOtpService = new MailOtpService();

export async function ensureAuthenticatedForSeeding(
  win: BrowserWindow,
  customSession: Electron.Session,
  acc: AccountInfo,
  targetUrl: string,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
): Promise<boolean> {
  const loggedOutState = await detectTikTokLoggedOutState(win);
  if (!loggedOutState.loggedOut) return true;

  onAccountStatusChange(acc.id, 'unauthenticated');
  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'warning',
    message: `[Auth] @${acc.username} bi out session khi seeding: ${loggedOutState.reason || 'TikTok hien trang thai chua dang nhap.'}`,
  });

  if (!acc.password) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `[Auth] @${acc.username} chua co mat khau trong app nen khong the tu login lai. Vui long mo Chrome/Login thu cong de lay session moi.`,
    });
    return false;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Auth] Dang tu login lai cho @${acc.username} truoc khi tiep tuc seeding...`,
  });

  await clearTikTokAuthCookies(customSession).catch(() => undefined);
  await win.loadURL('https://www.tiktok.com/login/phone-or-email/email').catch((err: any) => {
    const errMsg = err?.message || String(err);
    if (!errMsg.includes('ERR_ABORTED') && err?.code !== 'ERR_ABORTED' && err?.errno !== -3) {
      throw err;
    }
  });

  const loginResult = await monitorLoginFlow(
    win,
    customSession,
    acc,
    onLog,
    onAccountStatusChange,
    onAccountSessionUpdate
  );

  if (!loginResult?.success) {
    onAccountStatusChange(acc.id, 'unauthenticated');
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'error',
      message: `[Auth] Login lai that bai cho @${acc.username}: ${loginResult?.status || 'unknown'}. Bo qua tai khoan nay.`,
    });
    return false;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'success',
    message: `[Auth] Login lai thanh cong cho @${acc.username}. Dang tai lai URL seeding...`,
  });

  await loadTikTokUrlForSeeding(win, customSession, targetUrl, acc, onLog);
  return true;
}

/**
 * Auto-Fill Username & Password on TikTok Login Page
 */
export async function autoFillTikTokLogin(win: BrowserWindow, usernameOrEmail: string, password?: string): Promise<boolean> {
  if (!usernameOrEmail || !password || win.isDestroyed()) return false;

  try {
    await new Promise(r => setTimeout(r, 1500));
    if (win.isDestroyed()) return false;

    const filled = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const setReactInputValue = (inputEl, val) => {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) {
              nativeSetter.call(inputEl, val);
            } else {
              inputEl.value = val;
            }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            inputEl.dispatchEvent(new Event('blur', { bubbles: true }));
          };

          const emailInput = document.querySelector('input[name="username"]') ||
                             document.querySelector('input[placeholder*="Email" i]') ||
                             document.querySelector('input[placeholder*="phone" i]') ||
                             document.querySelector('input[type="text"]');

          const passInput = document.querySelector('input[type="password"]');

          if (emailInput && passInput) {
            emailInput.focus();
            setReactInputValue(emailInput, ${JSON.stringify(usernameOrEmail)});

            await new Promise(r => setTimeout(r, 400));

            passInput.focus();
            setReactInputValue(passInput, ${JSON.stringify(password)});

            await new Promise(r => setTimeout(r, 600));

            const isVisible = (el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const submitBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(btn => {
              if (!isVisible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
              const txt = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
              const e2e = (btn.getAttribute('data-e2e') || '').toLowerCase();
              return btn.type === 'submit' ||
                     e2e.includes('login') ||
                     txt === 'log in' ||
                     txt === 'login' ||
                     txt === 'continue' ||
                     txt.includes('đăng nhập') ||
                     txt.includes('tiếp tục');
            });

            if (submitBtn) {
              submitBtn.removeAttribute('disabled');
              submitBtn.disabled = false;
              submitBtn.classList.remove('disabled');
              submitBtn.click();
              return true;
            }
          }
          return false;
        } catch(e) {
          return false;
        }
      })();
    `);

    if (filled) {
      await new Promise(r => setTimeout(r, 400));
      if (!win.isDestroyed()) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
    }

    return filled;
  } catch (err) {
    console.error('[Auto-Fill Login Error]:', err);
    return false;
  }
}

/**
 * Single Strategy helper to fill 6-digit OTP code into inputs without duplicating characters
 */
export async function fillSixDigitCodeSingleStrategy(win: BrowserWindow, code: string): Promise<boolean> {
  if (!code || code.length < 6 || win.isDestroyed()) return false;

  try {
    const success = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const otpDigits = ${JSON.stringify(code)};
          const setNativeValue = (inputEl, val) => {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
            if (nativeSetter) {
              nativeSetter.call(inputEl, val);
            } else {
              inputEl.value = val;
            }
            inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            inputEl.dispatchEvent(new Event('change', { bubbles: true }));
            inputEl.dispatchEvent(new Event('keyup', { bubbles: true }));
            inputEl.dispatchEvent(new Event('blur', { bubbles: true }));
          };

          const isVisible = (el) => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };

          const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[inputmode="numeric"], input[class*="Digit"]'))
            .filter(input => isVisible(input) && input.type !== 'password' && !input.disabled && !input.readOnly);

          if (inputs.length >= 6) {
            for (let i = 0; i < 6; i++) {
              if (inputs[i]) {
                inputs[i].focus();
                setNativeValue(inputs[i], otpDigits[i]);
              }
            }
          } else if (inputs.length > 0) {
            const singleInput = inputs[0];
            singleInput.focus();
            setNativeValue(singleInput, otpDigits);
          } else {
            return false;
          }

          await new Promise(r => setTimeout(r, 500));

          const submitBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(btn => {
            if (!isVisible(btn) || btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
            const txt = (btn.innerText || btn.textContent || btn.getAttribute('aria-label') || '').trim().toLowerCase();
            const e2e = (btn.getAttribute('data-e2e') || '').toLowerCase();
            return e2e.includes('verify') ||
                   e2e.includes('two-step') ||
                   txt === 'verify' ||
                   txt === 'continue' ||
                   txt === 'next' ||
                   txt === 'submit' ||
                   txt.includes('xác minh') ||
                   txt.includes('tiếp tục') ||
                   txt.includes('kế tiếp');
          });

          if (submitBtn) {
            submitBtn.removeAttribute('disabled');
            submitBtn.disabled = false;
            submitBtn.click();
          }
          return true;
        } catch(e) {
          return false;
        }
      })();
    `);

    if (success) {
      await new Promise(r => setTimeout(r, 300));
      if (!win.isDestroyed()) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
    }
    return success;
  } catch (err) {
    console.error('[Fill 6-Digit Code Error]:', err);
    return false;
  }
}

/**
 * Unified Login Flow Monitor (90 seconds) for both Single & Multi login
 */
export async function monitorLoginFlow(
  win: BrowserWindow,
  customSession: Electron.Session,
  acc: AccountInfo,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
): Promise<{ success: boolean; status: string }> {
  const maxMonitorMs = 90000; // 90 seconds monitoring
  const pollIntervalMs = 3000; // Poll every 3s
  const startTime = Date.now();

  let hasWarnedCaptcha = false;
  let hasAutoFilled = false;
  let hasFilledTotp = false;
  let hasClickedEmailOption = false;
  let emailOptionClickedAt = 0;
  let hasFilledEmailOtp = false;
  let requestedOtpTimestamp = 0;
  let isSolvingCaptcha = false;

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Monitor] Đã kích hoạt giám sát luồng đăng nhập cho @${acc.username}...`,
  });

  while (Date.now() - startTime < maxMonitorMs) {
    if (win.isDestroyed()) break;

    try {
      // 1. STRICT SESSION COOKIE CHECK FOR AUTHENTICATED STATUS
      const cookies = await customSession.cookies.get({ domain: '.tiktok.com' });
      const hasSessionCookie = cookies.some(
        c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt'
      );

      // DOM State Check
      const pageState = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const url = window.location.href;
            const bodyText = document.body.innerText || '';

            // STRICT Logged-In DOM Indicators (User Profile Avatar Menu / Logout Button)
            // DO NOT match generic a[href*="/@"]
            const hasUserMenu = !!document.querySelector('[data-e2e="profile-icon"]') &&
                                (!!document.querySelector('ul[class*="UserMenu"]') || !!document.querySelector('[aria-label*="Profile"]'));
            const hasLogoutBtn = bodyText.includes('Log out') || bodyText.includes('Đăng xuất');

            // Captcha / Challenge Indicators
            const hasCaptcha = !!document.querySelector('iframe[src*="captcha"]') ||
                               !!document.querySelector('iframe[src*="sec"]') ||
                               !!document.querySelector('#captcha-verify-container') ||
                               !!document.querySelector('.sec-captcha-container') ||
                               bodyText.includes('Drag the slider') ||
                               bodyText.includes('Select 2 objects') ||
                               bodyText.includes('Rotate the image') ||
                               bodyText.includes('Complete the puzzle') ||
                               bodyText.includes('Verify to continue');

            // Precise 2FA TOTP Indicators
            const is2FA = !hasCaptcha && (
              bodyText.includes('2-step verification') ||
              bodyText.includes('Authenticator app') ||
              bodyText.includes('Enter 6-digit code') ||
              bodyText.includes('Security code') ||
              bodyText.includes('Enter the code from authenticator app')
            );

            // Email Checkpoint: Option Selection Screen vs 6-Digit Code Input Screen
            const isEmailCheckpoint = !hasCaptcha && !is2FA && (
              bodyText.includes("Verify it's really you") ||
              bodyText.includes("Xác minh đó là bạn")
            );

            // Check if 6-digit inputs are active on screen for Email OTP
            const hasDigitInputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[class*="Digit"]')).length >= 1;

            const isEmailCodeInputScreen = isEmailCheckpoint && (hasDigitInputs || bodyText.includes('Enter code') || bodyText.includes('sent to email'));
            const isEmailOptionSelectionScreen = isEmailCheckpoint && !isEmailCodeInputScreen;

            const lowerText = bodyText.toLowerCase();
            const isVisible = (el) => {
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
            };

            const visibleCodeInputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[inputmode="numeric"], input[class*="Digit"]'))
              .filter(input => isVisible(input) && input.type !== 'password' && !input.disabled && !input.readOnly);

            const hasSixSingleDigitInputs = visibleCodeInputs.length >= 6 && visibleCodeInputs.slice(0, 6).every(input => {
              const maxLength = Number(input.getAttribute('maxlength') || input.maxLength || 0);
              const inputMode = (input.getAttribute('inputmode') || '').toLowerCase();
              const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
              return input.type === 'number' || inputMode === 'numeric' || autocomplete === 'one-time-code' || maxLength === 1;
            });

            const hasEmailSignal = lowerText.includes('email') ||
                                   lowerText.includes('mail') ||
                                   lowerText.includes('@') ||
                                   lowerText.includes('hòm thư') ||
                                   lowerText.includes('thư điện tử');

            const hasEmailCodePrompt = lowerText.includes('enter code') ||
                                       lowerText.includes('enter the code') ||
                                       lowerText.includes('verification code') ||
                                       lowerText.includes('6-digit') ||
                                       lowerText.includes('six-digit') ||
                                       lowerText.includes('sent to email') ||
                                       lowerText.includes('sent to your email') ||
                                       lowerText.includes('code sent') ||
                                       lowerText.includes('mã xác minh') ||
                                       lowerText.includes('nhập mã') ||
                                       lowerText.includes('gửi đến email') ||
                                       lowerText.includes('gửi tới email');

            const emailOptionCandidate = Array.from(document.querySelectorAll('button, [role="button"], div, span, p')).find(el => {
              if (!isVisible(el)) return false;
              const txt = (el.innerText || el.textContent || '').toLowerCase();
              return (txt.includes('email') || txt.includes('@') || txt.includes('hòm thư')) &&
                     !txt.includes('enter code') &&
                     !txt.includes('verification code') &&
                     !txt.includes('nhập mã');
            });

            const resolvedEmailCodeInputScreen = isEmailCodeInputScreen ||
              (!hasCaptcha && !is2FA && hasEmailSignal && hasEmailCodePrompt && (visibleCodeInputs.length >= 1 || hasSixSingleDigitInputs));
            const resolvedEmailOptionSelectionScreen = !resolvedEmailCodeInputScreen &&
              (isEmailOptionSelectionScreen || ((isEmailCheckpoint || hasEmailSignal) && !!emailOptionCandidate));

            // Login Error Toast / Bad Credentials
            const hasError = bodyText.includes('Maximum number of attempts reached') ||
                             bodyText.includes('Incorrect password') ||
                             bodyText.includes('User does not exist');

            const visibleButtons = Array.from(document.querySelectorAll('button, a, [role="button"], [data-e2e]')).filter(isVisible);
            const hasLoginButton = visibleButtons.some(el => {
              const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
              const e2e = (el.getAttribute('data-e2e') || '').toLowerCase();
              return e2e === 'top-login-button' ||
                     txt === 'log in' ||
                     txt === 'login' ||
                     txt.includes('dang nhap') ||
                     txt.includes('đăng nhập');
            });
            const hasLoginToComment = visibleButtons.some(el => {
              const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
              return txt.includes('log in to comment') ||
                     txt.includes('login to comment') ||
                     txt.includes('đăng nhập để bình luận') ||
                     txt.includes('dang nhap de binh luan');
            }) || lowerText.includes('log in to comment') || lowerText.includes('login to comment');
            const isLoginScreen = hasLoginButton ||
                                  hasLoginToComment ||
                                  bodyText.includes('Log in to TikTok') ||
                                  bodyText.includes('Use phone or email') ||
                                  bodyText.includes('Đăng nhập vào TikTok') ||
                                  bodyText.includes('Đăng nhập');

            return {
              hasUserMenu,
              hasLogoutBtn,
              hasCaptcha,
              is2FA,
              isEmailOptionSelectionScreen: resolvedEmailOptionSelectionScreen,
              isEmailCodeInputScreen: resolvedEmailCodeInputScreen,
              hasError,
              isLoginScreen,
              hasLoginButton,
              hasLoginToComment
            };
          } catch(e) {
            return {
              hasUserMenu: false,
              hasLogoutBtn: false,
              hasCaptcha: false,
              is2FA: false,
              isEmailOptionSelectionScreen: false,
              isEmailCodeInputScreen: false,
              hasError: false,
              isLoginScreen: false,
              hasLoginButton: false,
              hasLoginToComment: false
            };
          }
        })();
      `);

      // A. STRICT LOGGED_IN CHECK
      // A stale TikTok cookie can remain after the page has been logged out, so DOM logged-out signals win.
      if ((hasSessionCookie && !pageState.isLoginScreen) || (pageState.hasUserMenu && pageState.hasLogoutBtn)) {
        const savedCookie = await persistTikTokSessionCookies(
          acc.id,
          acc.username,
          customSession,
          onLog,
          onAccountSessionUpdate
        );
        if (!savedCookie) {
          onAccountStatusChange(acc.id, 'authenticated');
        }
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'success',
          message: `🎉 ĐĂNG NHẬP THÀNH CÔNG cho @${acc.username}! Session Cookie đã được xác nhận.`,
        });
        return { success: true, status: 'authenticated' };
      }

      // B. CAPTCHA DETECTED -> Try OmoCaptcha, then wait/manual fallback.
      if (pageState.hasCaptcha) {
        if (!isSolvingCaptcha) {
          isSolvingCaptcha = true;
          const solved = await solveTikTokWebCaptchaWithOmo(win, acc, onLog).catch(err => {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'error',
              message: `[Captcha] OmoCaptcha solve error: ${err?.message || err}`,
            });
            return false;
          });
          isSolvingCaptcha = false;
          if (solved) {
            hasWarnedCaptcha = false;
            await new Promise(r => setTimeout(r, pollIntervalMs));
            continue;
          }
        }

        if (!hasWarnedCaptcha) {
          hasWarnedCaptcha = true;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `⚠️ PHÁT HIỆN CAPTCHA/CHALLENGE cho @${acc.username}! OmoCaptcha chưa giải được hoặc chưa có API key. Vui lòng kéo/giải thủ công nếu cần.`,
          });
        }
        await new Promise(r => setTimeout(r, pollIntervalMs));
        continue;
      } else {
        hasWarnedCaptcha = false; // Reset if captcha solved
      }

      // C. PRECISE 2FA TOTP SCREEN DETECTED -> Only enter TOTP if strictly on 2FA screen
      if (pageState.is2FA && !hasFilledTotp) {
        if (acc.twoFactor && acc.twoFactor.trim().length >= 8) {
          const totpCode = generateTotpToken(acc.twoFactor);
          if (totpCode) {
            hasFilledTotp = true;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `🔑 Đã phát hiện màn hình 2FA! Đã tự động sinh mã TOTP 6 số [ ${totpCode} ]. Đang điền...`,
            });

            // Fill TOTP using single safe strategy
            await fillSixDigitCodeSingleStrategy(win, totpCode);
          }
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `⚠️ Màn hình 2FA yêu cầu mã Authenticator nhưng tài khoản @${acc.username} chưa cài Khóa 2FA!`,
          });
          hasFilledTotp = true; // Prevent log spam
        }
      }

      // D. EMAIL OPTION SELECTION SCREEN -> Click Email card and wait for transition
      if (pageState.isEmailOptionSelectionScreen && (!hasClickedEmailOption || Date.now() - emailOptionClickedAt > 10000)) {
        hasClickedEmailOption = true;
        emailOptionClickedAt = Date.now();
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'info',
          message: `📬 Đã thấy màn hình chọn phương thức xác minh Email. Đang bấm chọn Email...`,
        });

        await win.webContents.executeJavaScript(`
          (() => {
            try {
              const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };
              const emailCard = Array.from(document.querySelectorAll('button, [role="button"], div, span, p')).find(el => {
                if (!isVisible(el)) return false;
                const txt = (el.innerText || el.textContent || '').toLowerCase();
                return (txt.includes('email') || txt.includes('@') || txt.includes('hòm thư')) &&
                       !txt.includes('enter code') &&
                       !txt.includes('verification code') &&
                       !txt.includes('nhập mã');
              });
              if (emailCard) emailCard.click();
            } catch(e) {}
          })();
        `);

        // Wait 2.5s for UI to transition to 6-digit code input screen
        await new Promise(r => setTimeout(r, 2500));
        continue;
      }

      // E. EMAIL CODE INPUT SCREEN DETECTED -> Strictly fetch OTP ONLY when input screen is ready
      if (pageState.isEmailCodeInputScreen && !hasFilledEmailOtp) {
        if (acc.email && acc.passMail) {
          hasFilledEmailOtp = true;
          requestedOtpTimestamp = Date.now();

          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `📬 Màn hình nhập mã Email OTP đã sẵn sàng! Đang kết nối ngầm hòm thư ${acc.email} để bóc mã...`,
          });

          // Fetch OTP with requestedAt timestamp
          const otpRes = await mailOtpService.fetchTikTokOtp(acc.email, acc.passMail, {
            sinceTimestamp: requestedOtpTimestamp - 30000,
            timeoutMs: 35000,
          });

          if (otpRes.success && otpRes.otp) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'success',
              message: `🎉 Đã đọc được mã OTP TikTok từ hòm thư: [ ${otpRes.otp} ]. Đang tự động điền...`,
            });

            if (!win.isDestroyed()) {
              // Fill Email OTP using single safe strategy
              await fillSixDigitCodeSingleStrategy(win, otpRes.otp);
            }
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'warning',
              message: `⚠️ Kết quả đọc Email OTP: ${otpRes.message}`,
            });
          }
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `⚠️ Màn hình xác minh yêu cầu mã OTP Email nhưng tài khoản chưa nhập Email & PassMail!`,
          });
          hasFilledEmailOtp = true; // Prevent log spam
        }
      }

      // F. UNAUTHENTICATED HOMEPAGE / LOGIN FORM DETECTED -> Click "Log in" button or trigger Auto-fill
      if ((!hasSessionCookie || pageState.isLoginScreen || pageState.hasLoginButton || pageState.hasLoginToComment) && acc.password) {
        const loginCheck = await win.webContents.executeJavaScript(`
          (() => {
            try {
              const isVisible = (el) => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
              };

              const emailInput = document.querySelector('input[name="username"]') ||
                                 document.querySelector('input[placeholder*="Email" i]') ||
                                 document.querySelector('input[placeholder*="phone" i]') ||
                                 document.querySelector('input[type="text"]');
              const passInput = document.querySelector('input[type="password"]');

              if (emailInput && passInput && isVisible(emailInput) && isVisible(passInput)) {
                return 'FORM_READY';
              }

              const clickCentered = (el) => {
                const rect = el.getBoundingClientRect();
                const target = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
                (target || el).click();
              };

              // Check for 'Use phone or email' option in Login Modal
              const usePhoneEmailCard = Array.from(document.querySelectorAll('button, [role="button"], a, div')).find(el => {
                if (!isVisible(el)) return false;
                const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                const exactMethod = txt === 'use phone or email' ||
                       txt === 'use phone/email' ||
                       txt === 'use phone or email or username' ||
                       txt === 'use phone / email / username';
                const containsMethod = txt.includes('use phone or email') ||
                       txt.includes('use phone/email') ||
                       txt.includes('use phone or email or username') ||
                       txt.includes('use phone / email / username') ||
                       txt.includes('sử dụng điện thoại / email / tên người dùng') ||
                       txt.includes('sử dụng điện thoại') ||
                       txt.includes('sử dụng email');
                const rect = el.getBoundingClientRect();
                return exactMethod || (containsMethod && rect.width <= 650 && rect.height <= 140);
              });
              if (usePhoneEmailCard) {
                clickCentered(usePhoneEmailCard);
                return 'CLICKED_MODAL_OPTION';
              }

              // Check for Top "Log in" button on TikTok homepage
              const topLoginBtn = document.querySelector('[data-e2e="top-login-button"]') ||
                                  document.querySelector('button[aria-label*="Log in" i]') ||
                                  Array.from(document.querySelectorAll('button, a')).find(el => {
                                    if (!isVisible(el)) return false;
                                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                    return txt === 'log in' || txt === 'đăng nhập';
                                  });
              if (topLoginBtn) {
                topLoginBtn.click();
                return 'CLICKED_TOP_LOGIN';
              }

              return 'NONE';
            } catch(e) {
              return 'NONE';
            }
          })();
        `);

        if (loginCheck === 'FORM_READY' && !hasAutoFilled) {
          hasAutoFilled = true;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `🔑 Phát hiện ô đăng nhập trên TikTok! Đang tự động điền Username & Mật khẩu...`,
          });
          await autoFillTikTokLogin(win, acc.username, acc.password);
        } else if (loginCheck === 'CLICKED_TOP_LOGIN' || loginCheck === 'CLICKED_MODAL_OPTION') {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `🌐 Tài khoản chưa đăng nhập. Đang tự động bấm nút "Đăng nhập" trên TikTok...`,
          });
          await new Promise(r => setTimeout(r, 1500));
        }
      }

      // G. LOGIN ERROR DETECTED
      if (pageState.hasError) {
        onLog({
          accountId: acc.id,
          accountUsername: acc.username,
          level: 'error',
          message: `❌ Phát hiện lỗi đăng nhập trên TikTok cho @${acc.username}: Mật khẩu không đúng hoặc tài khoản không tồn tại.`,
        });
        return { success: false, status: 'error' };
      }

    } catch (err: any) {
      // Ignore transient errors during navigation
    }

    await new Promise(r => setTimeout(r, pollIntervalMs));
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Monitor] Kết thúc thời gian giám sát 90s cho @${acc.username}.`,
  });

  return { success: false, status: 'timeout' };
}
