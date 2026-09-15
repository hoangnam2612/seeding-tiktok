namespace MyTikTokTool.Models;

public sealed class AuthSession
{
    public string AccessToken { get; set; } = string.Empty;
    public string RefreshToken { get; set; } = string.Empty;
    public string AppCode { get; set; } = string.Empty;
    public string? Username { get; set; }
    public string? Email { get; set; }
    public DateTimeOffset? ExpiresAt { get; set; }
    /// <summary>
    /// TikTok Tool is a duration-based product. The server remains authoritative;
    /// this is evaluated only from its most recent login/me response.
    /// </summary>
    public bool HasActiveEntitlement => ExpiresAt is { } expiresAt && expiresAt > DateTimeOffset.UtcNow;
}
