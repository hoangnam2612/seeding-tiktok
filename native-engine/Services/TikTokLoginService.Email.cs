using System.Text.RegularExpressions;
using MyTikTokTool.Models;
using OpenQA.Selenium;

namespace MyTikTokTool.Services;

public partial class TikTokLoginService
{
    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> EmailLoginLocks = new();
    public static string GetLoginIdentifier(Account account)
    {
        // A numeric UID identifies the account, but the login form expects username/email.
        if (!string.IsNullOrWhiteSpace(account.Uid) && !account.Uid.All(char.IsDigit)) return account.Uid.Trim().TrimStart('@');
        if (!string.IsNullOrWhiteSpace(account.Username) && !account.Username.All(char.IsDigit)) return account.Username.Trim().TrimStart('@');
        return account.Email?.Trim() ?? account.Uid?.Trim() ?? "";
    }

    private static List<IWebElement> CodeInputs(IWebDriver driver) => driver.FindElements(By.CssSelector(
        "input[autocomplete='one-time-code'], input[name='code'], input[name='email_code'], input[aria-label*='Digit'], " +
        "input[maxlength='1'], [class*='code-input'] input, input[placeholder*='6-digit'], input[placeholder*='6 chữ số'], " +
        "input[placeholder*='code'], input[placeholder*='Code'], input[placeholder*='mã'], input[placeholder*='Mã']"))
        .Where(e => e.Displayed && e.Enabled).ToList();

    private static string VerificationText(IWebDriver driver)
    {
        try
        {
            var input = CodeInputs(driver).FirstOrDefault();
            var container = input?.FindElements(By.XPath("./ancestor::*[@role='dialog' or self::form or contains(@class,'Modal')][1]")).FirstOrDefault();
            return (container ?? driver.FindElement(By.TagName("body"))).Text;
        }
        catch (WebDriverException) { return ""; }
    }

    public static bool IsEmailChallengeText(string text)
    {
        // Alternative-method links can mention email on an authenticator/SMS screen.
        if (Regex.IsMatch(text, @"(?:code|mã)[\s\S]{0,60}(?:from|từ|trong)[\s\S]{0,40}(?:authenticator|authentication app|ứng dụng xác thực)", RegexOptions.IgnoreCase)) return false;
        if (Regex.IsMatch(text, @"(?:sent to|gửi (?:đến|tới))[\s\S]{0,30}(?:phone|mobile|số điện thoại)", RegexOptions.IgnoreCase)) return false;
        return Regex.IsMatch(text,
            @"(?:code|mã)[\s\S]{0,160}(?:sent|send|gửi)[\s\S]{0,100}(?:email|e-mail|hộp thư|[^\s@]+@[^\s@]+\.[a-z]{2,})|(?:send|gửi)[\s\S]{0,30}(?:code|mã)[\s\S]{0,80}(?:email|e-mail|[^\s@]+@[^\s@]+\.[a-z]{2,})|(?:email|e-mail)[\s\S]{0,60}(?:verification code|mã xác minh)|(?:verify|xác minh)[\s\S]{0,40}(?:email|e-mail)|(?:email|e-mail) verification",
            RegexOptions.IgnoreCase);
    }

    private static IWebElement? InitialSendCodeButton(IWebDriver driver) =>
        driver.FindElements(By.CssSelector("button[data-e2e='send-code-button'], button"))
            .FirstOrDefault(e => e.Displayed && e.Enabled && Regex.IsMatch(e.Text.Trim(), "^(send code|send a code|gửi mã|gửi mã xác minh)$", RegexOptions.IgnoreCase));

    private static bool IsEmailVerificationShowing(IWebDriver driver) =>
        (CodeInputs(driver).Count > 0 || InitialSendCodeButton(driver) != null) && IsEmailChallengeText(VerificationText(driver));

    private static bool IsAuthenticatorVerificationShowing(IWebDriver driver) =>
        CodeInputs(driver).Count > 0 && !IsEmailVerificationShowing(driver) &&
        Regex.IsMatch(VerificationText(driver), "authenticator|authentication app|ứng dụng xác thực", RegexOptions.IgnoreCase);

    public static bool IsVerificationMethodChooserText(string text) => Regex.IsMatch(text,
        @"2-step verification|two-step verification|verify your identity|verify\s+it['’]s\s+really\s+you|verify\s+your\s+identity\s+using|choose.*verification|xác minh 2 bước|xác minh danh tính|chọn.*xác minh",
        RegexOptions.IgnoreCase);

    private static bool TrySelectEmailVerification(IWebDriver driver)
    {
        // Restrict selection to an explicit verification-method chooser, never the login email tab.
        var text = VerificationText(driver);
        if (!IsVerificationMethodChooserText(text)) return false;
        if (CodeInputs(driver).Count > 0) return false;
        var option = driver.FindElements(By.CssSelector("[role='dialog'] button, [role='dialog'] [role='button'], [role='dialog'] [role='radio'], [class*='Modal'] button"))
            .FirstOrDefault(e => e.Displayed && e.Enabled && Regex.IsMatch(e.Text, "email|e-mail", RegexOptions.IgnoreCase));
        // Some TikTok choosers render the Email row as divs rather than buttons.
        // Click only the exact visible label after recognizing the verification chooser.
        option ??= driver.FindElements(By.XPath("//*[not(*) and (normalize-space(.)='Email' or normalize-space(.)='E-mail') ]"))
            .FirstOrDefault(e => e.Displayed && e.Enabled);
        if (option == null) return false;
        option.Click();
        if (CodeInputs(driver).Count == 0)
        {
            var next = driver.FindElements(By.CssSelector("[role='dialog'] button, [class*='Modal'] button"))
                .FirstOrDefault(e => e.Displayed && e.Enabled && Regex.IsMatch(e.Text.Trim(), "^(next|continue|tiếp|tiếp tục)$", RegexOptions.IgnoreCase));
            next?.Click();
        }
        return true;
    }

