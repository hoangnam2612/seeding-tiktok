using System;
using OtpNet;

namespace MyTikTokTool.Services;

public static class TwoFactorService
{
    /// <summary>
    /// Tính toán mã 6 số OTP từ Secret Key (2FA Private Key)
    /// </summary>
    public static string GenerateTotpCode(string? secretKey)
    {
        if (string.IsNullOrWhiteSpace(secretKey)) return string.Empty;

        try
        {
            // Làm sạch key (bỏ dấu cách, dấu gạch ngang)
            string cleanKey = secretKey.Replace(" ", "").Replace("-", "").Trim().ToUpperInvariant();
            byte[] secretBytes = Base32Encoding.ToBytes(cleanKey);
            var totp = new Totp(secretBytes);
            return totp.ComputeTotp();
        }
        catch (Exception)
        {
            return string.Empty;
        }
    }

    /// <summary>
    /// Số giây còn lại cho mã OTP hiện tại
    /// </summary>
    public static int GetRemainingSeconds()
    {
        return 30 - (int)(DateTime.UtcNow.Subtract(new DateTime(1970, 1, 1))).TotalSeconds % 30;
    }
}
