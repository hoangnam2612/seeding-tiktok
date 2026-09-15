using MyTikTokTool.Models;
using OpenQA.Selenium;
using System.Text.RegularExpressions;

namespace MyTikTokTool.Services;

/// <summary>Drives first-time Microsoft sign-in in a separate tab of the account's browser.</summary>
public sealed class OutlookBrowserLogin
{
    private readonly IWebDriver _driver;
    private readonly Account _account;
    private readonly string _deviceCode;
    private readonly Action<string>? _progress;
    private bool _deviceSent;
    private bool _emailSent;
    private bool _passwordSent;
    private bool _passwordMethodSelected;
    private bool _accountSelected;
    private bool _consentSubmitted;
    private bool _appSignInConfirmed;
    private string? _lastMessage;

    private OutlookBrowserLogin(IWebDriver driver, Account account, string code, Action<string>? progress)
    { _driver = driver; _account = account; _deviceCode = code; _progress = progress; }

    public static bool IsMicrosoftSignInUrl(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo)
        && (uri.Host.Equals("login.microsoftonline.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("login.live.com", StringComparison.OrdinalIgnoreCase));

    public static bool IsDeviceCodeUrl(string url) => IsMicrosoftSignInUrl(url)
        && (new Uri(url).AbsolutePath.Contains("/deviceauth", StringComparison.OrdinalIgnoreCase)
            || new Uri(url).AbsolutePath.Equals("/oauth20_remoteconnect.srf", StringComparison.OrdinalIgnoreCase));

    public static bool ContainsExactMailbox(string text, string email) => !string.IsNullOrWhiteSpace(email)
        && Regex.IsMatch(text, @"(?<![\w.@+-])" + Regex.Escape(email.Trim()) + @"(?![\w.@+-])", RegexOptions.IgnoreCase);

    public static bool IsExpectedConsent(string text, string email) =>
        text.Contains("MyTikTokTool Outlook", StringComparison.OrdinalIgnoreCase)
        && ContainsExactMailbox(text, email)
        && Regex.IsMatch(text, "read your mail|read user mail|đọc thư của bạn|đọc email của bạn", RegexOptions.IgnoreCase)
        && !Regex.IsMatch(text, "read and write|send mail|send email|delete|đọc và ghi|gửi thư|gửi email|xóa thư|all users|tất cả người dùng", RegexOptions.IgnoreCase);

    public static async Task EnsureConnectedAsync(IWebDriver driver, Account account, Action<string>? progress, CancellationToken token)
    {
        var mail = new OutlookMailService();
        if (await mail.TryRefreshConnectionAsync(account.Email!, token))
        {
            progress?.Invoke("Kết nối Outlook đã sẵn sàng, sẽ lấy OTP tự động.");
            return;
        }
        if (string.IsNullOrWhiteSpace(account.Passmail))
            throw new InvalidOperationException("Thiếu PassMail để tự đăng nhập Outlook.");

        string originalTab = driver.CurrentWindowHandle;
        string? microsoftTab = null;
        bool connected = false;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
        deadline.CancelAfter(TimeSpan.FromMinutes(5));
        try
        {
            OutlookBrowserLogin? automation = null;
            progress?.Invoke("Đang tự kết nối Outlook lần đầu...");
            for (int attempt = 0; ; attempt++)
            {
                try
                {
                    await mail.ConnectAsync(account.Email!, _ => { }, deadline.Token, ct =>
                    {
                        driver.SwitchTo().Window(microsoftTab!);
                        return automation!.StepAsync(ct);
                    }, (code, verificationUri) =>
                    {
                        if (microsoftTab == null)
                        {
                            driver.SwitchTo().NewWindow(WindowType.Tab);
                            microsoftTab = driver.CurrentWindowHandle;
                        }
                        else driver.SwitchTo().Window(microsoftTab);
                        automation = new OutlookBrowserLogin(driver, account, code, progress);
                        driver.Navigate().GoToUrl(verificationUri);
                    });
                    break;
                }
                catch (DeviceCodeRejectedException) when (attempt == 0)
                {
                    progress?.Invoke("Microsoft từ chối mã kết nối. Đang xin mã mới và thử lại một lần...");
                }
            }
            connected = true;
            progress?.Invoke("Đã kết nối Outlook và lưu token. Tiếp tục đăng nhập TikTok...");
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        {
            throw new TimeoutException("Hết 5 phút kết nối Outlook. Microsoft có thể đang chờ MFA, Captcha hoặc xác nhận cấp quyền. Hoàn tất bước trên Microsoft rồi chạy lại.");
        }
        finally
        {
            // Keep the failed Microsoft page available for inspection; return control to TikTok.
            try
            {
                if (microsoftTab != null && connected && driver.WindowHandles.Contains(microsoftTab))
                { driver.SwitchTo().Window(microsoftTab); driver.Close(); }
                if (driver.WindowHandles.Contains(originalTab)) driver.SwitchTo().Window(originalTab);
            }
            catch (WebDriverException) { }
        }
    }

    private void Report(string text)
    {
        if (_lastMessage == text) return;
        _lastMessage = text;
        _progress?.Invoke(text);
    }

    private IWebElement? Find(string css) => _driver.FindElements(By.CssSelector(css)).FirstOrDefault(e => e.Displayed && e.Enabled);

    private void Fill(IWebElement field, string value)
    {
        // Re-check origin immediately before sending any email/password/device code.
        if (!IsMicrosoftSignInUrl(_driver.Url)) throw new InvalidOperationException("Trang hiện tại không phải trang đăng nhập Microsoft; đã dừng điền thông tin.");
        field.Click();
        field.SendKeys(OpenQA.Selenium.Keys.Control + "a");
        field.SendKeys(OpenQA.Selenium.Keys.Backspace);
        field.SendKeys(value);
        if (field.GetAttribute("value") != value) throw new InvalidOperationException("Không điền được thông tin đăng nhập Microsoft.");
    }

    private void Submit(IWebElement field)
    {
        var next = Find("#idSIButton9, button[type='submit'], input[type='submit']");
        if (next != null) next.Click(); else field.SendKeys(OpenQA.Selenium.Keys.Enter);
    }

    public sealed class DeviceCodeRejectedException : InvalidOperationException
    {
        public DeviceCodeRejectedException() : base("Microsoft từ chối mã kết nối thiết bị. Đây không phải lỗi Mail/PassMail. Hãy khởi động lại lần kết nối.") { }
    }

    public static bool IsRejectedDeviceCode(string url, string text) => IsDeviceCodeUrl(url)
        && Regex.IsMatch(text, "that code didn.t work|code (?:is )?(?:invalid|expired|incorrect)|invalid (?:verification )?code|mã.*(?:không đúng|không hợp lệ|hết hạn)", RegexOptions.IgnoreCase);

    private async Task StepAsync(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (!IsMicrosoftSignInUrl(_driver.Url))
        {
            Report("Microsoft đang chuyển trang hoặc yêu cầu xác minh bổ sung; kiểm tra tab Microsoft nếu cần.");
            return;
        }
        string text = _driver.FindElement(By.TagName("body")).Text;
        if (_deviceSent && IsRejectedDeviceCode(_driver.Url, text)) throw new DeviceCodeRejectedException();
        var error = Find("#passwordError, #usernameError, #errorText, [data-testid='error-message']");
        if (error != null && !string.IsNullOrWhiteSpace(error.Text))
            throw new InvalidOperationException("Microsoft từ chối thông tin đăng nhập hoặc mã kết nối. Kiểm tra Mail/PassMail và thông báo trên tab Microsoft.");

        if (!_deviceSent && IsDeviceCodeUrl(_driver.Url))
        {
            var codeInput = Find("input[name='otc'], #otc, input[name='code'], #code");
            if (codeInput != null)
            {
                Fill(codeInput, _deviceCode);
                // Microsoft may re-render its controlled field after input events.
                // Verify the settled DOM before submission, not just the immediate value.
                await Task.Delay(500, token);
                codeInput = Find("input[name='otc'], #otc, input[name='code'], #code")
                    ?? throw new InvalidOperationException("Ô nhập mã Microsoft đã thay đổi.");
                if (codeInput.GetAttribute("value") != _deviceCode)
                    throw new InvalidOperationException("Mã kết nối chưa được nhập đầy đủ; chưa gửi mã lên Microsoft.");
                _deviceSent = true;
                Report("Đang tự nhập mã kết nối Microsoft...");
                Submit(codeInput);
                return;
            }
        }

        if (!_passwordMethodSelected && !_passwordSent)
        {
            var passwordOption = Find("#idA_PWD_SwitchToPassword");
            passwordOption ??= _driver.FindElements(By.CssSelector("a, button, [role='button']"))
                .FirstOrDefault(e => e.Displayed && e.Enabled && Regex.IsMatch(e.Text.Trim(), "^(use your password|use a password|sign in with a password|sử dụng mật khẩu|đăng nhập bằng mật khẩu)$", RegexOptions.IgnoreCase));
            if (passwordOption != null) { _passwordMethodSelected = true; passwordOption.Click(); return; }
        }
        // Other one-time-code fields belong to MFA. Never fill them with the device code or password.
        if (Find("input[name='otc'], input[name='ProofConfirmation'], #idTxtBx_SAOTCC_OTC") != null
            || Regex.IsMatch(text, "approve sign.in request|check your authenticator|xác nhận.*ứng dụng|prove you're not a robot", RegexOptions.IgnoreCase))
        {
            Report("Microsoft yêu cầu xác minh bổ sung. Hoàn tất MFA/Captcha trên tab Microsoft; phần mềm sẽ tự tiếp tục.");
            return;
        }

        if (!_emailSent && Find("input[name='loginfmt'], input[type='email']") is { } email)
        {
            Fill(email, _account.Email!.Trim());
            _emailSent = true;
            Report("Đang tự nhập email Microsoft...");
            Submit(email);
            return;
        }
        if (!_passwordSent && Find("input[name='passwd'], input[type='password']") is { } password)
        {
            // A browser profile may contain a different signed-in Microsoft account.
            string identity = Find("#displayName, #userDisplayName, [data-testid='identity-banner']")?.Text ?? text;
            if (!ContainsExactMailbox(identity, _account.Email!))
            {
                Report("Kiểm tra email trên trang Microsoft: chưa xác nhận được đúng hộp thư nên chưa điền mật khẩu.");
                return;
            }
            Fill(password, _account.Passmail!);
            _passwordSent = true;
            Report("Đang tự đăng nhập Microsoft bằng mật khẩu email...");
            Submit(password);
            return;
        }

        if (!_accountSelected && Regex.IsMatch(text, "pick an account|choose an account|chọn.*tài khoản", RegexOptions.IgnoreCase))
        {
            var accountOption = _driver.FindElements(By.CssSelector("[role='button'], button, [data-test-id]"))
                .FirstOrDefault(e => e.Displayed && e.Enabled && e.Text.Trim().Equals(_account.Email!.Trim(), StringComparison.OrdinalIgnoreCase));
            accountOption ??= Find("#otherTile");
            if (accountOption != null) { _accountSelected = true; accountOption.Click(); return; }
        }

        if (Regex.IsMatch(text, "stay signed in|duy trì đăng nhập|duy trì trạng thái đăng nhập", RegexOptions.IgnoreCase))
        {
            // Tokens persist the connection; no need to retain an additional Microsoft web session.
            Find("#idBtn_Back")?.Click();
            return;
        }
        if (!_consentSubmitted && IsExpectedConsent(text, _account.Email!))
        {
            var consent = Find("#idBtn_Accept, [data-testid='appConsentPrimaryButton']");
            if (consent != null)
            {
                _consentSubmitted = true;
                Report("Đang xác nhận quyền đọc email cho MyTikTokTool Outlook...");
                consent.Click();
                return;
            }
        }
        if (!_appSignInConfirmed && text.Contains("MyTikTokTool Outlook", StringComparison.OrdinalIgnoreCase)
            && ContainsExactMailbox(text, _account.Email!)
            && Regex.IsMatch(text, "are you trying to sign in|bạn có đang.*đăng nhập|bạn đang cố.*đăng nhập", RegexOptions.IgnoreCase))
        {
            var confirm = Find("#idSIButton9");
            if (confirm != null) { _appSignInConfirmed = true; confirm.Click(); return; }
        }
        if (text.Contains("MyTikTokTool Outlook", StringComparison.OrdinalIgnoreCase))
            Report("Microsoft đang chờ xác nhận ứng dụng MyTikTokTool Outlook. Kiểm tra và xác nhận trên tab Microsoft để tiếp tục.");
        else Report("Đang chờ Microsoft hoàn tất đăng nhập; nếu có yêu cầu xác minh, xử lý trên tab Microsoft.");
        return;
    }
}
