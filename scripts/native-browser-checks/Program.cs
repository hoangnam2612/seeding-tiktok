using MyTikTokTool.Models;
using MyTikTokTool.Services;
using System.Text.Json;
using System.Management;

List<(int id, int parent, string name, string command)> Snapshot() {
    using var query = new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process");
    return query.Get().Cast<ManagementObject>().Select(p => (Convert.ToInt32(p["ProcessId"]), Convert.ToInt32(p["ParentProcessId"]), p["Name"]?.ToString() ?? "", p["CommandLine"]?.ToString() ?? "")).ToList();
}

var root = Path.GetFullPath(Path.Combine("tmp", "native-browser-checks", DateTime.UtcNow.Ticks.ToString()));
Directory.CreateDirectory(root); Environment.SetEnvironmentVariable("TIKTOK_ENGINE_DATA", root); Directory.SetCurrentDirectory(root);
BrowserLayoutManager.Config = new BrowserConfig { Columns = 2, Rows = 1, ScaleFactor = .65, WindowWidth = 700, WindowHeight = 600 };
var tracked = new HashSet<int>();
try {
    var first = ChromeService.OpenSeleniumChrome(new Account { Id = 90001, Uid = "fixture-one" }, "about:blank");
    var second = ChromeService.OpenSeleniumChrome(new Account { Id = 90002, Uid = "fixture-two" }, "about:blank");
    var opened = Snapshot(); tracked.Add(Environment.ProcessId);
    bool changed; do { changed = false; foreach (var process in opened) if (tracked.Contains(process.parent)) changed |= tracked.Add(process.id); } while (changed);
    tracked.Remove(Environment.ProcessId);
    var expected = BrowserLayoutManager.CalculateSize();
    if (first.Manage().Window.Size.Width != expected.X || second.Manage().Window.Size.Height != expected.Y) throw new Exception("Window dimensions mismatch.");
    var position = BrowserLayoutManager.CalculatePosition(1, expected);
    if (second.Manage().Window.Position != position) throw new Exception("Window position mismatch.");
    ChromeService.CloseAccountChrome(90001);
    if (second.Url != "about:blank") throw new Exception("Closing one account affected another.");
    File.WriteAllText(Path.Combine(root, "result.json"), JsonSerializer.Serialize(new { success = true, checks = new[] { "actual Selenium Chrome launch", "two profiles", "window bounds", "close isolation" } }));
    Console.WriteLine("PASS C# Selenium opens two isolated Chrome windows, applies bounds, and keeps second window alive after closing first.");
} finally { ChromeService.CloseAllChrome(); }
var deadline = DateTime.UtcNow.AddSeconds(10);
List<int> remaining;
do {
    remaining = Snapshot().Where(p => tracked.Contains(p.id) || (p.name.Equals("chrome.exe", StringComparison.OrdinalIgnoreCase) && p.command.Contains(root, StringComparison.OrdinalIgnoreCase))).Select(p => p.id).ToList();
    if (remaining.Count == 0) break;
    await Task.Delay(250);
} while (DateTime.UtcNow < deadline);
File.WriteAllText(Path.Combine(root, "cleanup.json"), JsonSerializer.Serialize(new { success = remaining.Count == 0, trackedCount = tracked.Count, remaining }));
if (remaining.Count != 0) throw new Exception("Residual test process IDs: " + string.Join(",", remaining));
Console.WriteLine($"PASS cleanup: all {tracked.Count} tracked Chrome/driver descendant processes exited; no test profile process remains.");
