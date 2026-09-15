using System.Collections.Generic;

namespace MyTikTokTool.Models;

public class VideoUploadItem
{
    public string Title { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public string Path { get; set; } = string.Empty;
    public string Size { get; set; } = string.Empty;
    public VideoProduct? Product { get; init; }
}

public class VideoUploadConfig
{
    public bool AttachProducts { get; set; }
    public List<VideoProduct> Products { get; set; } = new();
    public List<VideoUploadItem> Videos { get; set; } = new();
    public List<string> Captions { get; set; } = new();
    public List<string> Hashtags { get; set; } = new();
    public List<string> Tags { get; set; } = new();
    public bool UseVideoDescription { get; set; } = true;
    public bool SetPublicVisibility { get; set; } = true;
    public int MaxTags { get; set; } = 3;
    public int UploadTimeoutSeconds { get; set; } = 180;
    public int PostWaitSeconds { get; set; } = 30;
    public int MinDelaySeconds { get; set; } = 5;
    public int MaxDelaySeconds { get; set; } = 10;
    public int ThreadCount { get; set; } = 1;

    public List<VideoUploadItem> CreateUploadQueue()
    {
        if (AttachProducts && Products.Count != Videos.Count)
            throw new System.FormatException($"Có {Videos.Count} video nhưng có {Products.Count} dòng sản phẩm. Cần đúng 1 dòng sản phẩm cho mỗi video, theo cùng thứ tự.");

        return System.Linq.Enumerable.Select(Videos, (video, index) => new VideoUploadItem
        {
            Title = video.Title, Description = video.Description, Path = video.Path, Size = video.Size,
            Product = AttachProducts ? new VideoProduct { Id = Products[index].Id, DisplayName = Products[index].DisplayName } : null
        }).ToList();
    }
}

public class VideoProduct
{
    public string Id { get; set; } = string.Empty;
    public string DisplayName { get; set; } = string.Empty;

    public static List<VideoProduct> ParseLines(IEnumerable<string> lines)
    {
        var products = new List<VideoProduct>();
        foreach (var line in lines)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            var parts = line.Split('|', 2);
            string id = parts[0].Trim();
            if (id.Length == 0 || System.Linq.Enumerable.Any(id, c => c < '0' || c > '9'))
                throw new System.FormatException($"ID sản phẩm không hợp lệ: {id}. Nhập ID dạng số, không nhập URL.");
            products.Add(new VideoProduct { Id = id, DisplayName = parts.Length > 1 ? parts[1].Trim() : string.Empty });
        }
        return products;
    }
}

public class VideoUploadResult
{
    public bool Success { get; set; }
    public string Message { get; set; } = string.Empty;
    public string? NewVideoUrl { get; set; }

    public static VideoUploadResult Ok(string message, string? newVideoUrl = null)
    {
        return new VideoUploadResult { Success = true, Message = message, NewVideoUrl = newVideoUrl };
    }

    public static VideoUploadResult Fail(string message)
    {
        return new VideoUploadResult { Success = false, Message = message };
    }
}
