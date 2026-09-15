using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Forms;
using MyTikTokTool.Models;
using OpenQA.Selenium;
using OpenQA.Selenium.Chrome;
using OpenQA.Selenium.Chromium;
using SeleniumUndetectedChromeDriver;

namespace MyTikTokTool.Services;

public class ChromeService
{
    private static readonly ConcurrentDictionary<int, IWebDriver> _activeDrivers = new();
    private static readonly ConcurrentDictionary<int, Process> _activeProcesses = new();
    private static readonly ConcurrentDictionary<int, string> _activeProfilePaths = new();
    private static readonly SemaphoreSlim _driverInstallerLock = new(1, 1);
    private static string? _cachedChromeDriverPath;

    public static string DefaultProfilesFolder => Path.Combine((Environment.GetEnvironmentVariable("TIKTOK_ENGINE_DATA") ?? Application.StartupPath), "ChromeProfiles");

    static ChromeService()
    {
        ChromeDriverPatcher.PatchAllDrivers();
    }

    public static string? GetInstalledChromePath()
    {
        string[] commonPaths = new[]
        {
            @"C:\Program Files\Google\Chrome\Application\chrome.exe",
            @"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Google\Chrome\Application\chrome.exe")
        };

        foreach (var path in commonPaths)
        {
            if (File.Exists(path)) return path;
        }

