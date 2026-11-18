/**
 * TELEGRAM SIGNAL PARSER
 * Bóc tách tín hiệu bắn kèo từ các nhóm/kênh Telegram sang TradeSignal chuẩn
 */

/**
 * @typedef {Object} ParsedTelegramSignal
 * @property {'BUY' | 'SELL'} action
 * @property {string} symbol
 * @property {number} entry Giá vào lệnh (nếu là vùng thì lấy mid hoặc min/max)
 * @property {number} [entryMin] Giá cận dưới vùng entry
 * @property {number} [entryMax] Giá cận trên vùng entry
 * @property {number} sl Giá dừng lỗ (Stop Loss)
 * @property {number} tp Giá chốt lời chính (ưu tiên TP1)
 * @property {number} [tp1] Mục tiêu 1
 * @property {number} [tp2] Mục tiêu 2
 * @property {number} [tp3] Mục tiêu 3
 * @property {string} rawText Tin nhắn gốc
 */

/**
 * Bóc tách tin nhắn bắn kèo từ Telegram
 * @param {string} text Nội dung tin nhắn Telegram
 * @param {number|null} currentPrice Giá thị trường hiện tại (nếu có để chọn entry tốt nhất)
 * @returns {ParsedTelegramSignal|null}
 */
export function parseTelegramSignal(text, currentPrice = null) {
  if (!text || typeof text !== 'string') return null;

  const clean = text
    .replace(/[❌✅🟢🔴🔥⚡️🎯⭐📍🚨]/g, ' ')
    .replace(/\r\n/g, '\n');

  // 1. Nhận diện Symbol (XAUUSD hoặc GOLD)
  const isGold = /XAUUSD|XAU\s*\/\s*USD|GOLD|VANG|VÀNG/i.test(clean);
  if (!isGold) {
    // Nếu tin nhắn không chứa vàng hoặc cặp tiền nào, kiểm tra xem có SL/TP rõ ràng không
    const hasSlTp = /(?:SL|STOP\s*LOSS|CẮT\s*LỖ)\s*[:=]?\s*[\d.]+/i.test(clean) &&
                    /(?:TP|TAKE\s*PROFIT|CHỐT\s*LỜI)\s*[:=]?\s*[\d.]+/i.test(clean);
    if (!hasSlTp) return null;
  }
  const symbol = 'XAUUSD';

  // 2. Nhận diện Action (BUY hoặc SELL)
  let action = null;
  if (/\b(?:BUY\s*NOW|BUY\s*LIMIT|BUY\s*STOP|BUY|MUA|LONG)\b/i.test(clean)) {
    action = 'BUY';
  } else if (/\b(?:SELL\s*NOW|SELL\s*LIMIT|SELL\s*STOP|SELL|BÁN|SHORT)\b/i.test(clean)) {
    action = 'SELL';
  }
  if (!action) return null;

  // 3. Nhận diện Entry (Đơn giá hoặc Vùng giá, ví dụ: 3927-3930 hoặc @ 3928.5)
  let entryMin = null;
  let entryMax = null;
  let entry = null;

  // Pattern vùng giá: "3927-3930" hoặc "3927 - 3930" hoặc "3927/3930"
  const rangeMatch = clean.match(/(?:BUY|SELL|NOW|ENTRY|VÀO|QUANH|ZONE|AT|@)?\s*([1-9]\d{2,4}(?:\.\d+)?)\s*(?:-|–|—|\/|TO|ĐẾN)\s*([1-9]\d{2,4}(?:\.\d+)?)/i);
  if (rangeMatch) {
    const val1 = parseFloat(rangeMatch[1]);
    const val2 = parseFloat(rangeMatch[2]);
    if (val1 > 500 && val2 > 500) {
      entryMin = Math.min(val1, val2);
      entryMax = Math.max(val1, val2);
      // Nếu có giá thị trường và giá nằm trong vùng, ưu tiên giá thị trường
      if (currentPrice && currentPrice >= entryMin && currentPrice <= entryMax) {
        entry = currentPrice;
      } else {
        entry = Number(((entryMin + entryMax) / 2).toFixed(2));
      }
    }
  }

  // Nếu không có vùng giá, tìm giá đơn: "BUY NOW XAUUSD 3928" hoặc "@ 3928.5"
  if (!entry) {
    const singleMatch = clean.match(/(?:BUY|SELL|NOW|ENTRY|VÀO|QUANH|AT|@)\s*(?:XAUUSD|GOLD)?\s*([1-9]\d{2,4}(?:\.\d+)?)/i);
    if (singleMatch) {
      const val = parseFloat(singleMatch[1]);
      if (val > 500) entry = val;
    }
  }

  // Fallback: Dùng giá hiện tại nếu tin là BUY NOW / SELL NOW mà không ghi entry
  if (!entry && currentPrice && currentPrice > 500) {
    entry = currentPrice;
  }

  // 4. Nhận diện Stop Loss (SL)
  let sl = null;
  const slMatch = clean.match(/(?:SL|STOP\s*LOSS|CẮT\s*LỖ)\s*[:=]?\s*([1-9]\d{2,4}(?:\.\d+)?)/i);
  if (slMatch) {
    sl = parseFloat(slMatch[1]);
  }

  // 5. Nhận diện Take Profit (TP1, TP2, TP3...)
  let tp1 = null;
  let tp2 = null;
  let tp3 = null;

  const tp1Match = clean.match(/(?:TP\s*1|TARGET\s*1|TP1)\s*[:=]?\s*([1-9]\d{2,4}(?:\.\d+)?)/i);
  if (tp1Match) tp1 = parseFloat(tp1Match[1]);

  const tp2Match = clean.match(/(?:TP\s*2|TARGET\s*2|TP2)\s*[:=]?\s*([1-9]\d{2,4}(?:\.\d+)?)/i);
  if (tp2Match) tp2 = parseFloat(tp2Match[1]);

  const tp3Match = clean.match(/(?:TP\s*3|TARGET\s*3|TP3)\s*[:=]?\s*([1-9]\d{2,4}(?:\.\d+)?)/i);
  if (tp3Match) tp3 = parseFloat(tp3Match[1]);

  // Nếu chỉ có 1 TP duy nhất (không chia TP1, TP2)
  let generalTp = null;
  if (!tp1) {
    const tpMatch = clean.match(/(?:TP|TAKE\s*PROFIT|CHỐT\s*LỜI)\s*[:=]?\s*([1-9]\d{2,4}(?:\.\d+)?)/i);
    if (tpMatch) generalTp = parseFloat(tpMatch[1]);
  }

  const primaryTp = tp1 || generalTp || 0;

  // Kiểm tra tính hợp lệ cơ bản
  if (!entry || !sl || !primaryTp) {
    return null;
  }

  // Logic kiểm tra hướng: BUY thì SL < Entry < TP | SELL thì SL > Entry > TP
  if (action === 'BUY' && (sl >= entry || primaryTp <= entry)) {
    // Có thể entry bị lấy nhầm, nếu sl < primaryTp thì vẫn hợp lệ
    if (sl < primaryTp) {
      // Hợp lệ logic BUY
    } else {
      return null;
    }
  }
  if (action === 'SELL' && (sl <= entry || primaryTp >= entry)) {
    if (sl > primaryTp) {
      // Hợp lệ logic SELL
    } else {
      return null;
    }
  }

  return {
    action,
    symbol,
    entry,
    ...(entryMin ? { entryMin, entryMax } : {}),
    sl,
    tp: primaryTp,
    ...(tp1 ? { tp1 } : {}),
    ...(tp2 ? { tp2 } : {}),
    ...(tp3 ? { tp3 } : {}),
    rawText: text
  };
}
