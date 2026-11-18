# 🤖 BOTCHECKXAU - HỆ THỐNG PHÂN TÍCH VÀNG ĐA KHUNG THỜI GIAN (H4, H1, M15)

Hệ thống bot tự động hóa phân tích biểu đồ Vàng (XAU/USD) theo thời gian thực sử dụng **Puppeteer Headless**, **TradingView Chart Widget**, **Gemini Vision AI (Cascade Fallback 5 Models)** và **Telegram Bot API**.

---

## 🌟 Tính Năng Chính
1. **Chụp Biểu Đồ Đa Khung Thời Gian (H4, H1, M15):**
   * Mở trình duyệt ngầm Chromium chụp đồng thời 3 khung nến kỹ thuật.
   * Đầy đủ 4 chỉ báo: **EMA 20, EMA 50, EMA 200, RSI 14**.
   * Tự động dọn dẹp dung lượng đĩa (giữ 12 ảnh mới nhất).
2. **AI Vision Đa Khung Kết Hợp Thuật Toán ICT & Định Lượng Kaufman:**
   * Gemini Multimodal Vision đối chiếu 5 biểu đồ (H4, H1, M15, M5, M1) theo phương pháp **ICT (Inner Circle Trader)** và **Perry J. Kaufman (Trading Systems and Methods, 5th Edition)**.
   * **Bản đồ thanh khoản ICT**: Xác định Dealing Range, IRL (Fair Value Gap - FVG), ERL (Buy Side / Sell Side Liquidity), mô hình Unicorn (Breaker Block + FVG) và Optimal Trade Entry (OTE Fib 0.62 - 0.79).
   * **Bộ lọc vị thế PD Array**: Cấm tuyệt đối BUY ở Premium (> 50%) và cấm SELL ở Discount (< 50%).
   * **Bộ lọc nhiễu Kaufman (Efficiency Ratio - KER)**: Tự động phát hiện thị trường giằng co, nến chồng chéo (`CHOP_HIGH_NOISE`, $ER < 0.25$) để ra lệnh `HOLD`, ngăn ngừa bẫy False Breakout.
   * **Tự động nhận diện phiên & Killzone**: Đồng bộ giờ New York, phát hiện phiên London Open, New York Open, Asian Range và các cửa sổ thuật toán ICT Macros (20 phút).
   * **Cơ chế dừng lỗ cấu trúc (Kaufman on Stops)**: Đặt SL theo điểm vô hiệu hóa cấu trúc (ngoài Order Block / Breaker Block / Swing Point + vùng đệm nhiễu) thay vì SL cố định rập khuôn.
   * Cơ chế **Cascade Fallback 5 tầng** tự động vượt lỗi 429 Quota: `gemini-3.5-flash-lite` -> `gemini-3.8-flash` -> `gemini-3.6-flash` -> `gemini-3.5-flash` -> `gemini-3.7-flash`.
   * Tự động xuất khối dữ liệu tín hiệu có cấu trúc chuẩn JSON cho khớp lệnh MT5.
