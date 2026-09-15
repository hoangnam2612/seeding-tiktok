using System;
using System.Collections.Concurrent;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;
using MyTikTokTool.Models;

namespace MyTikTokTool.Services;

public static class BrowserLayoutManager
{
    private static readonly ConcurrentDictionary<int, int> _accountSlotMap = new(); // AccountId -> SlotIndex
    private static readonly object _lock = new();

    public static BrowserConfig Config { get; set; } = BrowserConfig.Load();

    /// <summary>
    /// Cấp phát vị trí slot trống (0, 1, 2, 3...) cho tài khoản
    /// </summary>
    public static int AllocateSlot(int accountId)
    {
        lock (_lock)
        {
            if (_accountSlotMap.TryGetValue(accountId, out int existingSlot))
            {
                return existingSlot;
            }

            var usedSlots = _accountSlotMap.Values.ToHashSet();
            int slot = 0;
            while (usedSlots.Contains(slot))
            {
                slot++;
            }

            _accountSlotMap[accountId] = slot;
            return slot;
        }
    }

    /// <summary>
    /// Giải phóng vị trí slot khi cửa sổ Chrome đóng
    /// </summary>
    public static void ReleaseSlot(int accountId)
    {
        lock (_lock)
        {
            _accountSlotMap.TryRemove(accountId, out _);
        }
    }

    /// <summary>
    /// Tính toán kích thước (Width, Height) của từng cửa sổ Chrome theo tỷ lệ màn hình
    /// </summary>
    public static Point CalculateSize()
    {
        var screenArea = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);

        int cols = Math.Max(1, Config.Columns);
        int width = Config.WindowWidth > 0 
            ? Config.WindowWidth 
            : screenArea.Width / cols;

        int height = Config.WindowHeight > 0 
            ? Config.WindowHeight 
            : width * 16 / 9;

        if (width < 600) width = 600;
        if (height > 700) height = 700;

        return new Point(width, height);
    }

    /// <summary>
    /// Tính toán tọa độ (X, Y) hiển thị của cửa sổ Chrome theo vị trí slot dạng lưới
    /// </summary>
    public static Point CalculatePosition(int slotIndex, Point windowSize)
    {
        var screenArea = Screen.PrimaryScreen?.WorkingArea ?? new Rectangle(0, 0, 1920, 1080);
        int cols = Math.Max(1, Config.Columns);
        int rows = Math.Max(1, Config.Rows);

        int totalGridSlots = cols * rows;
        int normalizedSlot = slotIndex % totalGridSlots;

        int colIndex = normalizedSlot % cols;
        int rowIndex = normalizedSlot / cols;

        int posX = screenArea.Left + (colIndex * windowSize.X);
        int posY = screenArea.Top + (rowIndex * windowSize.Y);

        return new Point(posX, posY);
    }
}
