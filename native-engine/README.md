# Engine C#

Theo yêu cầu đổi công nghệ ngày 15/09/2026, runtime tự động hóa hiện là C#/.NET 8 + Selenium. Giao diện, API đăng nhập ứng dụng, kiểm tra giấy phép và kho tài khoản hiện tại vẫn được giữ.

`Services/TikTok*`, `Outlook*`, `ChromeService`, `BrowserLayoutManager`, `LocalProxyBridge`, `TwoFactorService`, `SpinTextHelper` và model được sao chép từ dự án tham chiếu vào đây để build độc lập, không yêu cầu đường dẫn dự án bên cạnh. Các nhánh đăng nhập/OTP, seeding, profile, upload gọi chính các service C# này; không port lại selector bằng Playwright.

Điều chỉnh tích hợp:

- `Program.cs` nhận lệnh JSON mỗi dòng trên stdin, trả reply/event/account trên stdout. Chẩn đoán console của thư viện đi stderr, không chuyển nguyên văn ra UI.
- `AccountService` chỉ trả cập nhật về Electron, không mở SQLite phụ. Electron ánh xạ ID chuỗi sang ID số ổn định trong engine-ids.json và chỉ nhận các trường kết quả cần thiết.
- Đường dẫn profile/cấu hình/token được chuyển sang thư mục dữ liệu riêng, tránh ghi vào thư mục cài đặt.
- Giữ engine chạy sau login để giữ Chrome; cancel hủy tác vụ và đóng Chrome. Khi không phản hồi sau 15 giây, adapter dừng cây tiến trình engine.
- Sửa phạm vi đóng Chrome: đóng một tài khoản không diệt tất cả ChromeDriver con của engine; bỏ quét driver mồ côi của ứng dụng khác. CloseAll vẫn dọn các profile và tiến trình con của chính engine.
- UI chính và các lời gọi preload cũ đều chuyển sang workflow IPC, kiểm tra quyền và chọn tài khoản từ kho trước khi gửi engine. Không đăng ký bộ chạy Electron cũ nữa.
- Proxy dùng HTTP theo ChromeService gốc. Không tự biến SOCKS thành HTTP. Công cụ check proxy độc lập vẫn dùng thư viện Node.

Build: `npm run build:engine`. Publish self-contained win-x64 ở `native-engine/publish`; electron-builder chép vào `resources/native-engine`. `npm run dev`/`start` tự build engine trước khi mở. Kiểm tra riêng: `test:native`, `test:native:browser`, `test:native:packaged`.

Mã Playwright cũ còn trong source để đối chiếu/kiểm tra helper; workflow sản phẩm không gọi `WorkflowService` cũ. Chuyển runtime không có nghĩa đã kiểm thử toàn bộ các màn hình TikTok/Microsoft thật. Bản C# có hành vi upload xác nhận lỏng hơn bản TypeScript trước đó; kết quả giờ theo service tham chiếu.

Đã kiểm chứng: biên dịch engine không lỗi/cảnh báo; handshake và sáu command, hàng đợi upload dừng tài khoản khi file lỗi, cập nhật đúng ID tài khoản, close/cancel; Selenium mở hai Chrome trắng thật, kích thước/vị trí đúng, đóng một tài khoản không đóng tài khoản còn lại. Bộ kiểm tra UI và production smoke đều qua. Không đăng nhập hoặc đăng bài lên tài khoản thật trong đợt tích hợp này.

Bộ cài NSIS và portable đã được tạo kèm runtime. `test:native:packaged` đã chạy engine từ `release/win-unpacked/resources/native-engine`; đối chiếu file xác nhận engine/runtime đúng bản publish và workflow IPC trong app.asar gọi native-service, không đăng ký bộ chạy Electron cũ.

Sửa lỗi mở Chrome: không truyền toàn bộ object tài khoản Electron thẳng sang model C#. `categoryId` của Electron là chuỗi, còn C# là int; bộ đếm của Electron là số, còn C# là chuỗi. Adapter hiện ánh xạ rõ từng trường, không chuyển ID nhóm sang engine (nhóm vẫn do Electron quản lý). Đã tái hiện lỗi chuyển System.Int32 trước sửa và kiểm tra engine thật qua sau sửa với fixture có ID nhóm chuỗi và bộ đếm số. Lỗi khởi chạy cũng được ghi vào log và trạng thái tài khoản.
