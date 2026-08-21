import { BrowserWindow } from 'electron';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { MailOtpService } from '../nest/accounts/mail-otp.service';
import { generateTotpToken } from '../nest/accounts/totp.helper';
import { AccountInfo, AccountStatus } from './types';
import { AccountSessionUpdate, persistTikTokSessionCookies } from './session-profile';
import {
  clearTikTokAuthCookies,
  clearTikTokRenderCache,
  detectTikTokLoggedOutState,
  loadTikTokUrlForSeeding,
} from './tiktok-page';
import { solveTikTokWebCaptchaWithOmo } from './captcha-solver';
import { performZoomAwareElectronClick } from './browser-control';

const mailOtpService = new MailOtpService();

/**
 * Auto-Renew TikTok Session & Cookies by resetting auth/cache, logging in again, and reloading target
 */
export async function renewTikTokSessionForSeeding(
  win: BrowserWindow,
  customSession: Electron.Session,
  acc: AccountInfo & { proxy?: string; proxyType?: string },
  targetUrl: string,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void,
  triggerReason: string = 'Session/Cookie stale hoặc trang TikTok không lên'
): Promise<boolean> {
  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[RenewSession] Bắt đầu renew cookie/session cho @${acc.username} (Lý do: ${triggerReason})...`,
  });

  if (acc.proxy) {
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'info',
      message: `[RenewSession] Thông tin proxy đang dùng: ${acc.proxy} [${acc.proxyType || 'http'}]`,
    });
  }

  if (!acc.password) {
    onAccountStatusChange(acc.id, 'unauthenticated');
    onLog({
      accountId: acc.id,
      accountUsername: acc.username,
      level: 'warning',
      message: `[RenewSession] @${acc.username} chưa có mật khẩu trong app nên không thể tự động renew session. Vui lòng mở Chrome/Login thủ công để lấy session mới.`,
    });
    return false;
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[RenewSession] Đang clear auth cookies và cache/service worker cho @${acc.username}...`,
  });

  await clearTikTokAuthCookies(customSession).catch(() => undefined);
  await clearTikTokRenderCache(customSession).catch(() => undefined);

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[RenewSession] Đang tải trang đăng nhập TikTok cho @${acc.username}...`,
  });

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
      message: `[RenewSession] Auto-login để renew session thất bại cho @${acc.username}: ${loginResult?.status || 'quá trình login không hoàn tất'}.`,
    });
    return false;
  }

  // Persist the newly obtained session cookies immediately
  const savedCookie = await persistTikTokSessionCookies(
    acc.id,
    acc.username,
    customSession,
    onLog,
    onAccountSessionUpdate,
    '[RenewSession] '
  );

  if (!savedCookie) {
    onAccountStatusChange(acc.id, 'authenticated');
  }

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'success',
    message: `[RenewSession] ✅ Đã renew và lưu session cookie mới thành công cho @${acc.username}!`,
  });

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[RenewSession] Đang tải lại target URL (${targetUrl}) cho @${acc.username}...`,
  });

  await loadTikTokUrlForSeeding(win, customSession, targetUrl, acc, onLog);
  return true;
}

export async function ensureAuthenticatedForSeeding(
  win: BrowserWindow,
  customSession: Electron.Session,
  acc: AccountInfo & { proxy?: string; proxyType?: string },
  targetUrl: string,
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void,
  onAccountStatusChange: (id: string, status: AccountStatus) => void,
  onAccountSessionUpdate: (id: string, update: AccountSessionUpdate) => void
): Promise<boolean> {
  const loggedOutState = await detectTikTokLoggedOutState(win);
  if (!loggedOutState.loggedOut) return true;

  onAccountStatusChange(acc.id, 'unauthenticated');
  const reason = loggedOutState.reason || 'TikTok hiển thị trạng thái chưa đăng nhập.';
  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'warning',
    message: `[Auth] @${acc.username} bị out session khi seeding: ${reason}`,
  });

  return renewTikTokSessionForSeeding(
    win,
    customSession,
    acc,
    targetUrl,
    onLog,
    onAccountStatusChange,
    onAccountSessionUpdate,
    reason
  );
}

