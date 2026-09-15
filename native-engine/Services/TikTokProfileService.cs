using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MyTikTokTool.Models;
using OpenQA.Selenium;
using OpenQA.Selenium.Interactions;
using SeleniumKeys = OpenQA.Selenium.Keys;

namespace MyTikTokTool.Services;

public class TikTokProfileService
{
    private readonly AccountService _accountService;
    private static readonly Random _random = new();
    private const int ShortPollMs = 350;

    public TikTokProfileService(AccountService accountService)
    {
        _accountService = accountService;
    }

    public async Task<bool> UpdateProfileAsync(Account account, ProfileUpdateConfig config, Action<string> onProgress, CancellationToken token = default)
    {
        IWebDriver? driver = null;
        try
        {
            onProgress("Đang khởi tạo trình duyệt...");
            driver = ChromeService.OpenSeleniumChrome(account, startUrl: "https://www.tiktok.com");
            driver.Manage().Timeouts().PageLoad = TimeSpan.FromSeconds(18);
            await Task.Delay(3000, token);
            driver.Navigate().Refresh();
            await Task.Delay(2000, token);

            // 1. Kiểm tra đăng nhập
            onProgress("Đang kiểm tra phiên đăng nhập...");
            if (!TikTokLoginService.CheckIfLoggedIn(driver))
            {
                onProgress("Đang đăng nhập tài khoản...");
                var loginService = new TikTokLoginService(_accountService);
                var loginRes = await loginService.LoginAsync(account, driver, onProgress, token);
                if (!loginRes.Success)
                {
                    onProgress($"❌ Không thể đăng nhập: {loginRes.Message}");
                    return false;
                }
            }

            // 2. Mở trang cá nhân
            onProgress("Đang mở trang cá nhân Profile...");
            bool openedEdit = await OpenEditProfileAsync(driver, account, onProgress, token);

            if (!openedEdit)
            {
                onProgress("⚠️ Không tìm thấy nút Sửa hồ sơ (Edit profile).");
                return false;
            }

            await Task.Delay(2000, token);
            var updatedActions = new List<string>();
            string? originalUid = account.Uid;
            string? originalUsername = account.Username;
            string? originalName = account.Name;
            string? originalAvatar = account.Avatar;
            string? originalBio = account.Bio;

            // 3. ĐỔI AVATAR (ẢNH ĐẠI DIỆN)
            if (config.IsChangeAvatar)
            {
                onProgress("Đang xử lý đổi Ảnh đại diện (Avatar)...");
                var imageFiles = config.AvatarFiles.Count > 0
                    ? config.AvatarFiles
                    : GetImageFiles(config.AvatarFolder);

                if (imageFiles.Count > 0)
                {
                    string chosenImage = TakeRandom(imageFiles, config.AvoidDuplicateContent);
                    onProgress($"Đang tải ảnh: {Path.GetFileName(chosenImage)}...");

                    bool avatarSuccess = await UploadAvatarAsync(driver, chosenImage, onProgress, token);
                    if (avatarSuccess)
                    {
                        account.Avatar = chosenImage;
                        updatedActions.Add("Avatar");
                        onProgress("✅ Đã cập nhật ảnh đại diện thành công!");
                    }
                    else
                    {
                        onProgress("⚠️ Không tải được ảnh đại diện.");
                    }
                }
                else
                {
                    onProgress("⚠️ Thư mục ảnh đại diện không có file ảnh hợp lệ.");
                }

                await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
            }

            // 4. ĐỔI TÊN HIỂN THỊ (NAME / NICKNAME)
            if (config.IsChangeName && config.Names.Count > 0)
            {
                string rawName = TakeRandom(config.Names, config.AvoidDuplicateContent);
                string newName = SpinTextHelper.Resolve(rawName);

                if (!string.IsNullOrWhiteSpace(newName))
                {
                    onProgress($"Đang đổi Tên hiển thị thành: \"{newName}\"...");
                    var nameSuccess = ChangeProfileText(
                        driver,
                        newName,
                        "[data-e2e='edit-profile-name-input'] input, [data-e2e='edit-profile-nickname-input'] input, input[name='nickname'], input[placeholder*='Name'], input[placeholder*='Tên']",
                        "[data-e2e='edit-profile-name-input'], [data-e2e='edit-profile-nickname-input']",
                        onProgress,
                        "Tên hiển thị",
                        token);
                    if (nameSuccess)
                    {
                        account.Name = newName;
                        updatedActions.Add("Tên");
                        onProgress("✅ Đã nhập Tên hiển thị mới!");
                    }
                }

                await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
            }

            // 5. ĐỔI USERNAME (TIKTOK ID)
            if (config.IsChangeUsername && config.Usernames.Count > 0)
            {
                string rawUser = TakeRandom(config.Usernames, config.AvoidDuplicateContent).Trim();
                if (config.AppendRandomNumber)
                {
                    rawUser += _random.Next(config.MinRandomNumber, config.MaxRandomNumber + 1).ToString();
                }

                if (!string.IsNullOrWhiteSpace(rawUser))
                {
                    onProgress($"Đang đổi Username (ID) thành: \"{rawUser}\"...");
                    var userSuccess = ChangeProfileText(
                        driver,
                        rawUser,
                        "[data-e2e='edit-profile-username-input'] input, input[name='uniqueId'], input[placeholder*='Username']",
                        "[data-e2e='edit-profile-username-input']",
                        onProgress,
                        "Username",
                        token);
                    if (userSuccess)
                    {
                        account.Uid = rawUser;
                        account.Username = rawUser;
                        updatedActions.Add("Username");
                        onProgress("✅ Đã nhập Username mới!");
                    }
                }

                await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
            }

            // 6. ĐỔI TIỂU SỬ (BIO)
            if (config.IsChangeBio && config.Bios.Count > 0)
            {
                string rawBio = TakeRandom(config.Bios, config.AvoidDuplicateContent);
                string newBio = SpinTextHelper.Resolve(rawBio);

                if (!string.IsNullOrWhiteSpace(newBio))
                {
                    onProgress($"Đang đổi Tiểu sử (Bio) thành: \"{newBio}\"...");
                    var bioSuccess = ChangeProfileText(
                        driver,
                        newBio,
                        "[data-e2e='edit-profile-bio-input'] textarea, [data-e2e='edit-profile-bio-input'], textarea[name='bio'], textarea[placeholder*='Bio'], textarea[placeholder*='Tiểu sử']",
                        "[data-e2e='edit-profile-bio-input']",
                        onProgress,
                        "Bio",
                        token);
                    if (bioSuccess)
                    {
                        account.Bio = newBio;
                        updatedActions.Add("Bio");
                        onProgress("✅ Đã nhập Bio mới!");
                    }
                }

                await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
            }

            // 7. BẤM NÚT LƯU THAY ĐỔI (SAVE PROFILE)
            onProgress("Đang bấm nút Lưu hồ sơ...");
            bool saved = await SaveProfileChangesAsync(driver, onProgress, token);
            if (!saved)
            {
                account.Uid = originalUid;
                account.Username = originalUsername;
                account.Name = originalName;
                account.Avatar = originalAvatar;
                account.Bio = originalBio;
                onProgress("⚠️ Không lưu được hồ sơ, đã giữ nguyên dữ liệu tài khoản.");
                return false;
            }

            // Cập nhật CSDL
            account.LastAction = "Đổi Profile: " + (updatedActions.Count > 0 ? string.Join(", ", updatedActions) : "Không thay đổi");
            account.LastTimeAction = DateTime.Now;
            _accountService.UpdateAccount(account);

            onProgress($"🎉 Hoàn tất đổi hồ sơ! ({string.Join(", ", updatedActions)})");
            return true;
        }
        catch (OperationCanceledException)
        {
            onProgress("⏹ Đã dừng đổi Profile.");
            return false;
        }
        catch (Exception ex)
        {
            onProgress($"❌ Lỗi đổi Profile: {ex.Message}");
            return false;
        }
        finally
        {
            if (driver != null)
            {
                await Task.Delay(2000);
                ChromeService.CloseAccountChrome(account.Id);
            }
        }
    }

