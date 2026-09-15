using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MyTikTokTool.Services;

public sealed class OutlookMailService
{
    private const string Authority = "https://login.microsoftonline.com/consumers/oauth2/v2.0/";
    private const string Scope = "https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/User.Read offline_access";
    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(25) };
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> Locks = new();
    private static string Root => Path.Combine(Environment.GetEnvironmentVariable("TIKTOK_ENGINE_DATA") ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "outlook");
    // Public application identifier owned by the software publisher, shared by all customers.
    public const string ClientId = "8550482d-40af-4c22-8996-aebd9c59b88a";

    public static bool Supports(string? email) => email != null && Regex.IsMatch(email.Trim(), @"^[^@\s]+@(hotmail|outlook|live|msn)\.[a-z.]+$", RegexOptions.IgnoreCase);
    private static string TokenPath(string email, string clientId) => Path.Combine(Root,
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(clientId + "|" + email.Trim().ToLowerInvariant()))) + ".dat");
    public static bool IsConnected(string email) => Load(email, ClientId) != null;

    private sealed record MailToken(string AccessToken, string RefreshToken, DateTimeOffset ExpiresAt);
    private static MailToken? Load(string email, string clientId)
    {
        try
        {
            var path = TokenPath(email, clientId);
            return File.Exists(path) ? JsonSerializer.Deserialize<MailToken>(ProtectedData.Unprotect(File.ReadAllBytes(path), null, DataProtectionScope.CurrentUser)) : null;
        }
        catch (Exception ex) when (ex is IOException or CryptographicException or JsonException) { return null; }
    }
    private static void Save(string email, string clientId, MailToken token)
    {
        Directory.CreateDirectory(Root);
        var path = TokenPath(email, clientId);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllBytes(temporary, ProtectedData.Protect(JsonSerializer.SerializeToUtf8Bytes(token), null, DataProtectionScope.CurrentUser));
            File.Move(temporary, path, true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    private static MailToken ParseToken(JsonNode json, string refresh = "") => new(
        json["access_token"]?.GetValue<string>() ?? throw new InvalidOperationException("Microsoft không trả về access token."),
        json["refresh_token"]?.GetValue<string>() ?? refresh,
        DateTimeOffset.UtcNow.AddSeconds(json["expires_in"]?.GetValue<int>() ?? 3600));

    private static async Task<JsonNode> PostAsync(string endpoint, Dictionary<string, string> fields, CancellationToken token)
    {
        using var content = new FormUrlEncodedContent(fields);
        using var response = await Http.PostAsync(Authority + endpoint, content, token);
        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(token)) ?? throw new InvalidOperationException("Phản hồi Microsoft trống.");
        if (!response.IsSuccessStatusCode && json["error"] == null)
            throw new InvalidOperationException($"Microsoft không phản hồi thành công ({(int)response.StatusCode}).");
        return json;
    }

    // The callback displays Microsoft's device code locally, never in account logs.
    public async Task ConnectAsync(string email, Action<string> showDeviceCode, CancellationToken token,
        Func<CancellationToken, Task>? browserStep = null, Action<string, string>? openVerification = null)
    {
        if (!Supports(email)) throw new InvalidOperationException("Chức năng này hỗ trợ Hotmail/Outlook cá nhân.");
        string clientId = ClientId;
        var gate = Locks.GetOrAdd(clientId + email.ToLowerInvariant(), _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(token);
        try
        {
            var device = await PostAsync("devicecode", new() { ["client_id"] = clientId, ["scope"] = Scope }, token);
            if (device["error"] != null) throw new InvalidOperationException("Microsoft chưa cho phép kết nối Outlook. Hãy liên hệ người quản lý phần mềm để kiểm tra cấu hình ứng dụng.");
            string userCode = device["user_code"]!.GetValue<string>();
            string verificationUri = device["verification_uri"]?.GetValue<string>() ?? throw new InvalidOperationException("Microsoft không trả địa chỉ xác minh.");
            if (!IsVerificationUri(verificationUri)) throw new InvalidOperationException("Địa chỉ xác minh Microsoft không hợp lệ.");
            if (string.IsNullOrWhiteSpace(userCode)) throw new InvalidOperationException("Microsoft không trả mã kết nối.");
            int interval = Math.Max(5, device["interval"]?.GetValue<int>() ?? 5);
            using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
            deadline.CancelAfter(TimeSpan.FromSeconds(device["expires_in"]?.GetValue<int>() ?? 900));
            if (openVerification != null) openVerification(userCode, verificationUri);
            else showDeviceCode(userCode);
            while (true)
            {
                if (browserStep != null) await browserStep(deadline.Token);
                await Task.Delay(TimeSpan.FromSeconds(interval), deadline.Token);
                var result = await PostAsync("token", new() {
                    ["client_id"] = clientId, ["device_code"] = device["device_code"]!.GetValue<string>(),
                    ["grant_type"] = "urn:ietf:params:oauth:grant-type:device_code"
                }, deadline.Token);
                string? error = result["error"]?.GetValue<string>();
                if (error == "authorization_pending") continue;
                if (error == "slow_down") { interval += 5; continue; }
                if (error != null) throw new InvalidOperationException("Cấp quyền Outlook bị từ chối hoặc hết hạn. Hãy kết nối lại.");
                var credentials = ParseToken(result);
                using var request = new HttpRequestMessage(HttpMethod.Get, "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,otherMails");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credentials.AccessToken);
                using var response = await Http.SendAsync(request, deadline.Token);
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException("Không xác minh được tài khoản Outlook đã cấp quyền.");
                var profile = JsonNode.Parse(await response.Content.ReadAsStringAsync(deadline.Token))!;
                var addresses = new List<string?> { profile["mail"]?.ToString(), profile["userPrincipalName"]?.ToString() };
                if (profile["otherMails"] is JsonArray aliases) addresses.AddRange(aliases.Select(a => a?.ToString()));
                if (!addresses.Any(a => string.Equals(a, email.Trim(), StringComparison.OrdinalIgnoreCase)))
                    throw new InvalidOperationException("Bạn đã cấp quyền cho email khác. Đăng nhập đúng email của tài khoản đã chọn (hoặc dùng địa chỉ chính của hộp thư).");
                Save(email, clientId, credentials);
                return;
            }
        }
        finally { gate.Release(); }
    }

    private static async Task<string> AccessTokenAsync(string email, CancellationToken token, bool forceRefresh = false)
    {
        var clientId = ClientId;
        var gate = Locks.GetOrAdd(clientId + email.ToLowerInvariant(), _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(token);
        try
        {
            var saved = Load(email, clientId) ?? throw new InvalidOperationException("Chưa kết nối Outlook. Chuột phải tài khoản → Kết nối Outlook.");
            if (!forceRefresh && saved.ExpiresAt > DateTimeOffset.UtcNow.AddMinutes(2)) return saved.AccessToken;
            var result = await PostAsync("token", new() { ["client_id"] = clientId, ["refresh_token"] = saved.RefreshToken, ["grant_type"] = "refresh_token", ["scope"] = Scope }, token);
            if (result["error"]?.ToString() is "invalid_grant" or "interaction_required" or "consent_required")
                throw new ReconnectRequiredException();
            if (result["error"] != null) throw new InvalidOperationException("Microsoft không làm mới được kết nối Outlook. Hãy thử lại hoặc liên hệ người quản lý phần mềm.");
            saved = ParseToken(result, saved.RefreshToken);
            Save(email, clientId, saved);
            return saved.AccessToken;
        }
        finally { gate.Release(); }
    }

    public static bool IsVerificationUri(string url) => Uri.TryCreate(url, UriKind.Absolute, out var uri)
        && uri.Scheme == "https" && uri.IsDefaultPort && string.IsNullOrEmpty(uri.UserInfo)
        && (uri.Host.Equals("microsoft.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("www.microsoft.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("login.microsoftonline.com", StringComparison.OrdinalIgnoreCase)
            || uri.Host.Equals("login.live.com", StringComparison.OrdinalIgnoreCase));

    public sealed class ReconnectRequiredException : InvalidOperationException
    {
        public ReconnectRequiredException() : base("Outlook yêu cầu đăng nhập và kết nối lại.") { }
    }

    public async Task<bool> TryRefreshConnectionAsync(string email, CancellationToken token)
    {
        if (!IsConnected(email)) return false;
        try { await AccessTokenAsync(email, token, forceRefresh: true); return true; }
        catch (ReconnectRequiredException) { return false; }
    }

    public async Task<string> WaitForCodeAsync(string email, DateTimeOffset requestedAt, CancellationToken token = default)
    {
        if (!Supports(email)) throw new InvalidOperationException("Email OTP hiện hỗ trợ Hotmail/Outlook cá nhân.");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(token);
        timeout.CancelAfter(TimeSpan.FromSeconds(120));
        var ct = timeout.Token;
        try
        {
            var accessToken = await AccessTokenAsync(email, ct);
            bool refreshed = false;
            string date = requestedAt.UtcDateTime.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture);
            string url = "https://graph.microsoft.com/v1.0/me/messages?$top=50&$orderby=receivedDateTime%20desc&$filter=" +
                Uri.EscapeDataString("receivedDateTime ge " + date + " and from/emailAddress/address eq 'noreply@account.tiktok.com'") +
                "&$select=id,from,toRecipients,receivedDateTime,subject,body";
            while (true)
            {
                ct.ThrowIfCancellationRequested();
                using var request = new HttpRequestMessage(HttpMethod.Get, url);
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
                using var response = await Http.SendAsync(request, ct);
                if (response.StatusCode == HttpStatusCode.Unauthorized && !refreshed)
                {
                    accessToken = await AccessTokenAsync(email, ct, true);
                    refreshed = true;
                    continue;
                }
                if ((int)response.StatusCode == 429 || (int)response.StatusCode >= 500)
                {
                    var retry = response.Headers.RetryAfter?.Delta ?? (response.Headers.RetryAfter?.Date - DateTimeOffset.UtcNow) ?? TimeSpan.FromSeconds(8);
                    await Task.Delay(retry > TimeSpan.Zero ? retry : TimeSpan.FromSeconds(8), ct);
                    continue;
                }
                if (!response.IsSuccessStatusCode) throw new InvalidOperationException($"Không đọc được Outlook ({(int)response.StatusCode}). Kiểm tra quyền Mail.Read hoặc kết nối lại.");
                var json = JsonNode.Parse(await response.Content.ReadAsStringAsync(ct));
                if (json?["value"] is JsonArray messages)
                {
                    foreach (var message in messages)
                    {
                        var code = ExtractCode(message!, email, requestedAt);
                        if (code != null) return code;
                    }
                }
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
            }
        }
        catch (OperationCanceledException) when (!token.IsCancellationRequested)
        { throw new TimeoutException("Hết 120 giây chờ mã email mới. Kiểm tra hộp thư và yêu cầu gửi lại mã trên TikTok."); }
    }

    public static string? ExtractCode(JsonNode message, string email, DateTimeOffset requestedAt)
    {
        if (!string.Equals(message["from"]?["emailAddress"]?["address"]?.ToString(), "noreply@account.tiktok.com", StringComparison.OrdinalIgnoreCase)) return null;
        if (!DateTimeOffset.TryParse(message["receivedDateTime"]?.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var received) || received < requestedAt || received > DateTimeOffset.UtcNow.AddMinutes(1)) return null;
        if (message["toRecipients"] is not JsonArray recipients || !recipients.Any(r => string.Equals(r?["emailAddress"]?["address"]?.ToString(), email.Trim(), StringComparison.OrdinalIgnoreCase))) return null;
        string body = message["body"]?["content"]?.ToString() ?? "";
        body = Regex.Replace(body, @"<(script|style)\b[^>]*>.*?</\1>", " ", RegexOptions.IgnoreCase | RegexOptions.Singleline);
        body = WebUtility.HtmlDecode(Regex.Replace(body, "<[^>]+>", " "));
        string text = message["subject"] + " " + body;
        if (!Regex.IsMatch(text, @"code|verification|verify|mã|xác minh", RegexOptions.IgnoreCase)) return null;
        var codes = Regex.Matches(text, @"(?<![\d])\d{6}(?![\d])").Select(m => m.Value).Distinct().ToList();
        return codes.Count == 1 ? codes[0] : null;
    }
}
