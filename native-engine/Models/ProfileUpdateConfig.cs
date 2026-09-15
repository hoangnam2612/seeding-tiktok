using System;
using System.Collections.Generic;

namespace MyTikTokTool.Models;

public class ProfileUpdateConfig
{
    // 1. Avatar
    public bool IsChangeAvatar { get; set; } = false;
    public string AvatarFolder { get; set; } = string.Empty;
    public List<string> AvatarFiles { get; set; } = new();

    // 2. Name (Nickname)
    public bool IsChangeName { get; set; } = false;
    public List<string> Names { get; set; } = new();

    // 3. Username (TikTok ID)
    public bool IsChangeUsername { get; set; } = false;
    public List<string> Usernames { get; set; } = new();
    public bool AppendRandomNumber { get; set; } = true;
    public int MinRandomNumber { get; set; } = 1000;
    public int MaxRandomNumber { get; set; } = 9999;

    // 4. Bio
    public bool IsChangeBio { get; set; } = false;
    public List<string> Bios { get; set; } = new();

    // 5. Execution settings
    public int ThreadCount { get; set; } = 2;
    public int MinDelaySeconds { get; set; } = 2;
    public int MaxDelaySeconds { get; set; } = 5;
    public bool AvoidDuplicateContent { get; set; } = false;
}
