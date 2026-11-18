import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import dotenv from 'dotenv';
import { getCurrentICTSession } from './session_helper.js';
dotenv.config();

/**
 * Gọi Gemini generateContent có giới hạn timeout để tránh treo chu kỳ quét vĩnh viễn
 */
async function generateContentWithTimeout(ai, model, contents, timeoutMs = 45000) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout sau ${timeoutMs / 1000}s khi gọi model ${model}`));
    }, timeoutMs);
  });

  try {
    const response = await Promise.race([
      ai.models.generateContent({ model, contents }),
      timeoutPromise
    ]);
    clearTimeout(timer);
    return response;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

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

  const sessionInfo = getCurrentICTSession();

  const prompt = `
Bạn là Chuyên gia Phân tích Kỹ thuật & Giao dịch Đa Khung Thời Gian XAU/USD Cấp Cao kết hợp Phương pháp ICT (Inner Circle Trader) và Hệ thống Định lượng Perry J. Kaufman (Trading Systems and Methods).
Dữ liệu đầu vào: Các ảnh biểu đồ H4, H1, M15, M5 và M1.
Giá hiện tại: ${priceInfo ? priceInfo.price + ' USD' : 'Xem chart'}.
Thời gian: ${now} | Giờ NY: ${sessionInfo.nyTimeStr} | ${sessionInfo.sessionName}
Hướng dẫn phiên: ${sessionInfo.tradingGuidance} ${sessionInfo.isMacroActive ? '| ĐANG TRONG ICT MACRO WINDOW: ' + sessionInfo.macroWindow : ''}

QUY TẮC BẮT BUỘC (KỶ LUẬT THÉP & QUẢN TRỊ RỦI RO):
- CÂU TỪ CỰC KỲ NGẮN GỌN (Mỗi dòng tối đa 4 - 8 từ, không viết văn giải thích dài dòng).
- TUYỆT ĐỐI KHÔNG dùng bất kỳ emoji / icon nào.

I. NGUYÊN LÝ CỐT LÕI ICT (INNER CIRCLE TRADER):
1. THUẬT TOÁN DỊCH CHUYỂN GIÁ: Giá CHỈ di chuyển vì 2 lý do: (a) Quét thanh khoản (Sweep Liquidity - ERL) và (b) Cân bằng khoảng trống giá trị hợp lý (Fair Value Gap - IRL). Chu kỳ: ERL -> IRL -> ERL.
2. DEALING RANGE & PD ARRAY (PREMIUM VS DISCOUNT & XU HƯỚNG TIẾP DIỄN):
   - Xác định Dealing Range: Swing High (đã quét thanh khoản) và Swing Low (đã quét thanh khoản).
   - Vùng PREMIUM (> 50% Dealing Range): Vùng giá đắt.
     + Trong cấu trúc Sideway hoặc thị trường giằng co: Ưu tiên tìm lệnh SELL về Discount IRL/SSL. Cấm Buy ở đỉnh range.
     + Trong SIÊU XU HƯỚNG TĂNG MẠNH (H4 UP, TRENDING_LOW_NOISE): ĐƯỢC PHÉP BUY SCALP M5/M15 theo đà tiếp diễn (retest FVG/OB nhỏ M5/M15) để ăn nhịp mở rộng thanh khoản (BSL) lên đỉnh mới, chọn "trade_style": "SCALP", SL ATR 6-8 giá, TP 10-15 giá. Chỉ cấm BUY nếu RSI H1 > 80 hoặc xuất hiện phân kỳ đỉnh.
   - Vùng DISCOUNT (< 50% Dealing Range): Vùng giá rẻ.
     + Trong cấu trúc Sideway hoặc thị trường giằng co: Ưu tiên tìm lệnh BUY về Premium IRL/BSL. Cấm Sell ở đáy range.
     + Trong SIÊU XU HƯỚNG GIẢM MẠNH (H4 DOWN, TRENDING_LOW_NOISE): ĐƯỢC PHÉP SELL SCALP M5/M15 theo đà tiếp diễn, chọn "trade_style": "SCALP".
