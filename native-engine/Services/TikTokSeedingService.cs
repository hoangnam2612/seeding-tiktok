using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MyTikTokTool.Models;
using OpenQA.Selenium;
using OpenQA.Selenium.Interactions;
using SeleniumKeys = OpenQA.Selenium.Keys;

namespace MyTikTokTool.Services;

public class TikTokSeedingService
{
    private readonly AccountService _accountService;
    private readonly TikTokLoginService _loginService;
    private static readonly Random _random = new();

    public TikTokSeedingService(AccountService accountService)
    {
        _accountService = accountService;
        _loginService = new TikTokLoginService(accountService);
    }

    #region SEEDING VIDEO
    public async Task<bool> RunVideoSeedingAsync(Account account, SeedingVideoConfig config, Action<string> onProgress, CancellationToken token = default)
    {
        IWebDriver? driver = null;
        try
        {
            onProgress("Đang khởi tạo trình duyệt...");
            driver = ChromeService.OpenSeleniumChrome(account, startUrl: "https://www.tiktok.com");
            await Task.Delay(3000, token);

            if (!await EnsureLoggedInAsync(account, driver, onProgress, token))
            {
                return false;
            }

            int totalVideos = config.VideoUrls.Count;
            int currentVideoIndex = 0;

            foreach (var rawUrl in config.VideoUrls)
            {
                if (token.IsCancellationRequested) break;
                if (string.IsNullOrWhiteSpace(rawUrl)) continue;

                string videoUrl = rawUrl.Trim();
                currentVideoIndex++;
                onProgress($"[{currentVideoIndex}/{totalVideos}] Đang mở video: {videoUrl}");

                driver.Navigate().GoToUrl(videoUrl);
                await Task.Delay(3000, token);

                if (!await EnsureReadyForVideoActionAsync(account, driver, onProgress, token, "mở video", videoUrl))
                {
                    return false;
                }

                // 1. Xem video
                int watchSeconds = _random.Next(config.MinViewSeconds, config.MaxViewSeconds + 1);
                onProgress($"Đang xem video trong {watchSeconds} giây...");

                int elapsed = 0;
                while (elapsed < watchSeconds && !token.IsCancellationRequested)
                {
                    await Task.Delay(1000, token);
                    elapsed++;

                    // Cuộn nhẹ tự nhiên
                    if (elapsed == 2)
                    {
                        try
                        {
                            ((IJavaScriptExecutor)driver).ExecuteScript("window.scrollBy(0, 100);");
                        }
                        catch { }
                    }
                }

                if (token.IsCancellationRequested) break;

                // 2. Thả tim (Like)
                if (config.IsLike)
                {
                    if (!await EnsureReadyForVideoActionAsync(account, driver, onProgress, token, "thả tim", videoUrl))
                    {
                        return false;
                    }

                    onProgress("Đang thả tim video...");
                    bool liked = LikeVideo(driver);
                    if (liked)
                        onProgress("✅ Đã thả tim thành công!");
                    else
                        onProgress("ℹ️ Video đã được thả tim từ trước hoặc không tìm thấy nút tim.");

                    await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
                }

                // 3. Follow tác giả
                if (config.IsFollow)
                {
                    if (!await EnsureReadyForVideoActionAsync(account, driver, onProgress, token, "follow", videoUrl))
                    {
                        return false;
                    }

                    onProgress("Đang kiểm tra Follow chủ kênh...");
                    bool followed = await FollowAuthorAsync(driver, onProgress, token, videoUrl);
                    if (followed)
                        onProgress("✅ Đã Follow chủ kênh!");
                    else
                        onProgress("⚠️ Chưa xác nhận được Follow chủ kênh sau nhiều lần thử.");

                    await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
                }

                // 4. Lưu vào yêu thích (Favorite)
                if (config.IsFavorite)
                {
                    if (!await EnsureReadyForVideoActionAsync(account, driver, onProgress, token, "lưu yêu thích", videoUrl))
                    {
                        return false;
                    }

                    onProgress("Đang lưu video vào mục Yêu thích...");
                    bool favorited = FavoriteVideo(driver);
                    if (favorited)
                        onProgress("✅ Đã lưu Yêu thích!");

                    await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
                }

                // 5. Bình luận (Comment)
                if (config.IsComment && config.Comments.Count > 0)
                {
                    string rawComment = config.Comments[_random.Next(config.Comments.Count)];
                    string commentContent = SpinTextHelper.Resolve(rawComment);

                    if (!string.IsNullOrWhiteSpace(commentContent))
                    {
                        if (!await EnsureReadyForVideoActionAsync(account, driver, onProgress, token, "bình luận", videoUrl))
                        {
                            return false;
                        }

                        onProgress($"Đang đăng bình luận: \"{commentContent}\"...");
                        bool commented = await PostCommentAsync(driver, commentContent, token);
                        if (commented)
                            onProgress("✅ Đã gửi bình luận thành công!");
                        else
                            onProgress("⚠️ Không gửi được bình luận (Ô comment bị ẩn hoặc lỗi giao diện).");
                    }

                    await DelayRandomAsync(config.MinDelaySeconds, config.MaxDelaySeconds, token);
                }
            }

            onProgress("🎉 Hoàn thành tương tác video!");
            return true;
        }
        catch (OperationCanceledException)
        {
            onProgress("⏹ Đã dừng tác vụ.");
            return false;
        }
        catch (Exception ex)
        {
            onProgress($"❌ Lỗi seeding video: {ex.Message}");
            return false;
        }
        finally
        {
            if (driver != null)
            {
                if (!token.IsCancellationRequested)
                {
                    await Task.Delay(1000);
                }
                ChromeService.CloseAccountChrome(account.Id);
            }
        }
    }

