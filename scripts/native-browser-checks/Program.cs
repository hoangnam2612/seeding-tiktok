using MyTikTokTool.Models;
using MyTikTokTool.Services;
using System.Text.Json;

var root = Path.GetFullPath(Path.Combine("tmp", "native-browser-checks", DateTime.UtcNow.Ticks.ToString()));
Directory.CreateDirectory(root); Environment.SetEnvironmentVariable("TIKTOK_ENGINE_DATA", root); Directory.SetCurrentDirectory(root);
BrowserLayoutManager.Config = new BrowserConfig { Columns = 2, Rows = 1, ScaleFactor = .65, WindowWidth = 700, WindowHeight = 600 };
try {
    var first = ChromeService.OpenSeleniumChrome(new Account { Id = 90001, Uid = "fixture-one" }, "about:blank");
    var second = ChromeService.OpenSeleniumChrome(new Account { Id = 90002, Uid = "fixture-two" }, "about:blank");
    var expected = BrowserLayoutManager.CalculateSize();
    if (first.Manage().Window.Size.Width != expected.X || second.Manage().Window.Size.Height != expected.Y) throw new Exception("Window dimensions mismatch.");
    var position = BrowserLayoutManager.CalculatePosition(1, expected);
    if (second.Manage().Window.Position != position) throw new Exception("Window position mismatch.");
    ChromeService.CloseAccountChrome(90001);
    if (second.Url != "about:blank") throw new Exception("Closing one account affected another.");
    File.WriteAllText(Path.Combine(root, "result.json"), JsonSerializer.Serialize(new { success = true, checks = new[] { "actual Selenium Chrome launch", "two profiles", "window bounds", "close isolation" } }));
    Console.WriteLine("PASS C# Selenium opens two isolated Chrome windows, applies bounds, and keeps second window alive after closing first.");
} finally { ChromeService.CloseAllChrome(); }