3. CÁC MÔ HÌNH THIẾT LẬP LỆNH XÁC SUẤT CAO (ĐẦY ĐỦ PD ARRAY):
   - "UNICORN": Hợp lưu đỉnh cao giữa Breaker Block (BB) và Fair Value Gap (FVG) nằm kẹp bên trong. ĐIỀU KIỆN BẮT BUỘC: Giá phải đã quét BSL (xu hướng SELL) hoặc SSL (xu hướng BUY) trước đó rồi mới hình thành BB+FVG.
   - "OTE": Optimal Trade Entry khi giá hồi sâu vào vùng Fibonacci 0.62 - 0.705 - 0.79 kết hợp chạm FVG hoặc Order Block (OB). TP1 đặt tại Fib -0.27, TP2 tại Fib -0.62 tính từ Swing Low/High của displacement move.
   - "OB_PULLBACK": Giá retest Bullish/Bearish Order Block sau đợt bùng nổ phá vỡ cấu trúc (MSS với Displacement). OB chỉ dùng 1 lần duy nhất (Mitigation), không dùng lại lần 2. Phải có FVG đi kèm trong vùng OB.
   - "IFVG": Inversion Fair Value Gap khi FVG cũ bị nến thân lớn đâm xuyên hoàn toàn (đóng cửa vượt qua toàn bộ FVG), quay lại retest biến thành hỗ trợ/kháng cự. Mạnh hơn FVG một bậc. IFVG sau Failed MSS là tín hiệu bẫy thanh khoản uy lực nhất. Có 3 điều kiện dùng IFVG: (1) IFVG ở Premium Zone, (2) IFVG ở Discount Zone, (3) IFVG sau Failed MSS.
   - "LIQUIDITY_SWEEP": Râu nến thọc qua đỉnh/đáy cũ quét SL (Turtle Soup) rồi rút chân đóng nến ngược lại trong vùng Dealing Range.
   - "LIQUIDITY_VOID": Vùng giá bị bỏ trống lớn do nhiều cây nến liên tiếp cùng chiều không có hồi (chứa nhiều FVG bên trong). Giá sẽ quay lại fill đến ít nhất mức Consequent Encroachment 50% của Void trước khi phản ứng. Tìm buy/sell setup BÊN TRONG Void khi giá reprice về.
   - "MITIGATION_BLOCK": Order Block đã bị giá test fail lần 1 (không giữ được giá), nhưng giá sau đó quay lại vùng này lần 2. Thể hiện lực tổ chức còn lại, dùng như điểm entry thứ cấp sau OB fail.
   - "NWOG": New Week Opening Gap - Khoảng trống giá giữa giá đóng cửa thứ 6 và giá mở cửa Chủ nhật (Sunday open). Là vùng mất cân bằng được fill ưu tiên đầu tuần. Chú ý NWOG giữa tuần vẫn chưa được fill.
   - "NDOG": New Day Opening Gap - Khoảng trống giá tại NY Midnight Open (00:00 NY = 12:00 trưa VN). Ưu tiên fill trong phiên ngày hôm đó.

II. NGUYÊN LÝ ĐỊNH LƯỢNG KAUFMAN (TRADING SYSTEMS AND METHODS):
1. BỘ LỌC NHIỄU & EFFICIENCY RATIO (KER):
   - ER = |Giá thay đổi ròng| / Tổng các bước sóng nến.
   - Nếu thị trường giằng co, nến chồng chéo, râu hai đầu, nhiễu cao (CHOP_HIGH_NOISE, ER < 0.30): KHÔNG ĐÁNH BREAKOUT, BẮT BUỘC CHỌN "action": "HOLD"!
   - Nếu nến có thân lớn, lực đẩy dứt khoát theo một hướng (TRENDING_LOW_NOISE, ER >= 0.55): Ưu tiên đánh thuận xu hướng tiếp diễn.