3. **Cầu Nối & Khung Sườn Khớp Lệnh MetaTrader 5 (MT5 Bridge):**
   * **`MT5BridgeServer`**: Cổng HTTP cục bộ (`http://127.0.0.1:3000`) giao tiếp 2 chiều với MT5.
   * **`RiskManager`**: Bộ lọc bảo vệ tài khoản nghiêm ngặt:
     * **Trần tổng khối lượng tối đa**: `MAX_TOTAL_LOT=0.02` (tổng lot tất cả các vị thế đang chạy không vượt quá 0.02).
     * **Chặn nhồi lệnh khi lệnh cũ chưa đóng**: `ALLOW_CONCURRENT_TRADES=false` (nếu các lệnh trước đó chưa đóng SL/TP, bot tuyệt đối không vào lệnh mới).
     * **Chiến lược Hold dài xu hướng lớn**: `FIXED_SL_USD=15.0` (SL 15 giá an toàn, loại bỏ quét râu nến) và `FIXED_TP_USD=30.0` (TP 30 giá, tỷ lệ R:R chuẩn 1:2), dời SL hòa vốn khi lãi >= +$10.00 USD (`BREAKEVEN_TRIGGER_USD=10.0`).
   * **`OrderManager`**: Hỗ trợ 2 chế độ:
     * *Bán tự động (Semi-Auto)*: Gửi nút bấm duyệt `[Xác nhận]` / `[Hủy]` trực tiếp trên Telegram.
     * *Tự động 100% (Full-Auto)*: Khớp thẳng sang MT5 khi `AUTO_EXECUTE=true`.
   * **`mt5_ea/BotCheckXauEA.mq5`**: Expert Advisor MQL5 chính thức cho MT5:
     * **Tự động quét và dời SL hòa vốn**: `InpBreakevenTriggerUSD=10.0`, `InpBreakevenOffsetUSD=1.0` (bảo vệ lệnh khi lãi đạt 10 giá, gồng tiếp về TP 30 giá).
     * Kiểm soát trần volume 0.02 lot và chặn lệnh mở thêm khi có vị thế cũ đang chạy.
4. **Tương Tác Hai Chiều & Cảnh Báo Telegram:**
   * Phân tích và gửi Album ảnh kèm bảng Kế hoạch Scalp & Swing theo yêu cầu người dùng qua lệnh `/plan`. Tắt tự động spam định kỳ (`AUTO_SEND_PLAN=false`).
   * Phản hồi lệnh tra cứu giá tức thì: `giá xau`, `/gia`, `/price`, `vàng`...
   * Phân tích theo yêu cầu ngay lập tức: `/plan`, `phân tích`, `/check`.
   * Kiểm tra tình trạng kết nối & số dư tài khoản MT5 tức thì: `/mt5`.
5. **Vận Hành Bền Vững & Chống Crash:**
   * Mutex lock `isRunning` ngăn chặn xung đột trình duyệt.
   * Bẫy lỗi toàn cục (`uncaughtException`, `unhandledRejection`) và ghi log chi tiết vào `logs/bot.log`.
5. **Đóng Gói & Tự Động Chạy Cùng Windows:**
   * Khởi động ngầm hoàn toàn không hiện cửa sổ đen (Silent Background).
   * Tự động kích hoạt mỗi khi khởi động/đăng nhập Windows.

---

## 📦 Bộ Công Cụ Quản Lý & Đóng Gói (Scripts)

| Tên file script | Công dụng |
| :--- | :--- |
| **`setup_autostart.bat`** | **Kích hoạt tự động chạy Bot ngầm cùng Windows khi mở máy** |
| **`remove_autostart.bat`** | Hủy kích hoạt tự động chạy cùng Windows |
| **`start_silent.vbs`** | Khởi động bot chạy ngầm lập tức (không hiện cửa sổ cmd) |
| **`start_bot.bat`** | Khởi động bot với cửa sổ dòng lệnh để debug |
| **`stop_bot.bat`** | Dừng toàn bộ các tiến trình bot đang chạy |
| **`status_bot.bat`** | Kiểm tra trạng thái đang chạy, PID và 10 dòng log mới nhất |

---

## 🚀 Hướng Dẫn Sử Dụng Nhanh

### 1. Kích hoạt tự động chạy khi khởi động máy:
Nhấp đúp chuột vào file:
```
setup_autostart.bat
```
*(Hệ thống sẽ tạo file khởi động ngầm trong thư mục `shell:startup` của Windows. Mỗi khi bạn bật máy tính, bot sẽ tự chạy ngầm gửi tin nhắn mỗi 15 phút về Telegram).*

### 2. Kiểm tra trạng thái bot:
Nhấp đúp chuột vào file:
```
status_bot.bat
```

### 3. Tắt bot khi cần bảo trì:
Nhấp đúp chuột vào file:
```
stop_bot.bat
```