    private async Task<bool> EnsureLoggedInAsync(
        Account account,
        IWebDriver driver,
        Action<string> onProgress,
        CancellationToken token,
        string? returnUrl = null,
        int maxAttempts = 3)
    {
        if (TikTokLoginService.CheckIfLoggedIn(driver))
        {
            return true;
        }

        onProgress("Tài khoản chưa đăng nhập, đang gọi lại hàm login...");

        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            if (token.IsCancellationRequested)
            {
                return false;
            }

            var loginResult = await _loginService.LoginAsync(account, driver, msg => onProgress($"Login: {msg}"), token);
            if (loginResult.Success)
            {
                onProgress("✅ Đăng nhập lại thành công, tiếp tục thao tác.");
                if (!string.IsNullOrWhiteSpace(returnUrl))
                {
                    driver.Navigate().GoToUrl(returnUrl);
                    await Task.Delay(3000, token);
                }

                return true;
            }

            onProgress($"⚠️ Lần {attempt}/{maxAttempts} chưa login được: {loginResult.Message}");
            if (attempt < maxAttempts)
            {
                await Task.Delay(1500, token);
            }
        }

        return false;
    }

    private async Task<bool> EnsureReadyForVideoActionAsync(
        Account account,
        IWebDriver driver,
        Action<string> onProgress,
        CancellationToken token,
        string actionName,
        string? returnUrl = null)
    {
        if (IsCaptchaOrChallengeVisible(driver))
        {
            onProgress($"⚠️ Phát hiện captcha/challenge trước khi {actionName}. Thử đăng nhập lại tối đa 3 lần...");
            if (!await TryReloginToClearCaptchaAsync(account, driver, onProgress, token, returnUrl))
            {
                onProgress($"⚠️ Sau 3 lần đăng nhập lại vẫn còn captcha/challenge. Chuyển sang logic giải captcha...");
                if (!await TrySolveCaptchaAsync(driver, onProgress, token))
                {
                    onProgress($"❌ Không xử lý được captcha/challenge trước khi {actionName}.");
                    return false;
                }
            }
        }

        if (await EnsureLoggedInAsync(account, driver, onProgress, token, returnUrl))
        {
            return true;
        }

        onProgress($"⚠️ Tài khoản chưa đăng nhập nên không thể {actionName}.");
        return false;
    }

    private async Task<bool> EnsureReadyForLiveActionAsync(
        Account account,
        IWebDriver driver,
        Action<string> onProgress,
        CancellationToken token,
        string actionName,
        string? returnUrl = null)
    {
        bool ready = await EnsureReadyForVideoActionAsync(account, driver, onProgress, token, actionName, returnUrl);
        if (ready)
        {
            ApplyLivePageZoom(driver);
        }

        return ready;
    }

    private async Task<bool> TryReloginToClearCaptchaAsync(
        Account account,
        IWebDriver driver,
        Action<string> onProgress,
        CancellationToken token,
        string? returnUrl = null,
        int maxAttempts = 3)
    {
        for (int attempt = 1; attempt <= maxAttempts; attempt++)
        {
            if (token.IsCancellationRequested)
            {
                return false;
            }

            var loginResult = await _loginService.LoginAsync(account, driver, msg => onProgress($"Login: {msg}"), token);
            if (loginResult.Success)
            {
                if (!string.IsNullOrWhiteSpace(returnUrl))
                {
                    driver.Navigate().GoToUrl(returnUrl);
                    await Task.Delay(3000, token);
                }

                if (!IsCaptchaOrChallengeVisible(driver))
                {
                    onProgress("✅ Đăng nhập lại thành công và captcha/challenge đã biến mất.");
                    return true;
                }
            }

            onProgress($"⚠️ Lần {attempt}/{maxAttempts} vẫn còn captcha/challenge hoặc chưa login được: {loginResult.Message}");
            if (attempt < maxAttempts)
            {
                await Task.Delay(1500, token);
            }
        }

        return false;
    }

    private async Task<bool> TrySolveCaptchaAsync(IWebDriver driver, Action<string> onProgress, CancellationToken token)
    {
        // Chỗ cắm engine giải captcha sau này. Hiện tại chỉ chờ nếu người dùng xử lý thủ công trên Chrome.
        const int maxWaitSeconds = 60;
        for (int elapsed = 0; elapsed < maxWaitSeconds; elapsed += 3)
        {
            if (token.IsCancellationRequested)
            {
                return false;
            }

            if (!IsCaptchaOrChallengeVisible(driver))
            {
                onProgress("✅ Captcha/challenge đã được xử lý, tiếp tục thao tác.");
                return true;
            }

            onProgress($"⏳ Đang chờ xử lý captcha/challenge... còn {maxWaitSeconds - elapsed}s");
            await Task.Delay(3000, token);
        }

        return !IsCaptchaOrChallengeVisible(driver);
    }

    private bool LikeVideo(IWebDriver driver)
    {
        try
        {
            var unlikedButtons = driver.FindElements(By.XPath(
                "//*[@data-e2e='like-icon']/ancestor::button[@aria-pressed='false'] | " +
                "//*[@data-e2e='browse-like-icon']/ancestor::button[@aria-pressed='false'] | " +
                "//button[contains(@aria-label, 'Like') or contains(@aria-label, 'Thích')][@aria-pressed='false']"
            )).Where(e => e.Displayed && e.Enabled).ToList();

            if (unlikedButtons.Count > 0)
            {
                var target = unlikedButtons[0];
                var actions = new Actions(driver);
                actions.MoveToElement(target, 5, 5).Pause(TimeSpan.FromMilliseconds(150)).Click().Perform();
                return true;
            }

            var generalLike = driver.FindElements(By.CssSelector("[data-e2e='like-icon'], [data-e2e='browse-like-icon']"))
                .FirstOrDefault(e => e.Displayed);
            if (generalLike != null)
            {
                var actions = new Actions(driver);
                actions.MoveToElement(generalLike, 5, 5).Pause(TimeSpan.FromMilliseconds(150)).Click().Perform();
                return true;
            }
        }
        catch { }
        return false;
    }

    private async Task<bool> FollowAuthorAsync(IWebDriver driver, Action<string> onProgress, CancellationToken token, string videoUrl)
    {
        try
        {
            const int maxAttempts = 5;
            for (int attempt = 1; attempt <= maxAttempts; attempt++)
            {
                if (token.IsCancellationRequested)
                {
                    return false;
                }

                var targets = FindUnfollowedButtons(driver);
                if (targets.Count == 0)
                {
                    if (HasFollowedAuthorIndicator(driver))
                    {
                        return true;
                    }

                    onProgress($"⚠️ Lần {attempt}/{maxAttempts}: chưa tìm thấy nút Follow đúng trên video.");
                    await ReopenCurrentVideoAsync(driver, videoUrl, token);
                    continue;
                }

                for (int targetIndex = 0; targetIndex < targets.Count; targetIndex++)
                {
                    if (token.IsCancellationRequested)
                    {
                        return false;
                    }

                    var target = targets[targetIndex];
                    onProgress($"Đang Follow chủ kênh... lần {attempt}/{maxAttempts}, nút {targetIndex + 1}/{targets.Count}");
                    if (!TryClickFollowButton(driver, target))
                    {
                        onProgress($"⚠️ Lần {attempt}/{maxAttempts}: click nút Follow {targetIndex + 1}/{targets.Count} chưa thành công.");
                        await Task.Delay(Random.Shared.Next(1200, 2200), token);
                        continue;
                    }

                    onProgress("Đã bấm Follow, đang chờ TikTok xác nhận trạng thái...");
                    if (await WaitForFollowConfirmedAsync(driver, token))
                    {
                        return true;
                    }

                    onProgress($"⚠️ Nút Follow {targetIndex + 1}/{targets.Count} chưa được TikTok xác nhận, thử nút tiếp theo.");
                    await Task.Delay(Random.Shared.Next(1500, 2600), token);
                }

                onProgress($"⚠️ Lần {attempt}/{maxAttempts}: TikTok chưa cập nhật trạng thái Follow, thử lại.");
                await ReopenCurrentVideoAsync(driver, videoUrl, token);
            }
        }
        catch { }
        return false;
    }

    /// <summary>
    /// Hàm phụ trợ: Quét tìm nút Follow đang ở trạng thái CHƯA FOLLOW
    /// </summary>
    private static List<IWebElement> FindUnfollowedButtons(IWebDriver driver)
    {
        try
        {
            return driver.FindElements(By.XPath(
                "//main //*[@data-e2e='browse-follow']//*[normalize-space()='Follow' or normalize-space()='Theo dõi']/ancestor-or-self::*[@data-e2e='browse-follow'] | " +
                "//*[@data-e2e='browse-follow']//button | " +
                "//button[@data-e2e='follow-button']//*[normalize-space()='Follow' or normalize-space()='Theo dõi' or normalize-space()='Follow back']/ancestor::button | " +
                "//*[@data-e2e='follow-button'] | " +
                "//*[@data-e2e='feed-follow'] | " +
                "//*[@data-e2e='follow-icon']/ancestor::*[self::button or @role='button'] | " +
                "//button[contains(@aria-label, 'Follow') or contains(@aria-label, 'Theo dõi')] | " +
                "//div[@role='button'][contains(@aria-label, 'Follow') or contains(@aria-label, 'Theo dõi')] | " +
                "//button[contains(., 'Follow') or contains(., 'Theo dõi')]"
            ))
            .Select(element => NormalizeFollowButtonTarget(driver, element))
            .Where(element => element != null)
            .Cast<IWebElement>()
            .Where(IsDisplayedEnabledAndUnfollowed)
            .GroupBy(GetElementFingerprint)
            .Select(group => group.First())
            .OrderBy(GetFollowButtonPriority)
            .ToList();
        }
        catch
        {
            return new List<IWebElement>();
        }
    }

    private static IWebElement? NormalizeFollowButtonTarget(IWebDriver driver, IWebElement element)
    {
        try
        {
            if (driver is not IJavaScriptExecutor js)
            {
                return element;
            }

            return js.ExecuteScript(@"
                const el = arguments[0];
                if (!el) return null;

                if (el.matches('button,[role=""button""]')) return el;

                const childButton = el.querySelector && el.querySelector('button,[role=""button""]');
                if (childButton) return childButton;

                return el.closest('button,[role=""button""],[data-e2e=""browse-follow""],[data-e2e=""follow-button""],[data-e2e=""feed-follow""]');
            ", element) as IWebElement ?? element;
        }
        catch
        {
            return element;
        }
    }

    private static string GetElementFingerprint(IWebElement element)
    {
        try
        {
            return $"{element.Location.X}:{element.Location.Y}:{element.Size.Width}:{element.Size.Height}:{element.GetAttribute("data-e2e")}:{element.Text}";
        }
        catch
        {
            return Guid.NewGuid().ToString();
        }
    }

    private static bool IsDisplayedEnabledAndUnfollowed(IWebElement element)
    {
        try
        {
            if (!element.Displayed || !element.Enabled)
            {
                return false;
            }

            string text = element.Text ?? "";
            string ariaLabel = element.GetAttribute("aria-label") ?? "";
            string dataE2e = element.GetAttribute("data-e2e") ?? "";
            string outerHtml = element.GetAttribute("outerHTML") ?? "";
            string state = $"{text} {ariaLabel} {dataE2e} {outerHtml}";

            bool hasTextFollowSignal = text.Contains("Follow", StringComparison.OrdinalIgnoreCase)
                || text.Contains("Theo dõi", StringComparison.OrdinalIgnoreCase)
                || ariaLabel.Contains("Follow", StringComparison.OrdinalIgnoreCase)
                || ariaLabel.Contains("Theo dõi", StringComparison.OrdinalIgnoreCase);

            bool hasIconFollowSignal = dataE2e.Equals("feed-follow", StringComparison.OrdinalIgnoreCase)
                || dataE2e.Equals("follow-icon", StringComparison.OrdinalIgnoreCase)
                || outerHtml.Contains("data-e2e=\"feed-follow\"", StringComparison.OrdinalIgnoreCase)
                || outerHtml.Contains("data-e2e=\"follow-icon\"", StringComparison.OrdinalIgnoreCase);

            bool hasFollowedSignal = state.Contains("Following", StringComparison.OrdinalIgnoreCase)
                || state.Contains("Đang follow", StringComparison.OrdinalIgnoreCase)
                || state.Contains("Đang theo dõi", StringComparison.OrdinalIgnoreCase)
                || state.Contains("Đã follow", StringComparison.OrdinalIgnoreCase)
                || state.Contains("Đã theo dõi", StringComparison.OrdinalIgnoreCase)
                || state.Contains("Friends", StringComparison.OrdinalIgnoreCase)
                || state.Contains("Bạn bè", StringComparison.OrdinalIgnoreCase);

            bool isMessageButton = state.Contains("Message", StringComparison.OrdinalIgnoreCase)
                || state.Contains("Tin nhắn", StringComparison.OrdinalIgnoreCase);

            return (hasTextFollowSignal || hasIconFollowSignal) && !hasFollowedSignal && !isMessageButton;
        }
        catch
        {
            return false;
        }
    }

    private static int GetFollowButtonPriority(IWebElement element)
    {
        try
        {
            string dataE2e = element.GetAttribute("data-e2e") ?? "";
            string outerHtml = element.GetAttribute("outerHTML") ?? "";

            if (dataE2e.Equals("browse-follow", StringComparison.OrdinalIgnoreCase)
                || outerHtml.Contains("data-e2e=\"browse-follow\"", StringComparison.OrdinalIgnoreCase))
            {
                return 0;
            }

            if (dataE2e.Equals("follow-button", StringComparison.OrdinalIgnoreCase))
            {
                return 1;
            }

            if (dataE2e.Equals("feed-follow", StringComparison.OrdinalIgnoreCase)
                || dataE2e.Equals("follow-icon", StringComparison.OrdinalIgnoreCase)
                || outerHtml.Contains("data-e2e=\"feed-follow\"", StringComparison.OrdinalIgnoreCase)
                || outerHtml.Contains("data-e2e=\"follow-icon\"", StringComparison.OrdinalIgnoreCase))
            {
                return 2;
            }
        }
        catch { }

        return 10;
    }

    private static async Task<bool> WaitForFollowConfirmedAsync(IWebDriver driver, CancellationToken token)
    {
        const int maxWaitMs = 10000;
        const int pollDelayMs = 500;
        const int minConfirmMs = 2000;
        var stableConfirmCount = 0;

        await Task.Delay(1200, token);

        for (int elapsed = 1200; elapsed < maxWaitMs; elapsed += pollDelayMs)
        {
            if (token.IsCancellationRequested)
            {
                return false;
            }

            if (IsLoginDialogVisible(driver) || IsCaptchaOrChallengeVisible(driver))
            {
                return false;
            }

            bool hasConfirmedState = HasFollowedAuthorIndicator(driver) || !HasUnfollowedAuthorButton(driver);
            if (elapsed >= minConfirmMs && hasConfirmedState)
            {
                stableConfirmCount++;
                if (stableConfirmCount >= 3)
                {
                    return true;
                }
            }
            else
            {
                stableConfirmCount = 0;
            }

            await Task.Delay(pollDelayMs, token);
        }

        return false;
    }

    private static bool HasUnfollowedAuthorButton(IWebDriver driver)
    {
        return FindUnfollowedButtons(driver).Count > 0;
    }

    private static bool HasFollowedAuthorIndicator(IWebDriver driver)
    {
        try
        {
            return driver.FindElements(By.XPath(
                "//*[@data-e2e='browse-follow']//*[contains(normalize-space(), 'Following') or contains(normalize-space(), 'Đang theo dõi') or contains(normalize-space(), 'Bạn bè') or contains(normalize-space(), 'Friends')] | " +
                "//*[@data-e2e='follow-button' and (contains(normalize-space(), 'Following') or contains(normalize-space(), 'Đang theo dõi') or contains(normalize-space(), 'Bạn bè') or contains(normalize-space(), 'Friends'))] | " +
                "//button[contains(normalize-space(), 'Following') or contains(normalize-space(), 'Đang theo dõi') or contains(normalize-space(), 'Bạn bè') or contains(normalize-space(), 'Friends')]"
            )).Any(e => e.Displayed);
        }
        catch
        {
            return false;
        }
    }

    private static async Task ReopenCurrentVideoAsync(IWebDriver driver, string videoUrl, CancellationToken token)
    {
        try
        {
            driver.Navigate().GoToUrl(videoUrl);
            await Task.Delay(3000, token);
        }
        catch
        {
        }
    }

    private bool FavoriteVideo(IWebDriver driver)
    {
        try
        {
            var favButton = FindFavoriteButton(driver);
            if (favButton == null)
            {
                return false;
            }

            // 1. Kiểm tra nếu video đã được lưu từ trước -> Không bấm nữa để tránh bị Hủy lưu
            if (IsVideoAlreadyFavorited(favButton))
            {
                return true;
            }

            // 2. Thực hiện Click ĐÚNG 1 LẦN DUY NHẤT
            if (TryNaturalClick(driver, favButton) || TryClickByJavaScript(driver, favButton))
            {
                Thread.Sleep(1200);
                return true;
            }
        }
        catch { }
        return false;
    }

    /// <summary>
    /// Quét tìm nút Yêu thích trên giao diện
    /// </summary>
    private IWebElement? FindFavoriteButton(IWebDriver driver)
    {
        try
        {
            var favButtons = driver.FindElements(By.XPath(
                // 1. Quét mọi biến thể data-e2e (trên chính button hoặc thẻ con)
                "//*[@data-e2e='browse-favorite-icon' or @data-e2e='favorite-icon' or @data-e2e='undefined-icon' or @data-e2e='bookmark-icon' or @data-e2e='browse-favorite' or @data-e2e='feed-favorite' or @data-e2e='favorite-button']/ancestor-or-self::button | " +
                "//*[@data-e2e='browse-favorite-icon' or @data-e2e='favorite-icon' or @data-e2e='undefined-icon' or @data-e2e='bookmark-icon' or @data-e2e='browse-favorite' or @data-e2e='feed-favorite' or @data-e2e='favorite-button']/ancestor-or-self::*[@role='button'] | " +

                // 2. Quét qua container số đếm Yêu thích
                "//*[contains(@data-e2e, 'favorite-count') or contains(@data-e2e, 'undefined-count') or contains(@data-e2e, 'bookmark-count')]/ancestor-or-self::button | " +

                // 3. Quét qua thuộc tính aria-label
                "//button[contains(@aria-label, 'Favorite') or contains(@aria-label, 'Yêu thích') or contains(@aria-label, 'Bookmark') or contains(@aria-label, 'favorite') or contains(@aria-label, 'yêu thích')] | " +
                "//div[@role='button'][contains(@aria-label, 'Favorite') or contains(@aria-label, 'Yêu thích') or contains(@aria-label, 'Bookmark') or contains(@aria-label, 'favorite') or contains(@aria-label, 'yêu thích')]"
            ))
            .Where(e => e.Displayed && e.Enabled)
            .ToList();

            return favButtons.FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Kiểm tra xem video đã ở trạng thái ĐÃ LƯU từ trước chưa
    /// </summary>
    private static bool IsVideoAlreadyFavorited(IWebElement element)
    {
        try
        {
            string ariaPressed = element.GetAttribute("aria-pressed") ?? "";
            string ariaLabel = element.GetAttribute("aria-label") ?? "";
            string outerHtml = element.GetAttribute("outerHTML") ?? "";

            return ariaPressed.Equals("true", StringComparison.OrdinalIgnoreCase)
                || ariaLabel.Contains("Remove", StringComparison.OrdinalIgnoreCase)
                || ariaLabel.Contains("Xóa", StringComparison.OrdinalIgnoreCase)
                || outerHtml.Contains("rgb(250, 206, 21)")
                || outerHtml.Contains("#face15")
                || outerHtml.Contains("rgb(254, 193, 7)");
        }
        catch
        {
            return false;
        }
    }

    private async Task<bool> PostCommentAsync(IWebDriver driver, string commentText, CancellationToken token)
    {
        try
        {
            if (IsCaptchaOrChallengeVisible(driver) || IsLoginDialogVisible(driver))
            {
                return false;
            }

            var commentIcons = driver.FindElements(By.CssSelector("[data-e2e='comment-icon'], [data-e2e='browse-comment-icon']"))
                .Where(e => e.Displayed).ToList();
            if (commentIcons.Count > 0)
            {
                TryNaturalClick(driver, commentIcons[0]);
                await Task.Delay(_random.Next(900, 1600), token);
            }

            IWebElement? input = null;
            for (int attempt = 0; attempt < 5 && !token.IsCancellationRequested; attempt++)
            {
                if (IsCaptchaOrChallengeVisible(driver) || IsLoginDialogVisible(driver))
                {
                    return false;
                }

                input = FindCommentInput(driver);
                if (input != null)
                {
                    break;
                }

                if (commentIcons.Count > 0)
                {
                    TryNaturalClick(driver, commentIcons[0]);
                }

                await Task.Delay(_random.Next(700, 1300), token);
            }

            if (input == null)
            {
                return false;
            }

            var actions = new Actions(driver);
            actions.MoveToElement(input, 5, 5).Pause(TimeSpan.FromMilliseconds(_random.Next(180, 420))).Click().Perform();
            await Task.Delay(_random.Next(350, 750), token);

            if (!await FillCommentInputAsync(driver, input, commentText, token))
            {
                return false;
            }

            var postButton = await WaitForEnabledCommentPostButtonAsync(driver, token);
            if (postButton != null)
            {
                if (IsCaptchaOrChallengeVisible(driver) || IsLoginDialogVisible(driver))
                {
                    return false;
                }

                TryNaturalClick(driver, postButton);
                await Task.Delay(_random.Next(2500, 4200), token);

                return !IsLoginDialogVisible(driver) && !IsCaptchaOrChallengeVisible(driver) && !IsCommentStillInInput(driver, commentText);
            }
            else
            {
                input.SendKeys(SeleniumKeys.Enter);
                await Task.Delay(_random.Next(2500, 4200), token);
                return !IsLoginDialogVisible(driver) && !IsCaptchaOrChallengeVisible(driver) && !IsCommentStillInInput(driver, commentText);
            }
        }
        catch { }
        return false;
    }

    private static IWebElement? FindCommentInput(IWebDriver driver)
    {
        try
        {
            return driver.FindElements(By.CssSelector(
                "[data-e2e='comment-input'] [role='textbox'], " +
                "[data-e2e='comment-input'] [contenteditable='true'], " +
                "[data-e2e='comment-input'] textarea, " +
                "[data-e2e='comment-input'] input, " +
                "div.public-DraftEditor-content[contenteditable='true']"
            )).FirstOrDefault(e => e.Displayed && e.Enabled);
        }
        catch
        {
            return null;
        }
    }

    private async Task<bool> FillCommentInputAsync(IWebDriver driver, IWebElement input, string commentText, CancellationToken token)
    {
        try
        {
            input.SendKeys(SeleniumKeys.Control + "a");
            input.SendKeys(SeleniumKeys.Backspace);
            await Task.Delay(200, token);

            foreach (char c in commentText)
            {
                if (token.IsCancellationRequested) return false;
                if (IsCaptchaOrChallengeVisible(driver) || IsLoginDialogVisible(driver)) return false;

                input.SendKeys(c.ToString());
                await Task.Delay(_random.Next(70, 180), token);
            }

            await Task.Delay(_random.Next(700, 1200), token);
            return IsCommentStillInInput(driver, commentText);
        }
        catch
        {
            return false;
        }
    }

    private static async Task<IWebElement?> WaitForEnabledCommentPostButtonAsync(IWebDriver driver, CancellationToken token)
    {
        for (int i = 0; i < 20 && !token.IsCancellationRequested; i++)
        {
            var postButton = driver.FindElements(By.CssSelector(
                "[data-e2e='comment-post'], " +
                "button[data-e2e='comment-post'], " +
                "div[data-e2e='comment-post']"
            )).FirstOrDefault(IsDisplayedAndEnabledPostButton);

            if (postButton != null)
            {
                return postButton;
            }

            await Task.Delay(250, token);
        }

        return null;
    }

    private static bool IsDisplayedAndEnabledPostButton(IWebElement element)
    {
        try
        {
            if (!element.Displayed || !element.Enabled)
            {
                return false;
            }

            string disabled = element.GetAttribute("disabled") ?? "";
            string ariaDisabled = element.GetAttribute("aria-disabled") ?? "";
            return !disabled.Equals("true", StringComparison.OrdinalIgnoreCase)
                && !ariaDisabled.Equals("true", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsCommentStillInInput(IWebDriver driver, string commentText)
    {
        try
        {
            var inputs = driver.FindElements(By.CssSelector(
                "[data-e2e='comment-input'] [role='textbox'], " +
                "[data-e2e='comment-input'] [contenteditable='true'], " +
                "[data-e2e='comment-input'] textarea, " +
                "[data-e2e='comment-input'] input, " +
                "div.public-DraftEditor-content[contenteditable='true']"
            ));

            return inputs.Any(input =>
            {
                try
                {
                    return input.Displayed
                        && (input.Text ?? "").Contains(commentText, StringComparison.OrdinalIgnoreCase);
                }
                catch
                {
                    return false;
                }
            });
        }
        catch
        {
            return false;
        }
    }

    private static bool IsLoginDialogVisible(IWebDriver driver)
    {
        try
        {
            return driver.FindElements(By.XPath(
                "//*[contains(text(), 'Đăng nhập vào TikTok')] | " +
                "//*[contains(text(), 'Log in to TikTok')] | " +
                "//*[contains(text(), 'Sử dụng số điện thoại hoặc email')] | " +
                "//*[contains(text(), 'Use phone / email / username')]"
            )).Any(e => e.Displayed);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsCaptchaOrChallengeVisible(IWebDriver driver)
    {
        try
        {
            return driver.FindElements(By.CssSelector(
                "#captcha_container, " +
                ".captcha_verify_container, " +
                "div[class*='captcha'], " +
                "iframe[src*='captcha'], " +
                "iframe[src*='verify']"
            )).Any(e => e.Displayed)
            || driver.FindElements(By.XPath(
                "//*[contains(translate(text(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'), 'captcha')] | " +
                "//*[contains(text(), 'Xác minh')] | " +
                "//*[contains(text(), 'Verify')] | " +
                "//*[contains(text(), 'Security check')] | " +
                "//*[contains(text(), 'Kiểm tra bảo mật')]"
            )).Any(e => e.Displayed);
        }
        catch
        {
            return false;
        }
    }

    private static bool TryNaturalClick(IWebDriver driver, IWebElement element)
    {
        try
        {
            var actions = new Actions(driver);
            actions
                .MoveToElement(element, _random.Next(3, 12), _random.Next(3, 12))
                .Pause(TimeSpan.FromMilliseconds(_random.Next(180, 480)))
                .Click()
                .Perform();
            return true;
        }
        catch
        {
            try
            {
                element.Click();
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    private static bool TryClickFollowButton(IWebDriver driver, IWebElement element)
    {
        try
        {
            if (driver is IJavaScriptExecutor js)
            {
                js.ExecuteScript("arguments[0].scrollIntoView({block: 'center', inline: 'center'});", element);
                Thread.Sleep(Random.Shared.Next(450, 850));
            }

            new Actions(driver)
                .MoveToElement(element)
                .Pause(TimeSpan.FromMilliseconds(Random.Shared.Next(650, 1100)))
                .Click()
                .Pause(TimeSpan.FromMilliseconds(Random.Shared.Next(350, 700)))
                .Perform();
            return true;
        }
        catch
        {
        }

        try
        {
            if (driver is IJavaScriptExecutor js)
            {
                js.ExecuteScript("arguments[0].scrollIntoView({block: 'center', inline: 'center'});", element);
                Thread.Sleep(Random.Shared.Next(500, 900));
                js.ExecuteScript(@"
                    const el = arguments[0];
                    const rect = el.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + rect.height / 2;
                    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                        el.dispatchEvent(new MouseEvent(type, {
                            bubbles: true,
                            cancelable: true,
                            clientX: x,
                            clientY: y,
                            view: window
                        }));
                    }
                    el.click();
                ", element);
                Thread.Sleep(Random.Shared.Next(450, 800));
                return true;
            }
        }
        catch
        {
        }

        try
        {
            Thread.Sleep(Random.Shared.Next(350, 700));
            element.Click();
            Thread.Sleep(Random.Shared.Next(450, 800));
            return true;
        }
        catch
        {
            try
            {
                new Actions(driver)
                    .MoveToElement(element)
                    .Pause(TimeSpan.FromMilliseconds(Random.Shared.Next(650, 1100)))
                    .Click()
                    .Pause(TimeSpan.FromMilliseconds(Random.Shared.Next(350, 700)))
                    .Perform();
                return true;
            }
            catch
            {
                return false;
            }
        }
    }

    private static bool TryClickByJavaScript(IWebDriver driver, IWebElement element)
    {
        try
        {
            if (driver is not IJavaScriptExecutor js)
            {
                return false;
            }

            js.ExecuteScript("arguments[0].scrollIntoView({block: 'center', inline: 'center'});", element);
            Thread.Sleep(200);
            js.ExecuteScript("arguments[0].click();", element);
            return true;
        }
        catch
        {
            return false;
        }
    }
    #endregion

    #region SEEDING LIVESTREAM
    public async Task<bool> RunLiveSeedingAsync(Account account, SeedingLiveConfig config, Action<string> onProgress, CancellationToken token = default)
    {
        IWebDriver? driver = null;
        try
        {
            onProgress("Đang khởi tạo trình duyệt...");
            driver = ChromeService.OpenSeleniumChrome(account, startUrl: "https://www.tiktok.com");
            await Task.Delay(3000, token);

            if (!await EnsureLoggedInAsync(account, driver, onProgress, token))
            {
                return false;
            }

            int totalLives = config.LiveUrls.Count;
            int currentLiveIndex = 0;

            foreach (var rawUrl in config.LiveUrls)
            {
                if (token.IsCancellationRequested) break;
                if (string.IsNullOrWhiteSpace(rawUrl)) continue;

                string liveUrl = rawUrl.Trim();
                currentLiveIndex++;
                onProgress($"[{currentLiveIndex}/{totalLives}] Đang vào phòng Live: {liveUrl}");

                driver.Navigate().GoToUrl(liveUrl);
                await Task.Delay(4000, token);
                ApplyLivePageZoom(driver);

                if (!await EnsureReadyForLiveActionAsync(account, driver, onProgress, token, "vào phòng Live", liveUrl))
                {
                    return false;
                }

                // 1. Follow chủ phòng Live nếu có cấu hình
                if (config.IsFollowHost)
                {
                    if (!await EnsureReadyForLiveActionAsync(account, driver, onProgress, token, "follow chủ phòng Live", liveUrl))
                    {
                        return false;
                    }

                    onProgress("Đang kiểm tra Follow chủ phòng Live...");
                    bool followed = FollowHostLive(driver);
                    if (followed)
                        onProgress("✅ Đã Follow chủ phòng Live!");
                }

                // 2. Duy trì mắt xem và tương tác
                int totalWatchSeconds = _random.Next(config.MinWatchMinutes * 60, config.MaxWatchMinutes * 60 + 1);
                onProgress($"Đang duy trì mắt xem trong {totalWatchSeconds / 60} phút ({totalWatchSeconds}s)...");

                DateTime startTime = DateTime.Now;
                DateTime nextCommentTime = DateTime.Now.AddSeconds(_random.Next(5, 15));
                DateTime nextHeartTime = DateTime.Now.AddSeconds(2);

                while ((DateTime.Now - startTime).TotalSeconds < totalWatchSeconds && !token.IsCancellationRequested)
                {
                    await Task.Delay(1000, token);

                    // Thả tim vào live
                    if (config.IsSendHearts && DateTime.Now >= nextHeartTime)
                    {
                        if (!await EnsureReadyForLiveActionAsync(account, driver, onProgress, token, "thả tim Livestream", liveUrl))
                        {
                            return false;
                        }

                        onProgress("❤️ Đang thả tim Livestream...");
                        SendHeartsLive(driver, config.HeartClicksPerRound);
                        nextHeartTime = DateTime.Now.AddSeconds(_random.Next(8, 16));
                    }

                    // Chat vào live
                    if (config.IsCommentLive && config.LiveComments.Count > 0 && DateTime.Now >= nextCommentTime)
                    {
                        string rawComment = config.LiveComments[_random.Next(config.LiveComments.Count)];
                        string commentContent = SpinTextHelper.Resolve(rawComment);

                        if (!string.IsNullOrWhiteSpace(commentContent))
                        {
                            if (!await EnsureReadyForLiveActionAsync(account, driver, onProgress, token, "chat live", liveUrl))
                            {
                                return false;
                            }

                            onProgress($"💬 Đang chat vào live: \"{commentContent}\"...");
                            bool commented = await SendChatLiveAsync(driver, commentContent, token);
                            if (commented)
                                onProgress("✅ Đã gửi tin nhắn chat live!");
                        }

                        nextCommentTime = DateTime.Now.AddSeconds(config.CommentIntervalSeconds + _random.Next(-3, 4));
                    }
                }
            }

            onProgress("🎉 Hoàn thành xem Livestream!");
            return true;
        }
        catch (OperationCanceledException)
        {
            onProgress("⏹ Đã dừng xem live.");
            return false;
        }
        catch (Exception ex)
        {
            onProgress($"❌ Lỗi xem live: {ex.Message}");
            return false;
        }
        finally
        {
            if (driver != null)
            {
                if (!token.IsCancellationRequested)
                {
                    await Task.Delay(1000);
                }
                ChromeService.CloseAccountChrome(account.Id);
            }
        }
    }

    private static void ApplyLivePageZoom(IWebDriver driver)
    {
        try
        {
            if (driver is not IJavaScriptExecutor js)
            {
                return;
            }

            double zoom = Math.Clamp(BrowserLayoutManager.Config.LivePageZoom, 0.5, 1.0);
            string zoomText = zoom.ToString("0.##", System.Globalization.CultureInfo.InvariantCulture);
            js.ExecuteScript(@"
                const zoom = arguments[0];
                document.documentElement.style.zoom = zoom;
                if (document.body) {
                    document.body.style.zoom = zoom;
                }
            ", zoomText);
        }
        catch
        {
        }
    }

    private bool FollowHostLive(IWebDriver driver)
    {
        try
        {
            var followButtons = driver.FindElements(By.XPath(
                "//button[contains(@data-e2e, 'follow') and not(contains(., 'Following')) and not(contains(., 'Đang follow'))] | " +
                "//div[contains(@data-e2e, 'live-room')]//button[text()='Follow' or text()='Theo dõi']"
            )).Where(e => e.Displayed && e.Enabled).ToList();

            if (followButtons.Count > 0)
            {
                var target = followButtons[0];
                var actions = new Actions(driver);
                actions.MoveToElement(target, 5, 5).Pause(TimeSpan.FromMilliseconds(150)).Click().Perform();
                return true;
            }
        }
        catch { }
        return false;
    }

    private void SendHeartsLive(IWebDriver driver, int clicks)
    {
        try
        {
            // 1. Tìm chính xác Nút Tim từ data-e2e="room-chat-like-btn"
            var heartButtons = driver.FindElements(By.CssSelector(
                "[data-e2e='room-chat-like-btn'], " +
                "div[data-e2e='room-chat-like-btn']"
            )).Where(e => e.Displayed).ToList();
            IWebElement? heartTarget = heartButtons.FirstOrDefault();
            if (heartTarget != null)
            {
                // Bấm liên tục vào nút tim (dùng JS click để bắn tim siêu mượt, không lệch tọa độ)
                for (int i = 0; i < clicks; i++)
                {
                    try
                    {
                        ((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].click();", heartTarget);
                    }
                    catch
                    {
                        new Actions(driver).MoveToElement(heartTarget).Click().Perform();
                    }
                    Thread.Sleep(_random.Next(80, 150));
                }
            }
            else
            {
                // Fallback JavaScript: Tìm trực tiếp [data-e2e="room-chat-like-btn"] trong DOM và kích hoạt click
                for (int i = 0; i < clicks; i++)
                {
                    ((IJavaScriptExecutor)driver).ExecuteScript(@"
                    const heart = document.querySelector('[data-e2e=""room-chat-like-btn""]');
                    if (heart) {
                        heart.click();
                    }
                ");
                    Thread.Sleep(_random.Next(80, 150));
                }
            }
        }
        catch { }
    }

    private async Task<bool> SendChatLiveAsync(IWebDriver driver, string chatText, CancellationToken token)
    {
        try
        {
            // 1. Tìm ô nhập bình luận data-e2e="room-chat-input-field" (thẻ div contenteditable)
            var chatInputs = driver.FindElements(By.CssSelector(
                "[data-e2e='room-chat-input-field'], " +
                "div[data-e2e='room-chat-input-field'], " +
                "[contenteditable='plaintext-only'][data-e2e*='chat']"
            )).Where(e => e.Displayed && e.Enabled).ToList();
            if (chatInputs.Count == 0) return false;
            var input = chatInputs[0];
            // Click để kích hoạt Focus vào ô chat
            new Actions(driver).MoveToElement(input, 5, 5).Click().Perform();
            await Task.Delay(200, token);
            // 2. Chèn nội dung chat vào thẻ contenteditable và kích hoạt sự kiện React
            bool inserted = false;
            try
            {
                ((IJavaScriptExecutor)driver).ExecuteScript(@"
                const el = arguments[0];
                el.focus();
                document.execCommand('selectAll', false, null);
                document.execCommand('insertText', false, arguments[1]);
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            ", input, chatText);
                inserted = true;
            }
            catch { }
            // Fallback nhập phím từng ký tự nếu JS execCommand bị chặn
            if (!inserted)
            {
                input.SendKeys(SeleniumKeys.Control + "a");
                input.SendKeys(SeleniumKeys.Backspace);
                await Task.Delay(100, token);
                foreach (char c in chatText)
                {
                    if (token.IsCancellationRequested) return false;
                    input.SendKeys(c.ToString());
                    await Task.Delay(_random.Next(30, 80), token);
                }
            }
            await Task.Delay(400, token);
            // 3. Bấm nút Gửi tin nhắn data-e2e="room-chat-send-btn" hoặc bấm Enter
            var sendButtons = driver.FindElements(By.CssSelector(
                "[data-e2e='room-chat-send-btn'], " +
                "div[data-e2e='room-chat-send-btn']"
            )).Where(e => e.Displayed).ToList();
            if (sendButtons.Count > 0)
            {
                try
                {
                    ((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].click();", sendButtons[0]);
                }
                catch
                {
                    new Actions(driver).MoveToElement(sendButtons[0], 5, 5).Click().Perform();
                }
                await Task.Delay(1000, token);
                return true;
            }
            else
            {
                input.SendKeys(SeleniumKeys.Enter);
                await Task.Delay(1000, token);
                return true;
            }
        }
        catch { }
        return false;
    }
    #endregion

    private static async Task DelayRandomAsync(int minSec, int maxSec, CancellationToken token)
    {
        int delay = _random.Next(minSec * 1000, (maxSec + 1) * 1000);
        await Task.Delay(delay, token);
    }
}