2. ĐA KHUNG THỜI GIAN ĐỒNG PHA - ELDER'S TRIPLE SCREEN ĐẦY ĐỦ 3 LỚP:
   - LỚP 1 - H4 (Thủy triều - Xu hướng chủ đạo): Xác định hướng giao dịch tổng thể UP/DOWN/SIDEWAY. Chỉ giao dịch thuận chiều H4.
   - LỚP 2 - H1 (Con sóng - Oscillator Filter): Dùng RSI(14) H1 làm bộ lọc oscillator. BUY chỉ khi RSI H1 đang DƯỚI 70 (không mua khi đang Overbought). SELL chỉ khi RSI H1 đang TRÊN 30 (không bán khi đang Oversold). Nếu RSI H1 > 75 (BUY) hoặc < 25 (SELL): giảm confidence 15%, ưu tiên chờ RSI hồi về trung tính.
   - LỚP 3 - M15/M5 (Entry Trigger): Sau khi H4 và H1 đồng pha, tìm setup kích hoạt MSS/Unicorn/OTE/IFVG trên M15/M5 để vào lệnh chính xác.
   - Nếu H4 và H1 xung đột hoặc Sideway -> "action": "HOLD". Không vào lệnh khi thiếu đồng pha.
3. DỪNG LỖ & CHỐT LỜI CẤU TRÚC (KAUFMAN ON STOPS - ATR-BASED VOLATILITY):
   - Stop Loss (SL) ATR-Based: Đặt ngoài điểm vô hiệu hóa cấu trúc (ngoài đáy/đỉnh OB, BB hoặc Swing Point + vùng đệm nhiễu). Ưu tiên tính theo biến động thực: SL = 1.5x đến 2.0x ATR(14) M15. Khoảng cách SL từ 8.0 đến 18.0 giá. TUYỆT ĐỐI KHÔNG ĐẶT SL QUÁ NGẮN (< 8 giá) DỄ BỊ CÁ MẬP QUÉT RÂU!
   - TP1 (Chốt lời một phần): Tại FVG đối diện gần nhất / mức Fib -0.27 (khoảng 15-20 giá).
   - TP2 (Mục tiêu chính - giữ lệnh về đích): Tại vùng thanh khoản ERL (BSL/SSL đỉnh/đáy cũ) / mức Fib -0.62 (từ 20-35 giá, R:R >= 1:1.8 - 1:2.5).
4. KAUFMAN THEORY OF RUNS (Lý thuyết chuỗi thua lỗ):
   - Mỗi lệnh là độc lập, xác suất không tích lũy. Sau chuỗi thua >= 3 lệnh liên tiếp: BẮT BUỘC giảm confidence xuống dưới 80 để bot kích hoạt cooldown bảo vệ.
   - Không đuổi lệnh, không tăng size để gỡ lỗ. Kỷ luật là tài sản.

Xuất theo đúng mẫu ngắn gọn sau:

[XAU/USD] Giá: ${priceHeader}
Khung: H4 - H1 - M15 - M5 - M1 | ${now}
Phiên: ${sessionInfo.sessionName} (${sessionInfo.nyTimeStr} NY)

1. CẤU TRÚC ICT & KAUFMAN:
• Xu hướng H4/H1: [Tăng / Giảm / Đi ngang] | Nhiễu ER: [Thấp Trend / Cao Sideway]
• RSI(14): H4 [x] | H1 [x] | M15 [x] | Oscillator H1: [Oversold / Overbought / Trung tính]
• Dealing Range: Đỉnh [Mức giá BSL] - Đáy [Mức giá SSL] | Vị thế: [Discount / Premium / Equilibrium]
• Vùng FVG/IRL: [Vị trí FVG hoặc IFVG gần nhất và mức CE 50%]
• Liquidity Void: [Có vùng giá [x-y] / Không] | NWOG: [x / Không] | NDOG: [x / Không]
• Cụm cản & OB/BB/MB: [Vùng Order Block / Breaker Block / Mitigation Block / EMA 34/89]

2. KẾ HOẠCH GIAO DỊCH:
• Setup ICT: [UNICORN / OTE / OB_PULLBACK / IFVG / LIQUIDITY_SWEEP / LIQUIDITY_VOID / MITIGATION_BLOCK / NWOG / NDOG / CHỜ]
• Hold H1/H4: [BUY / SELL / CHỜ] quanh [Giá] | SL [Giá] (ATR-based) | TP1 [Giá] | TP2 [Giá] (ERL)
• Scalp M15: [BUY / SELL / CHỜ] quanh [Giá] | SL [Giá] | TP [Giá]
• Lưu ý: [Ghi chú ngắn dưới 6 từ]

