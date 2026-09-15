using System;
using System.Collections.Generic;

namespace MyTikTokTool.Models;

public class SeedingLiveConfig
{
    public List<string> LiveUrls { get; set; } = new();
    public int MinWatchMinutes { get; set; } = 1;
    public int MaxWatchMinutes { get; set; } = 3;
    public bool IsSendHearts { get; set; } = true;
    public int HeartClicksPerRound { get; set; } = 15;
    public bool IsCommentLive { get; set; } = true;
    public List<string> LiveComments { get; set; } = new();
    public int CommentIntervalSeconds { get; set; } = 15;
    public bool IsFollowHost { get; set; } = false;
    public int ThreadCount { get; set; } = 2;
}
