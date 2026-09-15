import { Page } from 'playwright-core';
import { TikTokAccount } from '../nest/accounts/account.interface';
import { generateTotpToken } from '../nest/accounts/totp.helper';
import { check, delay, until, KeyedQueue } from './control';
import { clickOptional, find, requireElement, parseCookies } from './browser';
import { OutlookService, supportsOutlook, trustedMicrosoftUrl } from './outlook';

export function loginIdentifier(account: Partial<TikTokAccount>): string {
  return [account.uid, account.username].find(v => v?.trim() && !/^\d+$/.test(v.trim()))?.trim().replace(/^@/, '') || account.email?.trim() || account.uid || account.username || '';
}
export function isEmailChallenge(text: string): boolean {
  if (/(?:code|mã)[\s\S]{0,60}(?:from|từ|trong)[\s\S]{0,40}(?:authenticator|authentication app|ứng dụng xác thực)/i.test(text) || /(?:sent to|gửi (?:đến|tới))[\s\S]{0,30}(?:phone|mobile|số điện thoại)/i.test(text)) return false;
  return /(?:code|mã)[\s\S]{0,160}(?:sent|send|gửi)[\s\S]{0,100}(?:email|e-mail|hộp thư|[^\s@]+@[^\s@]+\.[a-z]{2,})|(?:send|gửi)[\s\S]{0,30}(?:code|mã)[\s\S]{0,80}(?:email|e-mail)|(?:email|e-mail)[\s\S]{0,60}(?:verification code|mã xác minh)|(?:verify|xác minh)[\s\S]{0,40}(?:email|e-mail)/i.test(text);
}
export function isVerificationChooser(text: string) { return /2-step verification|two-step verification|verify.*really you|verify your identity|choose.*verification|xác minh 2 bước|xác minh danh tính|chọn.*xác minh/is.test(text); }
const codeSelector = "input[autocomplete='one-time-code'], input[name='code'], input[name='email_code'], input[maxlength='1'], input[placeholder*='6-digit'], input[placeholder*='6 chữ số']";
const captchaSelector = "#captcha-verify-container, .sec-captcha-container, .captcha-verify-container, iframe[src*='captcha']";
export async function waitForChallenge(page: Page, signal: AbortSignal, log: (message: string) => void, timeout = 180000) {
  if (!await find(page, captchaSelector)) return;
  log('Cần hoàn tất xác minh đang hiển thị trong trình duyệt.');
  await until(async () => !await find(page, captchaSelector), signal, timeout, 'Chưa hoàn tất xác minh trong trình duyệt.');
}
export async function ensureReady(page: Page, account: TikTokAccount, outlook: OutlookService, signal: AbortSignal, log: (message: string) => void, showCode: (code: string) => void, returnUrl: string) {
  if (await find(page, captchaSelector)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      check(signal); log(`Đang kiểm tra lại phiên đăng nhập ${attempt + 1}/3.`);
      await page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded' });
      // Do not submit a form hidden underneath an active challenge.
      if (!await find(page, captchaSelector)) {
        try { await ensureLogin(page, account, outlook, signal, log, showCode); }
        catch (error) { check(signal); if (/giới hạn|từ chối|thiếu|mật khẩu/i.test((error as Error).message)) throw error; }
      }
      await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
      if (!await find(page, captchaSelector)) break;
      await delay(1500, signal);
    }
    await waitForChallenge(page, signal, log, 60000);
  }
  await ensureLogin(page, account, outlook, signal, log, showCode, 3);
  if (!page.url().startsWith(returnUrl)) await page.goto(returnUrl, { waitUntil: 'domcontentloaded' });
}
export async function authenticated(page: Page): Promise<boolean> {
  if (await find(page, [captchaSelector, codeSelector, "[data-e2e='top-login-button'], [data-e2e='nav-login-button'], button[data-e2e='login-button']"])) return false;
  if (await find(page, "[data-e2e='edit-profile-entrance'], [data-e2e='profile-icon'] img, [data-e2e='nav-profile'] [data-e2e='avatar']")) return true;
  if (!page.url().startsWith('https://www.tiktok.com/')) return false;
  return page.evaluate(async () => {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 5000);
    try { const response = await fetch('/passport/web/account/info/?aid=1459&app_name=tiktok_web&device_platform=web_pc', { credentials: 'include', signal: controller.signal }); const data = await response.json(); return data.message === 'success' && !!data.data && Object.keys(data.data).length > 0; }
    catch { return false; } finally { clearTimeout(timer); }
  }).catch(() => false);
}
export function containsMailbox(text: string, email: string): boolean {
  return text.toLowerCase().split(/[^a-z0-9_.@+\-]+/).includes(email.trim().toLowerCase());
}
export async function automateMicrosoft(page: Page, account: TikTokAccount, code: string, url: string, signal: AbortSignal, log: (message: string) => void) {
  if (!trustedMicrosoftUrl(url, true)) throw new Error('Địa chỉ Microsoft không hợp lệ.');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 180000;
  let deviceSent = false, emailSent = false, passwordSent = false, consentSent = false, accountSelected = false, methodSelected = false, appConfirmed = false;
  while (Date.now() < deadline) {
    check(signal);
    if (!trustedMicrosoftUrl(page.url())) { await delay(500, signal); continue; }
    const text = await page.locator('body').innerText();
    if (/you have signed in|you can now close|đã đăng nhập|có thể đóng/i.test(text)) return;
    const devicePage = /deviceauth|devicelogin|oauth2.*device|common\/oauth2\/deviceauth/i.test(page.url());
    if (deviceSent && devicePage && /invalid.*code|code.*expired|mã.*hết hạn|mã.*không hợp lệ/i.test(text)) { const error = new Error('Microsoft từ chối mã kết nối.'); error.name = 'DeviceCodeRejected'; throw error; }
    const error = await find(page, "#passwordError, #usernameError, #errorText, [data-testid='error-message']");
    if (error && (await error.innerText()).trim()) throw new Error('Microsoft từ chối thông tin đăng nhập; kiểm tra Mail/PassMail.');
    if (!deviceSent && devicePage) {
      const input = await find(page, "input[name='otc'], #otc, input[name='code'], #code");
      if (input) { await input.fill(code); deviceSent = await clickOptional(page, "input[type='submit'], button[type='submit']", signal); await delay(500, signal); continue; }
    }
    if (!methodSelected && !passwordSent) {
      methodSelected = await clickOptional(page, "#idA_PWD_SwitchToPassword, button:text-is('Use your password'), a:text-is('Use your password'), button:text-is('Sử dụng mật khẩu')", signal);
      if (methodSelected) { await delay(500, signal); continue; }
    }
    if (await find(page, "input[name='otc'], input[name='ProofConfirmation'], #idTxtBx_SAOTCC_OTC") || /approve sign.in request|check your authenticator|prove you're not a robot/i.test(text)) {
      log('Hoàn tất MFA hoặc xác minh trong tab Microsoft.'); await delay(1000, signal); continue;
    }
    if (!accountSelected && /pick an account|choose an account|chọn.*tài khoản/i.test(text)) {
      const options = page.locator("[role='button'], button, [data-test-id]");
      for (let i = 0; i < await options.count(); i++) {
        if (await options.nth(i).isVisible() && (await options.nth(i).innerText()).trim().toLowerCase() === account.email?.trim().toLowerCase()) { await options.nth(i).click(); accountSelected = true; break; }
      }
      if (!accountSelected) accountSelected = await clickOptional(page, '#otherTile', signal);
      await delay(500, signal); continue;
    }
    if (!emailSent) {
      const input = await find(page, "input[type='email'], input[name='loginfmt']");
      if (input) { await input.fill(account.email || ''); emailSent = await clickOptional(page, "input[type='submit'], button[type='submit']", signal); await delay(500, signal); continue; }
    }
    if (!passwordSent) {
      const input = await find(page, "input[name='passwd'], input[type='password']");
      if (input) {
        const banner = await find(page, "#displayName, #userDisplayName, [data-testid='identity-banner']");
        if (!containsMailbox(banner ? await banner.innerText() : text, account.email || '')) { log('Chưa xác nhận đúng hộp thư Microsoft; chưa điền mật khẩu.'); await delay(1000, signal); continue; }
        if (!account.passMail) { log('Nhập mật khẩu Outlook trong tab Microsoft.'); passwordSent = true; }
        else { await input.fill(account.passMail); passwordSent = await clickOptional(page, "input[type='submit'], button[type='submit']", signal); await delay(500, signal); continue; }
      }
    }
    const expected = /MyTikTokTool Outlook/i.test(text) && containsMailbox(text, account.email || '');
    const consent = expected && /read your mail|read user mail|đọc thư của bạn|đọc email của bạn/i.test(text) && !/read and write|send mail|delete|đọc và ghi|gửi thư|xóa thư|all users/i.test(text);
    if (consent && !consentSent) consentSent = await clickOptional(page, "#idBtn_Accept, [data-testid='appConsentPrimaryButton'], input[type='submit'], button[type='submit']", signal);
    if (!appConfirmed && expected && /are you trying to sign in|bạn có đang.*đăng nhập|bạn đang cố.*đăng nhập/i.test(text)) appConfirmed = await clickOptional(page, '#idSIButton9', signal);
    if (/stay signed in|duy trì đăng nhập/i.test(text)) await clickOptional(page, "#idBtn_Back, button:text-is('No'), button:text-is('Không')", signal);
    await delay(500, signal);
  }
  throw new Error('Hết thời gian chờ Microsoft; hoàn tất xác minh trong tab Microsoft.');
}
async function connectOutlook(page: Page, account: TikTokAccount, outlook: OutlookService, signal: AbortSignal, log: (s: string) => void, showCode: (s: string) => void) {
  if (await outlook.connected(account.email!, signal)) return;
  const microsoft = await page.context().newPage(); let connected = false;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await outlook.connect(account.email!, signal, showCode, (code, url, browserSignal) => automateMicrosoft(microsoft, account, code, url, browserSignal, log)); connected = true; return; }
      catch (error) { check(signal); if ((error as Error).name !== 'DeviceCodeRejected' || attempt > 0) throw error; log('Đang xin mã kết nối Microsoft mới.'); }
    }
  } finally { if (connected) await microsoft.close().catch(() => {}); await page.bringToFront().catch(() => {}); }
}
export async function fillCode(page: Page, code: string, signal: AbortSignal) {
  if (!/^\d{6}$/.test(code)) throw new Error('Mã xác minh phải có 6 chữ số.');
  const first = await requireElement(page, codeSelector, signal, 'Không tìm thấy ô mã xác minh.');
  const frame = await first.elementHandle().then(handle => handle!.ownerFrame());
  const inputs = frame!.locator(codeSelector);
  const visible = [];
  for (let i = 0; i < await inputs.count(); i++) if (await inputs.nth(i).isVisible()) visible.push(inputs.nth(i));
  if (visible.length === 6) {
    for (let i = 0; i < 6; i++) { check(signal); await visible[i].fill(code[i]); }
  } else if (visible.length === 1 && await first.getAttribute('maxlength') !== '1') await first.fill(code);
  else throw new Error('Không nhận diện được các ô mã xác minh.');
  await until(async () => {
    if (await authenticated(page)) return true;
    const field = await find(page, codeSelector);
    if (!field) return false;
    const action = "descendant::*[(self::button or @role='button') and (normalize-space(.)='Next' or normalize-space(.)='Verify' or normalize-space(.)='Confirm' or normalize-space(.)='Continue' or normalize-space(.)='Tiếp' or normalize-space(.)='Tiếp tục' or normalize-space(.)='Xác minh' or normalize-space(.)='Xác nhận')]";
    const container = field.locator('xpath=ancestor::*[' + action + '][1]');
    const buttons = container.locator('xpath=' + action);
    for (let i = 0; i < await buttons.count(); i++) {
      const button = buttons.nth(i);
      if (await button.isVisible() && await button.isEnabled() && await button.getAttribute('aria-disabled') !== 'true') { check(signal); await button.click(); return true; }
    }
    return false;
  }, signal, 10000, 'Đã điền mã nhưng chưa bấm được nút xác nhận OTP.');
}
const emailLogins = new KeyedQueue();
export async function ensureLogin(page: Page, account: TikTokAccount, outlook: OutlookService, signal: AbortSignal, log: (message: string) => void, showCode: (code: string) => void, attempts = 1) {
  const work = async () => {
    for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
      try { return await loginSession(page, account, outlook, signal, log, showCode); }
      catch (error) {
        check(signal);
        const message = (error as Error).message;
        if (attempt + 1 >= attempts || /thiếu|giới hạn|từ chối|mật khẩu|mã xác minh|Microsoft|Outlook/i.test(message)) throw error;
        log(`Đăng nhập chưa hoàn tất, thử lại ${attempt + 2}/${attempts}.`);
        await delay(1500, signal); await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' });
      }
    }
  };
  if (supportsOutlook(account.email || '')) return emailLogins.run(account.email!.trim().toLowerCase(), signal, work);
  return work();
}
async function loginSession(page: Page, account: TikTokAccount, outlook: OutlookService, signal: AbortSignal, log: (message: string) => void, showCode: (code: string) => void) {
  check(signal); await waitForChallenge(page, signal, log);
  if (await authenticated(page)) return;
  if (account.cookie) {
    try {
      await page.context().addCookies(parseCookies(account.cookie));
      await page.goto('https://www.tiktok.com', { waitUntil: 'domcontentloaded' });
      if (await authenticated(page)) return;
    } catch { check(signal); log('Cookie lưu không còn hiệu lực; chuyển sang mật khẩu.'); }
  }
  if (!account.password) throw new Error('Tài khoản thiếu mật khẩu và phiên đăng nhập không còn hiệu lực.');
  if (account.passMail && supportsOutlook(account.email || '')) await connectOutlook(page, account, outlook, signal, log, showCode);
  log('Đang đăng nhập bằng username/email, mật khẩu và mã xác minh.');
  await page.goto('https://www.tiktok.com/login/phone-or-email/email', { waitUntil: 'domcontentloaded' });
  await clickOptional(page, "[data-e2e='channel-item']:has-text('Use phone'), [data-e2e='channel-item']:has-text('Sử dụng số điện thoại')", signal);
  await clickOptional(page, "button[data-list-item-value*='email/username'], a[href*='phone-or-email/email']", signal);
  if (/maximum number of attempts|try again later|quá nhiều/i.test(await page.locator('body').innerText())) throw new Error('TikTok giới hạn số lần thử; đã dừng đăng nhập.');
  const identity = await requireElement(page, "input[name='username'], input[autocomplete='username'], input[placeholder*='Email'], input[placeholder*='Username']", signal, 'Không tìm thấy ô username/email.', 30000);
  await identity.fill(loginIdentifier(account));
  const password = await requireElement(page, "input[type='password']", signal, 'Không tìm thấy ô mật khẩu.');
  await password.fill(account.password);
  let requestedAt = Date.now();
  await (await requireElement(page, "button[data-e2e='login-button'], button[type='submit']", signal, 'Không tìm thấy nút đăng nhập.')).click();
  const deadline = Date.now() + 180000;
  let totpSent = false, emailSent = false, methodSelected = false;
  while (Date.now() < deadline) {
    check(signal); await waitForChallenge(page, signal, log);
    if (await authenticated(page)) { log('Đăng nhập thành công.'); return; }
    const text = await page.locator('body').innerText();
    const error = await find(page, "[data-e2e='error-message'], [role='alert']");
    if (error && /incorrect|wrong password|suspended|banned|không chính xác|bị khóa|maximum number of attempts|try again later|quá nhiều/i.test(await error.innerText())) throw new Error('TikTok từ chối đăng nhập hoặc giới hạn số lần thử.');
    if (isVerificationChooser(text) && !methodSelected) methodSelected = await clickOptional(page, "[role='dialog'] :text-is('Email'), [class*='Modal'] :text-is('Email')", signal);
    if (isEmailChallenge(text) && !emailSent) {
      if (!account.email || !supportsOutlook(account.email)) throw new Error('Xác minh email cần hộp thư Outlook/Hotmail đã cấu hình.');
      await connectOutlook(page, account, outlook, signal, log, showCode);
      const send = await find(page, "button[data-e2e='send-code-button'], button:text-is('Send code'), button:text-is('Gửi mã')");
      if (send && await send.isEnabled()) { requestedAt = Date.now(); await send.click(); }
      await waitForChallenge(page, signal, log);
      await requireElement(page, codeSelector, signal, 'TikTok chưa mở ô xác minh email.', 120000);
      log('Đang chờ mã email mới từ Outlook.');
      const code = await outlook.waitForCode(account.email, requestedAt, signal);
      if (await authenticated(page)) return;
      if (!isEmailChallenge(await page.locator('body').innerText())) throw new Error('Màn hình xác minh email đã thay đổi; chưa điền mã.');
      await fillCode(page, code, signal); emailSent = true;
    } else if (/authenticator|authentication app|ứng dụng xác thực/i.test(text) && await find(page, codeSelector) && !totpSent) {
      const code = generateTotpToken(account.twoFactor || '');
      if (!code) throw new Error('Tài khoản thiếu khóa 2FA hợp lệ.');
      await fillCode(page, code, signal); totpSent = true;
    }
    await delay(700, signal);
  }
  throw new Error('Hết thời gian chờ đăng nhập TikTok.');
}
