# Seeding TikTok — Electron + C# engine

Giao diện Electron/React và kho tài khoản NestJS dùng TypeScript. Các tác vụ login/video/live/profile/upload/Outlook hiện chạy bằng engine C# với các service Selenium của dự án tham chiếu. Không tự chuyển về Playwright nếu engine lỗi.

## Chạy và đóng gói

```powershell
npm ci
npm run build:engine
npm run build
npm run dev
npm run dist:win
```

Cần Node.js, .NET SDK 8 trở lên và Google Chrome để phát triển. Bộ cài và portable xuất vào `release`, kèm engine và .NET runtime; máy dùng bản cài không cần SDK. Engine có thể cần mạng trong lần đầu để tải ChromeDriver khớp Chrome.

## Chức năng

- Video: xem theo khoảng thời gian, thích, theo dõi, lưu và bình luận spintax.
- Livestream: thời gian xem, chu kỳ thả tim, bình luận và theo dõi chủ live.
- Hồ sơ: avatar, tên, username, bio, số ngẫu nhiên và phân bổ nội dung không trùng.
- Đăng video: hàng đợi chung; ghép một dòng `ID|Tên hiển thị` với từng video theo thứ tự; caption, hashtag, tag và quyền xem công khai theo service C# tham chiếu.
- Công cụ: đăng nhập cookie/mật khẩu/2FA/email; kết nối Outlook/Hotmail; sao chép trường tùy chọn và mã TOTP; nhập TXT, xuất TXT/Excel; sửa tài khoản và kiểm tra proxy.
- Chrome: số luồng, bố trí cửa sổ, kích thước, tỷ lệ giao diện, tắt ảnh/âm thanh. Engine dùng proxy HTTP có/không mật khẩu như service tham chiếu; công cụ kiểm tra proxy riêng vẫn có HTTP/SOCKS5.

Chọn tài khoản, cấu hình và bắt đầu. **Dừng tác vụ** hủy hàng đợi và đóng cửa sổ Chrome của luồng. Đăng nhập giữ cửa sổ mở để kiểm tra. Hoàn tất các bước xác minh tương tác trong Chrome.

Dữ liệu tài khoản/nhóm/proxy dùng kho hiện có. Engine giữ Chrome profiles và token Outlook trong `workflows/csharp` thuộc dữ liệu người dùng. Ánh xạ ID tài khoản nằm trong `workflows/engine-ids.json`. Token Outlook mã hóa bằng Windows DPAPI. Không sao chép tự động profile/token Playwright cũ; cookie tài khoản được truyền sang, Outlook cần kết nối lại nếu chưa có token của engine.

## Kiểm tra

```powershell
npm run test:workflows
npm run test:parity
npm run test:native
npm run test:native:browser
npm run test:feature-ui
npm run test:prod-smoke
npm run test:packaged
npm run test:native:packaged
```

Chạy các kiểm tra packaged sau khi đóng gói. `test:native` kiểm tra kết nối engine thật và kết quả lỗi bằng dữ liệu giả; `test:native:browser` mở Chrome trắng bằng Selenium. Các kiểm tra workflows/parity cũ vẫn kiểm tra nhiều helper và luồng Playwright tham khảo, không chứng minh engine C# chạy các tác vụ đó. Không thao tác tài khoản TikTok thật trong bộ kiểm tra.

[Kiến trúc và phạm vi chuyển engine](native-engine/README.md).

## Cấu hình đăng nhập ứng dụng

Tạo `settings/auth_config.json` ở thư mục dự án khi chạy dev, hoặc cạnh file exe của bản cài đặt:

```json
{
  "AuthBaseUrl": "https://your-auth-server.example",
  "AppCode": "TIKMAX"
}
```

Cũng có thể đặt biến môi trường trong PowerShell trước khi chạy:

```powershell
$env:AUTH_BASE_URL = "https://your-auth-server.example"
$env:AUTH_APP_CODE = "TIKMAX"
npm run dev
```

Thứ tự ưu tiên: biến môi trường → file cấu hình → URL mặc định hiện có. Khởi động lại ứng dụng sau khi đổi. URL là địa chỉ gốc của server, không thêm `/api/auth/login`. Với bản portable tự giải nén, ưu tiên biến môi trường vì vị trí exe chạy có thể nằm trong thư mục tạm.

Màn hình đăng nhập có quên mật khẩu qua OTP email và tùy chọn nhớ mật khẩu. Mật khẩu ghi nhớ dùng kho mã hóa của hệ điều hành. Bỏ chọn nhớ mật khẩu rồi đăng nhập thành công để xóa thông tin đã nhớ.

[Tiến độ sửa sau đối chiếu](docs/feature-parity-fixes.md).