        return null;
    }

    private static string GetChromeDriverExecutablePath()
    {
        _driverInstallerLock.Wait();
        try
        {
            if (!string.IsNullOrWhiteSpace(_cachedChromeDriverPath) && File.Exists(_cachedChromeDriverPath))
            {
                return _cachedChromeDriverPath;
            }

            _cachedChromeDriverPath = new ChromeDriverInstaller().Auto().GetAwaiter().GetResult();
            return _cachedChromeDriverPath;
        }
        finally
        {
            _driverInstallerLock.Release();
        }
    }

    public static string GetAccountProfilePath(Account account)
    {
        if (!Directory.Exists(DefaultProfilesFolder))
        {
            Directory.CreateDirectory(DefaultProfilesFolder);
        }

        string profileLabel = !string.IsNullOrWhiteSpace(account.Uid)
            ? account.Uid
            : (!string.IsNullOrWhiteSpace(account.Username) ? account.Username : "no_uid");
        string folderName = $"account_{account.Id}_{SanitizeFolderName(profileLabel)}";

        string profilePath = Path.Combine(DefaultProfilesFolder, folderName);
        string legacyFolderName = !string.IsNullOrWhiteSpace(account.Uid)
            ? SanitizeFolderName(account.Uid)
            : $"account_{account.Id}";
        string legacyProfilePath = Path.Combine(DefaultProfilesFolder, legacyFolderName);

        if (!Directory.Exists(profilePath)
            && Directory.Exists(legacyProfilePath)
            && !profilePath.Equals(legacyProfilePath, StringComparison.OrdinalIgnoreCase))
        {
            try
            {
                Directory.Move(legacyProfilePath, profilePath);
            }
            catch { }
        }

        if (!Directory.Exists(profilePath))
        {
            Directory.CreateDirectory(profilePath);
        }

        return profilePath;
    }

    /// <summary>
    /// Mở Chrome kết hợp LocalProxyBridge (Tự động nạp Auth ngầm, đổi IP 100%, 0 popup, Trust xanh lá)
    /// </summary>
    public static IWebDriver OpenSeleniumChrome(Account account, string startUrl = "https://www.tiktok.com", bool isMobileView = false)
    {
        CloseAccountChrome(account.Id);

        string profilePath = GetAccountProfilePath(account);
        _activeProfilePaths[account.Id] = profilePath;
        var config = BrowserLayoutManager.Config;

        int slot = BrowserLayoutManager.AllocateSlot(account.Id);
        Point windowSize = BrowserLayoutManager.CalculateSize();
        Point windowPos = BrowserLayoutManager.CalculatePosition(slot, windowSize);

        string? chromePath = GetInstalledChromePath();
        if (string.IsNullOrEmpty(chromePath))
        {
            throw new FileNotFoundException("Không tìm thấy Google Chrome trên máy tính của bạn!");
        }

        var chromeArgs = new List<string>
        {
            "--profile-directory=Default",
            $"--window-size={windowSize.X},{windowSize.Y}",
            $"--window-position={windowPos.X},{windowPos.Y}",
            "--no-first-run",
            "--no-default-browser-check",
            "--disable-session-crashed-bubble",
            "--restore-last-session=false",
            "--disable-popup-blocking",
            "--password-store=basic",
            "--lang=vi-VN,vi,en-US,en",
            "--force-webrtc-ip-handling-policy=default_public_interface_only",
            "--disable-save-password-bubble"
        };

        if (config.DisableAudio)
        {
            chromeArgs.Add("--mute-audio");
        }

        if (config.DisableImages)
        {
            chromeArgs.Add("--blink-settings=imagesEnabled=false");
        }

        if (Math.Abs(config.ScaleFactor - 1.0) > 0.01)
        {
            chromeArgs.Add($"--force-device-scale-factor={Math.Clamp(config.ScaleFactor, 0.5, 1.0):0.##}");
        }

        // Xử lý nạp Proxy qua LocalProxyBridge khi có User/Pass, hoặc qua CLI khi không có User/Pass
        if (!string.IsNullOrWhiteSpace(account.Proxy))
        {
            string[] proxyParts = account.Proxy.Trim().Split(':');
            if (proxyParts.Length >= 4)
            {
                int bridgePort = LocalProxyBridge.GetOrCreateBridge(account.Id, account.Proxy);
                chromeArgs.Add($"--proxy-server=http://127.0.0.1:{bridgePort}");
            }
            else if (proxyParts.Length >= 2)
            {
                chromeArgs.Add($"--proxy-server=http://{proxyParts[0]}:{proxyParts[1]}");
            }
        }

        if (!string.IsNullOrWhiteSpace(account.UserAgent))
        {
            chromeArgs.Add($"--user-agent={account.UserAgent.Trim()}");
        }
        else if (isMobileView)
        {
            chromeArgs.Add("--user-agent=Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1");
        }

        var options = new ChromeOptions
        {
            PageLoadStrategy = PageLoadStrategy.Eager
        };

        options.AddUserProfilePreference("credentials_enable_service", false);
        options.AddUserProfilePreference("profile.password_manager_enabled", false);
        options.AddUserProfilePreference("profile.password_manager_leak_detection", false);

        foreach (var arg in chromeArgs)
        {
            options.AddArgument(arg);
        }

        string driverPath = GetChromeDriverExecutablePath();
        IWebDriver driver = UndetectedChromeDriver.Create(
            driverExecutablePath: driverPath,
            browserExecutablePath: chromePath,
            options: options,
            userDataDir: profilePath,
            hideCommandPromptWindow: true,
            commandTimeout: TimeSpan.FromSeconds(60));
        _activeDrivers[account.Id] = driver;
        ApplyWindowBounds(driver, windowPos, windowSize);

        if (!string.IsNullOrEmpty(startUrl))
        {
            driver.Navigate().GoToUrl(startUrl);
        }

        // Nạp cookie nếu có
        if (!string.IsNullOrWhiteSpace(account.Cookies))
        {
            InjectCookies(driver, account.Cookies, ".tiktok.com");
        }

        StartChromeCloseWatcher(account.Id, driver, profilePath);

        return driver;
    }

    private static void ApplyWindowBounds(IWebDriver driver, Point position, Point size)
    {
        try
        {
            driver.Manage().Window.Position = position;
            driver.Manage().Window.Size = new Size(size.X, size.Y);
        }
        catch { }
    }

    private static int FindFreePort()
    {
        using var socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
        socket.Bind(new IPEndPoint(IPAddress.Loopback, 0));
        return ((IPEndPoint)socket.LocalEndPoint!).Port;
    }

    public static bool IsChromeRunning(int accountId)
    {
        if (_activeDrivers.TryGetValue(accountId, out var driver))
        {
            try
            {
                _ = driver.Title;
                return true;
            }
            catch
            {
                CleanupExternallyClosedChrome(accountId, driver);
            }
        }

        if (_activeProcesses.TryGetValue(accountId, out var process))
        {
            try
            {
                if (!process.HasExited) return true;
            }
            catch
            {
            }
            CleanupExternallyClosedChrome(accountId, null);
        }

        return false;
    }

    private static void StartChromeCloseWatcher(int accountId, IWebDriver driver, string profilePath)
    {
        Task.Run(async () =>
        {
            await Task.Delay(2000);

            while (_activeDrivers.TryGetValue(accountId, out var activeDriver)
                && ReferenceEquals(activeDriver, driver))
            {
                if (!HasChromeProcessForProfile(profilePath))
                {
                    CleanupExternallyClosedChrome(accountId, driver);
                    return;
                }

                await Task.Delay(2000);
            }
        });
    }

    private static bool HasChromeProcessForProfile(string profilePath)
    {
        string normalizedProfilePath = NormalizePathForCommandLine(profilePath);
        foreach (var processInfo in GetProcessInfos("chrome.exe"))
        {
            string commandLine = NormalizePathForCommandLine(processInfo.CommandLine);
            if (commandLine.Contains(normalizedProfilePath, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static void CleanupExternallyClosedChrome(int accountId, IWebDriver? knownDriver)
    {
        _activeProfilePaths.TryRemove(accountId, out var profilePath);
        BrowserLayoutManager.ReleaseSlot(accountId);
        LocalProxyBridge.StopBridge(accountId);

        if (_activeDrivers.TryRemove(accountId, out var driver))
        {
            try
            {
                driver.Quit();
            }
            catch { }

            try
            {
                driver.Dispose();
            }
            catch { }
        }
        else if (knownDriver != null)
        {
            try
            {
                knownDriver.Dispose();
            }
            catch { }
        }

        if (_activeProcesses.TryRemove(accountId, out var process))
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
                process.Dispose();
            }
            catch { }
        }

        if (!string.IsNullOrWhiteSpace(profilePath))
        {
            KillChromeProcessesByProfilePath(profilePath);
        }

        // Only close tracked account profiles; do not scan unrelated orphan drivers.
    }

    public static void CloseAccountChrome(int accountId)
    {
        _activeProfilePaths.TryRemove(accountId, out var profilePath);
        BrowserLayoutManager.ReleaseSlot(accountId);
        LocalProxyBridge.StopBridge(accountId);

        if (_activeDrivers.TryRemove(accountId, out var driver))
        {
            try
            {
                driver.Quit();
                driver.Dispose();
            }
            catch { }
        }

        if (_activeProcesses.TryRemove(accountId, out var process))
        {
            try
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                }
                process.Dispose();
            }
            catch { }
        }

        if (!string.IsNullOrWhiteSpace(profilePath))
        {
            KillChromeProcessesByProfilePath(profilePath);
        }

        // Other accounts may still be running in parallel.
        // Only close tracked account profiles; do not scan unrelated orphan drivers.
    }

    public static void CloseAllChrome()
    {
        var profilePaths = _activeProfilePaths.Values.ToList();

        foreach (var accountId in _activeDrivers.Keys)
        {
            CloseAccountChrome(accountId);
        }

        foreach (var accountId in _activeProcesses.Keys)
        {
            CloseAccountChrome(accountId);
        }

        foreach (var profilePath in profilePaths)
        {
            KillChromeProcessesByProfilePath(profilePath);
        }

        KillChromeProcessesByProfilePath(DefaultProfilesFolder);
        KillChildChromeDriverProcesses(Process.GetCurrentProcess().Id);
        // Only close tracked account profiles; do not scan unrelated orphan drivers.
    }

    private static void KillChromeProcessesByProfilePath(string profilePath)
    {
        string normalizedProfilePath = NormalizePathForCommandLine(profilePath);
        foreach (var processInfo in GetProcessInfos("chrome.exe"))
        {
            string commandLine = NormalizePathForCommandLine(processInfo.CommandLine);
            if (!commandLine.Contains(normalizedProfilePath, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            KillProcessTree(processInfo.ProcessId);
        }
    }

    private static void KillChildChromeDriverProcesses(int parentProcessId)
    {
        foreach (var processInfo in GetProcessInfos("chromedriver.exe"))
        {
            if (IsDescendantProcess(processInfo.ProcessId, parentProcessId))
            {
                KillProcessTree(processInfo.ProcessId);
            }
        }
    }

    private static void KillOrphanSeleniumChromeDrivers()
    {
        foreach (var processInfo in GetProcessInfos("chromedriver.exe"))
        {
            string commandLine = NormalizePathForCommandLine(processInfo.CommandLine);
            bool isSeleniumCacheDriver = commandLine.Contains(NormalizePathForCommandLine(@"\.cache\selenium\chromedriver\"), StringComparison.OrdinalIgnoreCase);
            bool isCachedDriver = !string.IsNullOrWhiteSpace(_cachedChromeDriverPath)
                && commandLine.Contains(NormalizePathForCommandLine(_cachedChromeDriverPath), StringComparison.OrdinalIgnoreCase);

            if ((isSeleniumCacheDriver || isCachedDriver) && !IsProcessRunning(processInfo.ParentProcessId))
            {
                KillProcessTree(processInfo.ProcessId);
            }
        }
    }

    private static bool IsDescendantProcess(int processId, int ancestorProcessId)
    {
        int currentProcessId = processId;
        var visited = new HashSet<int>();

        while (visited.Add(currentProcessId))
        {
            var processInfo = GetProcessInfo(currentProcessId);
            if (processInfo == null)
            {
                return false;
            }

            if (processInfo.ParentProcessId == ancestorProcessId)
            {
                return true;
            }

            currentProcessId = processInfo.ParentProcessId;
        }

        return false;
    }

    private static void KillProcessTree(int processId)
    {
        try
        {
            foreach (var child in GetChildProcessInfos(processId))
            {
                KillProcessTree(child.ProcessId);
            }

            var process = Process.GetProcessById(processId);
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
                process.WaitForExit(3000);
            }
            process.Dispose();
        }
        catch { }
    }

    private static bool IsProcessRunning(int processId)
    {
        try
        {
            var process = Process.GetProcessById(processId);
            bool isRunning = !process.HasExited;
            process.Dispose();
            return isRunning;
        }
        catch
        {
            return false;
        }
    }

    private static ProcessInfo? GetProcessInfo(int processId)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher($"SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process WHERE ProcessId = {processId}");
            return searcher.Get()
                .Cast<ManagementObject>()
                .Select(ProcessInfo.FromManagementObject)
                .FirstOrDefault();
        }
        catch
        {
            return null;
        }
    }

    private static List<ProcessInfo> GetChildProcessInfos(int parentProcessId)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher($"SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process WHERE ParentProcessId = {parentProcessId}");
            return searcher.Get()
                .Cast<ManagementObject>()
                .Select(ProcessInfo.FromManagementObject)
                .ToList();
        }
        catch
        {
            return new List<ProcessInfo>();
        }
    }

    private static List<ProcessInfo> GetProcessInfos(string processName)
    {
        try
        {
            using var searcher = new ManagementObjectSearcher($"SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process WHERE Name = '{processName}'");
            return searcher.Get()
                .Cast<ManagementObject>()
                .Select(ProcessInfo.FromManagementObject)
                .ToList();
        }
        catch
        {
            return new List<ProcessInfo>();
        }
    }

    private static string NormalizePathForCommandLine(string? value)
    {
        return (value ?? string.Empty).Replace('/', '\\').Trim('"');
    }

    private sealed class ProcessInfo
    {
        public int ProcessId { get; init; }
        public int ParentProcessId { get; init; }
        public string CommandLine { get; init; } = string.Empty;

        public static ProcessInfo FromManagementObject(ManagementObject obj)
        {
            return new ProcessInfo
            {
                ProcessId = Convert.ToInt32(obj["ProcessId"] ?? 0),
                ParentProcessId = Convert.ToInt32(obj["ParentProcessId"] ?? 0),
                CommandLine = obj["CommandLine"]?.ToString() ?? string.Empty
            };
        }
    }

    public static void InjectCookies(IWebDriver driver, string rawCookies, string domain)
    {
        try
        {
            string[] pairs = rawCookies.Split(';');
            foreach (var pair in pairs)
            {
                string item = pair.Trim();
                if (string.IsNullOrEmpty(item)) continue;

                int equalIndex = item.IndexOf('=');
                if (equalIndex > 0)
                {
                    string name = item.Substring(0, equalIndex).Trim();
                    string value = item.Substring(equalIndex + 1).Trim();

                    try
                    {
                        var cookie = new OpenQA.Selenium.Cookie(name, value, domain, "/", DateTime.Now.AddYears(1));
                        driver.Manage().Cookies.AddCookie(cookie);
                    }
                    catch { }
                }
            }
        }
        catch { }
    }

    private static string SanitizeFolderName(string name)
    {
        foreach (char c in Path.GetInvalidFileNameChars())
        {
            name = name.Replace(c, '_');
        }
        return name;
    }
}
