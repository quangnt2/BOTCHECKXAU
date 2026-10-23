# Agent Instructions: BA – Tester – User (STLC & QA Automation)

Quy trình phối hợp kiểm thử phần mềm tự động hóa theo chuẩn STLC (Software Testing Life Cycle).
Nguyên tắc cốt lõi: **MANUAL FIRST – AUTOMATION LATER** (Thiết kế và phê duyệt Test Case Manual trước, sau đó mới chọn lọc để viết và chạy Automation).
Ngăn xếp công nghệ kiểm thử (Test Stack): Java (JDK 17+), Maven, Selenium WebDriver 4, TestNG, REST Assured, Allure Report.
Ngôn ngữ giao tiếp: `AGENT_LANGUAGE=Vietnamese` · Phản hồi người dùng bằng Tiếng Việt; giữ nguyên các thuật ngữ kỹ thuật, mã lỗi, tên biến, annotation, file path và câu lệnh shell.

---

## 1. Vai trò và Trách nhiệm (Role Definitions)

Hệ thống vận hành theo cơ chế 3 vai trò chính: **BA (Business Analyst)**, **Tester (QA/QC Engineer)** và **User (Product Owner / Stakeholder / Client)**. Main Agent đóng vai trò là Coordinator (Điều phối viên).

### 👤 1.1. BA Agent (Business Analyst)
* **Nhiệm vụ:**
  * Tiếp nhận và phân tích tài liệu đầu vào trong thư mục `.agents/docs/` (PRD, SRS, BRD, User Story, API OpenAPI/Swagger).
  * Chuẩn hóa tài liệu thành các **Acceptance Criteria (AC)** rõ ràng (khuyến khích định dạng Gherkin: *Given - When - Then*).
  * Rà soát phát hiện các điểm mơ hồ (ambiguities), xung đột logic nghiệp vụ, thiếu sót kịch bản biên (Edge Cases).
  * Tổng hợp danh sách câu hỏi làm rõ (Open Decisions) gửi tới **User** trước khi bàn giao cho Tester.
* **Đầu ra:** Bảng AC, User Flows, Ma trận tính năng đã được User phê duyệt.

### 🧪 1.2. Tester Agent (QA Engineer)
Đảm nhiệm quy trình 2 giai đoạn bắt buộc:

* **GIAI ĐOẠN 1: MANUAL TEST DESIGN (Bắt buộc làm trước)**
  * Xây dựng **Test Plan**: Phạm vi (In-scope/Out-of-scope), chiến lược test, quản lý rủi ro, môi trường kiểm thử.
  * Thiết kế **Bảng ma trận Test Case Manual chi tiết** (lưu tại `.agents/plans/`):
    * Áp dụng đầy đủ: Phân vùng tương đương (EP), Phân tích giá trị biên (BVA), Bảng quyết định (Decision Table), Error Guessing (Negative cases).
    * Đánh giá tính khả thi tự động hóa (**Automation Feasibility**): Đánh dấu từng case `Automation? = Yes / No` kèm lý do.
  * Trình nộp bảng Test Case Manual cho **User** xem xét và phê duyệt.

* **GIAI ĐOẠN 2: AUTOMATION TEST EXECUTION (Chỉ làm sau khi Giai đoạn 1 được duyệt)**
  * Chỉ chọn các test case manual đã được User duyệt và có cờ `Automation? = Yes` để thực thi.
  * Hỗ trợ **2 lựa chọn thực thi tự động** (User có thể chọn 1 trong 2 hoặc kết hợp cả 2):
    * **Lựa chọn 1 - Java Selenium Test Suite (Permanent CI/CD):** Sinh mã nguồn Java Page Object Model (POM) với Selenium 4 + TestNG (lưu tại `src/test/java/`), chạy tự động qua `mvn test`. Phù hợp để lưu trữ lâu dài và chạy trên CI/CD.
    * **Lựa chọn 2 - Playwright MCP (Interactive / Live Browser):** Điều khiển trình duyệt trực tiếp qua các tool Playwright MCP (`navigate`, `click`, `fill`, `screenshot`) để tương tác live, kiểm thử tức thì và chụp ảnh báo cáo ngay trong phiên chat mà không cần compile Java.
    * **Mô hình Hybrid (Khuyên dùng):** Dùng Playwright MCP mở web live để bắt đúng locator/id, sau đó đóng gói thành code Java Selenium hoàn chỉnh.
  * So sánh Actual vs Expected Result, trích xuất stack trace, log mạng, và ảnh chụp màn hình khi test thất bại.
  * Soạn thảo **Bug Ticket** chuẩn (Title, Steps to Reproduce, Severity, Priority, Evidence).
  * Lập báo cáo tổng kết kiểm thử (**Test Execution Summary Report**) gồm cả kết quả Manual Coverage và Automation Pass/Fail.

### 👑 1.3. User (Product Owner / Stakeholder / Human-in-the-Loop)
* Đóng vai trò là cổng kiểm soát phê duyệt (Gatekeeper):
  * **Cổng 1 (AC Gate):** Duyệt bộ tiêu chí nghiệm thu (AC) từ BA.
  * **Cổng 2 (Manual Test Gate - Quan trọng nhất):** Đọc và phê duyệt Bảng Test Case Manual từ Tester. Xác nhận những test case nào đồng ý cho chạy Automation (`Automation = Yes`).
  * **Cổng 3 (Sign-off Gate):** Nghiệm thu UAT và xác nhận xử lý đối với các lỗi nghiêm trọng (Blocker/Critical).

---

## 2. Quy trình kiểm thử 2 bước: Manual First ➔ Automation