### 4. Quản lý qua lệnh npm:
```bash
npm run start:silent     # Chạy ngầm không hiện cửa sổ
npm run status           # Xem trạng thái PID
npm run stop             # Dừng bot
npm run autostart:enable # Cài đặt khởi động cùng Windows
npm run autostart:disable# Hủy khởi động cùng Windows
```

---

## 📈 Hướng Dẫn Kích Hoạt Cầu Nối Khớp Lệnh MT5

1. **Cho phép MT5 gọi API cục bộ:**
   * Trong phần mềm MT5, mở menu **Tools** -> **Options** (hoặc bấm `Ctrl + O`).
   * Chọn tab **Expert Advisors**.
   * Tích chọn **Allow WebRequest for listed URL**.
   * Thêm địa chỉ: `http://127.0.0.1:3000` và nhấn **OK**.

2. **Cài đặt EA:**
   * Mở **MetaEditor** trong MT5 (bấm phím `F4`).
   * Tạo file mới trong thư mục `Experts` tên là `BotCheckXauEA.mq5`.
   * Copy toàn bộ nội dung từ file [`mt5_ea/BotCheckXauEA.mq5`](mt5_ea/BotCheckXauEA.mq5) dán vào rồi nhấn **Compile** (phím `F7`).
   * Quay lại MT5, kéo EA `BotCheckXauEA` vào biểu đồ vàng (XAU/USD).
   * Đảm bảo nút **Algo Trading** (Giao dịch tự động) trên thanh công cụ MT5 đã được bật (màu xanh lá).

3. **Kiểm tra trên Telegram:**
   * Gõ `/mt5` trong khung chat bot Telegram để kiểm tra số dư và trạng thái kết nối trực tiếp.

---

## 🌐 Giao Diện Web Dashboard Quản Trị Trực Quan (`http://localhost:3000`)

Truy cập trực tiếp tại trình duyệt: **`http://localhost:3000`** hoặc **`http://127.0.0.1:3000`**.

1. **Cấu Hình Linh Động Tỷ Lệ R:R & Dừng Lỗ/Chốt Lời:**
   * Thiết lập tỷ lệ R:R tối thiểu (`Min R:R`, ví dụ: 1:1.5, 1:1.8, 1:2.0, 1:2.5, 1:3.0).
   * Điều chỉnh khoảng cách dừng lỗ (`SL USD`, mặc định 15$) và chốt lời (`TP USD`, mặc định 30$).
   * Tự động tính toán tỷ lệ tương ứng trực quan theo thời gian thực.
2. **Cấu Hình Số Vốn Ban Đầu & Tỷ Lệ Cắt Lỗ (Circuit Breaker):**
   * Thiết lập số vốn ban đầu (ví dụ: $300 USD hoặc tùy chỉnh).
   * Thiết lập tỷ lệ cắt lỗ tối đa (% vốn, ví dụ 50% vốn $\implies$ -$150.00 USD).
   * Tự động tính ra mức sụt giảm tối đa cho phép dừng lỗ và tự động ngắt mạch (Circuit Breaker) khi chạm ngưỡng.
   * Nút bấm lưu cấu hình tức thì, đồng bộ bộ nhớ bot và tự động ghi đè file `.env` bền vững.
3. **Hệ Thống Cảnh Báo Giá Vàng XAU/USD Thời Gian Thực:**
   * Đặt mốc giá cảnh báo theo điều kiện: Giá tăng vượt ($\ge$) hoặc Giá giảm thủng ($\le$).
   * Kèm ghi chú kỹ thuật (Kháng cự H4, Vùng OTE Fib, Hỗ trợ M15...).
   * Quét giá live mỗi 3 giây; khi giá thị trường chạm mốc, hệ thống sẽ:
     * Tự động phát tin nhắn cảnh báo khẩn cấp tới danh bạ Telegram (`TELEGRAM_CHAT_ID`).
     * Hiển thị trạng thái `ĐÃ CHẠM` trên Web Dashboard kèm thời gian chạm.
     * Cho phép Bật/Tắt, Kích hoạt lại hoặc Xóa mốc cảnh báo chỉ với 1 click.
