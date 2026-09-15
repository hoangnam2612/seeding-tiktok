using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Windows.Forms;

namespace MyTikTokTool.Services;

/// <summary>
/// Tự động patch ChromeDriver để xóa bỏ chuỗi nhận diện bot "cdc_" (Kỹ thuật Undetected ChromeDriver của TikPro)
/// </summary>
public static class ChromeDriverPatcher
{
    public static void PatchAllDrivers()
    {
        try
        {
            // Tìm tất cả file chromedriver.exe trong thư mục app và thư mục nuget
            string appDir = Application.StartupPath;
            var driverFiles = Directory.GetFiles(appDir, "chromedriver.exe", SearchOption.AllDirectories);

            foreach (var driverPath in driverFiles)
            {
                PatchDriverFile(driverPath);
            }
        }
        catch { }
    }

    public static bool PatchDriverFile(string driverExecutablePath)
    {
        if (!File.Exists(driverExecutablePath)) return false;

        try
        {
            if (!IsBinaryPatched(driverExecutablePath))
            {
                return PatchExe(driverExecutablePath) > 0;
            }
            return true;
        }
        catch
        {
            return false;
        }
    }

    private static bool IsBinaryPatched(string driverPath)
    {
        try
        {
            using var stream = new FileStream(driverPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            using var reader = new StreamReader(stream, Encoding.GetEncoding("ISO-8859-1"));
            while (true)
            {
                string? line = reader.ReadLine();
                if (line == null) break;
                if (line.Contains("cdc_")) return false;
            }
            return true;
        }
        catch
        {
            return true;
        }
    }

    private static int PatchExe(string driverPath)
    {
        int count = 0;
        string replacement = GenRandomCdc();

        try
        {
            using var fileStream = new FileStream(driverPath, FileMode.Open, FileAccess.ReadWrite, FileShare.ReadWrite);
            byte[] buffer = new byte[1];
            var sb = new StringBuilder("....");

            while (fileStream.Read(buffer, 0, buffer.Length) != 0)
            {
                sb.Remove(0, 1);
                sb.Append((char)buffer[0]);

                if (sb.ToString() == "cdc_")
                {
                    fileStream.Seek(-4L, SeekOrigin.Current);
                    byte[] bytes = Encoding.GetEncoding("ISO-8859-1").GetBytes(replacement);
                    fileStream.Write(bytes, 0, bytes.Length);
                    count++;
                }
            }
        }
        catch { }

        return count;
    }

    private static string GenRandomCdc()
    {
        var random = new Random();
        char[] array = (from s in Enumerable.Repeat("abcdefghijklmnopqrstuvwxyz", 26)
                        select s[random.Next(s.Length)]).ToArray();

        for (int i = 4; i <= 6 && i < array.Length; i++)
        {
            array[^i] = char.ToUpper(array[^i]);
        }

        if (array.Length > 3)
        {
            array[2] = array[0];
            array[3] = '_';
        }

        return new string(array);
    }
}