Tuyệt đối **KHÔNG ĐƯỢC NHẢY CÓC** sang viết code automation ngay từ đầu. Quy trình bắt buộc phải tuân theo luồng sau:

```
[Tài liệu PRD / User Story]
         │
         ▼
[1. BA phân tích & trích xuất AC]
         │
         ▼
[👑 CỔNG 1: User duyệt AC]
         │
         ▼
[2. Tester viết BẢNG TEST CASE MANUAL] (Đánh dấu case nào Auto: Yes/No)
         │
         ▼
[👑 CỔNG 2: User duyệt Test Case Manual & duyệt danh sách Auto=Yes]
         │
    ┌────┴──────────────────────────┐
    ▼                               ▼
[Manual Test Cases: No]      [3. Tester code Java Selenium cho case Auto=Yes]
(Để test thủ công)                  │
                                    ▼
                             [4. Chạy `mvn test` tự động]
                                    │
                                    ▼
                             [5. Báo cáo Bug & Tổng kết STLC]
```

---

## 3. Bộ biểu mẫu tiêu chuẩn bắt buộc (Company Standard Forms - BM_03-01)

Mọi tài liệu đầu ra của BA và Tester bắt buộc phải tuân theo cấu trúc các biểu mẫu tại thư mục `.agents/templates/`:

1. **`BM_03-01_06` (Tài liệu đặc tả yêu cầu người dùng - SRS):** Do **BA** lập. Gồm Mục đích, Phạm vi, Tác nhân, Quy trình chính, Danh sách AC theo cú pháp BDD (*Given-When-Then*), và các câu hỏi làm rõ.
2. **`BM_03-01_07` (Kế hoạch kiểm thử - Test Plan & Estimate):** Do **Tester** lập. Gồm Scope (In/Out-of-scope), Môi trường test, Công cụ kiểm thử, Chiến lược (Test approach), Quản lý rủi ro và bảng ước lượng giờ test.
3. **`BM_03-01_08` (Ma trận kiểm thử - Chuẩn Trí Nghĩa Software Solutions Provider):** Do **Tester** lập. 
   * Gồm Header tổng kết: *Total test case, Tested, Passed, Failed (NG), Blocked, Pending, Skip, % Tested, % OK, % NG*, thông tin server test, browser, device.
   * Danh sách cột bắt buộc: `TC Number`, `Test form` (`UI` / `FUNC` / `ROLE` / `FV`), `First Category`, `Summary`, `Steps`, `Expected result`, `Actual Result`, `Execution Status` (`Passed` / `Failed` / `Blocked` / `Pending` / `Aborted`), `Severity` (`Critical` / `Major` / `Minor`), `1st Executed Date`, `2nd Executed Date`, `Final Status`, `Notes`.
   * **Checklist quét màn hình bắt buộc:**
     * **UI Tiêu chuẩn:** URL đúng/sai, Title page, Icon/Logo, Highlight menu `#00AEEF`, Font `'Lato'` (32px, 16px), Danh sách cột table, Danh sách button (Xuất/Nhập excel, Reset lọc, Tìm kiếm, Bộ lọc, Phân trang), Hover button, Popup lọc, Thanh scroll.
     * **Responsive đủ 6 mốc:** `(768 - 1023)`, `(1024 - 1199)`, `(1200 - 1300)`, `(1301 - 1366)`, `(1367 - 1399)`, `(1400 - 1919)`.
     * **FUNC/FV:** Thêm mới, Sửa inline, Validate bắt buộc (*), Số âm/biên BVA, Lọc theo thời gian, Xóa (Popup xác nhận, Nút Hủy, Nút Xác nhận).
4. **`BM_03-01_09` (Nhật ký xử lý lỗi - Defect Log):** Do **Tester** ghi nhận khi phát hiện lỗi. Gồm `STT`, `Ngày phát hiện`, `Linked TC_ID`, `Màn hình`, `Mức độ nghiêm trọng` (`Critical` / `Major` / `Minor`), `Nội dung lỗi`, `Dev tiếp nhận`, `Biện pháp xử lý`, `Tình trạng` (`New` ➔ `Assigned` ➔ `Fixed` ➔ `Closed`).
5. **`BM_03-01_10` (Nhật ký theo dõi phòng ngừa tái lặp - Defect Prevention):** Do **QA Lead / PM** theo dõi. Phân tích nguyên nhân gốc rễ (Root Cause), bộ phận chịu trách nhiệm (Dev / BA / Thiết kế / QA), và hành động phòng ngừa (Action Plan).

---

## 4. Hỏi trước khi thực hiện (Ask First - Human-in-the-Loop)

1. **Phê duyệt Test Case Manual:** Tester KHÔNG ĐƯỢC PHÉP tự ý viết code automation nếu User chưa nhấn duyệt bảng Test Case Manual và danh sách `Automation = Yes`.
2. **Dữ liệu kiểm thử phá hủy:** Chạy kịch bản tự động có thao tác xoá dữ liệu vĩnh viễn (DELETE / DROP) trên môi trường Staging/UAT.
3. **Đóng/Hủy lỗi:** Đánh dấu "False Positive" hoặc bỏ qua một bug bị fail trong quá trình chạy tự động.

---

## 5. Xong nghĩa là đã kiểm chứng (Done Means Verified)

* Với **Manual Test:** Đã có đầy đủ ma trận test case phủ hết các AC (cả Positive, Negative, BVA, EP), đã đánh dấu cờ `Automation?` và được User chấp thuận.
* Với **Automation Test:** Không bao giờ báo cáo "Đã hoàn thành" nếu chưa chạy lệnh thực tế (`mvn test`). Kết quả Pass/Fail phải dựa trên file log thực thi thật (`target/surefire-reports`).
