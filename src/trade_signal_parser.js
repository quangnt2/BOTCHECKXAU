/**
 * TRADE SIGNAL PARSER
 * Trích xuất và chuẩn hóa tín hiệu giao dịch từ nội dung phân tích của Gemini AI
 */

/**
 * @typedef {Object} TradeSignal
 * @property {string} id Mã định danh tín hiệu
 * @property {string} symbol Cặp tiền (mặc định XAUUSD)
 * @property {'BUY' | 'SELL' | 'HOLD'} action Hành động
 * @property {'MARKET' | 'LIMIT'} orderType Loại lệnh
 * @property {number} entry Giá vào lệnh
 * @property {number} sl Giá dừng lỗ (Stop Loss)
 * @property {number} tp Giá chốt lời (Take Profit)
 * @property {number} rr Tỷ lệ Risk : Reward
 * @property {number} lot Khối lượng dự kiến (tính toán sau bởi Risk Manager)
 * @property {string} timeframe Khung thời gian tín hiệu (M15, H1)
 * @property {string} reason Lý do vào lệnh ngắn gọn
 * @property {number} confidence Độ tin cậy (0 - 100%)
 * @property {string} timestamp Thời gian sinh tín hiệu (ISO)
 * @property {'GENERATED' | 'APPROVED' | 'QUEUED' | 'EXECUTING' | 'FILLED' | 'REJECTED'} status Trạng thái
 */

/**
 * Trích xuất tín hiệu giao dịch từ văn bản phân tích của Gemini
 * @param {string} analysisText Văn bản trả về từ Gemini
 * @param {number|null} currentPrice Giá thị trường hiện tại
 * @returns {TradeSignal|null}
 */
export function parseTradeSignal(analysisText, currentPrice = null) {
  if (!analysisText || typeof analysisText !== 'string') return null;

  let parsed = null;

  // 1. Ưu tiên tìm khối JSON được định dạng sẵn trong văn bản: ```json { ... } ```
  const jsonMatch = analysisText.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonMatch && jsonMatch[1]) {
    try {
      parsed = JSON.parse(jsonMatch[1]);
    } catch (e) {
      // JSON format lỗi, tiếp tục fallback regex
    }
  }

  // 2. Nếu không có khối ```json```, tìm trực tiếp object { "action": ... }
  if (!parsed) {
    const rawJsonMatch = analysisText.match(/\{\s*"action"\s*:\s*"(BUY|SELL|HOLD)"[\s\S]*?\}/i);
    if (rawJsonMatch) {
      try {
        parsed = JSON.parse(rawJsonMatch[0]);
      } catch (e) {}
    }
  }

  // 3. Fallback: Dùng Regex quét từ văn bản thông thường
  if (!parsed) {
    parsed = extractSignalWithRegex(analysisText, currentPrice);
  }

  if (!parsed) {
    return null;
  }

  const action = (parsed.action || 'HOLD').toUpperCase();
  const isTradeAction = (action === 'BUY' || action === 'SELL');

  const entry = Number(parsed.entry || currentPrice || 0);
  const sl = Number(parsed.sl || 0);
  const tp = Number(parsed.tp || 0);

  // Tính tỷ lệ Risk : Reward (nếu có lệnh giao dịch)
  let rr = 0;
  if (isTradeAction && entry > 0 && sl > 0 && tp > 0) {
    const risk = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    rr = risk > 0 ? Number((reward / risk).toFixed(2)) : 0;
  }

  // Trích xuất xu hướng từ JSON hoặc văn bản phân tích
  let trend = parsed.trend ? String(parsed.trend).toUpperCase() : null;
  if (!trend || (trend !== 'UP' && trend !== 'DOWN' && trend !== 'SIDEWAY')) {
    const trendMatch = analysisText.match(/(?:Xu hướng|H4\/H1|H4)\s*:\s*([^\n\r\|•]+)/i);
    if (trendMatch && trendMatch[1]) {
      const raw = trendMatch[1].trim().toLowerCase();
      if (raw.includes('giam') || raw.includes('down') || raw.includes('bear')) {
        trend = 'DOWN';
      } else if (raw.includes('tang') || raw.includes('up') || raw.includes('bull')) {
        trend = 'UP';
      } else if (raw.includes('ngang') || raw.includes('sideway') || raw.includes('range')) {
        trend = 'SIDEWAY';
      }
    }
  }

  // Trích xuất dấu hiệu đảo chiều xu hướng
  let reversalDetected = Boolean(parsed.reversal_detected === true || parsed.reversal_detected === 'true');
  let reversalReason = parsed.reversal_reason || '';
  if (!reversalDetected) {
    const revMatch = analysisText.match(/(?:Đảo chiều|Dao chieu)\s*:\s*(Có|Co|True|Yes)([^\n\r•]+)?/i);
    if (revMatch) {
      reversalDetected = true;
      reversalReason = revMatch[2] ? revMatch[2].replace(/^[\s\-:]+/, '').trim() : 'Đảo chiều cấu trúc nến';
    }
  }

  const signalId = `sig_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  const tf = (parsed.timeframe || 'M5').toUpperCase();
  const rawStyle = parsed.trade_style ? String(parsed.trade_style).toUpperCase() : null;
  const tradeStyle = (rawStyle === 'HOLD' || rawStyle === 'SWING' || ['H1', 'H4', 'D1'].includes(tf)) ? 'HOLD' : 'SCALP';

  return {
    id: signalId,
    symbol: (parsed.symbol || 'XAUUSD').replace(/[^a-zA-Z0-9]/g, '').toUpperCase(),
    action,
    orderType: parsed.orderType || 'MARKET',
    entry,
    sl,
    tp,
    rr,
    lot: 0.01, // Mặc định, sẽ được Risk Manager gán lại
    timeframe: tf,
    tradeStyle,
    reason: parsed.reason || (isTradeAction ? `Tín hiệu ${tradeStyle}` : 'Thị trường quan sát'),
    confidence: Number(parsed.confidence) || 75,
    trend: trend || 'SIDEWAY',
    h4Trend: trend || 'SIDEWAY',
    reversalDetected,
    reversalReason,
    timestamp: new Date().toISOString(),
    status: isTradeAction ? 'GENERATED' : 'HOLD'
  };
}

/**
 * Trích xuất tín hiệu dự phòng bằng Regex
 */
function extractSignalWithRegex(text, currentPrice) {
  let action = null;
  if (/Khuyến nghị\s*:\s*(BUY|MUA)/i.test(text) || /KÈO SCALP.*?:\s*(BUY|MUA)/i.test(text)) {
    action = 'BUY';
  } else if (/Khuyến nghị\s*:\s*(SELL|BÁN)/i.test(text) || /KÈO SCALP.*?:\s*(SELL|BÁN)/i.test(text)) {
    action = 'SELL';
  }

  if (!action) return null;

  // Trích xuất Entry
  let entry = currentPrice;
  const entryMatch = text.match(/Entry\s*:\s*([\d.]+)/i);
  if (entryMatch) entry = parseFloat(entryMatch[1]);

  // Trích xuất SL
  let sl = null;
  const slMatch = text.match(/SL\s*:\s*([\d.]+)/i);
  if (slMatch) sl = parseFloat(slMatch[1]);

  // Trích xuất TP
  let tp = null;
  const tpMatch = text.match(/TP\s*:\s*([\d.]+)/i);
  if (tpMatch) tp = parseFloat(tpMatch[1]);

  return {
    action,
    entry,
    sl,
    tp,
    timeframe: 'M5',
    reason: 'Trích xuất tự động từ phân tích Scalp',
    confidence: 70
  };
}
