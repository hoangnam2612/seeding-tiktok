import { Page } from 'puppeteer-core';
import { TaskLogItem } from '../nest/automation/automation.interface';
import { generateTotpToken } from '../nest/accounts/totp.helper';

export interface AutoLoginOptions {
  page: Page;
  accountId: string;
  username?: string;
  email?: string;
  password?: string;
  twoFactor?: string;
  onLog: (log: Omit<TaskLogItem, 'id' | 'timestamp'>) => void;
  isCancelled?: () => boolean;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Automatically fills Username, Password and handles 2FA TOTP on TikTok Login page
 */
export async function autoFillTikTokLoginCredentials(options: AutoLoginOptions): Promise<boolean> {
  const {
    page,
    accountId,
    username,
    email,
    password,
    twoFactor,
    onLog,
    isCancelled = () => false,
  } = options;

  const cleanUsername = username ? username.replace(/^@/, '').trim() : '';
  const loginUser = cleanUsername || (email ? email.trim() : '');
  if (!loginUser || !password) {
    return false;
  }

  try {
    // 1. Wait up to 8s for the login input fields to be visible
    const userInputSelector = await page.waitForSelector(
      'input[name="username"], input[type="text"], input[placeholder*="Email"], input[placeholder*="username"], input[placeholder*="tài khoản"]',
      { visible: true, timeout: 8000 }
    ).then(() => 'input[name="username"], input[type="text"], input[placeholder*="Email"], input[placeholder*="username"], input[placeholder*="tài khoản"]')
    .catch(() => null);

    if (!userInputSelector || isCancelled()) {
      return false;
    }

    onLog({
      accountId,
      accountUsername: username,
      level: 'info',
      message: `🤖 Đang tự động điền Username: "${cleanUsername || loginUser}"...`,
    });

    // Clear and Type Username
    await page.click(userInputSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(userInputSelector, cleanUsername || loginUser, { delay: Math.floor(Math.random() * 30) + 30 });
    await delay(300);

    // Find and Type Password
    const passInputSelector = 'input[type="password"], input[placeholder*="Password"], input[placeholder*="Mật khẩu"]';
    await page.waitForSelector(passInputSelector, { visible: true, timeout: 4000 });
    await page.click(passInputSelector, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(passInputSelector, password, { delay: Math.floor(Math.random() * 30) + 30 });
    await delay(400);

    // Click Login Button
    onLog({
      accountId,
      accountUsername: username,
      level: 'info',
      message: `🚀 Đang bấm nút Đăng nhập...`,
    });

    const clicked = await page.evaluate(() => {
      const loginButtons = [
        'button[data-e2e="login-button"]',
        'button[type="submit"]',
        'button[aria-label*="Log in"]',
        'button[aria-label*="Đăng nhập"]',
      ];
      for (const sel of loginButtons) {
        const btn = document.querySelector(sel) as HTMLElement;
        if (btn && !btn.hasAttribute('disabled') && btn.getAttribute('aria-disabled') !== 'true') {
          btn.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) {
      await page.keyboard.press('Enter');
    }

    // 2. Continuous Watch Loop for 2FA Screen (up to 20 seconds)
    const watchStartTime = Date.now();
    let handled2FA = false;

    while (Date.now() - watchStartTime < 20000 && !handled2FA) {
      if (page.isClosed() || isCancelled()) break;

      // Detect if 2FA TOTP screen / 6-digit input is present
      const has2FAScreen = await page.evaluate(() => {
        const text = (document.body?.innerText || '').toLowerCase();
        const hasText =
          text.includes('2-step') ||
          text.includes('verification') ||
          text.includes('xác minh') ||
          text.includes('6-digit') ||
          text.includes('mã 6') ||
          text.includes('authenticator') ||
          text.includes('bảo mật');

        const inputs = document.querySelectorAll(
          'input[type="tel"], input[maxlength="1"], input[data-e2e*="digit"], input[placeholder*="6"], input[autocomplete="one-time-code"]'
        );

        return hasText || inputs.length > 0;
      }).catch(() => false);

      if (has2FAScreen) {
        if (twoFactor && twoFactor.trim().length > 0) {
          const totpCode = generateTotpToken(twoFactor);
          if (totpCode && totpCode.length === 6) {
            onLog({
              accountId,
              accountUsername: username,
              level: 'info',
              message: `🔐 Phát hiện màn hình 2FA! Đã sinh mã TOTP 6 số [ ${totpCode} ]. Đang gõ từng số...`,
            });

            await delay(600);

            // Strategy 1: Find individual digit input boxes
            const digitInputs = await page.$$(
              'input[maxlength="1"], input[type="tel"], input[data-e2e*="digit"], input[pattern="[0-9]*"]'
            );

            if (digitInputs.length >= 6) {
              for (let i = 0; i < 6; i++) {
                try {
                  await digitInputs[i].click();
                  await delay(60);
                  await page.keyboard.press('Backspace');
                  await page.keyboard.type(totpCode[i], { delay: 80 });
                  await delay(80);
                } catch {}
              }
            } else {
              // Strategy 2: Single OTP input box or focus first input
              const singleInput = await page.$(
                'input[type="tel"], input[placeholder*="6"], input[placeholder*="code"], input[placeholder*="mã"], input[autocomplete="one-time-code"], input[type="text"], input'
              );

              if (singleInput) {
                await singleInput.click();
                await delay(100);
                // Clear any existing value
                await page.keyboard.down('Control');
                await page.keyboard.press('KeyA');
                await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await delay(80);

                for (const char of totpCode) {
                  await page.keyboard.type(char, { delay: 100 });
                  await delay(60);
                }
              } else {
                // Strategy 3: Global keyboard typing
                for (const char of totpCode) {
                  await page.keyboard.type(char, { delay: 100 });
                  await delay(60);
                }
              }
            }

            // Strategy 4: Native React value setter fallback to activate Next button state
            await page.evaluate((code) => {
              const setReactValue = (el: HTMLInputElement, val: string) => {
                const proto = Object.getPrototypeOf(el);
                const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
                if (setter) {
                  setter.call(el, val);
                } else {
                  el.value = val;
                }
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
                el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: val }));
              };

              const allInputs = Array.from(
                document.querySelectorAll('input[maxlength="1"], input[type="tel"], input[data-e2e*="digit"]')
              ) as HTMLInputElement[];

              if (allInputs.length >= 6) {
                allInputs.forEach((inp, idx) => setReactValue(inp, code[idx]));
              } else {
                const single = document.querySelector('input') as HTMLInputElement;
                if (single) setReactValue(single, code);
              }
            }, totpCode).catch(() => {});

            await delay(800);

            // Click Next / Verify / Submit button
            const nextClicked = await page.evaluate(() => {
              const buttons = Array.from(document.querySelectorAll('button'));
              for (const b of buttons) {
                const text = (b.textContent || '').toLowerCase().trim();
                const isVerifyBtn =
                  text.includes('next') ||
                  text.includes('tiếp') ||
                  text.includes('xác nhận') ||
                  text.includes('verify') ||
                  text.includes('continue') ||
                  text.includes('submit') ||
                  text.includes('đăng nhập') ||
                  text.includes('log in');

                if (isVerifyBtn && !b.hasAttribute('disabled') && b.getAttribute('aria-disabled') !== 'true') {
                  b.click();
                  return true;
                }
              }
              return false;
            }).catch(() => false);

            if (!nextClicked) {
              await page.keyboard.press('Enter');
            }

            handled2FA = true;
            onLog({
              accountId,
              accountUsername: username,
              level: 'success',
              message: `✅ Đã điền xong mã 2FA TOTP [ ${totpCode} ] và bấm Xác nhận!`,
            });
            break;
          }
        } else {
          onLog({
            accountId,
            accountUsername: username,
            level: 'warning',
            message: `⚠️ Màn hình yêu cầu mã 2FA nhưng tài khoản chưa có 2FA Secret Key. Vui lòng nhập thủ công.`,
          });
          break;
        }
      }

      await delay(1000);
    }

    return true;
  } catch (err: any) {
    onLog({
      accountId,
      accountUsername: username,
      level: 'warning',
      message: `⚠️ Tự động điền đăng nhập: ${err?.message || err}`,
    });
    return false;
  }
}
