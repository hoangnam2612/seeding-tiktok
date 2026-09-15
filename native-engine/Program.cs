using System.Collections.Concurrent;
using System.Text.Json;
using MyTikTokTool.Models;
using MyTikTokTool.Services;

internal static class Program
{
    static Program() { } // Capture stdout before Main redirects service diagnostics.
    static readonly JsonSerializerOptions Json = new() { PropertyNameCaseInsensitive = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    static readonly TextWriter Wire = Console.Out;
    static readonly object OutputLock = new();
    static CancellationTokenSource? RunCancellation;
    static Task? Running;
    static void Send(object value) { lock (OutputLock) { Wire.WriteLine(JsonSerializer.Serialize(value, Json)); Wire.Flush(); } }
    static T Read<T>(JsonElement value) => value.Deserialize<T>(Json) ?? throw new Exception("Dữ liệu trống.");
    static void Event(string accountId, string type, string? message = null, bool? success = null, string? file = null, string? url = null, string? code = null) => Send(new { kind = "event", value = new { accountId, type, message, success, file, url, code } });

    public static async Task Main()
    {
        Console.SetOut(Console.Error); // Reserve stdout exclusively for the IPC protocol.
        var root = Environment.GetEnvironmentVariable("TIKTOK_ENGINE_DATA") ?? throw new Exception("Missing engine data directory.");
        Directory.CreateDirectory(root); Directory.SetCurrentDirectory(root);
        try {
            string? line;
            while ((line = await Console.In.ReadLineAsync()) != null) {
                string? id = null;
                try {
                    using var document = JsonDocument.Parse(line); var request = document.RootElement.Clone();
                    id = request.GetProperty("id").GetString(); var action = request.GetProperty("action").GetString();
                    if (action == "hello") Send(new { id, result = new { engine = "csharp", protocol = 1, commands = new[] { "login", "video", "live", "profile", "upload", "outlook" } } });
                    else if (action == "run") {
                        if (Running is { IsCompleted: false }) throw new Exception("Một tác vụ đang chạy.");
                        RunCancellation?.Dispose(); RunCancellation = new();
                        var replyId = id; var token = RunCancellation.Token;
                        Running = Task.Run(async () => { try { Send(new { id = replyId, result = await Run(request.GetProperty("payload"), token) }); } catch (Exception e) { Send(new { id = replyId, error = e.Message }); } });
                    } else if (action == "cancel") {
                        RunCancellation?.Cancel(); await Task.Run(ChromeService.CloseAllChrome);
                        Send(new { id, result = new { success = true } });
                    } else if (action == "close") {
                        if (Running is { IsCompleted: false }) throw new Exception("Một tác vụ đang chạy.");
                        var ids = request.GetProperty("payload").GetProperty("ids");
                        if (ids.GetArrayLength() == 0) await Task.Run(ChromeService.CloseAllChrome);
                        else foreach (var accountId in ids.EnumerateArray()) await Task.Run(() => ChromeService.CloseAccountChrome(accountId.GetInt32()));
                        Send(new { id, result = new { success = true } });
                    } else throw new Exception("Lệnh engine không hợp lệ.");
                } catch (Exception e) { Send(new { id, error = e.Message }); }
            }
        } finally { RunCancellation?.Cancel(); ChromeService.CloseAllChrome(); if (Running != null) await Task.WhenAny(Running, Task.Delay(5000)); }
    }

    static async Task<object> Run(JsonElement payload, CancellationToken token)
    {
        var command = payload.GetProperty("command").GetString()!;
        if (!new[] { "login", "video", "live", "profile", "upload", "outlook" }.Contains(command)) throw new Exception("Tác vụ không được hỗ trợ.");
        var settings = Read<BrowserConfig>(payload.GetProperty("settings"));
        if (settings.MaxThreads < 1 || settings.MaxThreads > 32) throw new Exception("Số luồng không hợp lệ.");
        BrowserLayoutManager.Config = settings;
        var config = payload.GetProperty("config");
        var accounts = payload.GetProperty("accounts").EnumerateArray().Select(item => (external: item.GetProperty("externalId").GetString()!, account: Read<Account>(item))).ToArray();
        if (accounts.Any(a => a.account.Id <= 0) || accounts.Select(a => a.account.Id).Distinct().Count() != accounts.Length) throw new Exception("ID tài khoản không hợp lệ.");
        var uploadConfig = command == "upload" ? Read<VideoUploadConfig>(config) : null;
        var queue = new ConcurrentQueue<VideoUploadItem>(uploadConfig?.CreateUploadQueue() ?? new());
        var profileConfig = command == "profile" ? Read<ProfileUpdateConfig>(config) : null;
        var accountService = new AccountService();
        var externalIds = accounts.ToDictionary(a => a.account.Id, a => a.external);
        accountService.Updated = account => Send(new { kind = "account", accountId = externalIds[account.Id], value = account });
        int failures = 0;
        try {
            await Parallel.ForEachAsync(accounts, new ParallelOptions { MaxDegreeOfParallelism = settings.MaxThreads, CancellationToken = token }, async (entry, cancellation) => {
                var account = entry.account;
                void Log(string message) => Event(entry.external, "progress", message);
                void Result(bool success, string message, string? file = null, string? url = null) {
                    if (!success) Interlocked.Increment(ref failures);
                    account.Message = message; account.LastAction = command; account.LastTimeAction = DateTime.Now;
                    accountService.UpdateAccount(account); Event(entry.external, "item", message, success, file, url);
                }
                try {
                    switch (command) {
                        case "login": var login = await new TikTokLoginService(accountService).LoginAsync(account, onProgress: Log, token: cancellation); Result(login.Success, login.Message); break;
                        case "video": var video = await new TikTokSeedingService(accountService).RunVideoSeedingAsync(account, Read<SeedingVideoConfig>(config), Log, cancellation); Result(video, video ? "Đã xử lý video." : "Seeding video chưa hoàn tất."); break;
                        case "live": var live = await new TikTokSeedingService(accountService).RunLiveSeedingAsync(account, Read<SeedingLiveConfig>(config), Log, cancellation); Result(live, live ? "Đã xử lý livestream." : "Livestream chưa hoàn tất."); break;
                        case "profile": var profile = await new TikTokProfileService(accountService).UpdateProfileAsync(account, profileConfig!, Log, cancellation); Result(profile, profile ? "Đã cập nhật hồ sơ." : "Cập nhật hồ sơ chưa hoàn tất."); break;
                        case "outlook": await new OutlookMailService().ConnectAsync(account.Email ?? "", code => Event(entry.external, "device-code", code: code), cancellation); Result(true, "Đã kết nối Outlook."); break;
                        case "upload":
                            var uploader = new TikTokUploadVideoService(accountService);
                            while (!cancellation.IsCancellationRequested && queue.TryDequeue(out var item)) {
                                var result = await uploader.UploadOneVideoAsync(account, item, uploadConfig!, Log, cancellation);
                                Result(result.Success, result.Message, item.Path, result.NewVideoUrl); if (!result.Success) break;
                            }
                            break;
                    }
                } catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { Log("Đã dừng tác vụ."); }
                catch (Exception e) { if (!cancellation.IsCancellationRequested) Result(false, e.Message); }
                finally { if (command != "login" || cancellation.IsCancellationRequested) ChromeService.CloseAccountChrome(account.Id); }
            });
        } catch (OperationCanceledException) when (token.IsCancellationRequested) { }
        return new { success = !token.IsCancellationRequested && failures == 0 && queue.IsEmpty, canceled = token.IsCancellationRequested, failures, remaining = queue.Count, message = token.IsCancellationRequested ? "Đã dừng tác vụ." : "Đã kết thúc tác vụ C#." };
    }
}
