# Kiểm tra bản gửi khách — 15/09/2026

## Kết luận

Bản build được kiểm tra trên máy phát triển Windows hiện tại. Đủ bằng chứng để tạo bản thử nghiệm có kiểm soát; chưa đủ cơ sở xác nhận phát hành production rộng rãi. Không chạy thao tác lên tài khoản TikTok thật trong đợt này.

## Kiểm tra đã qua

| Kiểm tra | Bằng chứng/phạm vi |
|---|---|
| `test:native` | Engine thật nhận lệnh; chuyển ID nhóm chuỗi và bộ đếm; hàng đợi upload dừng sau file lỗi; đồng bộ đúng tài khoản; close/cancel. Không xác nhận thành công các tác vụ TikTok thật. |
| `test:workflows` | 13 nhóm; có kiểm tra IPC của native adapter. Nhiều nhóm còn kiểm tra helper/Playwright cũ, không coi đó là kiểm thử Selenium. |
| `batch-import-mail-checks.cjs` | Nhập/cập nhật User-Pass-Mail-PassMail, bảo toàn cookie và nhận diện các format cũ. |
| `test:prod-smoke` | Kho dữ liệu, mã hóa bằng mock, token API nội bộ, quan hệ tài khoản/proxy. |
| `test:feature-ui` | Màn hình, chọn tài khoản, payload thao tác, nút dừng và màn hình auth bằng fixture. |
| `test:native:browser` | Mở hai Chrome trắng thật bằng Selenium, xếp cửa sổ, đóng riêng và CloseAll; toàn bộ 20 tiến trình con được theo dõi đã thoát. Không chứng minh xử lý hết mọi tình huống treo hoặc mất quyền hệ điều hành. |
| `secret-storage-checks.cjs` | Không ghi plaintext khi không có mã hóa hoặc API mã hóa lỗi; báo lỗi giải mã; vẫn đọc được dữ liệu cũ để di trú. |
| `startup-checks.cjs` | Mô phỏng backend không mở được, phiên thứ hai và môi trường development trên bản packaged. |
| `dist:win` | Tạo bộ cài NSIS và portable, kèm C# engine/.NET runtime. |
| `test:native:packaged`, `test:packaged` | Engine trong gói chạy qua fixture; preload/IPC, từ chối giấy phép, Excel, Chrome và mã hóa Windows thực. Thông báo fixture-denied là lỗi dự kiến của phép thử. |
| Đối chiếu artifact | Mã khởi động, lưu bí mật và adapter trong app.asar khớp dist vừa kiểm tra. SHA-256 và kích thước bộ cài/portable ở `release/release-checksums.json`. |

## Sửa trong đợt kiểm tra

- Lưu bí mật: thay fallback plaintext bằng lỗi rõ ràng khi mã hóa không sẵn sàng hoặc thất bại; không trả chuỗi ciphertext như mật khẩu khi giải mã lỗi.
- Khởi động: giữ một phiên ứng dụng; lỗi backend thì báo lỗi và thoát thay vì mở giao diện không hoạt động.
- Bản đóng gói luôn tải giao diện local, không bị NODE_ENV=development chuyển sang Vite.

## Việc còn chặn kết luận production

1. `npm audit --omit=dev` báo 10 mục dependency: 2 high, 8 moderate, 0 critical. Hai mục high là `@nestjs/platform-express` và dependency `multer`; đây có thể là cùng chuỗi phụ thuộc, không phải hai lỗi độc lập. Chưa thấy endpoint multipart/FileInterceptor trong source, nhưng điều đó không đủ để bỏ qua cảnh báo. Chi tiết ở `tmp/production-audit.json`. Chưa thực hiện nâng Nest major hoặc override thư viện khi chưa kiểm tra tương thích.
2. Electron runtime hiện đóng gói là 28.3.3; audit omit-dev không đánh giá runtime này vì Electron nằm trong devDependencies. Chưa hoàn thành rà soát/nâng cấp Electron và dependency NuGet.
3. File ứng dụng kiểm tra có trạng thái Authenticode `NotSigned`. Chưa có bằng chứng cài đặt/gỡ/cập nhật trên máy Windows sạch, tài khoản Windows khác hoặc máy không có SDK.
4. Chưa kiểm thử trọn luồng TikTok/Microsoft thật: login/OTP, video/live, profile, upload/gắn sản phẩm; chưa kiểm thử tải dài ngày, mất mạng, driver tải lỗi và dừng đúng lúc Chrome đang khởi tạo.
5. Auth server phải được cấu hình/kiểm tra cho môi trường khách; URL mặc định hiện tại không được coi là bằng chứng server production sẵn sàng.

Không nên gửi bản này với cam kết mọi chức năng đã được kiểm chứng 100%. Có thể dùng làm ứng viên phát hành/beta với phạm vi thử nghiệm rõ ràng.
