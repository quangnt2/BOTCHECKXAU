import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Phân tích đa khung thời gian tập trung SCALPING M1 & M5 (kết hợp xu hướng nền H4/H1/M15)
 * @param {Array<{ tf: string, path: string }>} chartImages Danh sách ảnh các khung thời gian
 * @param {{ price: string, change: string, high: string, low: string } | null} priceInfo Thông tin giá thời gian thực
 * @returns {Promise<string>} Báo cáo phân tích kỹ thuật
 */
export async function analyzeMultiTimeframeCharts(chartImages, priceInfo = null) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trong file .env');
  }

  const ai = new GoogleGenAI({ apiKey });

  // Chuẩn bị các part hình ảnh gửi tới Gemini Vision
  const contents = [];

  for (const item of chartImages) {
    const buffer = fs.readFileSync(item.path);
    contents.push({
      inlineData: {
        data: buffer.toString('base64'),
        mimeType: 'image/png'
      }
    });
  }

  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const priceHeader = priceInfo 
    ? `${priceInfo.price} USD (${priceInfo.change} | Range: ${priceInfo.low} - ${priceInfo.high})`
    : 'Xem trên chart';

  const prompt = `
Bạn là Chuyên gia Scalping Phái sinh XAU/USD Cấp cao.
Nhiệm vụ:
1. Xác định xu hướng hiện tại và phát hiện sớm dấu hiệu ĐẢO CHIỀU XU HƯỚNG để tự ngắt lệnh bảo toàn vốn.
2. Tìm kiếm cơ hội vào lệnh SCALP lướt sóng nhanh trên khung thời gian M1 và M5.
Dữ liệu đầu vào: Các ảnh biểu đồ H4, H1, M15, M5 và M1.
Giá hiện tại: ${priceInfo ? priceInfo.price + ' USD' : 'Xem chart'}.

QUY TẮC BẮT BUỘC (KỶ LUẬT SCALPING & QUẢN TRỊ RỦI RO):
- CÂU TỪ CỰC KỲ NGẮN GỌN (Mỗi dòng tối đa 4 - 6 từ, không viết văn giải thích dài dòng).
- TUYỆT ĐỐI KHÔNG dùng bất kỳ emoji / icon nào.

QUY TẮC QUÉT XU HƯỚNG & PHÁT HIỆN ĐẢO CHIỀU:
- Xác định trường "trend":
  + "UP": Cấu trúc đỉnh đáy nâng cao dần, nến trên EMA M5/M1.
  + "DOWN": Cấu trúc đỉnh đáy hạ thấp dần, nến dưới EMA M5/M1.
  + "SIDEWAY": Giá đi ngang biên hẹp.
- Phát hiện ĐẢO CHIỀU ("reversal_detected": true):
  + Nếu thị trường vừa bẻ gãy cấu trúc cũ (ví dụ đang giảm mà nến phá đỉnh cũ M5/M1 kèm RSI tăng vọt, hoặc nến đảo chiều pinbar/engulfing mạnh từ hỗ trợ) -> Đặt "reversal_detected": true và ghi rõ "reversal_reason".
  + Dấu hiệu này sẽ kích hoạt hệ thống TỰ ĐỘNG CẮT LỆNH NGAY LẬP TỨC nếu đang giữ lệnh ngược xu hướng để bảo toàn vốn trước khi chạm SL!

CHIẾN LƯỢC SCALPING M1 & M5 (CHỦ ĐỘNG TÌM ĐIỂM VÀO LỆNH):
1. Khung tham chiếu xu hướng nền: H4 & H1 (Xác định Bias: Tăng / Giảm / Đi ngang).
2. Khung thực chiến bắt điểm vào lệnh (Entry): M5 và M1.
   • Lệnh SELL SCALP:
     - Khi xu hướng là Giảm, hoặc nến M1/M5 hồi nhẹ chạm đường EMA (EMA 34/89) / cản vi mô gần nhất trên M5/M1, hoặc RSI(14) M1/M5 > 60 -> LẬP TỨC RA TÍN HIỆU SELL SCALP.
     - KHÔNG ĐƯỢC chờ giá hồi hàng chục USD về tận cản lớn H4/H1 mới chịu SELL. Hãy bám sát cản vi mô M5/M1!
   • Lệnh BUY SCALP:
     - Khi xu hướng là Tăng, giá Pullback về hỗ trợ vi mô M5/M1 hoặc EMA M5/M1 -> RA TÍN HIỆU BUY SCALP.
     - Hoặc khi giá chạm hỗ trợ vi mô cứng M5/M1, RSI(14) M1/M5 rơi vào vùng quá bán (< 35) hoặc xuất hiện mô hình nến đảo chiều (Pinbar rút chân, nến nhấn chìm) -> CHỦ ĐỘNG RA TÍN HIỆU BUY SCALP để ăn nhịp hồi 4 - 6 USD.
   • Khi nào mới chọn "action": "HOLD"?
     - CHỈ CHỌN HOLD khi thị trường hoàn toàn tắc nghẽn biên độ dưới 1 USD, nến doji liên tục hoặc giật 2 đầu không có hướng.

Xuất theo đúng mẫu ngắn gọn sau:

[XAU/USD] Giá: ${priceHeader}
Khung: H4 - H1 - M15 - M5 - M1 | ${now}

1. CẤU TRÚC:
• Xu hướng: [Tăng / Giảm / Đi ngang]
• Đảo chiều: [Có / Không] - [Chi tiết ngắn nếu có]
• Cản vi mô M5/M1: Trên [Mức giá] | Dưới [Mức giá]
• RSI(14): M15 [x] | M5 [x] | M1 [x]

2. KẾ HOẠCH GIAO DỊCH:
• Scalp M1: [BUY / SELL / CHỜ] quanh [Giá] | SL [Giá] | TP [Giá]
• Scalp M5: [BUY / SELL / CHỜ] quanh [Giá] | SL [Giá] | TP [Giá]
• Hold H1: [BUY / SELL / CHỜ] quanh [Giá] | SL [Giá] | TP [Giá]
• Lưu ý: [Ghi chú ngắn dưới 6 từ]

3. TÍN HIỆU MT5 (Scalp: SL 4 giá, TP 6 giá; Hold dài: SL 8 giá, TP 18 giá):
\`\`\`json
{
  "action": "BUY" | "SELL" | "HOLD",
  "trade_style": "SCALP" | "HOLD",
  "trend": "UP" | "DOWN" | "SIDEWAY",
  "reversal_detected": false,
  "reversal_reason": "",
  "symbol": "XAUUSD",
  "entry": <mức giá số hiện tại>,
  "sl": <mức giá cắt lỗ, hoặc 0 nếu HOLD>,
  "tp": <mức giá chốt lời, hoặc 0 nếu HOLD>,
  "timeframe": "M5",
  "reason": "<dưới 6 từ>",
  "confidence": <số từ 75 đến 95>
}
\`\`\`
`;

  contents.push(prompt);

  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.8-flash',
    'gemini-3.6-flash',
    'gemini-3.5-flash',
    'gemini-3.7-flash'
  ];
  let lastError = null;

  for (const model of candidateModels) {
    try {
      console.log(`[AIAnalyst] Đang gửi các biểu đồ nến tới Gemini Vision (${model})...`);
      const response = await ai.models.generateContent({
        model: model,
        contents: contents
      });
      if (response && response.text) {
        return response.text;
      }
    } catch (err) {
      console.warn(`[AIAnalyst] Model ${model} gặp lỗi: ${err.message?.slice(0, 80)}, thử model kế tiếp...`);
      lastError = err;
    }
  }

  throw lastError || new Error('Tất cả các model Gemini đều không khả dụng lúc này.');
}
