using System;

namespace MyTikTokTool.Models;

public class Account
{
    public int Id { get; set; }
    public string? Uid { get; set; }
    public string? Username { get; set; }
    public string? Name { get; set; }
    public string? Password { get; set; }
    public string? TwoFA { get; set; }
    public string? Cookies { get; set; }
    public string? Token { get; set; }
    public string? Email { get; set; }
    public string? Passmail { get; set; }
    public string? RecoveryMail { get; set; }
    public string? Proxy { get; set; }
    public string? UserAgent { get; set; }
    public string? Status { get; set; } = "Chưa chạy";
    public string? Message { get; set; }
    public string? Note { get; set; }
    public string? Avatar { get; set; }
    public string? Bio { get; set; }
    public string? FollowerCount { get; set; } = "0";
    public string? FollowingCount { get; set; } = "0";
    public string? LikesCount { get; set; } = "0";
    public string? LastAction { get; set; }
    public DateTime? LastTimeAction { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    public int CategoryId { get; set; }
    public virtual Category? Category { get; set; }
}
