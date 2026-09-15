using System.Diagnostics;
using MyTikTokTool.Models;
using OpenQA.Selenium;
using SeleniumKeys = OpenQA.Selenium.Keys;

namespace MyTikTokTool.Services;

public partial class TikTokUploadVideoService
{
    // Ported from TikPro's AddLinkProduct flow, using this app's Selenium session.
    private const string AnchorSelector = "[class*='anchor-tag-container'], [data-e2e='anchor_container']";
    private const string ProductSearchSelector = "[class*='product-selector-container'] input[class*='TUXTextInputCore-input']";
    private const string ProductFooterSelector = "[class*='common-modal-footer'] button[class*='TUXButton--primary'], [class*='anchor-modal'] button[class*='TUXButton--primary']";

    private static async Task<string?> AttachProductAsync(IWebDriver driver, VideoProduct product, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        // IDs are validated again here because this service can be called outside the UI.
        if (string.IsNullOrWhiteSpace(product.Id) || product.Id.Any(c => c < '0' || c > '9'))
            return "ID sản phẩm phải là số.";

        string before = ReadAnchorText(driver);
        var add = await WaitForElementAsync(driver, new[]
        {
            By.CssSelector("[class*='anchor-tag-container'] [class*='add-more-btn'], [class*='anchor-tag-container'] [class*='add-first-btn'], [data-e2e='anchor_container'] button[data-type='neutral']")
        }, TimeSpan.FromSeconds(15), token);
        if (add == null)
            return "Không tìm thấy nút thêm sản phẩm. Tài khoản có thể chưa được bật tính năng hoặc giao diện TikTok đã thay đổi.";
        add.Click();

        // TikPro opens the product type dialog, then switches to the product ID tab.
        var timer = Stopwatch.StartNew();
        IWebElement? search = null;
        bool typeConfirmed = false;
        bool tabSelected = false;
        while (timer.Elapsed < TimeSpan.FromSeconds(30))
        {
            token.ThrowIfCancellationRequested();
            search = FindVisible(driver, By.CssSelector(ProductSearchSelector));
            if (search != null) break;
            var tab = FindVisible(driver, By.CssSelector("[aria-orientation='horizontal'] [id='2'] button"));
            if (tab != null && !tabSelected)
            {
                tab.Click();
                tabSelected = true;
            }
            else if (!typeConfirmed && FindVisible(driver, By.CssSelector("[class*='product-selector-container']")) == null)
            {
                var next = FindVisible(driver, By.CssSelector("[role='dialog'] button[class*='TUXButton--primary']"));
                if (next != null && next.GetAttribute("aria-disabled") != "true")
                {
                    next.Click();
                    typeConfirmed = true;
                }
            }
            await Task.Delay(500, token);
        }
        if (search == null) return "Không mở được ô tìm sản phẩm.";
        search.SendKeys(SeleniumKeys.Control + "a");
        search.SendKeys(SeleniumKeys.Backspace);
        search.SendKeys(product.Id);
        search.SendKeys(SeleniumKeys.Enter);

        var row = await WaitForElementAsync(driver, new[]
        {
            By.XPath($"//*[contains(@class,'product-selector-container')]//tr[.//*[normalize-space(text())='{product.Id}']]")
        }, TimeSpan.FromSeconds(25), token);
        if (row == null) return "Không tìm thấy sản phẩm theo ID trong danh sách của tài khoản.";
        var choice = row.FindElements(By.CssSelector("input[type='radio'], input[type='checkbox'], [role='radio'], [role='checkbox']")).FirstOrDefault();
        if (choice == null || !choice.Enabled || choice.GetAttribute("aria-disabled") == "true")
            return "Sản phẩm không thể chọn hoặc không đủ điều kiện gắn vào video.";
        if (!IsProductSelected(choice))
        {
            // TikTok can visually hide the input behind a styled radio control.
            ((IJavaScriptExecutor)driver).ExecuteScript("arguments[0].click();", choice);
        }
        if (!IsProductSelected(choice)) return "TikTok chưa xác nhận chọn sản phẩm.";

        if (!await ClickProductNextAsync(driver, token)) return "Không tìm thấy nút xác nhận sản phẩm.";

        timer.Restart();
        bool nameFilled = false;
        while (timer.Elapsed < TimeSpan.FromSeconds(20))
        {
            token.ThrowIfCancellationRequested();
            var error = FindVisible(driver, By.CssSelector("[class*='anchor-modal'] [class*='TUXFormField-error'], [role='dialog'] [class*='TUXFormField-error']"));
            if (error != null) return $"TikTok báo lỗi: {error.Text}";

            var name = FindVisible(driver, By.CssSelector("input[class*='TUXTextInputCore-input'][aria-describedby*='_description']"));
            if (name != null && !nameFilled)
            {
                if (!string.IsNullOrWhiteSpace(product.DisplayName))
                {
                    name.SendKeys(SeleniumKeys.Control + "a");
                    name.SendKeys(SeleniumKeys.Backspace);
                    name.SendKeys(product.DisplayName);
                }
                nameFilled = true;
                if (!await ClickProductNextAsync(driver, token)) return "Không xác nhận được tên hiển thị sản phẩm.";
                await Task.Delay(500, token);
                continue;
            }

            // A click alone is not success: the editor must close and the anchor summary must change.
            bool editorOpen = FindVisible(driver, By.CssSelector(ProductSearchSelector)) != null
                || FindVisible(driver, By.CssSelector("input[aria-describedby*='_description']")) != null
                || FindVisible(driver, By.CssSelector(ProductFooterSelector)) != null;
            string after = ReadAnchorText(driver);
            if (!editorOpen && !string.IsNullOrWhiteSpace(after) && after != before)
                return null;
            await Task.Delay(500, token);
        }
        return "Chưa xác nhận được sản phẩm đã xuất hiện trên video sau khi thêm.";
    }

    private static bool IsProductSelected(IWebElement element) =>
        element.Selected || element.GetAttribute("aria-checked") == "true";

    private static string ReadAnchorText(IWebDriver driver) =>
        string.Join("\n", driver.FindElements(By.CssSelector(AnchorSelector)).Where(e => e.Displayed).Select(e => e.Text.Trim()));

    private static async Task<bool> ClickProductNextAsync(IWebDriver driver, CancellationToken token)
    {
        var timer = Stopwatch.StartNew();
        while (timer.Elapsed < TimeSpan.FromSeconds(10))
        {
            token.ThrowIfCancellationRequested();
            var button = FindVisible(driver, By.CssSelector(ProductFooterSelector));
            if (button != null && button.GetAttribute("aria-disabled") != "true")
            {
                button.Click();
                return true;
            }
            await Task.Delay(300, token);
        }
        return false;
    }
}