    // null means code submitted, not login success. The caller verifies the actual session.
    private async Task<LoginResult?> SubmitEmailCodeAsync(IWebDriver driver, Account account,
        DateTimeOffset requestedAt, Action<string>? progress, CancellationToken token)
    {
        if (string.IsNullOrWhiteSpace(account.Email)) return LoginResult.Fail("Thiếu email", "TikTok yêu cầu mã email nhưng tài khoản chưa có Mail.");
        try
        {
            if (!OutlookMailService.Supports(account.Email))
                return LoginResult.Fail("Email chưa hỗ trợ", "Đọc OTP tự động hiện hỗ trợ Hotmail/Outlook cá nhân.");
            if (!OutlookMailService.IsConnected(account.Email))
                return LoginResult.Fail("Cần kết nối Outlook", "Chuột phải tài khoản → Kết nối Outlook, rồi đăng nhập lại.");

            var send = InitialSendCodeButton(driver);
            if (send != null)
            {
                requestedAt = DateTimeOffset.UtcNow;
                send.Click();
                // Sending the email can itself trigger a captcha or render the code fields asynchronously.
                var readyDeadline = DateTimeOffset.UtcNow.AddSeconds(120);
                do
                {
                    await Task.Delay(1000, token);
                    if (!IsCaptchaShowing(driver) && CodeInputs(driver).Count > 0) break;
                    progress?.Invoke(IsCaptchaShowing(driver) ? "Hoàn tất Captcha trên TikTok để gửi mã email..." : "Đang chờ TikTok mở ô xác minh email...");
                } while (DateTimeOffset.UtcNow < readyDeadline);
                if (IsCaptchaShowing(driver) || CodeInputs(driver).Count == 0)
                    return LoginResult.Fail("Chờ xác thực", "TikTok chưa hoàn tất gửi mã hoặc Captcha chưa được xử lý.");
            }
            progress?.Invoke("Đang chờ mã mới từ email Outlook (tối đa 120 giây)...");
            string code = await new OutlookMailService().WaitForCodeAsync(account.Email, requestedAt, token);
            token.ThrowIfCancellationRequested();
            if (!IsEmailVerificationShowing(driver))
                return CheckIfLoggedIn(driver) ? LoginResult.Ok("Đã đăng nhập", ExtractCookiesString(driver)) : LoginResult.Fail("Chờ xác thực", "Màn hình xác minh email đã thay đổi; chưa điền mã.");

            var inputs = CodeInputs(driver);
            var digits = inputs.Where(e => e.GetAttribute("maxlength") == "1" || (e.GetAttribute("aria-label") ?? "").Contains("Digit", StringComparison.OrdinalIgnoreCase)).ToList();
            progress?.Invoke("Đã nhận mã email mới, đang xác minh...");
            if (digits.Count == 6)
            {
                for (int d = 0; d < digits.Count; d++)
                {
                    digits[d].SendKeys(OpenQA.Selenium.Keys.Control + "a");
                    digits[d].SendKeys(code[d].ToString());
                    await Task.Delay(80, token);
                }
            }
            else if (inputs.Count == 1)
            {
                if (!FillInputAndVerify(driver, inputs[0], code, false))
                    return LoginResult.Fail("Lỗi nhập mã", "Không điền được mã email vào TikTok.");
            }
            else return LoginResult.Fail("Lỗi giao diện OTP", "Chưa nhận diện được ô nhập mã email TikTok.");

            // Wait for React to enable the action, and target the OTP container rather
            // than the login form's submit button behind the verification overlay.
            var confirmDeadline = DateTimeOffset.UtcNow.AddSeconds(10);
            while (DateTimeOffset.UtcNow < confirmDeadline)
            {
                await Task.Delay(350, token);
                if (CheckIfLoggedIn(driver)) return null;
                try
                {
                    var codeInput = CodeInputs(driver).FirstOrDefault();
                    if (codeInput == null) continue;
                    const string action = "descendant::*[(self::button or @role='button' or not(*)) and (normalize-space(.)='Next' or normalize-space(.)='Verify' or normalize-space(.)='Confirm' or normalize-space(.)='Tiếp' or normalize-space(.)='Tiếp tục' or normalize-space(.)='Xác minh' or normalize-space(.)='Xác nhận')]";
                    var container = codeInput.FindElements(By.XPath("./ancestor::*[" + action + "][1]")).FirstOrDefault();
                    var confirm = container?.FindElements(By.XPath("./" + action))
                        .FirstOrDefault(e => e.Displayed && e.Enabled && e.GetAttribute("aria-disabled") != "true");
                    if (confirm == null) continue;
                    confirm.Click();
                    progress?.Invoke("Đã bấm xác nhận mã email, đang chờ TikTok phản hồi...");
                    return null;
                }
                catch (StaleElementReferenceException) { /* The modal is rendering again. */ }
                catch (ElementClickInterceptedException) { /* Wait for the overlay animation. */ }
                catch (ElementNotInteractableException) { /* Wait until the button is ready. */ }
            }
            return LoginResult.Fail("Chưa xác nhận mã", "Đã điền mã email nhưng chưa bấm được Next trên cửa sổ xác minh TikTok.");
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested) { throw; }
        catch (TimeoutException ex) { return LoginResult.Fail("Hết thời gian OTP", ex.Message); }
        catch (InvalidOperationException ex) { return LoginResult.Fail("Lỗi email", ex.Message); }
        catch (HttpRequestException) { return LoginResult.Fail("Lỗi kết nối email", "Không kết nối được Microsoft. Kiểm tra mạng và thử lại."); }
    }
}
