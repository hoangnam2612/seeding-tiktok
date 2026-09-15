using System;

namespace MyTikTokTool.Models;

public class Proxy
{
    public int Id { get; set; }
    public string Host { get; set; } = string.Empty;
    public int Port { get; set; }
    public string? Username { get; set; }
    public string? Password { get; set; }
    public string Type { get; set; } = "HTTP";
    public string Status { get; set; } = "Chưa kiểm tra";
    public string? Note { get; set; }
    public DateTime? LastCheckedAt { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.Now;

    public string DisplayValue
    {
        get
        {
            string proxy = $"{Host}:{Port}";
            if (!string.IsNullOrWhiteSpace(Username) || !string.IsNullOrWhiteSpace(Password))
            {
                proxy += $":{Username ?? string.Empty}:{Password ?? string.Empty}";
            }

            return proxy;
        }
    }
}
