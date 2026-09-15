using System;
using System.Text.RegularExpressions;

namespace MyTikTokTool.Services;

/// <summary>
/// Hỗ trợ giải mã SpinText cú pháp {câu 1|câu 2|câu 3} để tạo nội dung đa dạng tránh spam
/// </summary>
public static class SpinTextHelper
{
    private static readonly Random _random = new();
    private static readonly Regex _spinRegex = new(@"\{([^{}]+)\}", RegexOptions.Compiled);

    public static string Resolve(string input)
    {
        if (string.IsNullOrWhiteSpace(input)) return string.Empty;

        string result = input;
        while (_spinRegex.IsMatch(result))
        {
            result = _spinRegex.Replace(result, match =>
            {
                string[] choices = match.Groups[1].Value.Split('|');
                return choices[_random.Next(choices.Length)].Trim();
            });
        }

        return result.Trim();
    }
}
