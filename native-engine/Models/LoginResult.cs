namespace MyTikTokTool.Models;

public class LoginResult
{
    public bool Success { get; set; }
    public string Status { get; set; } = "Chưa chạy";
    public string Message { get; set; } = string.Empty;
    public string? ExtractedCookies { get; set; }
    public string? ExtractedUsername { get; set; }

    public static LoginResult Ok(string message, string? cookies = null, string? username = null) => new()
    {
        Success = true,
        Status = "Live",
        Message = message,
        ExtractedCookies = cookies,
        ExtractedUsername = username
    };

    public static LoginResult Fail(string status, string message) => new()
    {
        Success = false,
        Status = status,
        Message = message
    };
}