/**
 * Auto-Fill Username & Password on TikTok Login Page
 */
export async function autoFillTikTokLogin(win: BrowserWindow, usernameOrEmail: string, password?: string): Promise<boolean> {
  if (!usernameOrEmail || !password || win.isDestroyed()) return false;

  try {
    await new Promise(r => setTimeout(r, 1200));
    if (win.isDestroyed()) return false;

    const fillResult = await win.webContents.executeJavaScript(`
      (async () => {
        try {
          const isVisible = (el) => {
            if (!el) return false;
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
          };

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

          const findInputs = () => {
            const emailSelectors = [
              'input[name="username"]',
              'input[autocomplete="username"]',
              'input[placeholder*="Email" i]',
              'input[placeholder*="username" i]',
              'input[placeholder*="phone" i]',
              'input[placeholder*="tên người dùng" i]',
              'input[type="text"]',
              'input:not([type="password"]):not([type="hidden"]):not([type="checkbox"])'
            ];
            const passSelectors = [
              'input[type="password"]',
              'input[name="password"]',
              'input[autocomplete="current-password"]',
              'input[placeholder*="Password" i]',
              'input[placeholder*="Mật khẩu" i]'
            ];

            let emailEl = null;
            for (const sel of emailSelectors) {
              const el = Array.from(document.querySelectorAll(sel)).find(isVisible);
              if (el && el.type !== 'password') {
                emailEl = el;
                break;
              }
            }

            let passEl = null;
            for (const sel of passSelectors) {
              const el = Array.from(document.querySelectorAll(sel)).find(isVisible);
              if (el) {
                passEl = el;
                break;
              }
            }

            return { emailEl, passEl };
          };

          // 1. KIỂM TRA XEM ĐÃ CÓ SẴN FORM EMAIL + PASSWORD CHƯA (Nếu có sẵn thì ĐIỀN LUÔN, không bấm gì khác!)
          let { emailEl, passEl } = findInputs();

          // 2. NẾU CHƯA CÓ FORM ĐĂNG NHẬP THÌ MỚI ĐIỀU HƯỚNG / CHỌN KÊNH
          if (!emailEl || !passEl) {
            // If on Channel Selection list modal (e.g. "Sử dụng số điện thoại hoặc email" / "Use phone / email / username")
            const channelItems = Array.from(document.querySelectorAll('[data-e2e="channel-item"], [role="link"], div, a')).filter(isVisible);
            const emailChannelItem = channelItems.find(el => {
              const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
              const href = (el.getAttribute('href') || '').toLowerCase();
              const svgHtml = el.querySelector('svg')?.innerHTML || '';

              if (svgHtml.includes('M24 3a10 10') || svgHtml.includes('16 44h16c7')) return true;
              if (href.includes('/phone-or-email') || href.includes('/login/phone')) return true;

              const isEmailOrPhoneText =
                txt.includes('số điện thoại') || txt.includes('so dien thoai') ||
                txt.includes('phone') || txt.includes('email') || txt.includes('username') ||
                txt.includes('use phone') || txt.includes('teléfono') || txt.includes('telefone') ||
                txt.includes('téléphone') || txt.includes('телефон') || txt.includes('電話') ||
                txt.includes('전화') || txt.includes('โทรศัพท์');

              const isThirdParty =
                txt.includes('google') || txt.includes('facebook') || txt.includes('apple') ||
                txt.includes('qr') || txt.includes('twitter') || txt.includes('kakaotalk') || txt.includes('line');

              return isEmailOrPhoneText && !isThirdParty;
            });

            if (emailChannelItem) {
              emailChannelItem.click?.();
              await new Promise(r => setTimeout(r, 600));
            }

            // If on Phone tab / Phone modal variant, click "Username or email" tab or switch link
            const isForgetPassword = (href, txt) => {
              return href.includes('forget-password') || href.includes('forgot-password') ||
                     txt.includes('forget') || txt.includes('forgot') ||
                     txt.includes('quên mật khẩu') || txt.includes('quen mat khau') ||
                     txt.includes('olvidaste') || txt.includes('oublié');
            };

            const isEmailTabOrLink = (el) => {
              if (!isVisible(el)) return false;
              const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
              const href = (el.getAttribute('href') || '').toLowerCase();

              // Tuyệt đối không click vào Forgot password!
              if (isForgetPassword(href, txt)) return false;

              // Không bấm vào tab Phone hiện tại
              if (txt === 'phone' || txt === 'điện thoại') return false;

              return href.includes('/login/phone-or-email/email') ||
                     txt === 'username or email' ||
                     txt === 'email or username' ||
                     txt === 'username / email' ||
                     txt === 'email / username' ||
                     txt === 'username' ||
                     txt === 'email' ||
                     (txt.includes('username') && txt.includes('email')) ||
                     (txt.includes('email') && txt.includes('username')) ||
                     (txt.includes('email') && txt.includes('tên')) ||
                     (txt.includes('email') && txt.includes('tiktok id')) ||
                     txt.includes('sử dụng email') ||
                     txt.includes('su dung email') ||
                     txt.includes('log in with email') ||
                     txt.includes('đăng nhập bằng email') ||
                     txt.includes('dang nhap bang email');
            };

            const switchLink = Array.from(document.querySelectorAll(
              'a[href*="/login/phone-or-email/email"], [role="tab"], button, [role="button"], span, div, a, p'
            )).find(isEmailTabOrLink);

            if (switchLink) {
              switchLink.click?.();
              await new Promise(r => setTimeout(r, 600));
            }

            // Quét lại input sau khi chuyển màn hình
            const retry = findInputs();
            emailEl = retry.emailEl;
            passEl = retry.passEl;
          }

          if (emailEl && passEl) {
            emailEl.focus();
            setReactInputValue(emailEl, ${JSON.stringify(usernameOrEmail)});

            await new Promise(r => setTimeout(r, 300));

            passEl.focus();
            setReactInputValue(passEl, ${JSON.stringify(password)});

            await new Promise(r => setTimeout(r, 500));

            const submitBtn = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]')).find(btn => {
              if (!isVisible(btn)) return false;
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
              return { success: true, submitted: true };
            }

            return { success: true, submitted: false };
          }

          return { success: false, reason: 'Inputs not found' };
        } catch(e) {
          return { success: false, error: String(e) };
        }
      })();
    `);

    if (fillResult?.success) {
      await new Promise(r => setTimeout(r, 400));
      if (!win.isDestroyed()) {
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
      }
      return true;
    }

    return false;
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
  const pollIntervalMs = 2500; // Poll every 2.5s
  const startTime = Date.now();

  let hasWarnedCaptcha = false;
  let hasAutoFilled = false;
  let hasFilledTotp = false;
  let hasClickedEmailOption = false;
  let emailOptionClickedAt = 0;
  let hasFilledEmailOtp = false;
  let requestedOtpTimestamp = 0;
  let isSolvingCaptcha = false;
  let modalClickAttempts = 0;
  let hasTriedDirectEmailUrlFallback = false;

  onLog({
    accountId: acc.id,
    accountUsername: acc.username,
    level: 'info',
    message: `[Monitor] Đã kích hoạt giám sát luồng đăng nhập cho @${acc.username}...`,
  });

  while (Date.now() - startTime < maxMonitorMs) {
    if (win.isDestroyed()) break;

    try {
      // 1. Check Cookies
      const cookies = await customSession.cookies.get({ domain: '.tiktok.com' });
      const hasSessionCookie = cookies.some(
        c => c.name === 'sessionid' || c.name === 'sessionid_ss' || c.name === 'sid_tt'
      );

      // 2. DOM State Check
      const pageState = await win.webContents.executeJavaScript(`
        (() => {
          try {
            const url = window.location.href;
            const bodyText = document.body?.innerText || '';
            const lowerText = bodyText.toLowerCase();

            const isVisible = (el) => {
              if (!el) return false;
              const rect = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
            };

            const hasUserMenu = (!!document.querySelector('[data-e2e="profile-icon"]') || !!document.querySelector('[aria-label*="Profile" i]')) &&
                                (!!document.querySelector('ul[class*="UserMenu"]') || lowerText.includes('log out') || lowerText.includes('đăng xuất'));
            const hasLogoutBtn = lowerText.includes('log out') || lowerText.includes('đăng xuất');

            const hasCaptcha = !!document.querySelector('iframe[src*="captcha"]') ||
                               !!document.querySelector('iframe[src*="sec"]') ||
                               !!document.querySelector('#captcha-verify-container') ||
                               !!document.querySelector('.sec-captcha-container') ||
                               lowerText.includes('drag the slider') ||
                               lowerText.includes('select 2 objects') ||
                               lowerText.includes('rotate the image') ||
                               lowerText.includes('complete the puzzle') ||
                               lowerText.includes('verify to continue');

            const is2FA = !hasCaptcha && (
              lowerText.includes('2-step verification') ||
              lowerText.includes('authenticator app') ||
              lowerText.includes('enter 6-digit code') ||
              lowerText.includes('security code') ||
              lowerText.includes('enter the code from authenticator app')
            );

            const isEmailCheckpoint = !hasCaptcha && !is2FA && (
              lowerText.includes("verify it's really you") ||
              lowerText.includes("xác minh đó là bạn")
            );

            const visibleCodeInputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"], input[inputmode="numeric"], input[class*="Digit"]'))
              .filter(input => isVisible(input) && input.type !== 'password' && !input.disabled && !input.readOnly);

            const hasSixSingleDigitInputs = visibleCodeInputs.length >= 6 && visibleCodeInputs.slice(0, 6).every(input => {
              const maxLength = Number(input.getAttribute('maxlength') || input.maxLength || 0);
              const inputMode = (input.getAttribute('inputmode') || '').toLowerCase();
              const autocomplete = (input.getAttribute('autocomplete') || '').toLowerCase();
              return input.type === 'number' || inputMode === 'numeric' || autocomplete === 'one-time-code' || maxLength === 1;
            });

            const hasEmailSignal = lowerText.includes('email') || lowerText.includes('mail') || lowerText.includes('@') || lowerText.includes('hòm thư');
            const hasEmailCodePrompt = lowerText.includes('enter code') || lowerText.includes('verification code') || lowerText.includes('6-digit') || lowerText.includes('sent to email') || lowerText.includes('mã xác minh');

            const isEmailCodeInputScreen = isEmailCheckpoint && (visibleCodeInputs.length >= 1 || lowerText.includes('enter code') || lowerText.includes('sent to email'));
            const isEmailOptionSelectionScreen = isEmailCheckpoint && !isEmailCodeInputScreen;

            const resolvedEmailCodeInputScreen = isEmailCodeInputScreen ||
              (!hasCaptcha && !is2FA && hasEmailSignal && hasEmailCodePrompt && (visibleCodeInputs.length >= 1 || hasSixSingleDigitInputs));
            const resolvedEmailOptionSelectionScreen = !resolvedEmailCodeInputScreen &&
              (isEmailOptionSelectionScreen || ((isEmailCheckpoint || hasEmailSignal) && !hasEmailCodePrompt));

            const hasError = lowerText.includes('maximum number of attempts reached') ||
                             lowerText.includes('incorrect password') ||
                             lowerText.includes('user does not exist') ||
                             lowerText.includes('mật khẩu không đúng') ||
                             lowerText.includes('tài khoản không tồn tại');

            const hasLoginModal = lowerText.includes('log in to tiktok') ||
                                  lowerText.includes('đăng nhập vào tiktok') ||
                                  lowerText.includes('use phone or email') ||
                                  lowerText.includes('use qr code') ||
                                  lowerText.includes('continue with facebook') ||
                                  lowerText.includes('continue with google') ||
                                  lowerText.includes('continue with line');

            const passInput = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
            const emailInput = Array.from(document.querySelectorAll('input[name="username"], input[autocomplete="username"], input[placeholder*="Email" i], input[placeholder*="username" i]')).find(isVisible);
            const hasLoginForm = !!passInput && !!emailInput;

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
              return txt.includes('log in to comment') || txt.includes('đăng nhập để bình luận');
            }) || lowerText.includes('log in to comment');

            const isLoginUrl = url.includes('/login');
            const isLoginScreen = hasLoginModal || hasLoginForm || isLoginUrl || hasLoginButton || hasLoginToComment;

            return {
              hasUserMenu,
              hasLogoutBtn,
              hasCaptcha,
              is2FA,
              isEmailOptionSelectionScreen: resolvedEmailOptionSelectionScreen,
              isEmailCodeInputScreen: resolvedEmailCodeInputScreen,
              hasError,
              isLoginScreen,
              hasLoginModal,
              hasLoginForm,
              hasLoginButton,
              hasLoginToComment,
              isLoginUrl
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
              isLoginScreen: true,
              hasLoginModal: false,
              hasLoginForm: false,
              hasLoginButton: false,
              hasLoginToComment: false,
              isLoginUrl: false
            };
          }
        })();
      `);

      // A. STRICT LOGGED_IN CHECK
      // If modal or login form or login URL is visible, DOM logged-out wins over old/stale cookie.
      const isStrictlyAuthenticated = (!pageState.isLoginScreen && hasSessionCookie) ||
                                     (!pageState.isLoginScreen && pageState.hasUserMenu && pageState.hasLogoutBtn);

      if (isStrictlyAuthenticated) {
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

      // B. CAPTCHA DETECTED
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
        hasWarnedCaptcha = false;
      }

      // C. 2FA TOTP SCREEN DETECTED
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
            await fillSixDigitCodeSingleStrategy(win, totpCode);
          }
        } else {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `⚠️ Màn hình 2FA yêu cầu mã Authenticator nhưng tài khoản @${acc.username} chưa cài Khóa 2FA!`,
          });
          hasFilledTotp = true;
        }
      }

      // D. EMAIL OPTION SELECTION SCREEN
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

        await new Promise(r => setTimeout(r, 2500));
        continue;
      }

      // E. EMAIL CODE INPUT SCREEN DETECTED
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
          hasFilledEmailOtp = true;
        }
      }

      // F. LOGIN MODAL / LOGIN FORM / UNLOGGED PAGE HANDLING
      if (pageState.isLoginScreen && acc.password) {
        // Fallback: If modal click tried 2+ times and still on modal, load direct URL
        if (modalClickAttempts >= 2 && !hasTriedDirectEmailUrlFallback && !pageState.hasLoginForm) {
          hasTriedDirectEmailUrlFallback = true;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[LoginModal] Fallback load direct email login page https://www.tiktok.com/login/phone-or-email/email`,
          });
          await win.loadURL('https://www.tiktok.com/login/phone-or-email/email').catch(() => {});
          await new Promise(r => setTimeout(r, 2500));
          continue;
        }

        const modalAction = await win.webContents.executeJavaScript(`
          (() => {
            try {
              const url = window.location.href;
              const bodyText = document.body?.innerText || '';
              const lowerText = bodyText.toLowerCase();

              const isVisible = (el) => {
                if (!el) return false;
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
              };

              // 1. Check if email/username and password inputs are already visible
              const passInput = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
              const emailInput = Array.from(document.querySelectorAll('input[name="username"], input[autocomplete="username"], input[placeholder*="Email" i], input[placeholder*="username" i], input[type="text"]')).find(isVisible);
              if (passInput && emailInput) {
                return { type: 'FORM_READY' };
              }

              // 2. Check if on Phone tab / variant (has tab/switch link "Username or email" / "Log in with email or username")
              const isForgetPassword = (href, txt) => {
                return href.includes('forget-password') || href.includes('forgot-password') ||
                       txt.includes('forget') || txt.includes('forgot') ||
                       txt.includes('quên mật khẩu') || txt.includes('quen mat khau') ||
                       txt.includes('olvidaste') || txt.includes('oublié');
              };

              const switchLink = Array.from(document.querySelectorAll('a[href*="/login/phone-or-email/email"], [role="tab"], button, [role="button"], span, div, a, p')).find(el => {
                if (!isVisible(el)) return false;
                const txt = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                const href = (el.getAttribute('href') || '').toLowerCase();

                if (isForgetPassword(href, txt)) return false;
                if (txt === 'phone' || txt === 'điện thoại') return false;

                return href.includes('/login/phone-or-email/email') ||
                       txt === 'username or email' ||
                       txt === 'email or username' ||
                       txt === 'username / email' ||
                       txt === 'email / username' ||
                       txt === 'username' ||
                       txt === 'email' ||
                       (txt.includes('username') && txt.includes('email')) ||
                       (txt.includes('email') && txt.includes('username')) ||
                       (txt.includes('email') && txt.includes('tên')) ||
                       (txt.includes('email') && txt.includes('tiktok id')) ||
                       txt.includes('sử dụng email') ||
                       txt.includes('su dung email') ||
                       txt.includes('log in with email') ||
                       txt.includes('đăng nhập bằng email') ||
                       txt.includes('dang nhap bang email');
              });

              if (switchLink) {
                const rect = switchLink.getBoundingClientRect();
                switchLink.click?.();
                return {
                  type: 'SWITCH_TO_EMAIL_TAB',
                  text: (switchLink.innerText || switchLink.textContent || '').trim(),
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2)
                };
              }

              // 3. Collect visible option texts in modal for diagnostics
              const visibleOptions = Array.from(document.querySelectorAll('button, [role="button"], a, div, li, span'))
                .filter(isVisible)
                .filter(el => {
                  const rect = el.getBoundingClientRect();
                  return rect.width >= 120 && rect.width <= 600 && rect.height >= 28 && rect.height <= 120;
                })
                .map(el => (el.innerText || el.textContent || '').trim())
                .filter(txt => txt.length > 2 && txt.length < 80)
                .filter((txt, idx, arr) => arr.indexOf(txt) === idx)
                .slice(0, 10);

              const isModalPresent = lowerText.includes('log in to tiktok') ||
                                     lowerText.includes('đăng nhập vào tiktok') ||
                                     lowerText.includes('use qr code') ||
                                     lowerText.includes('use phone or email') ||
                                     lowerText.includes('continue with facebook') ||
                                     lowerText.includes('continue with google') ||
                                     lowerText.includes('continue with line');

              // 4. Search for "Use phone or email" option across all element tags
              const allElements = Array.from(document.querySelectorAll('button, [role="button"], a, div, li, span, p')).filter(isVisible);

              const matchesUsePhoneEmail = (raw) => {
                const norm = (raw || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                if (!norm || norm === 'x' || norm === 'close' || norm.includes('sign up') || norm.includes('đăng ký')) return false;
                if (norm.includes('terms of service') || norm.includes('privacy policy') || norm.includes('điều khoản')) return false;
                return norm === 'use phone or email' ||
                       norm === 'use phone/email' ||
                       norm === 'use phone or email or username' ||
                       norm === 'use phone / email / username' ||
                       norm.includes('use phone or email') ||
                       norm.includes('use phone/email') ||
                       norm.includes('use phone or email or username') ||
                       norm.includes('use phone / email / username') ||
                       norm.includes('phone or email') ||
                       norm.includes('phone / email') ||
                       norm.includes('sử dụng điện thoại / email / tên người dùng') ||
                       norm.includes('sử dụng điện thoại hoặc email') ||
                       norm.includes('sử dụng số điện thoại / email / tên người dùng') ||
                       norm.includes('sử dụng email') ||
                       norm.includes('điện thoại / email / tên người dùng');
              };

              const matchedContainers = allElements
                .filter(el => matchesUsePhoneEmail(el.innerText || el.textContent || el.getAttribute?.('aria-label')))
                .map(el => {
                  let container = el;
                  let cur = el;
                  for (let i = 0; i < 4 && cur; i++) {
                    const cRect = cur.getBoundingClientRect();
                    if (cRect.width >= 160 && cRect.height >= 32 && cRect.height <= 120) {
                      container = cur;
                      break;
                    }
                    cur = cur.parentElement;
                  }
                  const cRect = container.getBoundingClientRect();
                  return {
                    el: container,
                    rect: cRect,
                    text: (container.innerText || container.textContent || '').trim()
                  };
                })
                .filter(({ rect }) => rect.width >= 100 && rect.height >= 24 && rect.height <= 140 && rect.left >= 0 && rect.top >= 0);

              if (matchedContainers.length > 0) {
                const target = matchedContainers[0];
                target.el.scrollIntoView?.({ block: 'center', inline: 'center' });

                const x = Math.round(target.rect.left + target.rect.width / 2);
                const y = Math.round(target.rect.top + target.rect.height / 2);

                const eventInit = {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: x,
                  clientY: y,
                  button: 0
                };
                ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(eventName => {
                  const EventCtor = eventName.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
                  target.el.dispatchEvent(new EventCtor(eventName, eventInit));
                });
                target.el.click?.();

                return {
                  type: 'CLICKED_USE_PHONE_EMAIL',
                  text: target.text.slice(0, 100),
                  x,
                  y,
                  visibleOptions,
                  isModalPresent
                };
              }

              // 5. Check Top login button on homepage
              const topLoginBtn = document.querySelector('[data-e2e="top-login-button"]') ||
                                  Array.from(document.querySelectorAll('button, a, [role="button"]')).find(el => {
                                    if (!isVisible(el)) return false;
                                    const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                                    return txt === 'log in' || txt === 'đăng nhập';
                                  });
              if (topLoginBtn && isVisible(topLoginBtn)) {
                const rect = topLoginBtn.getBoundingClientRect();
                topLoginBtn.click?.();
                return {
                  type: 'CLICKED_TOP_LOGIN',
                  x: Math.round(rect.left + rect.width / 2),
                  y: Math.round(rect.top + rect.height / 2),
                  visibleOptions
                };
              }

              return {
                type: isModalPresent ? 'MODAL_PRESENT_BUT_NO_OPTION_MATCH' : 'NONE',
                isModalPresent,
                visibleOptions,
                bodyLength: bodyText.length,
                url,
                title: document.title
              };
            } catch(e) {
              return { type: 'ERROR', error: String(e) };
            }
          })();
        `);

        if (modalAction.type === 'FORM_READY') {
          if (!hasAutoFilled) {
            hasAutoFilled = true;
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `[LoginModal] Email/password form ready. Đang tự động điền thông tin đăng nhập cho @${acc.username}...`,
            });
            await autoFillTikTokLogin(win, acc.username, acc.password);
          }
        } else if (modalAction.type === 'SWITCH_TO_EMAIL_TAB') {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[LoginModal] Đã click chuyển sang tab Email/Username ("${modalAction.text}"). Đang chờ form...`,
          });
          if (modalAction.x && modalAction.y) {
            await performZoomAwareElectronClick(win, modalAction.x, modalAction.y).catch(() => {});
          }
          await new Promise(r => setTimeout(r, 1200));
          await autoFillTikTokLogin(win, acc.username, acc.password);
        } else if (modalAction.type === 'CLICKED_USE_PHONE_EMAIL') {
          modalClickAttempts++;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[LoginModal] Detected TikTok login modal. Clicked Use phone/email via DOM & coordinate (${modalAction.x}, ${modalAction.y}) [Option: "${modalAction.text}"]`,
          });

          if (modalAction.x && modalAction.y) {
            await performZoomAwareElectronClick(win, modalAction.x, modalAction.y).catch(() => {});
          }

          await new Promise(r => setTimeout(r, 2000));

          // Inspect if form is ready after click
          const checkAfterClick = await win.webContents.executeJavaScript(`
            (() => {
              try {
                const isVisible = (el) => {
                  if (!el) return false;
                  const rect = el.getBoundingClientRect();
                  const style = window.getComputedStyle(el);
                  return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
                };
                const passInput = Array.from(document.querySelectorAll('input[type="password"]')).find(isVisible);
                const emailInput = Array.from(document.querySelectorAll('input[name="username"], input[autocomplete="username"], input[placeholder*="Email" i], input[placeholder*="username" i], input[type="text"]')).find(isVisible);
                const switchLink = Array.from(document.querySelectorAll('a, button, [role="button"], span, div, p')).find(el => {
                  if (!isVisible(el)) return false;
                  const txt = (el.innerText || el.textContent || '').trim().toLowerCase();
                  return txt.includes('log in with email') || txt.includes('email or username') || txt.includes('đăng nhập bằng email');
                });
                return {
                  formReady: !!passInput && !!emailInput,
                  hasSwitchLink: !!switchLink,
                  switchLinkText: switchLink ? (switchLink.innerText || switchLink.textContent || '').trim() : ''
                };
              } catch(e) { return { formReady: false, hasSwitchLink: false }; }
            })();
          `).catch(() => ({ formReady: false, hasSwitchLink: false }));

          if (checkAfterClick.formReady) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `[LoginModal] Email/password form ready. Đang điền form đăng nhập cho @${acc.username}...`,
            });
            await autoFillTikTokLogin(win, acc.username, acc.password);
            hasAutoFilled = true;
          } else if (checkAfterClick.hasSwitchLink) {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'info',
              message: `[LoginModal] Đang ở tab Phone, bấm chuyển tab sang Email: "${checkAfterClick.switchLinkText}"...`,
            });
            await autoFillTikTokLogin(win, acc.username, acc.password);
          } else {
            onLog({
              accountId: acc.id,
              accountUsername: acc.username,
              level: 'warning',
              message: `[LoginModal] Use phone/email clicked nhưng form chưa sẵn sàng. [URL: ${modalAction.url || ''}] [Options: ${modalAction.visibleOptions?.join(', ')}]`,
            });
          }
        } else if (modalAction.type === 'MODAL_PRESENT_BUT_NO_OPTION_MATCH') {
          modalClickAttempts++;
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'warning',
            message: `[LoginModal] Failed to find Use phone/email option. [Options: ${modalAction.visibleOptions?.join(', ')}] [URL: ${modalAction.url}] [Title: "${modalAction.title}"] [BodyLen: ${modalAction.bodyLength}]`,
          });
        } else if (modalAction.type === 'CLICKED_TOP_LOGIN') {
          onLog({
            accountId: acc.id,
            accountUsername: acc.username,
            level: 'info',
            message: `[LoginModal] Clicked top login button on homepage.`,
          });
          if (modalAction.x && modalAction.y) {
            await performZoomAwareElectronClick(win, modalAction.x, modalAction.y).catch(() => {});
          }
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
      // Ignore transient navigation errors
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