    private static async Task<bool> OpenEditProfileAsync(IWebDriver driver, Account account, Action<string> onProgress, CancellationToken token)
    {
        // 1. Lấy username chuẩn của tài khoản nếu có
        string? uid = !string.IsNullOrWhiteSpace(account.Username) ? account.Username : account.Uid;
        if (!string.IsNullOrWhiteSpace(uid))
        {
            string profileUrl = $"https://www.tiktok.com/@{uid.TrimStart('@')}";
            onProgress($"Đang mở trang cá nhân: {profileUrl}...");
            await NavigateSafelyAsync(driver, profileUrl, token);
            if (await ClickEditProfileButtonAsync(driver, token)) return true;
        }
        // 2. Nếu chưa có username hoặc link trên chưa mở được -> Click vào Avatar ở góc trên bên phải hoặc thanh Sidebar trái
        onProgress("Đang tìm mở trang cá nhân từ thanh điều hướng...");
        try
        {
            var profileNav = driver.FindElements(By.CssSelector(
                "a[data-e2e='nav-profile'], " +
                "[data-e2e='profile-icon'], " +
                "header a[href*='/@'], " +
                "aside a[href*='/@'], " +
                "[data-e2e='nav-profile'] a"
            )).FirstOrDefault(e => e.Displayed && e.Enabled);
            if (profileNav != null)
            {
                try { ((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].click();", profileNav); }
                catch { profileNav.Click(); }
                await Task.Delay(3000, token);
                if (await ClickEditProfileButtonAsync(driver, token)) return true;
            }
        }
        catch { }
        onProgress($"⚠️ Không mở được popup Sửa hồ sơ. URL hiện tại: {driver.Url}");
        return false;
    }

    private static async Task<bool> ClickEditProfileButtonAsync(IWebDriver driver, CancellationToken token)
    {
        for (int i = 0; i < 20; i++)
        {
            token.ThrowIfCancellationRequested();
            try
            {
                // Nếu popup sửa hồ sơ đã mở sẵn
                if (HasElement(driver, By.CssSelector("[data-e2e='edit-profile-header'], [data-e2e='edit-profile-name-input'], [data-e2e='edit-profile-popup']")))
                {
                    return true;
                }
                // Quét tìm nút "Sửa hồ sơ" / "Edit profile" (Bao quát cả thẻ a, button, div, data-e2e)
                var editButtons = driver.FindElements(By.XPath(
                    "//*[@data-e2e='edit-profile-entrance']//button | " +
                    "//*[@data-e2e='edit-profile-entrance'] | " +
                    "//*[self::button or self::a or @role='button'][contains(., 'Edit profile') or contains(., 'Sửa hồ sơ') or contains(., 'Chỉnh sửa hồ sơ') or contains(., 'Edit Profile') or contains(., 'Chỉnh sửa')] | " +
                    "//*[@aria-label='Edit profile' or @aria-label='Sửa hồ sơ' or @aria-label='Chỉnh sửa hồ sơ'] | " +
                    "//*[contains(@class, 'edit-profile') or contains(@class, 'EditProfile') or contains(@data-e2e, 'edit-profile')]"
                )).Where(e => e.Displayed && e.Enabled).ToList();
                if (editButtons.Count > 0)
                {
                    var targetBtn = editButtons[0];
                    // Click kết hợp cả JS lẫn Actions
                    try
                    {
                        ((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].click();", targetBtn);
                    }
                    catch
                    {
                        new Actions(driver).MoveToElement(targetBtn, 5, 5).Click().Perform();
                    }
                    await Task.Delay(1500, token);
                    // Kiểm tra xem popup đã mở ra chưa
                    if (HasElement(driver, By.CssSelector("[data-e2e='edit-profile-header'], [data-e2e='edit-profile-name-input'], [data-e2e='edit-profile-popup'], [role='dialog']")))
                    {
                        return true;
                    }
                }
            }
            catch { }
            await Task.Delay(500, token);
        }
        return false;
    }

    private static async Task NavigateSafelyAsync(IWebDriver driver, string url, CancellationToken token)
    {
        try
        {
            driver.Navigate().GoToUrl(url);
        }
        catch (WebDriverTimeoutException)
        {
            TryStopLoading(driver);
        }
        catch
        {
            try
            {
                ((IJavaScriptExecutor)driver).ExecuteScript("window.location.href = arguments[0];", url);
            }
            catch { }
        }

        await Task.Delay(2500, token);
    }

    private static void TryStopLoading(IWebDriver driver)
    {
        try
        {
            ((IJavaScriptExecutor)driver).ExecuteScript("window.stop();");
        }
        catch { }
    }

    private static async Task<bool> UploadAvatarAsync(IWebDriver driver, string imagePath, Action<string> onProgress, CancellationToken token)
    {
        try
        {
            var fileInputs = driver.FindElements(By.CssSelector("[data-e2e='edit-profile-avatar-edit-icon'] input, input[type='file']")).ToList();
            if (fileInputs.Count == 0) return false;
            fileInputs[0].SendKeys(imagePath);
            await Task.Delay(2500, token);
            // Kiểm tra xem đã mở màn hình Edit photo chưa
            if (!HasElement(driver, By.CssSelector("[src*='blob:https://www.tiktok.com/'], img[src^='blob:'], [class*='crop'], [class*='photo'], [class*='Photo']")))
            {
                onProgress("⚠️ TikTok chưa nhận ảnh preview, có thể định dạng ảnh không phù hợp.");
                return false;
            }
            onProgress("Đang tìm và bấm nút Apply ảnh đại diện...");
            var applyButton = await FindAvatarApplyButtonAsync(driver, token);
            if (applyButton != null)
            {
                // Cuộn phần tử vào giữa màn hình và click bằng JavaScript (tránh bị tràn mép 700px)
                try
                {
                    ((IJavaScriptExecutor)driver).ExecuteScript(@"
                    arguments[0].scrollIntoView({block: 'center', inline: 'center'});
                    arguments[0].click();
                ", applyButton);
                }
                catch
                {
                    ClickElement(driver, applyButton);
                }
                await Task.Delay(2000, token);
                await WaitForCaptchaOrChallengeAsync(driver, onProgress, token);
                return true;
            }
            // Fallback JavaScript tìm thẳng nút Apply trong popup Edit photo và click
            try
            {
                ((IJavaScriptExecutor)driver).ExecuteScript(@"
                const btns = Array.from(document.querySelectorAll('button, div[role=""button""]'))
                    .filter(b => {
                        const t = (b.innerText || '').trim();
                        const isApply = t.includes('Apply') || t.includes('Áp dụng') || t.includes('Save') || t.includes('Lưu') || t.includes('Xong') || t.includes('Done') || (b.className && b.className.includes('primary'));
                        const isCancel = t.includes('Cancel') || t.includes('Hủy');
                        return isApply && !isCancel && !b.disabled;
                    });
                if (btns.length > 0) {
                    const target = btns[btns.length - 1];
                    target.scrollIntoView({block: 'center', inline: 'center'});
                    target.click();
                }
            ");
                await Task.Delay(2000, token);
                return true;
            }
            catch { }
            CancelAvatarPopupIfPresent(driver);
            return false;
        }
        catch (OperationCanceledException) { throw; }
        catch { }
        return false;
    }

    private static async Task<IWebElement?> FindAvatarApplyButtonAsync(IWebDriver driver, CancellationToken token)
    {
        for (int i = 0; i < 20; i++)
        {
            token.ThrowIfCancellationRequested();
            // 1. Tự động cuộn popup xuống dưới để lộ nút
            try
            {
                ((IJavaScriptExecutor)driver).ExecuteScript(@"
                window.scrollTo(0, document.body.scrollHeight);
                document.querySelectorAll('[role=""dialog""], [class*=""modal""], [class*=""Modal""], [data-e2e*=""edit""]').forEach(el => el.scrollTop = el.scrollHeight);
            ");
            }
            catch { }
            // 2. Quét tìm nút Apply (Không bắt buộc Displayed vì nút có thể nằm ngoài mép 700px)
            var xpathCandidates = driver.FindElements(By.XPath(
                "//button[not(@disabled) and (contains(., 'Apply') or contains(., 'Áp dụng') or contains(., 'Save') or contains(., 'Lưu') or contains(., 'Xong') or contains(., 'Done'))] | " +
                "//*[@role='dialog']//button[not(@disabled) and (contains(@class, 'primary') or contains(@class, 'TUXButton--primary'))][not(contains(., 'Cancel')) and not(contains(., 'Hủy'))] | " +
                "//*[contains(@class,'Footer')]//button[not(@disabled) and not(contains(., 'Cancel')) and not(contains(., 'Hủy'))]"
            )).Where(e => e.Enabled).ToList();
            var preferred = xpathCandidates.LastOrDefault();
            if (preferred != null) return preferred;
            await Task.Delay(500, token);
        }
        return null;
    }

    private static bool ChangeProfileText(
    IWebDriver driver,
    string value,
    string inputSelector,
    string errorScopeSelector,
    Action<string> onProgress,
    string label,
    CancellationToken token)
    {
        try
        {
            token.ThrowIfCancellationRequested();
            var input = FindVisibleEnabled(driver, By.CssSelector(inputSelector));
            if (input == null)
            {
                onProgress($"⚠️ Không tìm thấy ô nhập {label}.");
                return false;
            }
            string oldValue = input.GetAttribute("value") ?? input.Text ?? string.Empty;

            // Gõ nội dung mới vào
            TypeText(input, value, label.Equals("Bio", StringComparison.OrdinalIgnoreCase) ? 30 : 40);
            Thread.Sleep(900);
            // Kiểm tra xem có lỗi thật từ TikTok không (chữ báo đỏ)
            if (!HasInputError(driver, errorScopeSelector))
            {
                return true;
            }
            onProgress($"⚠️ {label} bị TikTok báo lỗi, trả lại giá trị cũ.");
            TypeText(input, oldValue, 25);
            Thread.Sleep(700);
            return false;
        }
        catch (OperationCanceledException) { throw; }
        catch { }
        return false;
    }

    private static void TypeText(IWebElement input, string value, int minKeyDelayMs)
    {
        var actions = new Actions(((IWrapsDriver)input).WrappedDriver);
        actions.MoveToElement(input, 5, 5).Click().Perform();
        Thread.Sleep(150);

        input.SendKeys(SeleniumKeys.Control + "a");
        input.SendKeys(SeleniumKeys.Backspace);
        Thread.Sleep(150);

        foreach (char c in value)
        {
            input.SendKeys(c.ToString());
            Thread.Sleep(_random.Next(minKeyDelayMs, minKeyDelayMs + 55));
        }
    }

    private static async Task<bool> SaveProfileChangesAsync(IWebDriver driver, Action<string> onProgress, CancellationToken token)
    {
        try
        {
            if (HasAnyProfileInputError(driver))
            {
                onProgress("⚠️ TikTok đang báo lỗi trong form, bỏ qua thao tác lưu.");
                return false;
            }

            var saveButton = FindVisibleEnabled(driver, By.CssSelector("[data-e2e='edit-profile-save'], button[data-e2e='edit-profile-save']"));

            if (saveButton == null)
            {
                saveButton = driver.FindElements(By.XPath("//button[contains(text(), 'Save') or contains(text(), 'Lưu')]"))
                    .FirstOrDefault(e => e.Displayed && e.Enabled);
            }

            if (saveButton == null) return false;

            new Actions(driver).MoveToElement(saveButton, 5, 5).Pause(TimeSpan.FromMilliseconds(150)).Click().Perform();
            await Task.Delay(1800, token);

            ConfirmSaveDialogIfPresent(driver);
            await WaitForCaptchaOrChallengeAsync(driver, onProgress, token);

            return await WaitUntilAsync(driver, d =>
            {
                if (HasAnyProfileInputError(d)) return false;
                return !HasElement(d, By.CssSelector("[data-e2e='edit-profile-header'], [data-e2e='edit-profile-popup']"));
            }, TimeSpan.FromSeconds(12), token) || !HasAnyProfileInputError(driver);
        }
        catch (OperationCanceledException) { throw; }
        catch { }
        return false;
    }

    private static void ConfirmSaveDialogIfPresent(IWebDriver driver)
    {
        try
        {
            var confirmButtons = driver.FindElements(By.XPath(
                "//*[@data-e2e='set-username-popup-confirm'] | //button[contains(text(), 'Confirm') or contains(text(), 'Xác nhận') or contains(text(), 'Set username') or contains(text(), 'Lưu')]"
            )).Where(e => e.Displayed && e.Enabled).ToList();

            if (confirmButtons.Count > 0)
            {
                var actions = new Actions(driver);
                actions.MoveToElement(confirmButtons[0], 5, 5).Pause(TimeSpan.FromMilliseconds(100)).Click().Perform();
            }
        }
        catch { }
    }

    private static bool ClickElement(IWebDriver driver, IWebElement element)
    {
        try
        {
            element.Click();
            return true;
        }
        catch { }

        try
        {
            new Actions(driver).MoveToElement(element, 5, 5).Pause(TimeSpan.FromMilliseconds(150)).Click().Perform();
            return true;
        }
        catch { }

        try
        {
            ((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].click();", element);
            return true;
        }
        catch { }

        return false;
    }

    private static void CancelAvatarPopupIfPresent(IWebDriver driver)
    {
        try
        {
            var cancel = driver.FindElements(By.XPath(
                "//*[contains(@class,'DivFooterContainer')]//*[text()='Hủy' or text()='Cancel'] | " +
                "//*[@data-e2e='edit-profile-popup']//button[contains(., 'Hủy') or contains(., 'Cancel')]"
            )).FirstOrDefault(e => e.Displayed && e.Enabled);

            if (cancel != null)
            {
                new Actions(driver).MoveToElement(cancel, 5, 5).Click().Perform();
            }
        }
        catch { }
    }

    private static bool HasInputError(IWebDriver driver, string scopeSelector)
    {
        try
        {
            // Tách các selector riêng biệt nếu có dấu phẩy để không bị lỗi cú pháp CSS
            var scopes = scopeSelector.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
            foreach (var scope in scopes)
            {
                // Chỉ kiểm tra khi THỰC SỰ có class báo lỗi hoặc style màu đỏ
                var errorElements = driver.FindElements(By.CssSelector(
                    $"{scope} [class*='Error'], " +
                    $"{scope} [class*='error'], " +
                    $"{scope} [style*='rgb(255, 76, 58)'], " +
                    $"{scope} [style*='rgb(254, 44, 85)'], " +
                    $"{scope} [aria-label*='Không thể'], " +
                    $"{scope} [aria-label*='too frequently'], " +
                    $"{scope} [aria-label*='7 days'], " +
                    $"{scope} [aria-label*='30 days']"
                )).Where(e => e.Displayed).ToList();
                if (errorElements.Count > 0)
                {
                    return true;
                }
            }
            return false;
        }
        catch
        {
            return false;
        }
    }

    private static bool HasAnyProfileInputError(IWebDriver driver)
    {
        try
        {
            return HasElement(driver, By.CssSelector("[class*='PInputError'], [aria-label*='Không thể'], [aria-label*=\"This username isn\"], [aria-label*='too frequently'], [aria-label*='7 days'], [aria-label*='30 days'], [data-e2e*='edit-profile'][style*='rgb(255, 76, 58)']"));
        }
        catch
        {
            return false;
        }
    }

    private static async Task WaitForCaptchaOrChallengeAsync(IWebDriver driver, Action<string> onProgress, CancellationToken token)
    {
        for (int i = 0; i < 40; i++)
        {
            token.ThrowIfCancellationRequested();
            if (!IsCaptchaOrChallengeVisible(driver)) return;

            int remain = 40 - i;
            onProgress($"⚠️ Đang có Captcha/challenge, vui lòng xử lý trên Chrome ({remain}s)...");
            await Task.Delay(1000, token);
        }
    }

    private static bool IsCaptchaOrChallengeVisible(IWebDriver driver)
    {
        return HasElement(driver, By.CssSelector(
            "iframe[src*='captcha'], iframe[src*='verify'], " +
            "[class*='captcha'], [id*='captcha'], " +
            "[class*='verify'], [id*='verify'], " +
            "[data-e2e*='captcha'], [data-e2e*='verify']"
        ));
    }

    private static IWebElement? FindVisibleEnabled(IWebDriver driver, By by)
    {
        try
        {
            return driver.FindElements(by).FirstOrDefault(e => e.Displayed && e.Enabled);
        }
        catch
        {
            return null;
        }
    }

    private static bool HasElement(IWebDriver driver, By by)
    {
        try
        {
            return driver.FindElements(by).Any(e => e.Displayed);
        }
        catch
        {
            return false;
        }
    }

    private static void TryScrollToTop(IWebDriver driver)
    {
        try
        {
            ((IJavaScriptExecutor)driver).ExecuteScript("window.scrollTo(0, 0);");
        }
        catch { }
    }

    private static async Task<bool> WaitUntilAsync(IWebDriver driver, Func<IWebDriver, bool> condition, TimeSpan timeout, CancellationToken token)
    {
        var until = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < until)
        {
            token.ThrowIfCancellationRequested();
            if (condition(driver)) return true;
            await Task.Delay(ShortPollMs, token);
        }

        return condition(driver);
    }

    private static async Task DelayRandomAsync(int minSec, int maxSec, CancellationToken token)
    {
        int delay = _random.Next(minSec * 1000, (maxSec + 1) * 1000);
        await Task.Delay(delay, token);
    }

    private static string TakeRandom(List<string> values, bool removeAfterTake)
    {
        lock (values)
        {
            if (values.Count == 0) return string.Empty;

            int index = _random.Next(values.Count);
            string value = values[index];
            if (removeAfterTake)
            {
                values.RemoveAt(index);
            }

            return value;
        }
    }

    private static List<string> GetImageFiles(string folder)
    {
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder)) return new();

        return Directory.GetFiles(folder, "*.*")
            .Where(f => f.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase) ||
                        f.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase) ||
                        f.EndsWith(".png", StringComparison.OrdinalIgnoreCase) ||
                        f.EndsWith(".webp", StringComparison.OrdinalIgnoreCase))
            .ToList();
    }

    private static void SaveDiagnosticSnapshot(IWebDriver driver, string name)
    {
        try
        {
            string dir = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "e2e_diagnostics");
            Directory.CreateDirectory(dir);
            string stamp = DateTime.Now.ToString("yyyyMMdd_HHmmss");
            File.WriteAllText(Path.Combine(dir, $"{stamp}_{name}.html"), driver.PageSource);

            if (driver is ITakesScreenshot screenshots)
            {
                screenshots.GetScreenshot().SaveAsFile(Path.Combine(dir, $"{stamp}_{name}.png"));
            }
        }
        catch { }
    }
}