3. TÍN HIỆU MT5 (Cấu trúc ICT & Kaufman, R:R >= 1:1.8):
\`\`\`json
{
  "action": "BUY" | "SELL" | "HOLD",
  "trade_style": "HOLD" | "SCALP",
  "trend": "UP" | "DOWN" | "SIDEWAY",
  "setup_model": "UNICORN" | "OTE" | "OB_PULLBACK" | "IFVG" | "LIQUIDITY_SWEEP" | "LIQUIDITY_VOID" | "MITIGATION_BLOCK" | "NWOG" | "NDOG" | "NONE",
  "pda_zone": "DISCOUNT" | "PREMIUM" | "EQUILIBRIUM",
  "market_regime": "TRENDING_LOW_NOISE" | "CHOP_HIGH_NOISE" | "SWEEP_REVERSAL",
  "session_killzone": "${sessionInfo.sessionCode}",
  "efficiency_ratio_est": <số từ 0.1 đến 0.95>,
  "h1_rsi": <số RSI H1 ước tính từ 0-100>,
  "h1_oscillator_filter": "OVERSOLD" | "OVERBOUGHT" | "NEUTRAL",
  "reversal_detected": false,
  "reversal_reason": "",
  "symbol": "XAUUSD",
  "entry": <mức giá số hiện tại>,
  "sl": <mức giá cắt lỗ theo cấu trúc invalidation ATR-based, hoặc 0 nếu HOLD>,
  "tp": <mức giá chốt lời TP2 theo mục tiêu thanh khoản ERL/Fib-0.62, hoặc 0 nếu HOLD>,
  "tp1": <mức giá chốt lời TP1 tại FVG đối diện/Fib-0.27, hoặc 0 nếu HOLD>,
  "timeframe": "H1",
  "reason": "<dưới 6 từ>",
  "confidence": <số từ 75 đến 95>
}
\`\`\`
`;

  contents.push(prompt);

  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash'
  ];
  let lastError = null;

  for (const model of candidateModels) {
    try {
      console.log(`[AIAnalyst] Đang gửi các biểu đồ nến tới Gemini Vision (${model})...`);
      const response = await generateContentWithTimeout(ai, model, contents, 45000);
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

/**
 * Phân tích chuyên biệt SCALPING M1 liên tục cho Vàng XAU/USD
 * @param {Array<{ tf: string, path: string }>} chartImages Danh sách ảnh M1 (hoặc M5 + M1)
 * @param {{ price: string, change: string, high: string, low: string } | null} priceInfo Giá hiện tại
 * @param {{ tpUSD?: number, slUSD?: number }} scalpConfig Cấu hình TP (2-3 USD) và SL (7 USD)
 * @returns {Promise<string>} Báo cáo phân tích và khối JSON lệnh Scalp M1
 */
export async function analyzeM1ScalpChart(chartImages, priceInfo = null, scalpConfig = {}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Chưa cấu hình GEMINI_API_KEY trong file .env');
  }

  const ai = new GoogleGenAI({ apiKey });
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

  const tpUSD = Number(scalpConfig.tpUSD || process.env.SCALP_M1_TP_USD || 5.0);
  const slUSD = Number(scalpConfig.slUSD || process.env.SCALP_M1_SL_USD || 5.0);
  const h4Trend = scalpConfig.h4Trend || 'SIDEWAY';
  const h4TrendText = h4Trend === 'DOWN' ? 'GIẢM (DOWNTREND)' : h4Trend === 'UP' ? 'TĂNG (UPTREND)' : 'ĐI NGANG (SIDEWAY)';
  const curPriceStr = priceInfo?.price ? priceInfo.price : 'Xem chart';
  const curPriceNum = priceInfo?.price ? parseFloat(priceInfo.price) : 0;
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });

  const prompt = `
Bạn là Chuyên gia Scalping M1 Cấp Cao cho Vàng (XAU/USD).
Nhiệm vụ: Tìm kiếm cơ hội vào lệnh SCALP ngắn hạn khung M1 (kết hợp M5) TUÂN THỦ 100% XU HƯỚNG LỚN H4/H1.
Mục tiêu cấu hình:
- Take Profit (TP): ${tpUSD.toFixed(1)} USD
- Stop Loss (SL): ${slUSD.toFixed(1)} USD
- Giá hiện tại: ${curPriceStr} USD
- Thời gian: ${now}
- XU HƯỚNG CHỦ ĐẠO H4/H1: ${h4TrendText}

QUY TẮC ĐỒNG PHA XU HƯỚNG (KỶ LUẬT BẮT BUỘC):
1. NGUYÊN TẮC THUẬN XU HƯỚNG:
   - Nếu H4/H1 là GIẢM (DOWN): TUYỆT ĐỐI CẤM BUY. Chỉ tìm điểm SELL khi nến M1 hồi lên EMA 34/89, nến rút râu trên hoặc bị từ chối kháng cự. Nếu không có setup SELL đẹp, BẮT BUỘC chọn "HOLD"!
   - Nếu H4/H1 là TĂNG (UP): TUYỆT ĐỐI CẤM SELL. Chỉ tìm điểm BUY khi nến M1 hồi về EMA 34/89, nến rút chân pinbar hoặc bật tăng hỗ trợ. Nếu không có setup BUY đẹp, BẮT BUỘC chọn "HOLD"!
   - Nếu H4/H1 là ĐI NGANG (SIDEWAY): Ưu tiên "HOLD", chỉ giao dịch khi nến test biên cực trị.
2. NẾU THỊ TRƯỜNG ĐANG NÉN HOẶC NHIỄU GIẰNG CO KHÔNG RÕ RÀNG:
   - Chọn "action": "HOLD". Không cố vào lệnh khi không có setup sạch.
3. KHỐI LƯỢNG LỆNH & QUẢN TRỊ RỦI RO:
   - "trade_style": "SCALP_M1"
   - "timeframe": "M1"
   - Nếu BUY: entry = ${curPriceNum > 0 ? curPriceNum : '<giá>'}, sl = entry - ${slUSD.toFixed(1)}, tp = entry + ${tpUSD.toFixed(1)}
   - Nếu SELL: entry = ${curPriceNum > 0 ? curPriceNum : '<giá>'}, sl = entry + ${slUSD.toFixed(1)}, tp = entry - ${tpUSD.toFixed(1)}
   - Nếu HOLD: entry = 0, sl = 0, tp = 0

Xuất báo cáo cực ngắn và khối JSON chuẩn:
[SCALP M1] Giá: ${curPriceStr} | ${now}
• Nhịp M1: [Tăng / Giảm / Đi ngang]
• Setup: [Pullback EMA / Phá vỡ đỉnh đáy / Bật RSI / Đang nén]
• Tín hiệu: [BUY / SELL / HOLD]

\`\`\`json
{
  "action": "BUY" | "SELL" | "HOLD",
  "trade_style": "SCALP_M1",
  "timeframe": "M1",
  "trend": "${h4Trend}",
  "h4_trend": "${h4Trend}",
  "symbol": "XAUUSD",
  "entry": ${curPriceNum > 0 ? curPriceNum : '<giá hiện tại>'},
  "sl": <giá cắt lỗ cách ${slUSD.toFixed(1)} giá, hoặc 0 nếu HOLD>,
  "tp": <giá chốt lời cách ${tpUSD.toFixed(1)} giá, hoặc 0 nếu HOLD>,
  "reason": "<dưới 6 từ>",
  "confidence": <số từ 75 đến 95>
}
\`\`\`
`;

  contents.push(prompt);

  const candidateModels = [
    'gemini-3.5-flash-lite',
    'gemini-3.5-flash',
    'gemini-3.6-flash',
    'gemini-3.7-flash',
    'gemini-3.8-flash'
  ];
  let lastError = null;

  for (const model of candidateModels) {
    try {
      console.log(`[ScalpM1-AI] Đang phân tích biểu đồ M1 với Gemini Vision (${model})...`);
      const response = await generateContentWithTimeout(ai, model, contents, 30000);
      if (response && response.text) {
        return response.text;
      }
    } catch (err) {
      console.warn(`[ScalpM1-AI] Model ${model} gặp lỗi: ${err.message?.slice(0, 80)}, thử model kế tiếp...`);
      lastError = err;
    }
  }

  throw lastError || new Error('Tất cả các model Gemini đều không khả dụng lúc này.');
}
