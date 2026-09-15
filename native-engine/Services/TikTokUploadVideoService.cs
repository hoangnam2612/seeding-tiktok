using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MyTikTokTool.Models;
using OpenQA.Selenium;
using OpenQA.Selenium.Interactions;
using SeleniumKeys = OpenQA.Selenium.Keys;

namespace MyTikTokTool.Services;

public partial class TikTokUploadVideoService
{
    private readonly AccountService _accountService;
    private readonly TikTokLoginService _loginService;
    private static readonly Random _random = new();

    public TikTokUploadVideoService(AccountService accountService)
    {
        _accountService = accountService;
        _loginService = new TikTokLoginService(accountService);
    }

    public async Task<VideoUploadResult> UploadOneVideoAsync(
        Account account,
        VideoUploadItem video,
        VideoUploadConfig config,
        Action<string> onProgress,
        CancellationToken token = default)
    {
        IWebDriver? driver = null;
        try
        {
            if (string.IsNullOrWhiteSpace(video.Path) || !File.Exists(video.Path))
            {
                return VideoUploadResult.Fail($"Không tìm thấy file video: {video.Path}");
            }

            onProgress("Đang khởi tạo trình duyệt...");
            if (config.AttachProducts && video.Product == null)
                return VideoUploadResult.Fail("Video chưa được ghép sản phẩm theo thứ tự.");
            driver = ChromeService.OpenSeleniumChrome(account, startUrl: "https://www.tiktok.com");
            await Task.Delay(3000, token);

            if (!await EnsureLoggedInAsync(account, driver, onProgress, token))
            {
                return VideoUploadResult.Fail("Tài khoản chưa đăng nhập được.");
            }

            onProgress("Đang mở trang upload TikTok...");
            driver.Navigate().GoToUrl("https://www.tiktok.com/upload?lang=en");
            await Task.Delay(3500, token);

            SwitchToUploadFrameIfPresent(driver);
            await DismissUploadPopupsAsync(driver, token);

            var fileInput = await WaitForElementAsync(driver, new[]
            {
                By.CssSelector("[aria-live*='polite'] input[type='file']"),
                By.CssSelector("[class*='uploader'] input[type='file']"),
                By.CssSelector("input[type='file']")
            }, TimeSpan.FromSeconds(30), token, requireDisplayed: false);

            if (fileInput == null)
            {
                return VideoUploadResult.Fail("Không tìm thấy ô chọn file trên trang upload.");
            }

            onProgress($"Đang gửi file: {Path.GetFileName(video.Path)}");
            fileInput.SendKeys(video.Path);
            await Task.Delay(1500, token);
            await DismissUploadPopupsAsync(driver, token);

            bool uploaded = await WaitForUploadCompletedAsync(driver, TimeSpan.FromSeconds(config.UploadTimeoutSeconds), onProgress, token);
            if (!uploaded)
            {
                return VideoUploadResult.Fail("Hết thời gian chờ TikTok upload/xử lý video.");
            }

            await DismissUploadPopupsAsync(driver, token);

            string caption = BuildCaption(video, config);
            if (!string.IsNullOrWhiteSpace(caption))
            {
                onProgress("Đang nhập mô tả video...");
                await FillCaptionAsync(driver, caption, token);
            }

            if (config.Tags.Count > 0 && config.MaxTags > 0)
            {
                onProgress("Đang tag tài khoản trong caption...");
                await AddMentionTagsAsync(driver, config.Tags, config.MaxTags, token);
            }

            if (config.SetPublicVisibility)
            {
                onProgress("Đang chọn quyền xem Public...");
                await SelectPublicVisibilityAsync(driver, token);
            }

            await DismissUploadPopupsAsync(driver, token);

            if (config.AttachProducts)
            {
                var product = video.Product!;
                token.ThrowIfCancellationRequested();
                onProgress($"Đang gắn sản phẩm {product.Id} cho {Path.GetFileName(video.Path)}...");
                string? error = await AttachProductAsync(driver, product, token);
                if (error != null)
                    return VideoUploadResult.Fail($"Gắn sản phẩm {product.Id} thất bại: {error} Video chưa được đăng.");
                onProgress($"Đã gắn sản phẩm {product.Id}.");
            }

            token.ThrowIfCancellationRequested();
            var postButton = await WaitForElementAsync(driver, new[]
            {
                By.CssSelector("button[data-e2e='post_video_button']"),
                By.CssSelector("[class*='form'] button[class*='TUXButton--primary']"),
                By.CssSelector("[class*='form'] [class*='btn-post'] button"),
                By.CssSelector("div[class*='btn-post'] button"),
                By.XPath("//button[contains(., 'Post') or contains(., 'Đăng')]")
            }, TimeSpan.FromSeconds(25), token);

            if (postButton == null)
            {
                return VideoUploadResult.Fail("Không tìm thấy nút đăng video.");
            }

            onProgress("Đang bấm đăng video...");
            NaturalClick(driver, postButton);
            await Task.Delay(2500, token);
            if (await DismissUploadPopupsAsync(driver, token))
            {
                onProgress("Đã xử lý popup xác nhận đăng video.");
            }

            await WaitForPostProcessingAsync(driver, config.PostWaitSeconds, onProgress, token);
            string? newUrl = await TryFindNewestVideoUrlAsync(driver, account, config.PostWaitSeconds, token);
            if (!string.IsNullOrWhiteSpace(newUrl))
            {
                onProgress($"Đã lấy link video mới: {newUrl}");
                return VideoUploadResult.Ok("Upload video thành công.", newUrl);
            }

            return VideoUploadResult.Ok("Đã bấm đăng video, nhưng chưa lấy được link video mới.");
        }
        catch (OperationCanceledException)
        {
            onProgress("Đã dừng upload.");
            return VideoUploadResult.Fail("Đã dừng upload.");
        }
        catch (Exception ex)
        {
            onProgress($"Lỗi upload video: {ex.Message}");
            return VideoUploadResult.Fail(ex.Message);
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

    private async Task<bool> EnsureLoggedInAsync(Account account, IWebDriver driver, Action<string> onProgress, CancellationToken token)
    {
        if (TikTokLoginService.CheckIfLoggedIn(driver))
        {
            return true;
        }

        onProgress("Tài khoản chưa đăng nhập, đang login lại...");
        var loginResult = await _loginService.LoginAsync(account, driver, msg => onProgress($"Login: {msg}"), token);
        if (!loginResult.Success)
        {
            onProgress($"Login thất bại: {loginResult.Message}");
            return false;
        }

        await Task.Delay(1000, token);
        return true;
    }

    private static string BuildCaption(VideoUploadItem video, VideoUploadConfig config)
    {
        var parts = new List<string>();
        string source = config.UseVideoDescription && !string.IsNullOrWhiteSpace(video.Description)
            ? video.Description
            : config.Captions.FirstOrDefault(c => !string.IsNullOrWhiteSpace(c)) ?? string.Empty;

        if (!string.IsNullOrWhiteSpace(source))
        {
            parts.Add(SpinTextHelper.Resolve(source.Trim()));
        }

        foreach (var hashtag in config.Hashtags.Where(h => !string.IsNullOrWhiteSpace(h)))
        {
            string clean = hashtag.Trim().TrimStart('#');
            if (!string.IsNullOrWhiteSpace(clean))
            {
                parts.Add("#" + clean);
            }
        }

        return string.Join(" ", parts);
    }

    private static void SwitchToUploadFrameIfPresent(IWebDriver driver)
    {
        try
        {
            driver.SwitchTo().DefaultContent();
            var frame = driver.FindElements(By.CssSelector("iframe[src*='https://www.tiktok.com/creator#/upload'], iframe[src*='/creator#/upload']")).FirstOrDefault();
            if (frame != null)
            {
                driver.SwitchTo().Frame(frame);
            }
        }
        catch
        {
            try { driver.SwitchTo().DefaultContent(); } catch { }
        }
    }

    private static async Task<bool> DismissUploadPopupsAsync(IWebDriver driver, CancellationToken token)
    {
        bool clicked = false;
        try
        {
            if (driver is IJavaScriptExecutor js)
            {
                const string script = @"
                    const dialogs = Array.from(document.querySelectorAll(""[role='dialog'], [class*='modal'], [class*='Modal'], [id*='portal'] [class*='container']""));
                    const clickButton = (dlg, matcher) => {
                        const buttons = Array.from(dlg.querySelectorAll('button'));
                        const button = buttons.find(b => matcher((b.innerText || b.textContent || '').trim(), b));
                        if (button) {
                            button.click();
                            return true;
                        }
                        return false;
                    };

                    for (const dlg of dialogs) {
                        const text = (dlg.innerText || dlg.textContent || '').toLowerCase();

                        if (text.includes('continue to post') && text.includes('checking your video')) {
                            if (clickButton(dlg, label => /post now/i.test(label))) return 'continue-post';
                        }

                        if (text.includes('local draft') || text.includes('bản nháp') || text.includes('draft')) {
                            const ghost = dlg.querySelector(""[data-type='ghost'], button[class*='secondary']"");
                            if (ghost) {
                                ghost.click();
                                return 'local-draft';
                            }
                        }

                        if (text.includes('automatic content check') || text.includes('content checks') || text.includes('copyright check') || text.includes('kiểm tra nội dung')) {
                            if (clickButton(dlg, label => /turn on|bật|allow|accept|cho phép/i.test(label))) return 'content-check';
                            if (clickButton(dlg, label => /not now|cancel|hủy|để sau/i.test(label))) return 'content-check-skip';
                        }

                        if (text.includes('got it') || text.includes('đã hiểu') || text.includes('biết rồi') || text.includes('agree')) {
                            if (clickButton(dlg, label => /got it|đã hiểu|biết rồi|agree|ok/i.test(label))) return 'got-it';
                        }
                    }

                    return null;
                ";

                if (js.ExecuteScript(script) is string)
                {
                    await Task.Delay(1000, token);
                    clicked = true;
                }
            }

            var continuePostButton = FindVisible(driver, By.XPath(
                "//*[contains(., 'Continue to post') and contains(., 'checking your video')]" +
                "//button[contains(., 'Post now') or contains(., 'Đăng ngay')]"));
            if (continuePostButton != null)
            {
                NaturalClick(driver, continuePostButton);
                await Task.Delay(1000, token);
                clicked = true;
            }

            var draft = FindVisible(driver, By.CssSelector("[data-e2e='local_draft_container'] [data-type='ghost']"));
            if (draft != null)
            {
                NaturalClick(driver, draft);
                await Task.Delay(1200, token);
                clicked = true;
            }

            var dialogButton = FindVisible(driver, By.CssSelector("[role='dialog'] button[class*='primary'], [id*='portal-container'] [role='dialog'] [class*='footer'] button"));
            if (dialogButton != null)
            {
                NaturalClick(driver, dialogButton);
                await Task.Delay(1200, token);
                clicked = true;
            }

            return clicked;
        }
        catch
        {
            return clicked;
        }
    }

    private static async Task<bool> WaitForUploadCompletedAsync(IWebDriver driver, TimeSpan timeout, Action<string> onProgress, CancellationToken token)
    {
        DateTime deadline = DateTime.Now.Add(timeout);
        int lastNotice = -1;

        while (DateTime.Now < deadline && !token.IsCancellationRequested)
        {
            await DismissUploadPopupsAsync(driver, token);

            if (Exists(driver, By.XPath("//*[contains(@class,'info-progress-num') and normalize-space()='100%'] | //*[@alt='Uploaded'] | //*[contains(text(), 'Uploaded') or contains(text(), 'Đã tải lên')]"))
                || Exists(driver, By.CssSelector("div[data-e2e*='upload_status_container'] button[class*='root--loading-false'][aria-disabled='false']"))
                || Exists(driver, By.CssSelector("button[data-e2e='post_video_button']:not([disabled])"))
                || Exists(driver, By.XPath("//button[(contains(., 'Post') or contains(., 'Đăng')) and not(@disabled)]")))
            {
                return true;
            }

            string? progress = TryGetUploadProgress(driver);
            int remaining = Math.Max(0, (int)(deadline - DateTime.Now).TotalSeconds);
            if (remaining / 10 != lastNotice)
            {
                lastNotice = remaining / 10;
                onProgress(!string.IsNullOrWhiteSpace(progress)
                    ? $"Đang chờ upload: {progress}"
                    : $"Đang chờ upload/xử lý video, còn khoảng {remaining}s...");
            }

            await Task.Delay(1000, token);
        }

        return false;
    }

    private static string? TryGetUploadProgress(IWebDriver driver)
    {
        try
        {
            var progress = driver.FindElements(By.CssSelector("[class*='info-progress-num'], [class*='progress']")).FirstOrDefault(e =>
            {
                try { return e.Displayed && !string.IsNullOrWhiteSpace(e.Text); }
                catch { return false; }
            });
            return progress?.Text.Trim();
        }
        catch
        {
            return null;
        }
    }

    private static async Task FillCaptionAsync(IWebDriver driver, string caption, CancellationToken token)
    {
        var captionBox = await WaitForElementAsync(driver, new[]
        {
            By.CssSelector("[data-e2e='caption_container'] [contenteditable]"),
            By.CssSelector("[role='textbox'] [data-contents='true']"),
            By.CssSelector("[role='combobox'] [data-contents='true']"),
            By.CssSelector("[contenteditable='true']")
        }, TimeSpan.FromSeconds(20), token);

        if (captionBox == null)
        {
            return;
        }

        ScrollIntoView(driver, captionBox);
        NaturalClick(driver, captionBox);
        await Task.Delay(300, token);
        captionBox.SendKeys(SeleniumKeys.Control + "a");
        captionBox.SendKeys(SeleniumKeys.Backspace);
        await Task.Delay(200, token);
        captionBox.SendKeys(caption);
        await Task.Delay(800, token);
    }

    private static async Task AddMentionTagsAsync(IWebDriver driver, List<string> tags, int maxTags, CancellationToken token)
    {
        var captionBox = FindVisible(driver, By.CssSelector("[data-e2e='caption_container'] [contenteditable], [contenteditable='true']"));
        if (captionBox == null)
        {
            return;
        }

        int added = 0;
        foreach (var rawTag in tags.Where(t => !string.IsNullOrWhiteSpace(t)).Take(maxTags))
        {
            string tag = rawTag.Trim().TrimStart('@');
            if (string.IsNullOrWhiteSpace(tag))
            {
                continue;
            }

            NaturalClick(driver, captionBox);
            captionBox.SendKeys(" @" + tag);
            await Task.Delay(1500, token);

            var suggestion = FindVisible(driver, By.XPath("//*[contains(@class,'mention-suggestion-item')]//*[contains(@class,'user-id')]/ancestor::*[contains(@class,'mention-suggestion-item')]"));
            if (suggestion != null)
            {
                NaturalClick(driver, suggestion);
                await Task.Delay(700, token);
            }

            added++;
            if (added >= maxTags)
            {
                break;
            }
        }
    }

    private static async Task SelectPublicVisibilityAsync(IWebDriver driver, CancellationToken token)
    {
        var visibilityButton = FindVisible(driver, By.CssSelector("[data-e2e='video_visibility_container'] button, [data-e2e='video_visibility_container'] [role='combobox']"));
        if (visibilityButton == null)
        {
            return;
        }

        NaturalClick(driver, visibilityButton);
        await Task.Delay(800, token);

        var publicOption = FindVisible(driver, By.XPath(
            "//*[@role='listbox']//*[self::li or @role='option'][contains(., 'Public') or contains(., 'Everyone') or contains(., 'Công khai') or contains(., 'Mọi người')]"));
        if (publicOption != null)
        {
            NaturalClick(driver, publicOption);
            await Task.Delay(500, token);
        }
    }

    private static async Task WaitForPostProcessingAsync(IWebDriver driver, int waitSeconds, Action<string> onProgress, CancellationToken token)
    {
        DateTime deadline = DateTime.Now.AddSeconds(Math.Max(5, waitSeconds));
        while (DateTime.Now < deadline && !token.IsCancellationRequested)
        {
            await DismissUploadPopupsAsync(driver, token);

            if (Exists(driver, By.XPath("//*[contains(., 'Your videos are being uploaded to TikTok') or contains(., 'Your videos are being posted to TikTok') or contains(., 'You can manage your posts or upload another video') or contains(., 'Video của bạn đã được tải lên') or contains(., 'Tải video khác lên')]")))
            {
                return;
            }

            onProgress("Đang chờ TikTok xác nhận đăng video...");
            await Task.Delay(2500, token);
        }
    }

    private static async Task<string?> TryFindNewestVideoUrlAsync(IWebDriver driver, Account account, int waitSeconds, CancellationToken token)
    {
        string? username = NormalizeUsername(account.Uid) ?? NormalizeUsername(account.Username);
        if (string.IsNullOrWhiteSpace(username))
        {
            return null;
        }

        DateTime deadline = DateTime.Now.AddSeconds(Math.Max(10, waitSeconds));
        while (DateTime.Now < deadline && !token.IsCancellationRequested)
        {
            try
            {
                driver.SwitchTo().DefaultContent();
                driver.Navigate().GoToUrl($"https://www.tiktok.com/@{username}");
                await Task.Delay(3500, token);

                var href = driver.FindElements(By.CssSelector("a[href*='/video/']")).Select(e =>
                {
                    try { return e.GetAttribute("href"); }
                    catch { return null; }
                }).FirstOrDefault(h => !string.IsNullOrWhiteSpace(h));

                if (!string.IsNullOrWhiteSpace(href))
                {
                    return href;
                }
            }
            catch
            {
            }

            await Task.Delay(3000, token);
        }

        return null;
    }

    private static string? NormalizeUsername(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string text = value.Trim();
        if (text.Contains("tiktok.com", StringComparison.OrdinalIgnoreCase))
        {
            var match = Regex.Match(text, @"@([^/?#\s]+)");
            return match.Success ? match.Groups[1].Value : null;
        }

        return text.TrimStart('@');
    }

    private static async Task<IWebElement?> WaitForElementAsync(IWebDriver driver, IEnumerable<By> selectors, TimeSpan timeout, CancellationToken token, bool requireDisplayed = true)
    {
        DateTime deadline = DateTime.Now.Add(timeout);
        while (DateTime.Now < deadline && !token.IsCancellationRequested)
        {
            foreach (var selector in selectors)
            {
                IWebElement? element = requireDisplayed ? FindVisible(driver, selector) : FindPresent(driver, selector);
                if (element != null)
                {
                    return element;
                }
            }

            await Task.Delay(500, token);
        }

        return null;
    }

    private static IWebElement? FindPresent(IWebDriver driver, By by)
    {
        try
        {
            return driver.FindElements(by).FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    private static IWebElement? FindVisible(IWebDriver driver, By by)
    {
        try
        {
            return driver.FindElements(by).FirstOrDefault(e =>
            {
                try { return e.Displayed && e.Enabled; }
                catch { return false; }
            });
        }
        catch
        {
            return null;
        }
    }

    private static bool Exists(IWebDriver driver, By by)
    {
        return FindVisible(driver, by) != null;
    }

    private static void NaturalClick(IWebDriver driver, IWebElement element)
    {
        try
        {
            ScrollIntoView(driver, element);
            var actions = new Actions(driver);
            actions.MoveToElement(element, 5, 5).Pause(TimeSpan.FromMilliseconds(_random.Next(120, 260))).Click().Perform();
        }
        catch
        {
            try { element.Click(); } catch { }
        }
    }

    private static void ScrollIntoView(IWebDriver driver, IWebElement element)
    {
        try
        {
            ((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].scrollIntoView({block:'center', inline:'center'});", element);
        }
        catch
        {
        }
    }
}
