/**
 * AI TELEGRAM MESSAGE INTERPRETER (Google Gemini)
 * Tự động phân tích ngôn ngữ tự nhiên từ tin nhắn nhóm VIP Telegram
 * Bóc tách hành động: Hủy lệnh chờ, Dời SL hòa vốn (BE), Đóng lệnh tay, Chốt 1 phần, Cập nhật SL/TP
 */

import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config();

// Bỏ qua lỗi SSL certificate do antivirus/proxy trên máy Windows
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const candidateModels = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.7-flash'
];

/**
 * Phân tích tin nhắn Telegram bằng Gemini AI
 * @param {Object} params
 * @param {string} params.text Nội dung tin nhắn từ nhóm
 * @param {string} [params.sourceChat] Tên kênh/nhóm gửi tin nhắn
 * @param {Array} [params.pendingOrders] Danh sách lệnh chờ hiện tại trên MT5
 * @param {Array} [params.openPositions] Danh sách vị thế đang mở trên MT5
 * @param {function(string): void} [params.logger]
 * @returns {Promise<Object>} Kết quả phân tích hành động
 */
export async function interpretChannelMessageWithAI({
  text,
  sourceChat = 'Kênh Telegram',
  pendingOrders = [],
  openPositions = [],
  logger = console.log
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    logger('[AI Interpreter] ⚠️ Chưa cấu hình GEMINI_API_KEY. Bỏ qua phân tích AI.');
    return { action: 'NO_ACTION', confidence: 0, reason: 'Chưa cấu hình GEMINI_API_KEY' };
  }

  // Lọc nhanh những tin nhắn quá ngắn hoặc spam rõ ràng
  const trimmed = (text || '').trim();
  if (trimmed.length < 3) {
    return { action: 'NO_ACTION', confidence: 0, reason: 'Tin nhắn quá ngắn' };
  }

  const ai = new GoogleGenAI({ apiKey });

  const prompt = `
Bạn là Trợ lý AI Chuyên gia Phân tích Tín hiệu Giao dịch & Quản lý Lệnh XAU/USD (Vàng).
Nhiệm vụ của bạn: Đọc tin nhắn mới từ Admin kênh Telegram bắn kèo, hiểu ngữ cảnh và phân loại hành động cần thực thi trên phần mềm giao dịch MT5.

Tin nhắn từ Admin [${sourceChat}]:
"""
${trimmed}
"""

Trạng thái giao dịch hiện tại trên MT5:
- Lệnh chờ (Pending Limit): ${JSON.stringify(pendingOrders)}
- Vị thế đang chạy (Open Positions): ${JSON.stringify(openPositions)}

HÃY PHÂN LOẠI TIN NHẮN VÀO ĐÚNG 1 TRONG CÁC HÀNH ĐỘNG DƯỚI ĐÂY:
1. "CANCEL_PENDING": Admin yêu cầu hủy lệnh chờ limit, hủy kèo, xóa entry chưa khớp, giá không về vùng entry nên bỏ.
   Ví dụ: "Hủy kèo Buy Limit nhé", "Hủy Buy 3928", "Xóa lệnh limit", "Cancel pending order", "Hủy kèo vàng", "Bỏ lệnh chờ nhé".
2. "MOVE_SL_BE": Admin yêu cầu dời Stop Loss về điểm hòa vốn (Breakeven / Entry) để bảo toàn vốn.
   Ví dụ: "Dời SL về hòa nhé ae", "Dời SL về BE", "Kéo SL về entry", "Set breakeven", "Bảo toàn vốn kéo sl về giá vào".
3. "CLOSE_POSITION": Admin yêu cầu đóng/cắt lệnh ngay lập tức bằng tay, thoát vị thế đang chạy.
   Ví dụ: "Cắt tay lệnh Buy", "Cắt hòa/cắt lỗ tay đi", "Đóng hết vị thế", "Close now", "Exit trade", "Tin ra xấu cắt tay thôi mọi người".
4. "CLOSE_PARTIAL": Admin yêu cầu chốt bớt 1 phần khối lượng (50%, 1/2...).
   Ví dụ: "Chốt 50% volume gồng tiếp", "Chốt 1 nửa", "Chốt bớt lãi hạ volume".
5. "UPDATE_SL_TP": Admin thay đổi mốc SL hoặc TP cụ thể.
   Ví dụ: "Dời SL về 3925 nhé", "Nâng TP lên 3970", "SL mới: 3920".
6. "NEW_SIGNAL": Admin bắn 1 tín hiệu vào lệnh mới dạng văn xuôi tự nhiên.
   Ví dụ: "Canh Buy Vàng vùng 3925-3928, SL 3915, TP 3950".
7. "NO_ACTION": Tin nhắn chào hỏi, chúc mừng PnL, thảo luận thị trường, gửi ảnh, nhận định không kèm hành động cụ thể.
   Ví dụ: "Chào buổi sáng ae", "Vàng bay đẹp quá", "Đã húp TP1 nhé" (chỉ khoe kết quả), "Nay tin CPI ae cẩn thận".

QUY TẮC PHẢN HỒI:
- BẮT BUỘC chỉ trả về 1 chuỗi JSON hợp lệ duy nhất, KHÔNG viết bất kỳ chữ nào khác ngoài JSON.

\`\`\`json
{
  "action": "CANCEL_PENDING" | "MOVE_SL_BE" | "CLOSE_POSITION" | "CLOSE_PARTIAL" | "UPDATE_SL_TP" | "NEW_SIGNAL" | "NO_ACTION",
  "confidence": <số từ 0 đến 100>,
  "symbol": "XAUUSD",
  "target_price": <giá số hoặc null>,
  "sl": <giá số hoặc null>,
  "tp": <giá số hoặc null>,
  "percent": <số % nếu là CLOSE_PARTIAL, ví dụ 50, hoặc null>,
  "signal": {
    "action": "BUY" | "SELL" | "BUY_LIMIT" | "SELL_LIMIT",
    "entry": <giá số>,
    "sl": <giá số>,
    "tp": <giá số>
  },
  "reason": "<tóm tắt ngắn gọn dưới 20 từ lý do đưa ra hành động này>"
}
\`\`\`
`;

  let lastError = null;

  for (const model of candidateModels) {
    try {
      const response = await ai.models.generateContent({
        model: model,
        contents: prompt
      });

      const responseText = response?.text || '';
      // Trích xuất JSON từ phản hồi
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return parsed;
      }
    } catch (err) {
      lastError = err;
    }
  }

  logger(`[AI Interpreter] ⚠️ Lỗi khi gọi Gemini: ${lastError?.message?.slice(0, 80)}`);
  return { action: 'NO_ACTION', confidence: 0, reason: 'Lỗi kết nối Gemini' };
}
