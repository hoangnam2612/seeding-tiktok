using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using MyTikTokTool.Models;
using Newtonsoft.Json.Linq;
using OpenQA.Selenium;
using OpenQA.Selenium.Interactions;
using SeleniumKeys = OpenQA.Selenium.Keys;

namespace MyTikTokTool.Services;

public partial class TikTokLoginService
{
    private readonly AccountService _accountService;

    public TikTokLoginService(AccountService accountService)
    {
        _accountService = accountService;
    }

    public async Task<LoginResult> LoginAsync(Account account, IWebDriver? driver = null, Action<string>? onProgress = null, CancellationToken token = default)
    {
        try
        {
            token.ThrowIfCancellationRequested();
            if (driver == null)
            {
                onProgress?.Invoke("Đang khởi tạo trình duyệt Chrome...");
                driver = ChromeService.OpenSeleniumChrome(account, startUrl: "https://www.tiktok.com");
            }

            await Task.Delay(3500, token);

            // BƯỚC 1: Kiểm tra xem tài khoản đã đăng nhập sẵn trong Profile này chưa
            onProgress?.Invoke("Kiểm tra trạng thái đăng nhập...");
            if (CheckIfLoggedIn(driver))
            {
                string cookies = ExtractCookiesString(driver);
                UpdateAccountSuccess(account, cookies);
                return LoginResult.Ok("Đã đăng nhập sẵn từ trước (Live)", cookies);
            }

            // BƯỚC 2: Nếu có Cookie lưu sẵn -> Thử nạp Cookie
            if (!string.IsNullOrWhiteSpace(account.Cookies))
            {
                onProgress?.Invoke("Đang nạp Cookie tài khoản...");
                var cookieResult = LoginWithCookies(driver, account);
                if (cookieResult.Success)
                {
                    UpdateAccountSuccess(account, cookieResult.ExtractedCookies);
                    return cookieResult;
                }
                else
                {
                    onProgress?.Invoke("Cookie cũ không còn hiệu lực, chuyển sang đăng nhập bằng tài khoản/mật khẩu...");
                }
            }

            // BƯỚC 3: Đăng nhập bằng Username / Email + Password + 2FA
            if (!string.IsNullOrWhiteSpace(account.Password) && (!string.IsNullOrWhiteSpace(account.Uid) || !string.IsNullOrWhiteSpace(account.Username) || !string.IsNullOrWhiteSpace(account.Email)))
            {
                onProgress?.Invoke("Đang mở form đăng nhập TikTok...");
                var credResult = await LoginWithCredentialsAsync(driver, account, onProgress, token);
                if (credResult.Success)
                {
                    UpdateAccountSuccess(account, credResult.ExtractedCookies);
                    return credResult;
                }
                else
                {
                    UpdateAccountStatus(account, credResult.Status, credResult.Message);
                    return credResult;
                }
            }

            return LoginResult.Fail("Thiếu thông tin", "Tài khoản thiếu mật khẩu hoặc thông tin đăng nhập.");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            UpdateAccountStatus(account, "Đã dừng", "Đã dừng đăng nhập.");
            return LoginResult.Fail("Đã dừng", "Đã dừng đăng nhập.");
        }
        catch (Exception ex)
        {
            UpdateAccountStatus(account, "Lỗi", ex.Message);
            return LoginResult.Fail("Lỗi", $"Lỗi đăng nhập: {ex.Message}");
        }
    }

    public LoginResult LoginWithCookies(IWebDriver driver, Account account)
    {
        try
        {
            driver.Navigate().GoToUrl("https://www.tiktok.com");
            Thread.Sleep(2500);

            ChromeService.InjectCookies(driver, account.Cookies!, ".tiktok.com");
            driver.Navigate().Refresh();
            Thread.Sleep(3000);

            if (CheckIfLoggedIn(driver))
            {
                string newCookies = ExtractCookiesString(driver);
                return LoginResult.Ok("Đăng nhập bằng Cookie thành công", newCookies);
            }

            return LoginResult.Fail("Cookie hết hạn", "Cookie không hợp lệ hoặc đã hết hạn.");
        }
        catch (Exception ex)
        {
            return LoginResult.Fail("Lỗi Cookie", ex.Message);
        }
    }

