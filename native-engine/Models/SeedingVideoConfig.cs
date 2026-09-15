using System;
using System.Collections.Generic;

namespace MyTikTokTool.Models;

public class SeedingVideoConfig
{
    public List<string> VideoUrls { get; set; } = new();
    public int MinViewSeconds { get; set; } = 5;
    public int MaxViewSeconds { get; set; } = 15;
    public bool IsLike { get; set; } = true;
    public bool IsComment { get; set; } = true;
    public List<string> Comments { get; set; } = new();
    public bool IsFollow { get; set; } = false;
    public bool IsFavorite { get; set; } = false;
    public int ThreadCount { get; set; } = 2;
    public int MinDelaySeconds { get; set; } = 3;
    public int MaxDelaySeconds { get; set; } = 6;
}
