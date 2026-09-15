using System;
using System.IO;
using System.Windows.Forms;
using Newtonsoft.Json;

namespace MyTikTokTool.Models;

public class BrowserConfig
{
    public int Columns { get; set; } = 4;
    public int Rows { get; set; } = 2;
    public double ScaleFactor { get; set; } = 0.65;
    public double LivePageZoom { get; set; } = 0.80;
    public int MaxThreads { get; set; } = 4;
    public bool AutoArrangeGrid { get; set; } = true;
    public bool DisableImages { get; set; } = false;
    public bool DisableAudio { get; set; } = true;
    public int WindowWidth { get; set; } = 0; // 0 = Tự động tính theo màn hình
    public int WindowHeight { get; set; } = 0; // 0 = Tự động tính theo màn hình

    private static string ConfigPath => Path.Combine((Environment.GetEnvironmentVariable("TIKTOK_ENGINE_DATA") ?? Application.StartupPath), "settings", "browser_config.json");

    public static BrowserConfig Load()
    {
        try
        {
            if (File.Exists(ConfigPath))
            {
                string json = File.ReadAllText(ConfigPath);
                var config = JsonConvert.DeserializeObject<BrowserConfig>(json);
                if (config != null) return config;
            }
        }
        catch { }

        var defaultConfig = new BrowserConfig();
        defaultConfig.Save();
        return defaultConfig;
    }

    public void Save()
    {
        try
        {
            string dir = Path.GetDirectoryName(ConfigPath)!;
            if (!Directory.Exists(dir))
            {
                Directory.CreateDirectory(dir);
            }
            string json = JsonConvert.SerializeObject(this, Formatting.Indented);
            File.WriteAllText(ConfigPath, json);
        }
        catch { }
    }
}
