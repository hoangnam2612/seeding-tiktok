# Sửa hành vi sau đối chiếu — 15/09/2026

> Cập nhật kiến trúc: người dùng đã yêu cầu quay lại C# engine. Workflow hiện dùng [engine C#](../native-engine/README.md); bảng dưới ghi lại đợt hoàn thiện TypeScript trước khi đổi engine, không phải mô tả runtime hiện tại.

Đã triển khai các sửa đổi dưới đây bằng TypeScript. Đây là đối chiếu mã nguồn và kiểm tra fixture, **chưa phải chứng nhận tương đương hoàn toàn trên TikTok/Microsoft thật**. Số mục trong bảng không phải tỷ lệ hoàn thành.

| Mục audit | Thay đổi hiện tại |
|---|---|
| 01 | Khóa toàn bộ luồng đăng nhập theo hộp thư Outlook; chờ khóa có thể hủy. |
| 02 | Điền từng ô OTP, tìm Next/Confirm/Tiếp/Xác nhận trong vùng chứa mã, chờ nút bật. |
| 03 | Kiểm tra đúng email trước mật khẩu Microsoft; chọn tài khoản/phương thức mật khẩu, tách MFA và device code, xác nhận ứng dụng, xin mã mới một lần khi mã bị từ chối. Poll token đồng thời với tab đăng nhập; nhận token thì hủy và đợi nhánh trình duyệt kết thúc. Chưa kiểm chứng mọi biến thể Microsoft thật. |
| 04, 16 | Server từ chối kiểm tra quyền thì chặn dù cache còn giấy phép; từ chối phiên thiếu token hoặc sai mã sản phẩm. |
| 05 | Tìm nút Follow mục tiêu trước khi xét Following; xác nhận trạng thái, tải lại để kiểm tra trước khi thử tiếp, tối đa 5 lượt. |
| 06 | Khi phiên chưa đăng nhập vẫn thử cookie lưu trong tài khoản, kể cả profile có cookie phiên cũ. |
| 07 | Seeding thử đăng nhập tối đa 3 lần; khôi phục khi gặp challenge và chờ xác minh thủ công 60 giây sau các lượt khôi phục. Lỗi mật khẩu, giới hạn và lỗi terminal vẫn dừng; không gửi lại vô hạn. |
| 08 | Lỗi riêng Like/Follow/Favorite/Comment và thao tác live được ghi cảnh báo, tiếp tục mục kế tiếp; kết quả có lỗi không bị báo thành công toàn bộ. Lỗi đăng nhập/xác minh vẫn dừng tài khoản. |
| 09 | Ghi message, lastAction, lastActionAt khi trả kết quả hoặc dừng. Lỗi tổng quát dùng status=error; chưa ánh xạ chi tiết mọi trạng thái khóa/checkpoint của bản tham chiếu. |
| 10 | Mở profile bằng URL trước, fallback điều hướng; bổ sung selector, tiếp tục trường khác khi avatar/trường nhập lỗi, chỉ lưu patch văn bản sau xác nhận Save. Chưa kiểm chứng mọi popup/lỗi validation thật. |
| 11 | Lấy video từ hàng đợi trước login; mở/đóng Chrome cho từng video; một video lỗi thì dừng tài khoản đó. |
| 12 | Nếu upload đã được xác nhận nhưng thiếu URL, so sánh danh sách video profile trước/sau. Chỉ nhận khi có đúng một link mới; không lấy đại video cũ. |
| 13 | Màn hình quên mật khẩu, gửi OTP/reset-password; nhớ thông tin đăng nhập bằng mã hóa hệ điều hành. |
| 14 | Đọc AUTH_BASE_URL/AUTH_APP_CODE và settings/auth_config.json, hỗ trợ tên trường không phân biệt hoa thường. Giữ URL hiện có làm fallback. |
| 15 | Gọi logout trên server rồi xóa phiên local trong finally. |
| 17 | Cấp vị trí cửa sổ theo tài khoản đang mở, giải phóng khi đóng. Tính chiều cao từ chiều rộng ban đầu rồi mới áp giới hạn rộng tối thiểu 600/cao tối đa 700; xếp lưới và quay vòng như bản tham chiếu kể cả khi autoArrangeGrid=false. Đặt lại bounds qua Chrome DevTools sau khi mở, đưa cửa sổ về normal nếu cần. |
| 18 | Kiểm tra proxy trực tiếp không cần Chrome, có HTTP/SOCKS xác thực; khử trùng host/port/user. Chrome vẫn không hỗ trợ SOCKS có xác thực trực tiếp. |
| 19 | Format TXT thông thường chấp nhận thiếu/thừa cột, bỏ dòng không nhận diện; format UID/PASS/MAIL/PASSMAIL vẫn kiểm tra chặt. |
| 20 | Giữ hành vi bảo toàn tài khoản khi xóa nhóm: chuyển về nhóm mặc định. Chưa đổi thành xóa cả tài khoản như bản tham chiếu. |
| 21 | Giữ xác nhận upload, Public và đúng username tag; không sao chép hành vi có thể báo thành công khi chưa xác nhận. |
| 22 | Deadline 120 giây bao gồm token/request/delay khi chờ OTP; đọc Retry-After dạng giây hoặc ngày HTTP. |
| 23 | Áp zoom html và body sau ready/login; giữ interval tối thiểu 1 giây và kiểm tra hết thời gian trước lượt tiếp theo. |

## Kiểm chứng

- `npm run test:parity`: 14 tình huống qua, gồm ba lỗi đã tái hiện ở audit, sai mã sản phẩm, remote logout, cấu hình auth, nhớ mật khẩu (mock mã hóa), poll Outlook đồng thời, vòng đời upload, tiếp tục sau lỗi, khóa hộp thư, OTP 6 ô, không điền mật khẩu sai hộp thư và bố trí Chrome. Kiểm tra bố trí gồm màn hình nhỏ, kích thước tùy chỉnh, quay vòng lưới, cờ autoArrangeGrid và đọc lại bounds thực từ Chrome headless sau khi đặt.
- `npm run test:workflows`: 13 nhóm qua; dữ liệu giả/HTML cục bộ, không tác động tài khoản thật.
- `npm run test:feature-ui`: qua các màn hình chức năng, dark/light, chọn tài khoản, payload upload, dừng, live/profile, nhớ đăng nhập và quên mật khẩu.
- `npm run test:prod-smoke`: qua kiểm tra production.
- `npm run dist:win`: tạo thành công bộ cài NSIS và portable mới.
- `npm run test:packaged`: qua workflow runtime, preload/IPC, từ chối giấy phép, Chrome, Excel và mã hóa hệ điều hành từ `app.asar`. Thông báo `fixture-denied` là tình huống từ chối quyền có chủ đích của kiểm tra.

Kết quả fixture không chứng minh tất cả selector, CAPTCHA/MFA, proxy thực, trường hợp lỗi mạng và thao tác đăng bài hoạt động giống nhau trên môi trường thật. Cần kiểm tra có kiểm soát các nhánh này trước khi kết luận 100%. Các mục 09/10 còn hạn chế chi tiết nêu trên; 20/21 là khác biệt được giữ để bảo toàn dữ liệu và xác nhận đúng kết quả.