    public async Task<LoginResult> LoginWithCredentialsAsync(IWebDriver driver, Account account, Action<string>? onProgress = null, CancellationToken token = default)
    {
        SemaphoreSlim? emailGate = null;
        bool acquired = false;
        try
        {
            if (OutlookMailService.Supports(account.Email))
            {
                emailGate = EmailLoginLocks.GetOrAdd(account.Email!.Trim().ToLowerInvariant(), _ => new SemaphoreSlim(1, 1));
                onProgress?.Invoke("Đang chờ lượt đăng nhập của hộp thư...");
                await emailGate.WaitAsync(token);
                acquired = true;
                if (!string.IsNullOrWhiteSpace(account.Passmail))
                {
                    onProgress?.Invoke("Đang chuẩn bị kết nối hộp thư Outlook...");
                    try { await OutlookBrowserLogin.EnsureConnectedAsync(driver, account, onProgress, token); }
                    catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
                    catch (Exception ex) when (ex is InvalidOperationException or TimeoutException or HttpRequestException or WebDriverException)
                    {
                        return LoginResult.Fail("Lỗi kết nối Outlook", ex is HttpRequestException or WebDriverException
                            ? "Không kết nối được Outlook trên trình duyệt. Kiểm tra mạng hoặc thử lại." : ex.Message);
                    }
                }
            }
            // 1. Mở trang chủ TikTok để nạp cookie phiên và passport security tokens (s_v_web_id, ttwid)
            onProgress?.Invoke("Đang khởi tạo phiên bảo mật TikTok...");
            driver.Navigate().GoToUrl("https://www.tiktok.com");
            await Task.Delay(3500, token);

            try
            {
                ((IJavaScriptExecutor)driver).ExecuteScript("window.scrollBy(0, 200);");
            }
            catch { }
            await Task.Delay(1000, token);

            // 2. Mở trang đăng nhập trực tiếp
            string targetUrl = "https://www.tiktok.com/login/phone-or-email/email";
            onProgress?.Invoke("Đang mở trang đăng nhập TikTok...");
            driver.Navigate().GoToUrl(targetUrl);
            await Task.Delay(3000, token);

            // Xử lý nếu TikTok hiện màn hình chọn phương thức (modal login chung)
            NaturalClick(driver, new[]
            {
                "//div[contains(text(), 'Use phone / email / username') or contains(text(), 'Sử dụng số điện thoại / email / tên người dùng')]",
                "//p[contains(text(), 'Use phone / email / username') or contains(text(), 'Sử dụng số điện thoại')]",
                "div[data-e2e='channel-item']:first-child"
            });
            await Task.Delay(1000, token);

            // Click tab email/username nếu có (chuyển từ tab Phone sang tab Email/Username)
            NaturalClick(driver, new[]
            {
                "button[data-list-item-value*='email/username']",
                "//a[contains(@href, 'phone-or-email/email')]",
                "//a[contains(text(), 'Log in with email or username') or contains(text(), 'Đăng nhập bằng email')]",
                "//div[contains(text(), 'Log in with email') or contains(text(), 'Đăng nhập bằng email')]",
                "//a[contains(text(), 'Log in with email') or contains(text(), 'Email') or contains(text(), 'Username')]",
                "//span[contains(text(), 'Log in with email') or contains(text(), 'Đăng nhập bằng email')]"
            });
            await Task.Delay(1200, token);

            string? preSubmitError = CheckErrorMessage(driver);
            if (IsAttemptLimitError(preSubmitError))
            {
                return LoginResult.Fail("Bị chặn IP/Tài khoản", "TikTok đang giới hạn số lần thử. Đã dừng trước khi gửi thêm attempt.");
            }

            // Chờ tìm ô nhập tài khoản (thử tối đa 8 lần)
            IWebElement? userInput = null;
            string[] userSelectors = new[]
            {
                "input[name='username']",
                "input[placeholder*='Email']",
                "input[placeholder*='Username']",
                "input[placeholder*='tên người dùng']",
                "input[autocomplete='username']",
                "input[type='text']"
            };

            for (int retry = 0; retry < 8; retry++)
            {
                userInput = FindInputElement(driver, userSelectors);
                if (userInput != null) break;

                // Thử click lại tab email nếu chưa mở
                NaturalClick(driver, new[]
                {
                    "//a[contains(@href, 'phone-or-email/email')]",
                    "//a[contains(text(), 'Log in with email or username') or contains(text(), 'Đăng nhập bằng email')]",
                    "//div[contains(text(), 'Log in with email') or contains(text(), 'Đăng nhập bằng email')]"
                });
                await Task.Delay(800, token);
            }

            if (userInput == null)
            {
                return LoginResult.Fail("Lỗi giao diện", "Không tìm thấy ô nhập tài khoản (Form đăng nhập chưa tải xong hoặc khác giao diện).");
            }

            string loginUser = GetLoginIdentifier(account);

            onProgress?.Invoke($"Đang nhập tài khoản: {loginUser}...");
            if (!FillInputAndVerify(driver, userInput, loginUser, isPassword: false))
            {
                return LoginResult.Fail("Lỗi nhập liệu", "Không thể nhập tài khoản vào form đăng nhập TikTok.");
            }
            await Task.Delay(1000, token);

            // Điền Password
            var passInput = FindInputElement(driver, new[]
            {
                "input[type='password']",
                "input[name='password']",
                "input[placeholder*='Password']",
                "input[placeholder*='mật khẩu']",
                "input[autocomplete='current-password']"
            });

            if (passInput == null)
            {
                return LoginResult.Fail("Lỗi giao diện", "Không tìm thấy ô nhập mật khẩu.");
            }

            onProgress?.Invoke("Đang nhập mật khẩu...");
            if (!FillInputAndVerify(driver, passInput, account.Password!, isPassword: true))
            {
                return LoginResult.Fail("Lỗi nhập liệu", "Không thể nhập mật khẩu vào form đăng nhập TikTok.");
            }
            await Task.Delay(1200, token);

            string? beforeClickError = CheckErrorMessage(driver);
            if (IsAttemptLimitError(beforeClickError))
            {
                return LoginResult.Fail("Bị chặn IP/Tài khoản", "TikTok đang giới hạn số lần thử. Đã dừng trước khi bấm đăng nhập.");
            }

            // Bấm nút Đăng nhập với tọa độ chuột tự nhiên
            token.ThrowIfCancellationRequested();
            var emailRequestedAt = DateTimeOffset.UtcNow;
            onProgress?.Invoke("Bấm nút Đăng nhập...");
            bool clickedLogin = NaturalClick(driver, new[]
            {
                "button[data-e2e='login-button']",
                "button[type='submit']",
                "//button[contains(., 'Log in') or contains(., 'Đăng nhập')]"
            });

            if (!clickedLogin)
            {
                passInput.SendKeys(SeleniumKeys.Enter);
            }

            onProgress?.Invoke("Đang chờ phản hồi từ máy chủ TikTok (OTP/2FA/Captcha)...");
            bool twoFactorSubmitted = false;
            bool emailSubmitted = false;
            bool emailSelected = false;

            // Chờ phản hồi và xử lý 2FA / OTP / Captcha (tối đa 40 lần ~ 60s)
            for (int i = 0; i < 40; i++)
            {
                await Task.Delay(1500, token);

                if (CheckIfLoggedIn(driver))
                {
                    string cookies = ExtractCookiesString(driver);
                    onProgress?.Invoke("🎉 Phát hiện đăng nhập thành công!");
                    return LoginResult.Ok("Đăng nhập thành công!", cookies);
                }

                // Kiểm tra thông báo lỗi trên màn hình trước khi gửi thêm thao tác
                string? errorMsg = CheckErrorMessage(driver);
                if (!string.IsNullOrEmpty(errorMsg))
                {
                    onProgress?.Invoke($"⚠️ Thông báo từ TikTok: {errorMsg}");
                    if (IsAttemptLimitError(errorMsg))
                    {
                        return LoginResult.Fail("Bị chặn IP/Tài khoản", "TikTok giới hạn số lần thử. Đã dừng auto-login để tránh tăng thêm attempt.");
                    }
                    if (errorMsg.Contains("suspended") || errorMsg.Contains("đình chỉ") || errorMsg.Contains("khóa"))
                    {
                        return LoginResult.Fail("Die", $"Tài khoản bị khóa: {errorMsg}");
                    }
                    if (errorMsg.Contains("exist") || errorMsg.Contains("không tồn tại"))
                    {
                        return LoginResult.Fail("Die", $"Tài khoản không tồn tại: {errorMsg}");
                    }
                    if (emailSubmitted && System.Text.RegularExpressions.Regex.IsMatch(errorMsg, "incorrect|invalid|expired|không đúng|không hợp lệ|hết hạn", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                        return LoginResult.Fail("Lỗi mã email", "TikTok từ chối mã email hoặc mã đã hết hạn. Hãy yêu cầu mã mới.");
                    if (errorMsg.Contains("Incorrect") || errorMsg.Contains("sai mật khẩu"))
                    {
                        return LoginResult.Fail("Sai Pass", "Mật khẩu không chính xác.");
                    }
                }

                if (IsCaptchaShowing(driver))
                {
                    onProgress?.Invoke("Đang chờ bạn hoàn tất Captcha trên TikTok...");
                    continue;
                }

                if (!emailSelected && !emailSubmitted && TrySelectEmailVerification(driver))
                {
                    emailSelected = true;
                    await Task.Delay(1000, token);
                }
                if (!emailSubmitted && IsEmailVerificationShowing(driver))
                {
                    var emailResult = await SubmitEmailCodeAsync(driver, account, emailRequestedAt, onProgress, token);
                    if (emailResult != null) return emailResult;
                    emailSubmitted = true;
                    // Give TikTok a fresh response window after waiting for mail.
                    i = 0;
                    continue;
                }

                // Only fill TOTP when TikTok explicitly requests an authenticator code.
                if (!twoFactorSubmitted && IsAuthenticatorVerificationShowing(driver) && !string.IsNullOrWhiteSpace(account.TwoFA))
                {
                    bool handled2FA = await TryHandleTwoFactorAuth(driver, account.TwoFA, onProgress);
                    if (handled2FA)
                    {
                        twoFactorSubmitted = true;
                        onProgress?.Invoke("Đã gửi mã 2FA, đang xác minh...");
                        await Task.Delay(3500, token);
                        if (CheckIfLoggedIn(driver))
                        {
                            string cookies = ExtractCookiesString(driver);
                            onProgress?.Invoke("🎉 Đăng nhập 2FA thành công!");
                            return LoginResult.Ok("Đăng nhập 2FA thành công!", cookies);
                        }
                    }
                }

            }

            if (CheckIfLoggedIn(driver))
            {
                string cookies = ExtractCookiesString(driver);
                return LoginResult.Ok("Đăng nhập thành công!", cookies);
            }

            return LoginResult.Fail("Chờ xác thực", "Hết thời gian chờ: Vui lòng hoàn tất kéo Captcha hoặc xác minh trên màn hình.");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (Exception ex)
        {
            return LoginResult.Fail("Lỗi", $"Lỗi form đăng nhập: {ex.Message}");
        }
        finally { if (acquired) emailGate!.Release(); }
    }

    private async Task<bool> TryHandleTwoFactorAuth(IWebDriver driver, string twoFaKey, Action<string>? onProgress)
    {
        try
        {
            var otpDigits = driver.FindElements(By.CssSelector("input[aria-label*='Digit'], input[maxlength='1'], input[type='number']")).Where(d => d.Displayed).ToList();
            if (otpDigits.Count == 6)
            {
                string otpCode = TwoFactorService.GenerateTotpCode(twoFaKey);
                if (!string.IsNullOrEmpty(otpCode) && otpCode.Length == 6)
                {
                    onProgress?.Invoke("Đang điền mã OTP 2FA...");
                    for (int d = 0; d < 6; d++)
                    {
                        otpDigits[d].SendKeys(otpCode[d].ToString());
                        await Task.Delay(120);
                    }
                    await Task.Delay(1500);
                    return true;
                }
            }

            var singleOtpInput = driver.FindElements(By.CssSelector("input[placeholder*='6-digit'], input[placeholder*='6 chữ số'], input[placeholder*='code'], input[placeholder*='mã']")).FirstOrDefault(e => e.Displayed);
            if (singleOtpInput != null)
            {
                string otpCode = TwoFactorService.GenerateTotpCode(twoFaKey);
                if (!string.IsNullOrEmpty(otpCode))
                {
                    onProgress?.Invoke("Đang điền mã OTP 2FA...");
                    singleOtpInput.Click();
                    singleOtpInput.SendKeys(SeleniumKeys.Control + "a");
                    singleOtpInput.SendKeys(SeleniumKeys.Backspace);
                    singleOtpInput.SendKeys(otpCode);
                    await Task.Delay(500);

                    var submitBtn = driver.FindElements(By.CssSelector("button[type='submit'], button[data-e2e*='submit']")).FirstOrDefault(b => b.Displayed);
                    submitBtn?.Click();
                    return true;
                }
            }
        }
        catch { }

        return false;
    }

    private static bool IsCaptchaShowing(IWebDriver driver)
    {
        try
        {
            var captcha = driver.FindElements(By.CssSelector("#captcha_container, .captcha_verify_container, div[class*='captcha']")).FirstOrDefault(c => c.Displayed);
            return captcha != null;
        }
        catch
        {
            return false;
        }
    }

    private static string? CheckErrorMessage(IWebDriver driver)
    {
        try
        {
            var errors = driver.FindElements(By.XPath(
                "//*[@type='error'] | " +
                "//*[contains(@class, 'error')] | " +
                "//*[contains(@class, 'Error')] | " +
                "//*[contains(@class, 'Description')] | " +
                "//*[@role='alert'] | " +
                "//*[contains(text(), 'Maximum number of attempts')] | " +
                "//*[contains(text(), 'Try again later')] | " +
                "//*[contains(text(), 'Incorrect')] | " +
                "//*[contains(text(), 'không tồn tại')] | " +
                "//*[contains(text(), 'bị khóa')] | " +
                "//*[contains(text(), 'suspended')]"
            ));

            foreach (var err in errors)
            {
                if (err.Displayed && !string.IsNullOrWhiteSpace(err.Text))
                {
                    return err.Text.Trim();
                }
            }
        }
        catch { }

        return null;
    }

    public static bool CheckIfLoggedIn(IWebDriver driver)
    {
        try
        {
            for (int i = 0; i < 2; i++)
            {
                if (IsCaptchaShowing(driver) || IsLoginDialogShowing(driver) || CodeInputs(driver).Count > 0)
                {
                    return false;
                }

                var loginButtons = driver.FindElements(By.CssSelector("[id='app-header'] [data-e2e='top-login-button'], [data-e2e='top-login-button'], [data-e2e='nav-login-button'], button[data-e2e='login-button']"));
                if (loginButtons.Any(b => b.Displayed))
                {
                    return false;
                }

                var hasProfile = driver.FindElements(By.CssSelector("[data-e2e*='profile']")).Any(e => e.Displayed);
                var hasAvatar = driver.FindElements(By.CssSelector("[data-e2e='avatar']")).Any(e => e.Displayed);

                if (hasProfile && hasAvatar)
                {
                    return true;
                }

                if (CheckIfLoggedInByApi(driver))
                {
                    return true;
                }

                Thread.Sleep(800);
            }
        }
        catch { }

        return false;
    }

    private static bool CheckIfLoggedInByApi(IWebDriver driver)
    {
        try
        {
            if (driver is not IJavaScriptExecutor js) return false;

            const string script = @"
                const done = arguments[arguments.length - 1];
                fetch('https://www.tiktok.com/passport/web/account/info/?aid=1459&app_name=tiktok_web&device_platform=web_pc', {
                    credentials: 'include'
                })
                .then(r => r.json())
                .then(j => done(JSON.stringify(j)))
                .catch(() => done(''));
            ";

            var raw = js.ExecuteAsyncScript(script)?.ToString();
            if (string.IsNullOrWhiteSpace(raw)) return false;

            var json = JObject.Parse(raw);
            return string.Equals(json["message"]?.ToString(), "success", StringComparison.OrdinalIgnoreCase)
                && json["data"] is JObject data
                && data.HasValues;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsLoginDialogShowing(IWebDriver driver)
    {
        try
        {
            var loginDialogElements = driver.FindElements(By.XPath(
                "//*[contains(text(), 'Đăng nhập vào TikTok')] | " +
                "//*[contains(text(), 'Log in to TikTok')] | " +
                "//*[contains(text(), 'Sử dụng số điện thoại hoặc email')] | " +
                "//*[contains(text(), 'Use phone / email / username')] | " +
                "//*[contains(text(), 'Tiếp tục với Google')] | " +
                "//*[contains(text(), 'Continue with Google')]"
            ));

            return loginDialogElements.Any(e => e.Displayed);
        }
        catch
        {
            return false;
        }
    }

    public static string ExtractCookiesString(IWebDriver driver)
    {
        try
        {
            var cookies = driver.Manage().Cookies.AllCookies;
            var sb = new StringBuilder();
            foreach (var cookie in cookies)
            {
                sb.Append($"{cookie.Name}={cookie.Value}; ");
            }
            return sb.ToString().TrimEnd(' ', ';');
        }
        catch
        {
            return string.Empty;
        }
    }

    private static IWebElement? FindInputElement(IWebDriver driver, string[] selectors)
    {
        foreach (var selector in selectors)
        {
            try
            {
                var elements = driver.FindElements(By.CssSelector(selector));
                var match = elements.FirstOrDefault(e => e.Displayed && e.Enabled);
                if (match != null) return match;
            }
            catch { }
        }
        return null;
    }

    private static bool NaturalClick(IWebDriver driver, string[] selectors)
    {
        foreach (var selector in selectors)
        {
            try
            {
                IWebElement? el = null;
                if (selector.StartsWith("//"))
                {
                    el = driver.FindElements(By.XPath(selector)).FirstOrDefault(e => e.Displayed && e.Enabled);
                }
                else
                {
                    el = driver.FindElements(By.CssSelector(selector)).FirstOrDefault(e => e.Displayed && e.Enabled);
                }

                if (el != null)
                {
                    var actions = new Actions(driver);
                    actions.MoveToElement(el, 5, 5).Pause(TimeSpan.FromMilliseconds(150)).Click().Perform();
                    return true;
                }
            }
            catch { }
        }
        return false;
    }

    private static void NaturalSendKeys(IWebDriver driver, IWebElement element, string text)
    {
        try
        {
            var actions = new Actions(driver);
            actions.MoveToElement(element, 5, 5).Click().Perform();
            Thread.Sleep(200);

            element.SendKeys(SeleniumKeys.Control + "a");
            element.SendKeys(SeleniumKeys.Backspace);
            Thread.Sleep(150);

            var random = new Random();
            foreach (char c in text)
            {
                element.SendKeys(c.ToString());
                Thread.Sleep(random.Next(60, 140));
            }
        }
        catch
        {
            element.SendKeys(text);
        }
    }

    private static bool FillInputAndVerify(IWebDriver driver, IWebElement element, string text, bool isPassword)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return false;
        }

        for (int attempt = 0; attempt < 3; attempt++)
        {
            try
            {
                ScrollIntoView(driver, element);
                NaturalSendKeys(driver, element, text);
                Thread.Sleep(350);

                string? currentValue = element.GetAttribute("value");
                if (string.Equals(currentValue, text, StringComparison.Ordinal))
                {
                    return true;
                }

                if (driver is IJavaScriptExecutor js)
                {
                    js.ExecuteScript(@"
                        const input = arguments[0];
                        const value = arguments[1];
                        input.focus();
                        const proto = input instanceof HTMLTextAreaElement
                            ? HTMLTextAreaElement.prototype
                            : HTMLInputElement.prototype;
                        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
                        setter.call(input, value);
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                        input.dispatchEvent(new Event('change', { bubbles: true }));
                    ", element, text);
                    Thread.Sleep(350);

                    currentValue = element.GetAttribute("value");
                    if (string.Equals(currentValue, text, StringComparison.Ordinal))
                    {
                        return true;
                    }
                }
            }
            catch
            {
                try
                {
                    element.SendKeys(text);
                    Thread.Sleep(350);

                    string? currentValue = element.GetAttribute("value");
                    if (string.Equals(currentValue, text, StringComparison.Ordinal))
                    {
                        return true;
                    }
                }
                catch { }
            }
        }

        return isPassword
            ? !string.IsNullOrEmpty(element.GetAttribute("value"))
            : string.Equals(element.GetAttribute("value"), text, StringComparison.Ordinal);
    }

    private static void ScrollIntoView(IWebDriver driver, IWebElement element)
    {
        try
        {
            if (driver is IJavaScriptExecutor js)
            {
                js.ExecuteScript("arguments[0].scrollIntoView({ block: 'center', inline: 'center' });", element);
            }
        }
        catch { }
    }

    private void UpdateAccountSuccess(Account account, string? cookies)
    {
        account.Status = "Live";
        account.Message = "Đăng nhập thành công";
        if (!string.IsNullOrEmpty(cookies))
        {
            account.Cookies = cookies;
        }
        account.LastAction = "Đăng nhập";
        account.LastTimeAction = DateTime.Now;
        _accountService.UpdateAccount(account);
    }

    private void UpdateAccountStatus(Account account, string status, string message)
    {
        account.Status = status;
        account.Message = message;
        account.LastTimeAction = DateTime.Now;
        _accountService.UpdateAccount(account);
    }

    private static bool IsAttemptLimitError(string? errorMsg)
    {
        if (string.IsNullOrWhiteSpace(errorMsg)) return false;

        return errorMsg.Contains("Maximum number of attempts", StringComparison.OrdinalIgnoreCase)
            || errorMsg.Contains("Try again later", StringComparison.OrdinalIgnoreCase)
            || errorMsg.Contains("quá nhiều", StringComparison.OrdinalIgnoreCase);
    }
}
