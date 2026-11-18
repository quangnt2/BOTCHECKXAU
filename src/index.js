import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { captureMultiTimeframeCharts } from './chart_capture.js';
import { analyzeMultiTimeframeCharts, analyzeM1ScalpChart } from './ai_analyst.js';
import { sendTelegramMultiReport, sendTelegramMessage, startTelegramListener } from './telegram.js';
import { getCurrentXAUPrice } from './market_data.js';
import { MT5BridgeServer } from './mt5_bridge_server.js';
import { OrderManager } from './order_manager.js';
import { formatHistoryReport, formatOpenPositions } from './order_history.js';
import { getCurrentICTSession } from './session_helper.js';
import { PriceAlertManager } from './price_alert_manager.js';
import { parseTelegramSignal } from './telegram_signal_parser.js';
import { startTelegramUserbot } from './telegram_userbot.js';
import { updateEnvFile } from './dashboard_handler.js';

// Bỏ qua lỗi SSL do proxy/antivirus trên máy tính
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Tạo thư mục logs để lưu vết hoạt động lâu dài
const logsDir = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Lấy ngày hiện tại dạng YYYY-MM-DD theo múi giờ Việt Nam
function getTodayDateStr() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Tự động dọn dẹp file log cũ: Xóa log quá 2 ngày (48 giờ)
function cleanOldLogs() {
  try {
    const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
    let deletedLogs = 0;
    files.forEach(f => {
      try {
        const filePath = path.join(logsDir, f);
        const stat = fs.statSync(filePath);
        if (f !== 'bot.log') {
          if (now - stat.mtimeMs > TWO_DAYS_MS) {
            fs.unlinkSync(filePath);
            deletedLogs++;
          }
        }
      } catch {}
    });
    if (deletedLogs > 0) {
      console.log(`[Cleaner] Đã dọn dẹp ${deletedLogs} file log cũ hơn 2 ngày.`);
    }
  } catch {}
}

function logger(msg) {
  const timeStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const logLine = `[${timeStr}] ${msg}\n`;
  const todayLogFile = path.join(logsDir, `bot_${getTodayDateStr()}.log`);
  const generalLogFile = path.join(logsDir, 'bot.log');
  try {
    fs.appendFileSync(todayLogFile, logLine);
    fs.appendFileSync(generalLogFile, logLine);
  } catch {}
  try {
    console.log(msg);
  } catch {}
}

// Bẫy lỗi toàn cục tránh crash tiến trình
process.on('uncaughtException', (err) => {
  logger(`❌ [UncaughtException]: ${err.stack || err.message}`);
});
process.on('unhandledRejection', (reason) => {
  logger(`❌ [UnhandledRejection]: ${reason?.stack || reason}`);
});

const SYMBOL = process.env.SYMBOL || 'OANDA:XAUUSD';
// 5 khung thời gian chuẩn: H4 (240), H1 (60), M15 (15), M5 (5), M1 (1) - Tối ưu Scalping M1 & M5
const TIMEFRAMES = ['240', '60', '15', '5', '1'];

let isRunning = false;
// Danh sách hàng đợi các Chat ID đang chờ nhận kết quả phân tích
const pendingSubscribers = new Set();

// Danh sách Chat ID mặc định nhận thông báo định kỳ từ .env (hỗ trợ phân tách bằng dấu phẩy)
function getDefaultChatIds() {
  return (process.env.TELEGRAM_CHAT_ID || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

// ==========================================
// KHỞI TẠO CẦU NỐI MT5 & BỘ QUẢN LÝ LỆNH
// ==========================================
const MT5_PORT = process.env.MT5_PORT || 3000;
const bridgeServer = new MT5BridgeServer({
  port: MT5_PORT,
  logger,
  onExecutionComplete: async ({ id, status, ticket, price, error, originalOrder }) => {
    const timeStr = new Date().toLocaleTimeString('vi-VN');

    // 1. Trường hợp MT5 vừa tự động dời SL về hòa vốn (Breakeven)
    if (status === 'BREAKEVEN') {
      // Trích xuất số lãi thực tế mà MT5 EA báo về (ví dụ: "SL hoa von: 4126.71 (Lai: +$2.01 USD)")
      const matchProfit = error ? error.match(/Lai:\s*([^\)]+)/) : null;
      const actualProfit = matchProfit ? matchProfit[1] : `+$${process.env.BREAKEVEN_TRIGGER_USD || '10.0'} USD`;

      const msg = [
        `🛡️ [MT5 DỜI SL HÒA VỐN]`,
        `• Ticket: #${ticket}`,
        `• Lãi thực tế lúc dời: ${actualProfit}`,
        `• Ngưỡng cấu hình (.env): ≥ +$${process.env.BREAKEVEN_TRIGGER_USD || '10.0'} USD`,
        `• SL mới đã dời về: ${price} USD (Hòa vốn + phí)`,
        `• Trạng thái: Lệnh an toàn 0% rủi ro, tiếp tục giữ về TP ${process.env.FIXED_TP_USD || '30.0'} USD`,
        `• Giờ: ${timeStr}`
      ].join('\n');
      logger(`[MT5 Bridge] 🛡️ Thông báo Telegram: Ticket #${ticket} đã dời SL về hòa vốn ${price} USD. ${actualProfit}`);
      for (const cid of getDefaultChatIds()) {
        await sendTelegramMessage(msg, cid);
      }
      return;
    }

    // 1b. Trường hợp MT5 vừa tự động dời SL khóa lãi dương (+15u -> SL dương +6u)
    if (status === 'LOCK_PROFIT') {
      const matchProfit = error ? error.match(/Lai:\s*([^\,]+)/) : null;
      const actualProfit = matchProfit ? matchProfit[1] : `+$${process.env.LOCK_PROFIT_TRIGGER_USD || '15.0'} USD`;
      const lockOffset = process.env.LOCK_PROFIT_OFFSET_USD || '6.0';

      const msg = [
        `🎯 [MT5 KHÓA LÃI DƯƠNG +${lockOffset} USD]`,
        `• Ticket: #${ticket}`,
        `• Lãi thực tế lúc dời: ${actualProfit}`,
        `• Ngưỡng kích hoạt: ≥ +$${process.env.LOCK_PROFIT_TRIGGER_USD || '15.0'} USD`,
        `• SL mới đã dời lên: ${price} USD (Dương +${lockOffset} USD)`,
        `• Trạng thái: 🔒 Đã khóa chắc $${lockOffset} USD lợi nhuận trong túi! Tiếp tục gồng về TP ${process.env.FIXED_TP_USD || '24.0'} USD`,
        `• Giờ: ${timeStr}`
      ].join('\n');
      logger(`[MT5 Bridge] 🎯 Thông báo Telegram: Ticket #${ticket} đã khóa lãi dương ${price} USD (+${lockOffset} USD). ${actualProfit}`);
      for (const cid of getDefaultChatIds()) {
        await sendTelegramMessage(msg, cid);
      }
      return;
    }

    // 2. Trường hợp MT5 vừa đóng toàn bộ vị thế khẩn cấp (Emergency Close All)
    if (status === 'CLOSED_ALL') {
      const msg = [
        `🚨 [MT5 ĐÃ ĐÓNG TOÀN BỘ VỊ THẾ KHẨN CẤP]`,
        `• Chi tiết: Đã đóng tất cả các lệnh mở trên MT5 để bảo toàn vốn`,
        `• Giờ: ${timeStr}`
      ].join('\n');
      logger(`[MT5 Bridge] 🚨 Thông báo Telegram: Đã đóng toàn bộ vị thế trên MT5.`);
      for (const cid of getDefaultChatIds()) {
        await sendTelegramMessage(msg, cid);
      }
      return;
    }

    // 3. Trường hợp MT5 vừa ngắt vị thế cụ thể thành công (do đảo chiều xu hướng)
    if (status === 'CLOSED') {
      logger(`[MT5 Bridge] ✅ MT5 đã ngắt vị thế #${ticket} thành công do đảo chiều xu hướng.`);
      return;
    }

    const isFilled = status === 'FILLED';
    if (!isFilled) {
      orderManager?.riskManager?.resetCooldown();
    }

    const msg = isFilled
      ? [
          `[MT5 KHỚP LỆNH]`,
          `• Ticket: #${ticket}`,
          `• Lệnh: ${originalOrder?.action || ''} ${originalOrder?.lot || ''} Lot ${originalOrder?.symbol || 'XAUUSD'}`,
          `• Giá: ${price} USD`,
          `• SL: ${originalOrder?.sl || '-'} | TP: ${originalOrder?.tp || '-'}`,
          `• Giờ: ${timeStr}`
        ].join('\n')
      : [
          `[MT5 THẤT BẠI]`,
          `• Lệnh: ${originalOrder?.action || ''} ${originalOrder?.lot || ''} Lot`,
          `• Lỗi: ${error || 'Lỗi sàn'}`,
          `• Giờ: ${timeStr}`
        ].join('\n');

    for (const cid of getDefaultChatIds()) {
      await sendTelegramMessage(msg, cid);
    }
  },
  onDealClosed: async (deal) => {
    const profitNum = Number(deal.profit || 0);
    const targetTp = Number(process.env.FIXED_TP_USD || 30.0);
    const profitTag = profitNum >= (targetTp * 0.9) ? `🎯 CHẠM TP (+${profitNum.toFixed(1)}U)` : profitNum >= 8.0 ? '🟢 CHỐT LỜI' : profitNum >= 0 ? '🛡️ HÒA VỐN' : '🔴 CẮT LỖ';
    const profitStr = profitNum >= 0 ? `+$${profitNum.toFixed(2)}` : `-$${Math.abs(profitNum).toFixed(2)}`;

    // Ghi nhận kết quả lệnh vào RiskManager để theo dõi chuỗi thua lỗ (Kaufman Theory of Runs)
    try {
      if (typeof orderManager !== 'undefined' && orderManager?.riskManager) {
        orderManager.riskManager.recordTradeResult(profitNum);
      }
    } catch (err) {
      logger(`[RiskManager] Lỗi ghi nhận kết quả lệnh: ${err.message}`);
    }

    const msg = [
      `[MT5 ${profitTag}]`,
      `• Ticket: #${deal.ticket}`,
      `• Lệnh: ${deal.type} ${deal.lot} Lot ${deal.symbol || 'XAUUSD'}`,
      `• Giá đóng: ${deal.price}`,
      `• Lời/Lỗ: ${profitStr} USD`,
      `• Giờ đóng: ${deal.time || new Date().toLocaleTimeString('vi-VN')}`
    ].join('\n');

    logger(`[MT5] 🔔 Lệnh #${deal.ticket} vừa đóng: ${profitStr} USD`);
    for (const cid of getDefaultChatIds()) {
      await sendTelegramMessage(msg, cid);
    }
  }
});

bridgeServer.start();

const orderManager = new OrderManager({
  bridgeServer,
  sendTelegramAlert: sendTelegramMessage,
  logger
});

// Bộ quản lý cảnh báo giá thời gian thực
const priceAlertManager = new PriceAlertManager({
  logger,
  sendTelegramAlert: async (msg) => {
    for (const cid of getDefaultChatIds()) {
      await sendTelegramMessage(msg, cid);
    }
  }
});

// Lưu vết trạng thái phân tích mới nhất phục vụ Web Dashboard
const latestAnalysisData = {
  isAnalyzing: false,
  lastAnalysisReport: null,
  lastAnalysisTime: null,
  lastAnalysisTimeStr: null,
  lastPriceInfo: null,
  lastChartImages: getLatestScreenshotsFromDisk()
};

// Kết nối dữ liệu Bot vào MT5 Bridge Server để phục vụ Web Dashboard
bridgeServer.setDashboardContext({
  getOrderManager: () => orderManager,
  getPriceAlertManager: () => priceAlertManager,
  getAnalysisState: () => latestAnalysisData,
  triggerAnalysis: (targetChatIds = null) => runMultiAnalysisCycle(targetChatIds)
});

// Quét kiểm tra cảnh báo giá thời gian thực (mỗi 3 giây)
setInterval(async () => {
  try {
    const live = bridgeServer.getLatestMarketPrice();
    if (live && live.bid > 0) {
      const mid = Number(((live.bid + live.ask) / 2 || live.bid).toFixed(2));
      await priceAlertManager.checkPrice(mid);
    }
  } catch {
    // Không làm gián đoạn luồng chính
  }
}, 3000);

/**
 * Tìm các ảnh chụp biểu đồ gần nhất trên ổ đĩa khi khởi động
 */
function getLatestScreenshotsFromDisk() {
  try {
    const sDir = path.join(__dirname, '..', 'screenshots');
    if (!fs.existsSync(sDir)) return [];
    const files = fs.readdirSync(sDir).filter(f => f.endsWith('.png'));
    if (files.length === 0) return [];
    files.sort((a, b) => {
      try {
        const aTime = fs.statSync(path.join(sDir, a)).mtimeMs;
        const bTime = fs.statSync(path.join(sDir, b)).mtimeMs;
        return bTime - aTime;
      } catch { return 0; }
    });
    const foundTfs = new Set();
    const result = [];
    for (const f of files) {
      const match = f.match(/xauusd_([A-Za-z0-9]+)_/);
      if (match) {
        const tf = match[1];
        if (!foundTfs.has(tf)) {
          foundTfs.add(tf);
          result.push({ tf, path: path.join(sDir, f) });
        }
      }
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Thực hiện 1 chu kỳ: Chụp H4, H1, M15 -> Lấy giá -> Gemini đối chiếu phân tích -> Gửi Album + Plan về Telegram
 * @param {string|number|Array<string|number>|null} targetChatIds Chat ID nhận kết quả (mặc định lấy từ env)
 */
async function runMultiAnalysisCycle(targetChatIds = null) {
  if (targetChatIds) {
    if (Array.isArray(targetChatIds)) {
      targetChatIds.forEach(id => pendingSubscribers.add(String(id)));
    } else {
      pendingSubscribers.add(String(targetChatIds));
    }
  }

  if (isRunning) {
    logger(`[Bot] Chu kỳ trước vẫn đang xử lý, đã ghi nhận [${Array.from(pendingSubscribers).join(', ')}] vào hàng đợi nhận kết quả.`);
    return;
  }
  isRunning = true;
  latestAnalysisData.isAnalyzing = true;
  cleanOldLogs();
  const now = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const ictSession = getCurrentICTSession();
  logger(`\n======================================================`);
  logger(`[${now}] BẮT ĐẦU CHU KỲ PHÂN TÍCH ĐA KHUNG THỜI GIAN...`);
  logger(`[ICT & Kaufman] ${ictSession.sessionName} (NY: ${ictSession.nyTimeStr} | VN: ${ictSession.vnTimeStr})${ictSession.isMacroActive ? ' | MACRO: ' + ictSession.macroWindow : ''}`);
  logger(`======================================================`);

  try {
    // 1. Lấy giá vàng thời gian thực (Ưu tiên MT5 -> TradingView -> Yahoo)
    const priceInfo = await getCurrentXAUPrice(SYMBOL, bridgeServer);
    if (priceInfo) {
      if (priceInfo.source === 'MT5') {
        logger(`[Market] Giá hiện tại (MT5): Bid ${priceInfo.bid} / Ask ${priceInfo.ask} (Mid: ${priceInfo.price} USD) | Spread: ${priceInfo.spread} pts | Sàn: ${priceInfo.server}`);
      } else {
        logger(`[Market] Giá hiện tại: ${priceInfo.price} USD (${priceInfo.change}) | Range ngày: ${priceInfo.low} - ${priceInfo.high} | Nguồn: ${priceInfo.server}`);
      }
      if (priceInfo.price && Number(priceInfo.price) > 0) {
        await priceAlertManager.checkPrice(Number(priceInfo.price));
      }
    }

    // 2. Chụp ảnh biểu đồ đa khung thời gian (H4, H1, M15, M5, M1)
    logger(`[1/3] Đang chụp biểu đồ ${SYMBOL} các khung H4, H1, M15, M5, M1...`);
    const chartImages = await captureMultiTimeframeCharts(SYMBOL, TIMEFRAMES);
    latestAnalysisData.lastChartImages = chartImages;

    // 3. Gửi ảnh + giá hiện tại cho Gemini Vision phân tích điểm Scalp M1/M5
    logger(`[2/3] Gemini Vision đang đối chiếu 5 biểu đồ để tìm điểm Scalp M1/M5...`);
    const analysisReport = await analyzeMultiTimeframeCharts(chartImages, priceInfo);
    latestAnalysisData.lastAnalysisReport = analysisReport;
    latestAnalysisData.lastAnalysisTime = Date.now();
    latestAnalysisData.lastAnalysisTimeStr = new Date().toLocaleTimeString('vi-VN');
    latestAnalysisData.lastPriceInfo = priceInfo;
    logger('\n--- BÁO CÁO PHÂN TÍCH KỸ THUẬT ---');
    logger(analysisReport);
    logger('----------------------------------------\n');

    // 4. Xác định danh sách người nhận kết quả
    const recipients = Array.from(pendingSubscribers);
    pendingSubscribers.clear();

    // Chỉ gửi báo cáo về Telegram nếu có người dùng yêu cầu trên Telegram
    if (recipients.length > 0) {
      logger(`[3/3] Đang gửi Album ảnh và Bảng Kế hoạch về ${recipients.length} người yêu cầu: [${recipients.join(', ')}]...`);
      for (const cid of recipients) {
        try {
          await sendTelegramMultiReport(chartImages, analysisReport, priceInfo, cid);
          logger(`[Telegram] Đã gửi báo cáo thành công về Chat ID: ${cid}`);
        } catch (sendErr) {
          logger(`[Telegram] Lỗi gửi báo cáo về Chat ID ${cid}: ${sendErr.message}`);
        }
      }
      logger(`[THÀNH CÔNG] Đã hoàn thành chu kỳ phân tích và gửi báo cáo!`);
    } else {
      logger(`[3/3] Không có yêu cầu gửi Telegram nào trong chu kỳ này (chỉ gửi khi được yêu cầu trên Tele).`);
    }

    // 5. Kiểm tra tín hiệu vào lệnh & đưa sang Cầu nối MT5
    try {
      const priceNum = (priceInfo && priceInfo.price) ? parseFloat(priceInfo.price) : null;
      await orderManager.processAnalysisResult(analysisReport, priceNum, recipients);
    } catch (orderErr) {
      logger(`[OrderManager] Lỗi xử lý tín hiệu khớp lệnh: ${orderErr.message}`);
    }

  } catch (err) {
    logger(`[LỖI CHU KỲ]: ${err.stack || err.message}`);
  } finally {
    isRunning = false;
    latestAnalysisData.isAnalyzing = false;
  }
}

// ==========================================
// TÍNH NĂNG SCALP M1 LIÊN TỤC (TP 2-3 USD, SL 7 USD)
// ==========================================
let isM1ScalpRunning = false;
let m1ScalpIntervalTimer = null;

/**
 * Thực hiện 1 chu kỳ quét và phân tích Scalp M1 liên tục
 */
async function runM1ScalpCycle() {
  if (!orderManager.enableScalpM1) return;
  if (isM1ScalpRunning || isRunning) {
    logger(`[Scalp M1] ⏳ Đang có chu kỳ phân tích khác chạy, bỏ qua nhịp quét này.`);
    return;
  }

  // Kiểm tra vị thế mở trên MT5: Nếu đang có lệnh mở, kiên nhẫn đợi lệnh chốt lời/cắt lỗ trước khi vào lệnh mới
  const unclosed = bridgeServer.checkUnclosedOrders('XAUUSD');
  if (unclosed.hasUnclosed) {
    logger(`[Scalp M1] ⏳ Đang có vị thế chạy (${unclosed.summary}). Chờ chốt TP/SL xong mới mở lệnh mới.`);
    return;
  }

  isM1ScalpRunning = true;
  try {
    const priceInfo = await getCurrentXAUPrice(SYMBOL, bridgeServer);
    if (!priceInfo || !priceInfo.price) return;

    logger(`\n[Scalp M1] ⚡ Bắt đầu chu kỳ quét M1 liên tục (TP ${orderManager.scalpM1TpUSD}U | SL ${orderManager.scalpM1SlUSD}U) | Giá: ${priceInfo.price} USD...`);

    // Chụp biểu đồ khung M5 và M1
    const chartImages = await captureMultiTimeframeCharts(SYMBOL, ['5', '1']);
    if (!chartImages || chartImages.length === 0) return;

    // Phân tích Scalp M1 bằng Gemini Vision (tuân thủ xu hướng lớn H4/H1)
    const analysisReport = await analyzeM1ScalpChart(chartImages, priceInfo, {
      tpUSD: orderManager.scalpM1TpUSD,
      slUSD: orderManager.scalpM1SlUSD,
      h4Trend: orderManager.lastH4Trend || 'SIDEWAY'
    });

    logger(`\n--- BÁO CÁO PHÂN TÍCH SCALP M1 ---`);
    logger(analysisReport);
    logger(`----------------------------------\n`);

    // Đưa kết quả vào OrderManager để kiểm duyệt và khớp lệnh
    const priceNum = parseFloat(priceInfo.price);
    await orderManager.processAnalysisResult(analysisReport, priceNum, []);
  } catch (err) {
    logger(`[Scalp M1] ❌ Lỗi chu kỳ: ${err.message}`);
  } finally {
    isM1ScalpRunning = false;
  }
}

/**
 * Khởi động bộ quét Scalp M1 liên tục
 */
function startM1ScalpLoop() {
  if (m1ScalpIntervalTimer) clearInterval(m1ScalpIntervalTimer);
  const intervalSec = Math.max(30, parseInt(process.env.SCALP_M1_INTERVAL_SEC || '60', 10));
  m1ScalpIntervalTimer = setInterval(() => {
    if (orderManager.enableScalpM1) {
      runM1ScalpCycle();
    }
  }, intervalSec * 1000);
  logger(`⚡ [Scheduler] Đã kích hoạt bộ quét Scalp M1 liên tục mỗi ${intervalSec} giây.`);
}

// Chuẩn hóa chuỗi tiếng Việt không dấu, chữ thường để nhận diện lệnh thông minh
function normalizeText(str) {
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .trim();
}

/**
 * Thực thi tín hiệu giao dịch bóc tách từ Telegram (Telegram Signal Copier)
 * @param {import('./telegram_signal_parser.js').ParsedTelegramSignal} extSignal
 * @param {string} source Nguồn tín hiệu (Tên nhóm hoặc Chat ID)
 * @param {Array<string|number>} notifyChatIds Danh sách Chat ID nhận thông báo
 */
async function executeTelegramSignal(extSignal, source = 'Telegram', notifyChatIds = []) {
  if (!extSignal) return null;

  const priceInfo = await getCurrentXAUPrice(SYMBOL, bridgeServer);
  const curPrice = (priceInfo && priceInfo.price) ? Number(priceInfo.price) : extSignal.entry;

  // Tính tỷ lệ R:R
  const riskDist = Math.abs(extSignal.entry - extSignal.sl);
  const rewardDist = Math.abs(extSignal.tp - extSignal.entry);
  const rr = riskDist > 0 ? Number((rewardDist / riskDist).toFixed(2)) : 1.8;

  const targetChatIds = (notifyChatIds && notifyChatIds.length > 0)
    ? notifyChatIds
    : getDefaultChatIds();

  // Chuẩn hóa thành đối tượng TradeSignal chuẩn của hệ thống
  const signal = {
    id: `sig_tg_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    symbol: extSignal.symbol || 'XAUUSD',
    action: extSignal.action,
    orderType: 'MARKET',
    entry: extSignal.entry,
    sl: extSignal.sl,
    tp: extSignal.tp,
    ...(extSignal.tp1 ? { tp1: extSignal.tp1 } : {}),
    ...(extSignal.tp2 ? { tp2: extSignal.tp2 } : {}),
    ...(extSignal.tp3 ? { tp3: extSignal.tp3 } : {}),
    rr,
    lot: 0.01,
    timeframe: 'M15',
    tradeStyle: 'SCALP',
    reason: `[Copy Trade] Tín hiệu từ ${source}`,
    confidence: 90,
    setupModel: 'NONE',
    pdaZone: 'EQUILIBRIUM',
    marketRegime: 'NORMAL',
    sessionKillzone: 'UNKNOWN',
    trend: extSignal.action === 'BUY' ? 'UP' : 'DOWN',
    h4Trend: extSignal.action === 'BUY' ? 'UP' : 'DOWN',
    reversalDetected: false,
    reversalReason: '',
    timestamp: new Date().toISOString(),
    status: 'GENERATED'
  };

  logger(`[CopyTrade] 💡 Nhận tín hiệu từ [${source}]: ${signal.action} @ ${signal.entry} (SL: ${signal.sl}, TP: ${signal.tp})`);

  // Kiểm tra an toàn qua RiskManager
  const unclosedContext = bridgeServer.checkUnclosedOrders(signal.symbol);
  const validation = orderManager.riskManager.validateSignal(signal, curPrice, unclosedContext);
  if (!validation.valid) {
    logger(`[CopyTrade] ⚠️ Tín hiệu bị từ chối bởi Risk Manager: ${validation.reason}`);
    const rejectMsg = [
      `⚠️ [TỪ CHỐI TÍN HIỆU COPY TRADE]`,
      `• Nguồn: ${source}`,
      `• Kèo: ${signal.action} ${signal.symbol} @ ${signal.entry}`,
      `• Lý do: ${validation.reason}`
    ].join('\n');
    for (const cid of targetChatIds) {
      await sendTelegramMessage(rejectMsg, cid);
    }
    return null;
  }

  // Tính khối lượng Lot an toàn theo vốn và rủi ro
  const equity = bridgeServer.getLatestEquity();
  signal.lot = orderManager.riskManager.calculateLotSize(signal, equity, unclosedContext.totalActiveLot);

  if (!signal.lot || signal.lot < 0.01) {
    logger(`[CopyTrade] ⚠️ Khối lượng tính toán không hợp lệ hoặc đã chạm hạn mức volume.`);
    return null;
  }

  if (orderManager.autoExecute) {
    logger(`[CopyTrade] ⚡ AUTO_EXECUTE=true: Đang đẩy lệnh sang MT5 ngay lập tức...`);
    orderManager.riskManager.recordTradeExecution(signal.tradeStyle);
    bridgeServer.queueOrder(signal);

    const tpInfo = signal.tp1 ? `TP1: ${signal.tp1}${signal.tp2 ? ` | TP2: ${signal.tp2}` : ''}${signal.tp3 ? ` | TP3: ${signal.tp3}` : ''}` : `TP: ${signal.tp}`;
    const rangeInfo = (extSignal.entryMin && extSignal.entryMax) ? ` (Vùng: ${extSignal.entryMin}-${extSignal.entryMax})` : '';

    const execMsg = [
      `⚡ [MT5 AUTO COPY TRADE]`,
      `• Nguồn: ${source}`,
      `• Khớp lệnh: ${signal.action} ${signal.lot} Lot ${signal.symbol}`,
      `• Entry: ${signal.entry}${rangeInfo}`,
      `• SL: ${signal.sl}`,
      `• ${tpInfo}`,
      `• R:R: 1:${signal.rr}`,
      `• Trạng thái: ĐÃ GỬI LỆNH SANG MT5 THÀNH CÔNG!`
    ].join('\n');

    for (const cid of targetChatIds) {
      await sendTelegramMessage(execMsg, cid);
    }
  } else {
    // Chế độ Bán tự động (cần bấm nút duyệt trên Telegram)
    orderManager.pendingApprovals.set(signal.id, {
      signal,
      createdAt: Date.now(),
      chatIds: targetChatIds
    });

    const tpInfo = signal.tp1 ? `TP1: ${signal.tp1}${signal.tp2 ? ` | TP2: ${signal.tp2}` : ''}` : `TP: ${signal.tp}`;
    const promptMsg = [
      `🔔 [YÊU CẦU DUYỆT COPY TRADE]`,
      `• Nguồn: ${source}`,
      `• Lệnh: ${signal.action} ${signal.lot} Lot ${signal.symbol}`,
      `• Entry: ${signal.entry}`,
      `• SL: ${signal.sl} | ${tpInfo}`,
      `• R:R: 1:${signal.rr}`
    ].join('\n');

    const inlineKeyboard = {
      inline_keyboard: [
        [
          { text: `Vào lệnh ${signal.action} ${signal.lot} Lot`, callback_data: `APPROVE_${signal.id}` },
          { text: `Hủy`, callback_data: `REJECT_${signal.id}` }
        ]
      ]
    };

    for (const cid of targetChatIds) {
      await sendTelegramMessage(promptMsg, cid, inlineKeyboard);
    }
  }

  return signal;
}

/**
 * Xử lý tin nhắn tương tác từ người dùng gửi tới Telegram Bot
 */
async function handleTelegramCommand({ text, chatId }) {
  const norm = normalizeText(text);
  logger(`[TelegramListener] Nhận tin nhắn từ Chat ID ${chatId}: "${text}"`);

  // 0. Tự động nhận diện tin nhắn BẮN KÈO từ người dùng Forward hoặc Copy Paste sang
  const extSignal = parseTelegramSignal(text);
  if (extSignal) {
    logger(`[TelegramListener] 🎯 Phát hiện tin nhắn bắn kèo từ Chat ID ${chatId}!`);
    await executeTelegramSignal(extSignal, `Chat #${chatId}`, [chatId]);
    return;
  }

  // 1. Kiểm tra lệnh hỏi giá
  if (
    norm.includes('gia xau') ||
    norm.includes('gia vang') ||
    norm.includes('xau') ||
    norm.includes('vang') ||
    norm.includes('price') ||
    norm.startsWith('/gia') ||
    norm.startsWith('/xau') ||
    norm.startsWith('/price') ||
    norm === 'gia'
  ) {
    try {
      const priceInfo = await getCurrentXAUPrice(SYMBOL, bridgeServer);
      if (!priceInfo) {
        await sendTelegramMessage('[XAU/USD] Lỗi kết nối giá, thử lại sau.', chatId);
        return;
      }
      let msg = '';
      if (priceInfo.source === 'MT5') {
        const spreadUsd = (Number(priceInfo.spread || 0) * 0.01).toFixed(2);
        msg = [
          `[XAU/USD] Giá MT5: ${priceInfo.bid} (Bid) / ${priceInfo.ask} (Ask)`,
          `• Giá trung bình: ${priceInfo.price} USD`,
          `• Spread: ${priceInfo.spread} points (~${spreadUsd} USD)`,
          `• Nguồn: ${priceInfo.server || 'MT5 Live'}`,
          `• Cập nhật: ${new Date().toLocaleTimeString('vi-VN')}`
        ].join('\n');
      } else {
        msg = [
          `[XAU/USD] Giá: ${priceInfo.price} USD (${priceInfo.change})`,
          `• Range ngày: ${priceInfo.low} - ${priceInfo.high}`,
          `• Nguồn: ${priceInfo.server || 'TradingView'}`,
          `• Cập nhật: ${new Date().toLocaleTimeString('vi-VN')}`
        ].join('\n');
      }

      await sendTelegramMessage(msg, chatId);
      logger(`[TelegramListener] Đã phản hồi giá vàng cho Chat ID ${chatId}: ${priceInfo.price} USD (${priceInfo.source})`);
    } catch (err) {
      logger(`[TelegramListener] Lỗi xử lý tra cứu giá: ${err.message}`);
    }
    return;
  }

  // 2. Kiểm tra lệnh yêu cầu phân tích ngay lập tức
  if (
    norm.includes('plan') ||
    norm.includes('phan tich') ||
    norm.includes('ke hoach') ||
    norm.startsWith('/plan') ||
    norm.startsWith('/check')
  ) {
    pendingSubscribers.add(String(chatId));

    const priceInfo = await getCurrentXAUPrice(SYMBOL);
    const pStr = priceInfo ? `Giá hiện tại: ${priceInfo.price} USD (${priceInfo.change}). ` : '';

    if (isRunning) {
      await sendTelegramMessage(`[XAU/USD] ${pStr}Đang phân tích, sẽ gửi ngay.`, chatId);
      return;
    }

    await sendTelegramMessage(`[XAU/USD] ${pStr}Đang chụp ảnh H4/H1/M15...`, chatId);
    runMultiAnalysisCycle(chatId);
    return;
  }

  // 3. Kiểm tra lịch sử giao dịch (/history, /ls, lich su)
  if (
    norm === '/history' ||
    norm === 'history' ||
    norm === '/ls' ||
    norm === 'ls' ||
    norm.includes('lich su') ||
    norm.startsWith('/lichsu')
  ) {
    const msg = formatHistoryReport(bridgeServer.accountInfo);
    await sendTelegramMessage(msg, chatId);
    return;
  }

  // 4. Kiểm tra vị thế đang chạy (/positions, /vithe, vi the)
  if (
    norm === '/positions' ||
    norm === 'positions' ||
    norm === '/vithe' ||
    norm === 'vi the' ||
    norm.includes('lenh dang chay') ||
    norm.includes('vi the dang chay') ||
    norm.includes('vi the dang mo') ||
    norm.startsWith('/positions')
  ) {
    const msg = formatOpenPositions(bridgeServer.accountInfo);
    await sendTelegramMessage(msg, chatId);
    return;
  }

  // 5. Kiểm tra trạng thái MT5 (/mt5, mt5, /status, status)
  if (norm.startsWith('/mt5') || norm === 'mt5' || norm.startsWith('/status') || norm === 'status') {
    const status = bridgeServer.accountInfo;
    const isAlive = Date.now() - status.lastHeartbeat < 20000;
    const todayPlNum = Number(status.todayProfit || 0);
    const todayPlStr = todayPlNum >= 0 ? `+$${todayPlNum.toFixed(2)}` : `-$${Math.abs(todayPlNum).toFixed(2)}`;

    const dynRisk = orderManager?.riskManager?.getDynamicRiskStatus?.() || {};
    const lossCooldownStr = dynRisk.lossCooldownActive
      ? ` ⚠️ ĐANG COOLDOWN (${dynRisk.lossCooldownRemainingMinutes}p)`
      : '';
    const riskModeStr = dynRisk.dynamicRiskEnabled
      ? `Động ICT (${dynRisk.currentRiskPercent}% / lệnh)`
      : `Cố định (${orderManager.riskManager?.riskPercent || 1.0}%)`;

    const statusMsg = isAlive
      ? [
          `[MT5 STATUS: ONLINE]`,
          `• Server: ${status.serverName || 'MT5'}`,
          `• TK: #${status.accountNumber || '-'}`,
          `• Balance: $${status.balance.toFixed(2)}`,
          `• Equity: $${status.equity.toFixed(2)}`,
          `• Lời/Lỗ chốt hôm nay: ${todayPlStr}`,
          `• Vị thế mở: ${status.openPositions} lệnh`,
          `• Chế độ: ${orderManager.autoExecute ? 'Tự động 100% (Auto)' : 'Bán tự động (Semi-Auto)'}`,
          `• Quản trị vốn ICT: ${riskModeStr}`,
          `• Chuỗi thua Kaufman: ${dynRisk.consecutiveLosses ?? 0}/${dynRisk.maxConsecutiveLosses ?? 3} lệnh${lossCooldownStr}`,
          `• Nút Algo Trading (Thanh công cụ): ${status.terminalAlgo ? 'BẬT (Chuẩn)' : 'TẮT (Cần bấm xanh)'}`,
          `• Quyền EA (F7 Common): ${status.eaAlgo ? 'BẬT (Chuẩn)' : 'TẮT (Cần tích Allow)'}`
        ].join('\n')
      : [
          `[MT5 STATUS: OFFLINE]`,
          `Chưa nhận heartbeat từ EA trên MT5.`,
          `Kiểm tra WebRequest: http://127.0.0.1:${MT5_PORT}`
        ].join('\n');

    const inlineKeyboard = isAlive ? {
      inline_keyboard: [
        [
          { text: '📊 Xem Lịch sử & P&L', callback_data: 'VIEW_HISTORY' },
          { text: '🎯 Vị thế đang mở', callback_data: 'VIEW_POSITIONS' }
        ],
        [
          { text: '⚡ Phân tích & Quét lệnh ngay', callback_data: 'TRIGGER_PLAN' }
        ]
      ]
    } : null;

    await sendTelegramMessage(statusMsg, chatId, inlineKeyboard);
    return;
  }

  // 6. Lệnh kiểm thử khớp lệnh giả lập (/testorder, /test)
  if (norm.startsWith('/testorder') || norm === '/test' || norm === 'test order') {
    try {
      const priceInfo = await getCurrentXAUPrice(SYMBOL);
      const curP = priceInfo ? parseFloat(priceInfo.price) : 4118.0;
      const slDist = Number(process.env.FIXED_SL_USD || 15.0);
      const tpDist = Number(process.env.FIXED_TP_USD || 30.0);
      const slP = (curP - slDist).toFixed(2);
      const tpP = (curP + tpDist).toFixed(2);

      const mockAnalysis = `
[TEST ORDER] Giá: ${curP}
\`\`\`json
{
  "action": "BUY",
  "trade_style": "HOLD",
  "symbol": "XAUUSD",
  "entry": ${curP.toFixed(2)},
  "sl": ${slP},
  "tp": ${tpP},
  "timeframe": "H1",
  "reason": "Test MT5 Hold",
  "confidence": 99
}
\`\`\`
      `;

      await sendTelegramMessage(`[TEST] Giá: ${curP} USD. Kích hoạt lệnh test...`, chatId);
      await orderManager.processAnalysisResult(mockAnalysis, curP, [chatId]);
    } catch (err) {
      await sendTelegramMessage(`[TEST LỖI] ${err.message}`, chatId);
    }
    return;
  }

  // 7. Lệnh kiểm tra an toàn vốn & Circuit Breaker (/risk, /baove)
  if (norm.startsWith('/risk') || norm.startsWith('/baove') || norm === 'risk' || norm === 'bao ve') {
    const curEquity = bridgeServer.getLatestEquity();
    const risk = orderManager.riskManager.getRiskStatus(curEquity);
    const dynRisk = orderManager.riskManager.getDynamicRiskStatus();
    const isLocked = risk.isTriggered;
    const statusTag = isLocked ? '🔴 ĐÃ NGẮT MẠCH (KHÓA GIAO DỊCH)' : '🟢 AN TOÀN (BÌNH THƯỜNG)';
    const msg = [
      `🛡️ [BẢO VỆ VỐN & NGẮT MẠCH KHẨN CẤP]`,
      `• Trạng thái: ${statusTag}`,
      `• Vốn cơ sở cấu hình: $${risk.initialCapitalUSD.toFixed(2)} USD`,
      `• Giới hạn lỗ tối đa: -$${risk.maxAccountLossUSD.toFixed(2)} USD (${risk.maxDrawdownPercent}%)`,
      `• Sụt giảm phiên hiện tại: -$${risk.currentDrawdown.toFixed(2)} USD`,
      `• Đỉnh vốn phiên (Peak): $${risk.peakEquity.toFixed(2)} USD`,
      `• Vốn hiện tại (Equity): $${risk.currentEquity.toFixed(2)} USD`,
      `• Tự động ngắt khi vi phạm: ${risk.emergencyStopEnabled ? 'BẬT' : 'TẮT'}`,
      `• Tự động đóng hết vị thế: ${risk.closeAllOnEmergency ? 'BẬT' : 'TẮT'}`,
      ``,
      `📊 [QUẢN LÝ VỐN ICT & LÝ THUYẾT CHUỖI KAUFMAN]`,
      `• Quản lý vốn động (ICT): ${dynRisk.dynamicRiskEnabled ? `BẬT (Hiện tại: ${dynRisk.currentRiskPercent}% / Base: ${dynRisk.baseRiskPercent}% / Max: ${dynRisk.highRiskPercent}% / Min: ${dynRisk.lowRiskPercent}%)` : `TẮT (Cố định: ${risk.riskPercent || orderManager.riskManager.riskPercent || 1.0}%)`}`,
      `• Chuỗi thua liên tiếp (Kaufman): ${dynRisk.consecutiveLosses}/${dynRisk.maxConsecutiveLosses} lệnh`,
      `• Cooldown bảo vệ chuỗi thua: ${dynRisk.lossCooldownActive ? `⚠️ ĐANG KÍCH HOẠT (Còn ${dynRisk.lossCooldownRemainingMinutes} phút)` : '🟢 Sẵn sàng'}`,
      isLocked ? `\n⚠️ Lý do ngắt: ${risk.reason}\n👉 Gõ /unlock để mở khóa khi bạn muốn tiếp tục.` : ''
    ].filter(Boolean).join('\n');

    await sendTelegramMessage(msg, chatId);
    return;
  }

  // 8. Lệnh mở khóa giao dịch sau khi ngắt mạch (/unlock, /mokhoa)
  if (norm.startsWith('/unlock') || norm === 'unlock' || norm === 'mo khoa') {
    orderManager.resetCircuitBreaker();
    const curEq = bridgeServer.getLatestEquity() || 0;
    const msg = [
      `🔓 [MỞ KHÓA BẢO VỆ VỐN THÀNH CÔNG]`,
      `• Trạng thái: Bot đã được mở khóa giao dịch.`,
      `• Vốn mốc mới ghi nhận: $${curEq.toFixed(2)} USD`,
      `• Giới hạn lỗ tiếp tục bảo vệ: -$${orderManager.riskManager.maxAccountLossUSD.toFixed(2)} USD`,
      `• Hệ thống tiếp tục quét thị trường và giao dịch bình thường.`
    ].join('\n');
    await sendTelegramMessage(msg, chatId);
    return;
  }

  // 8.1 Lệnh tra cứu phiên ICT Kill Zone & Macro (/ict, /session, /phien)
  if (norm.startsWith('/ict') || norm.startsWith('/session') || norm === 'phien' || norm === 'killzone') {
    const s = getCurrentICTSession();
    const msg = [
      `🏛️ [PHIÊN GIAO DỊCH ICT & KILL ZONE]`,
      `• Phiên hiện tại: ${s.sessionName}`,
      `• Giờ New York: ${s.nyTimeStr} NY`,
      `• Giờ Việt Nam: ${s.vnTimeStr} VN`,
      `• ICT Macro: ${s.isMacroActive ? '⚡ ĐANG TRONG CỬA SỔ (' + s.macroWindow + ')' : 'Chưa có macro'}`,
      `• Định hướng ICT & Kaufman: ${s.tradingGuidance}`
    ].join('\n');
    await sendTelegramMessage(msg, chatId);
    return;
  }

  // 9. Lệnh khẩn cấp đóng toàn bộ vị thế trên MT5 (/close_all, /donghet)
  if (norm.startsWith('/close_all') || norm === '/closeall' || norm === 'close all' || norm === 'dong het') {
    bridgeServer.queueEmergencyCloseAll('Yêu cầu thủ công của người dùng qua Telegram');
    await sendTelegramMessage('🚨 [KHẨN CẤP] Đã phát lệnh đóng toàn bộ vị thế sang MT5 ngay lập tức!', chatId);
    return;
  }

  // 10. Lệnh kiểm tra và chuyển đổi chế độ Scalp / Hold dài (/mode, /chedo, /scalp, /hold)
  if (
    norm.startsWith('/mode') ||
    norm.startsWith('/chedo') ||
    norm === 'mode' ||
    norm === 'che do'
  ) {
    const statusMsg = orderManager.getTradingModeStatus();
    const keyboard = orderManager.getModeInlineKeyboard();
    await sendTelegramMessage(statusMsg, chatId, keyboard);
    return;
  }

  // Lệnh cấu hình khoảng cách TP và SL cho Scalp M1: /scalp config <tp> <sl> hoặc /scalpm1 config <tp> <sl>
  if (norm.startsWith('/scalp config') || norm.startsWith('/scalpm1 config') || norm.startsWith('scalp config')) {
    const parts = text.trim().split(/\s+/);
    const tpVal = parseFloat(parts[2]);
    const slVal = parseFloat(parts[3]);

    if (!isNaN(tpVal) && tpVal > 0 && !isNaN(slVal) && slVal > 0) {
      orderManager.setScalpM1Config(tpVal, slVal);
      updateEnvFile({
        SCALP_M1_TP_USD: tpVal,
        SCALP_M1_SL_USD: slVal
      });
      const cfgMsg = [
        `⚙️ [CẤU HÌNH SCALP M1 THÀNH CÔNG]`,
        `• Take Profit (TP): ${tpVal.toFixed(1)} USD (2 - 3 giá)`,
        `• Stop Loss (SL): ${slVal.toFixed(1)} USD (7 giá)`,
        `• Quét liên tục: Khung M1 mỗi ${orderManager.scalpM1IntervalSec}s`,
        `• Trạng thái: ${orderManager.enableScalpM1 ? 'ĐANG BẬT 🟢' : 'ĐANG TẮT 🔴 (Gõ /scalpm1 on để kích hoạt)'}`,
        `• Đã lưu tự động vào file .env!`
      ].join('\n');
      await sendTelegramMessage(cfgMsg, chatId);
    } else {
      await sendTelegramMessage(`Cú pháp: /scalp config <TP> <SL>\nVí dụ: /scalp config 2.5 7 (TP 2.5 giá, SL 7 giá)`, chatId);
    }
    return;
  }

  // Lệnh cấu hình khối lượng Lot vào lệnh: /lot [số_lot] hoặc /config lot [số_lot]
  if (norm.startsWith('/lot') || norm.startsWith('/config lot')) {
    const parts = text.trim().split(/\s+/);
    const valIndex = norm.startsWith('/config lot') ? 2 : 1;
    const lotVal = parseFloat(parts[valIndex]);

    if (!isNaN(lotVal) && lotVal > 0) {
      const roundedLot = Number(lotVal.toFixed(2));
      const updates = { defaultLot: roundedLot };
      const envUpdates = { DEFAULT_LOT: roundedLot.toFixed(2) };
      if (roundedLot > orderManager.riskManager.maxLot) {
        updates.maxLot = roundedLot;
        envUpdates.MAX_LOT = roundedLot.toFixed(2);
      }
      if (roundedLot > orderManager.riskManager.maxTotalLot) {
        updates.maxTotalLot = roundedLot;
        envUpdates.MAX_TOTAL_LOT = roundedLot.toFixed(2);
      }
      orderManager.setLotConfig(updates);
      updateEnvFile(envUpdates);

      const cfgMsg = [
        `📊 [CẤU HÌNH KHỐI LƯỢNG LOT THÀNH CÔNG]`,
        `• Khối lượng vào lệnh mặc định: ${orderManager.riskManager.defaultLot} lot`,
        `• Khối lượng tối đa 1 lệnh: ${orderManager.riskManager.maxLot} lot`,
        `• Khối lượng tổng tối đa: ${orderManager.riskManager.maxTotalLot} lot`,
        `• Số lệnh tối đa cùng lúc: ${orderManager.riskManager.maxConcurrentTrades} lệnh`,
        `• Đã lưu tự động vào file .env!`
      ].join('\n');
      await sendTelegramMessage(cfgMsg, chatId);
    } else {
      const lotCfg = orderManager.getLotConfig();
      const currentMsg = [
        `📊 [CẤU HÌNH KHỐI LƯỢNG LOT HIỆN TẠI]`,
        `• Khối lượng vào lệnh mặc định: ${lotCfg.defaultLot} lot`,
        `• Khối lượng tối đa 1 lệnh: ${lotCfg.maxLot} lot`,
        `• Khối lượng tổng tối đa: ${lotCfg.maxTotalLot} lot`,
        `• Số lệnh tối đa cùng lúc: ${lotCfg.maxConcurrentTrades} lệnh`,
        `\n👉 Cú pháp thay đổi: /lot <số_lot> (Ví dụ: /lot 0.02)`
      ].join('\n');
      await sendTelegramMessage(currentMsg, chatId);
    }
    return;
  }

  // Lệnh cấu hình khối lượng lot tối đa cho 1 lệnh: /maxlot [số_lot] hoặc /config maxlot [số_lot]
  if (norm.startsWith('/maxlot') || norm.startsWith('/config maxlot')) {
    const parts = text.trim().split(/\s+/);
    const valIndex = norm.startsWith('/config maxlot') ? 2 : 1;
    const maxVal = parseFloat(parts[valIndex]);

    if (!isNaN(maxVal) && maxVal > 0) {
      const roundedMax = Number(maxVal.toFixed(2));
      const updates = { maxLot: roundedMax };
      const envUpdates = { MAX_LOT: roundedMax.toFixed(2) };
      if (roundedMax > orderManager.riskManager.maxTotalLot) {
        updates.maxTotalLot = roundedMax;
        envUpdates.MAX_TOTAL_LOT = roundedMax.toFixed(2);
      }
      orderManager.setLotConfig(updates);
      updateEnvFile(envUpdates);

      const msg = [
        `📊 [CẤU HÌNH MAX LOT/LỆNH THÀNH CÔNG]`,
        `• Khối lượng tối đa cho 1 lệnh: ${orderManager.riskManager.maxLot} lot`,
        `• Khối lượng mặc định: ${orderManager.riskManager.defaultLot} lot`,
        `• Khối lượng tổng tối đa: ${orderManager.riskManager.maxTotalLot} lot`,
        `• Đã lưu tự động vào file .env!`
      ].join('\n');
      await sendTelegramMessage(msg, chatId);
    } else {
      await sendTelegramMessage(`Cú pháp: /maxlot <số_lot>\nVí dụ: /maxlot 0.02 (Giới hạn tối đa 0.02 lot/lệnh)`, chatId);
    }
    return;
  }

  // Lệnh cấu hình tổng khối lượng trần: /maxtotallot [số_lot] hoặc /config maxtotallot [số_lot]
  if (norm.startsWith('/maxtotallot') || norm.startsWith('/config maxtotallot')) {
    const parts = text.trim().split(/\s+/);
    const valIndex = norm.startsWith('/config maxtotallot') ? 2 : 1;
    const totalVal = parseFloat(parts[valIndex]);

    if (!isNaN(totalVal) && totalVal > 0) {
      const roundedTotal = Number(totalVal.toFixed(2));
      orderManager.setLotConfig({ maxTotalLot: roundedTotal });
      updateEnvFile({ MAX_TOTAL_LOT: roundedTotal.toFixed(2) });

      const msg = [
        `📊 [CẤU HÌNH TỔNG VOLUME TỐI ĐA THÀNH CÔNG]`,
        `• Khối lượng tổng trần tối đa: ${orderManager.riskManager.maxTotalLot} lot`,
        `• Khối lượng tối đa 1 lệnh: ${orderManager.riskManager.maxLot} lot`,
        `• Khối lượng mặc định: ${orderManager.riskManager.defaultLot} lot`,
        `• Số lệnh tối đa cùng lúc: ${orderManager.riskManager.maxConcurrentTrades} lệnh`,
        `• Đã lưu tự động vào file .env!`
      ].join('\n');
      await sendTelegramMessage(msg, chatId);
    } else {
      await sendTelegramMessage(`Cú pháp: /maxtotallot <số_lot>\nVí dụ: /maxtotallot 0.05`, chatId);
    }
    return;
  }

  // Lệnh cấu hình số lệnh tối đa cho phép mở cùng lúc: /maxorders [n] hoặc /orders [n] hoặc /config orders [n]
  if (
    norm.startsWith('/maxorders') ||
    norm.startsWith('/orders') ||
    norm.startsWith('/config orders') ||
    norm.startsWith('/config maxorders') ||
    norm.startsWith('/solenh')
  ) {
    const parts = text.trim().split(/\s+/);
    const valIndex = (norm.startsWith('/config orders') || norm.startsWith('/config maxorders')) ? 2 : 1;
    const numOrders = parseInt(parts[valIndex], 10);

    if (!isNaN(numOrders) && numOrders >= 1) {
      orderManager.setLotConfig({ maxConcurrentTrades: numOrders });
      updateEnvFile({
        MAX_CONCURRENT_TRADES: numOrders,
        ALLOW_CONCURRENT_TRADES: numOrders > 1 ? 'true' : 'false'
      });

      const msg = [
        `📊 [CẤU HÌNH SỐ LỆNH TỐI ĐA THÀNH CÔNG]`,
        `• Số lệnh tối đa được mở cùng lúc: ${numOrders} lệnh`,
        `• Chế độ vào nhiều lệnh đồng thời: ${numOrders > 1 ? 'BẬT 🟢 (Tối đa ' + numOrders + ' lệnh)' : 'TẮT 🔴 (Chỉ 1 lệnh duy nhất)'}`,
        `• Khối lượng mỗi lệnh: ${orderManager.riskManager.defaultLot} lot (Max: ${orderManager.riskManager.maxLot} lot)`,
        `• Tổng khối lượng trần tối đa: ${orderManager.riskManager.maxTotalLot} lot`,
        `• Đã lưu tự động vào file .env!`
      ].join('\n');
      await sendTelegramMessage(msg, chatId);
    } else {
      const lotCfg = orderManager.getLotConfig();
      const msg = [
        `📊 [CẤU HÌNH SỐ LỆNH TỐI ĐA HIỆN TẠI]`,
        `• Số lệnh tối đa được mở cùng lúc: ${lotCfg.maxConcurrentTrades} lệnh`,
        `• Trạng thái đồng thời: ${lotCfg.maxConcurrentTrades > 1 ? 'BẬT 🟢' : 'TẮT 🔴 (Chỉ 1 lệnh duy nhất)'}`,
        `• Khối lượng mặc định: ${lotCfg.defaultLot} lot (Tổng tối đa: ${lotCfg.maxTotalLot} lot)`,
        `\n👉 Cú pháp thay đổi: /maxorders <số_lệnh> (Ví dụ: /maxorders 2 hoặc /orders 1)`
      ].join('\n');
      await sendTelegramMessage(msg, chatId);
    }
    return;
  }

  // Lệnh xem hoặc cấu hình tổng thể: /config hoặc /cauhinh
  if (norm === '/config' || norm === 'config' || norm === '/cauhinh' || norm === 'cau hinh') {
    const lotCfg = orderManager.getLotConfig();
    const riskStatus = orderManager.riskManager.getRiskStatus(bridgeServer.getLatestEquity());
    const msg = [
      `⚙️ [BẢNG CẤU HÌNH TỔNG THỂ BOTCHECKXAU]`,
      `1️⃣ KHỐI LƯỢNG LOT & SỐ LỆNH VÀO:`,
      `• Khối lượng mặc định (Default Lot): ${lotCfg.defaultLot} lot`,
      `• Khối lượng tối đa 1 lệnh (Max Lot): ${lotCfg.maxLot} lot`,
      `• Khối lượng tổng tối đa (Max Total Lot): ${lotCfg.maxTotalLot} lot`,
      `• Số lệnh tối đa cùng lúc: ${lotCfg.maxConcurrentTrades} lệnh (${lotCfg.maxConcurrentTrades > 1 ? 'Cho phép nhiều vị thế' : 'Chỉ 1 lệnh duy nhất'})`,
      ``,
      `2️⃣ CHẾ ĐỘ GIAO DỊCH:`,
      `• Khớp lệnh tự động: ${orderManager.autoExecute ? 'BẬT 🟢 (Auto MT5)' : 'TẮT 🔴 (Chỉ Plan)'}`,
      `• Scalp M1 liên tục: ${orderManager.enableScalpM1 ? 'BẬT 🟢' : 'TẮT 🔴'} (TP: ${orderManager.scalpM1TpUSD}U | SL: ${orderManager.scalpM1SlUSD}U | ${orderManager.scalpM1IntervalSec}s)`,
      `• Hold dài H1/H4: ${orderManager.enableHold ? 'BẬT 🟢' : 'TẮT 🔴'} (SL: 15U | TP: 30U | R:R 1:2)`,
      `• Tự ngắt khi đảo chiều xu hướng: ${orderManager.autoCloseOnTrendReversal ? 'BẬT 🟢' : 'TẮT 🔴'}`,
      ``,
      `3️⃣ BẢO VỆ VỐN & CIRCUIT BREAKER:`,
      `• Vốn cơ sở cấu hình: $${riskStatus.initialCapitalUSD.toFixed(1)} USD`,
      `• Giới hạn lỗ tối đa: -$${riskStatus.maxAccountLossUSD.toFixed(1)} USD (${riskStatus.maxDrawdownPercent}%)`,
      `• Tỷ lệ R:R tối thiểu: 1:${riskStatus.minRR}`,
      ``,
      `💡 CÁC LỆNH ĐIỀU CHỈNH NHANH:`,
      `• /lot <số>: Đổi khối lượng mặc định (vd: /lot 0.02)`,
      `• /maxlot <số>: Đổi max lot 1 lệnh (vd: /maxlot 0.05)`,
      `• /maxtotallot <số>: Đổi tổng lot tối đa (vd: /maxtotallot 0.05)`,
      `• /maxorders <số>: Đổi số lệnh tối đa cùng lúc (vd: /maxorders 2)`,
      `• /scalp config <tp> <sl>: Đổi TP/SL Scalp M1 (vd: /scalp config 2.5 7)`,
      `• /auto on|off: Bật/tắt tự động vào lệnh MT5`,
      `• /scalpm1 on|off: Bật/tắt chế độ Scalp M1`
    ].join('\n');
    await sendTelegramMessage(msg, chatId);
    return;
  }

  // Lệnh bật/tắt Scalp M1 liên tục (/scalpm1, /scalp m1, /scalpm1 on|off)
  if (
    norm.startsWith('/scalpm1') ||
    norm.startsWith('/scalp m1') ||
    norm.includes('scalp m1 on') ||
    norm.includes('scalp m1 off') ||
    norm.includes('bat scalp m1') ||
    norm.includes('tat scalp m1')
  ) {
    if (norm.includes('off') || norm.includes('tat') || norm.includes('0')) {
      orderManager.setScalpM1(false);
    } else if (norm.includes('on') || norm.includes('bat') || norm.includes('1')) {
      orderManager.setScalpM1(true);
      setTimeout(() => runM1ScalpCycle(), 1000);
    } else {
      orderManager.toggleScalpM1();
      if (orderManager.enableScalpM1) {
        setTimeout(() => runM1ScalpCycle(), 1000);
      }
    }
    const statusMsg = orderManager.getTradingModeStatus();
    const keyboard = orderManager.getModeInlineKeyboard();
    await sendTelegramMessage(statusMsg, chatId, keyboard);
    return;
  }

  // Lệnh bật/tắt Scalp (/scalp, /scalp on, /scalp off)
  if (norm.startsWith('/scalp') || norm.includes('scalp on') || norm.includes('scalp off') || norm.includes('bat scalp') || norm.includes('tat scalp')) {
    if (norm.includes('off') || norm.includes('tat') || norm.includes('0')) {
      orderManager.setScalp(false);
      orderManager.setScalpM1(false);
    } else if (norm.includes('on') || norm.includes('bat') || norm.includes('1')) {
      orderManager.setScalp(true);
      orderManager.setScalpM1(true);
      setTimeout(() => runM1ScalpCycle(), 1000);
    } else {
      orderManager.toggleScalpM1();
      if (orderManager.enableScalpM1) {
        setTimeout(() => runM1ScalpCycle(), 1000);
      }
    }
    const statusMsg = orderManager.getTradingModeStatus();
    const keyboard = orderManager.getModeInlineKeyboard();
    await sendTelegramMessage(statusMsg, chatId, keyboard);
    return;
  }

  // Lệnh bật/tắt Hold dài (/hold, /hold on, /hold off, /swing)
  if (norm.startsWith('/hold') || norm.startsWith('/swing') || norm.includes('hold on') || norm.includes('hold off') || norm.includes('bat hold') || norm.includes('tat hold')) {
    if (norm.includes('off') || norm.includes('tat') || norm.includes('0')) {
      orderManager.setHold(false);
    } else if (norm.includes('on') || norm.includes('bat') || norm.includes('1')) {
      orderManager.setHold(true);
    } else {
      orderManager.toggleHold();
    }
    const statusMsg = orderManager.getTradingModeStatus();
    const keyboard = orderManager.getModeInlineKeyboard();
    await sendTelegramMessage(statusMsg, chatId, keyboard);
    return;
  }

  // Lệnh bật/tắt tự động vào lệnh (/auto, /auto on, /auto off)
  if (norm.startsWith('/auto') || norm.includes('tu dong') || norm.includes('auto execute')) {
    if (norm.includes('off') || norm.includes('tat') || norm.includes('0')) {
      orderManager.setAutoExecute(false);
    } else if (norm.includes('on') || norm.includes('bat') || norm.includes('1')) {
      orderManager.setAutoExecute(true);
    }
    const isAuto = orderManager.autoExecute;
    await sendTelegramMessage(
      `🤖 [CHẾ ĐỘ TỰ ĐỘNG KHỚP LỆNH]: ${isAuto ? '🟢 BẬT (Tự động vào lệnh MT5 khi có tín hiệu)' : '⏸️ TẮT (Chỉ gửi phân tích Plan, không vào lệnh)'}\n👉 Gõ /auto on hoặc /auto off để chuyển đổi.`,
      chatId
    );
    return;
  }

  // Lệnh lấy link Web Management Dashboard (/web, /dashboard)
  if (norm.startsWith('/web') || norm.startsWith('/dashboard') || norm === 'web' || norm === 'dashboard') {
    const webMsg = [
      `🌐 [WEB MANAGEMENT DASHBOARD]`,
      `• Địa chỉ truy cập: http://localhost:3000`,
      `• Tính năng: Bảng điều khiển thời gian thực, xem biểu đồ đa khung H4-M1, khớp lệnh tay, bật/tắt Scalp/Hold, quản lý vị thế và xem log bot.`,
      `• File mở nhanh: Chạy open_dashboard.bat trên máy tính.`
    ].join('\n');
    await sendTelegramMessage(webMsg, chatId);
    return;
  }

  // Lệnh đóng 1 vị thế cụ thể theo ticket (/close <ticket>)
  if (norm.startsWith('/close ') || norm.startsWith('/dong ')) {
    const parts = text.trim().split(/\s+/);
    const ticket = Number(parts[1]);
    if (ticket) {
      bridgeServer.queueCloseOrder({ ticket, symbol: 'XAUUSD', reason: 'Đóng thủ công qua Telegram' });
      await sendTelegramMessage(`✂️ [MT5] Đã phát lệnh đóng vị thế #${ticket} sang MT5!`, chatId);
    } else {
      await sendTelegramMessage(`Cú pháp: /close <Mã_Ticket> (ví dụ: /close 59025731051) hoặc /close_all để đóng hết`, chatId);
    }
    return;
  }

  // 11. Lệnh trợ giúp / Start (/start, /help, menu)
  if (norm.startsWith('/start') || norm.startsWith('/help') || norm === 'help' || norm === 'menu') {
    const helpMsg = [
      `[XAU/USD BOT - MENU LỆNH ĐẦY ĐỦ]`,
      `• /config: Xem toàn bộ thông số cấu hình của bot`,
      `• /lot <số>: Cài đặt khối lượng lot vào lệnh (vd: /lot 0.01)`,
      `• /maxorders <số>: Cài đặt số lệnh tối đa cùng lúc (vd: /maxorders 2)`,
      `• /maxlot <số>: Cài đặt khối lượng tối đa 1 lệnh (vd: /maxlot 0.02)`,
      `• /maxtotallot <số>: Cài đặt tổng khối lượng trần (vd: /maxtotallot 0.05)`,
      `• /gia: Xem giá vàng thời gian thực (Ưu tiên MT5)`,
      `• /plan: Chụp ảnh & phân tích Gemini đa khung`,
      `• /mode: Xem & đổi chế độ SCALP M1 / HOLD dài`,
      `• /scalpm1 on|off: Bật hoặc tắt đánh Scalp M1 liên tục`,
      `• /scalp config <tp> <sl>: Cài đặt TP (2-3 giá) và SL (7 giá)`,
      `• /hold on|off: Bật hoặc tắt lệnh Hold dài H1/H4`,
      `• /auto on|off: Bật hoặc tắt tự động khớp lệnh MT5`,
      `• /web: Mở trang Web Dashboard quản trị bot`,
      `• /status: Kiểm tra kết nối & số dư MT5 (/mt5)`,
      `• /positions: Xem các lệnh đang chạy trên MT5`,
      `• /history: Xem lịch sử giao dịch & P&L hôm nay`,
      `• /risk: Xem trạng thái bảo vệ vốn & Circuit Breaker`,
      `• /ict: Xem phiên giao dịch ICT Kill Zone & Macro`,
      `• /unlock: Mở khóa giao dịch khi bị ngắt mạch`,
      `• /close <ticket>: Đóng 1 vị thế cụ thể theo mã ticket`,
      `• /close_all: Đóng toàn bộ lệnh mở khẩn cấp`,
      `• /testorder: Thử khớp lệnh mẫu vào MT5`,
      `Chế độ: Gửi Plan khi có yêu cầu trên Telegram (/plan).`
    ].join('\n');

    await sendTelegramMessage(helpMsg, chatId);
    return;
  }

  // Phản hồi mặc định nếu nhập tin nhắn khác
  await sendTelegramMessage(
    `Lệnh hỗ trợ: /gia (giá), /plan (phân tích), /mode (bật/tắt Scalp & Hold), /mt5 (kết nối MT5), /positions (vị thế), /close_all (đóng hết)`,
    chatId
  );
}

/**
 * Xử lý sự kiện bấm nút Inline Keyboard từ Telegram (ví dụ: Duyệt lệnh vào MT5)
 */
async function handleTelegramCallbackQuery({ id, data, chatId }) {
  logger(`[TelegramListener] Nhận sự kiện bấm nút từ Chat ID ${chatId}: "${data}"`);
  try {
    if (data === 'VIEW_HISTORY') {
      const msg = formatHistoryReport(bridgeServer.accountInfo);
      await sendTelegramMessage(msg, chatId);
      return;
    }
    if (data === 'VIEW_POSITIONS') {
      const msg = formatOpenPositions(bridgeServer.accountInfo);
      await sendTelegramMessage(msg, chatId);
      return;
    }
    if (data === 'TRIGGER_PLAN') {
      await sendTelegramMessage(`[XAU/USD] Đang kích hoạt chu kỳ chụp đa khung H4/H1/M15/M5/M1 để Scalp...`, chatId);
      runMultiAnalysisCycle(chatId);
      return;
    }
    if (data.startsWith('TOGGLE_') || data.startsWith('MODE_')) {
      const replyText = await orderManager.handleCallbackAction(data, chatId);
      const keyboard = orderManager.getModeInlineKeyboard();
      await sendTelegramMessage(replyText, chatId, keyboard);
      return;
    }

    const replyText = await orderManager.handleCallbackAction(data, chatId);
    if (replyText) {
      await sendTelegramMessage(replyText, chatId);
    }
  } catch (err) {
    logger(`[TelegramListener] Lỗi xử lý callback: ${err.message}`);
  }
}

// Cấu hình tự động gửi Plan theo định kỳ (mặc định tắt: chỉ gửi khi có yêu cầu trên Telegram)
const AUTO_SEND_PLAN = (process.env.AUTO_SEND_PLAN || 'false').toLowerCase() === 'true';

// Cấu hình chu kỳ quét thị trường (mặc định 15 phút cho Hold dài để giảm nhiễu và tránh over-trading)
const SCAN_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.SCAN_INTERVAL_MINUTES || '15', 10));

// Lên lịch tự động quét nhịp nến để phân tích & vào lệnh MT5 (chạy ngầm, không spam Plan lên Telegram)
logger(`\n⏰ [Scheduler] Đã kích hoạt lịch tự động quét thị trường & vào lệnh MT5 mỗi ${SCAN_INTERVAL_MINUTES} phút.`);
if (!AUTO_SEND_PLAN) {
  logger(`ℹ️ [Chế độ] Tự động gửi Plan đang TẮT. Bot sẽ tự khớp lệnh MT5 ngầm và chỉ gửi Album + Plan khi người dùng yêu cầu trên Telegram (/plan).`);
}

cron.schedule(`*/${SCAN_INTERVAL_MINUTES} * * * *`, () => {
  // Nếu AUTO_SEND_PLAN=false, truyền null để KHÔNG gửi Album ảnh & Plan lên Telegram
  // Tín hiệu vào lệnh vẫn tự động được đưa sang MT5 nếu AUTO_EXECUTE=true
  runMultiAnalysisCycle(AUTO_SEND_PLAN ? getDefaultChatIds() : null);
});

// Khởi động bộ quét Scalp M1 liên tục
startM1ScalpLoop();

// Kích hoạt lắng nghe tin nhắn tương tác và sự kiện bấm nút từ Telegram
startTelegramListener(handleTelegramCommand, handleTelegramCallbackQuery);

// 1. Gửi thông báo khởi động lên Telegram để người dùng biết bot đang hoạt động
(async () => {
  try {
    const s = getCurrentICTSession();
    const lotInfo = orderManager.getLotConfig();
    const startMsg = [
      `🟢 [BOTCHECKXAU ĐÃ KHỞI ĐỘNG THÀNH CÔNG]`,
      `• Chu kỳ quét nến: ${SCAN_INTERVAL_MINUTES} phút/lần (Hold)`,
      `• Chế độ Scalp M1 liên tục: ${orderManager.enableScalpM1 ? `BẬT 🟢 (TP: ${orderManager.scalpM1TpUSD}u | SL: ${orderManager.scalpM1SlUSD}u | ${orderManager.scalpM1IntervalSec}s/lần)` : 'TẮT 🔴'}`,
      `• Chế độ khớp lệnh MT5: ${orderManager.autoExecute ? 'Tự động 100% (Auto)' : 'Bán tự động (Semi-Auto)'}`,
      `• Cấu hình Lot: Vào ${lotInfo.defaultLot} | Max/Lệnh ${lotInfo.maxLot} | Max Tổng ${lotInfo.maxTotalLot} lot`,
      `• Số lệnh tối đa cùng lúc: ${lotInfo.maxConcurrentTrades} lệnh (${lotInfo.maxConcurrentTrades > 1 ? 'Đồng thời' : 'Đơn lẻ'})`,
      `• Chế độ phân tích: ${orderManager.enableHold ? 'Hold dài H1/H4' : ''}${orderManager.enableScalpM1 ? ' + Scalp M1' : (orderManager.enableScalp ? ' + Scalp' : '')}`,
      `• Phiên ICT hiện tại: ${s.sessionName} (${s.nyTimeStr} NY)`,
      `• Cầu nối MT5: http://127.0.0.1:${MT5_PORT}`,
      `👉 Gõ /config để xem cấu hình Lot/Lệnh, /status kiểm tra MT5 hoặc /plan để phân tích ngay.`
    ].join('\n');

    for (const cid of getDefaultChatIds()) {
      await sendTelegramMessage(startMsg, cid);
    }
  } catch (err) {
    logger(`[Startup] Lỗi gửi thông báo Telegram: ${err.message}`);
  }
})();

// 2. Tự động thực hiện chu kỳ quét ban đầu sau 3 giây khởi động (không cần đợi hết 15 phút)
setTimeout(() => {
  logger(`[Scheduler] 🚀 Thực hiện chu kỳ quét kiểm tra ban đầu ngay sau khi khởi động...`);
  runMultiAnalysisCycle(AUTO_SEND_PLAN ? getDefaultChatIds() : null);
}, 3000);

// 3. Giám sát kết nối MT5 định kỳ (cảnh báo nếu MT5 bị tắt hoặc chưa mở)
let lastMt5AlertTime = 0;
setInterval(async () => {
  try {
    const status = bridgeServer.accountInfo;
    const isAlive = status.lastHeartbeat > 0 && (Date.now() - status.lastHeartbeat < 30000);
    // Nếu MT5 chưa kết nối hoặc mất kết nối quá 30s và chưa cảnh báo trong 30 phút qua
    if (!isAlive && (Date.now() - lastMt5AlertTime > 30 * 60 * 1000)) {
      lastMt5AlertTime = Date.now();
      const warnMsg = [
        `⚠️ [CẢNH BÁO: MT5 CHƯA KẾT NỐI HOẶC BỊ TẮT]`,
        `• Trạng thái MT5: OFFLINE (Chưa nhận heartbeat)`,
        `• Nguyên nhân: Phần mềm MetaTrader 5 chưa được mở hoặc EA BotCheckXauEA chưa được gắn vào chart.`,
        `• Hướng dẫn:`,
        `  1. Mở phần mềm MetaTrader 5 trên máy tính.`,
        `  2. Đảm bảo nút "Algo Trading" trên thanh công cụ MT5 có màu XANH.`,
        `  3. Gắn EA "BotCheckXauEA" vào biểu đồ XAUUSD.`,
        `  4. Kiểm tra URL WebRequest: http://127.0.0.1:${MT5_PORT}`
      ].join('\n');

      for (const cid of getDefaultChatIds()) {
        await sendTelegramMessage(warnMsg, cid);
      }
    }
  } catch {}
}, 60000);

// 4. Khởi động Telegram Userbot lắng nghe tự động từ nhóm kín (Telegram Signal Copier kết hợp AI Gemini)
if (process.env.TELEGRAM_API_ID && process.env.TELEGRAM_API_HASH) {
  const targetChannels = (process.env.TELEGRAM_TARGET_CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
  startTelegramUserbot({
    apiId: process.env.TELEGRAM_API_ID,
    apiHash: process.env.TELEGRAM_API_HASH,
    targetChannels,
    getTradingState: () => bridgeServer.getTradingState(),
    onSignalDetected: async ({ signal, sourceChat, rawText }) => {
      logger(`[Userbot] 🚀 Đang tự động xử lý tín hiệu từ nhóm: ${sourceChat}`);
      await executeTelegramSignal(signal, sourceChat, getDefaultChatIds());
    },
    onAdminInstruction: async ({ aiResult, sourceChat, rawText }) => {
      logger(`[Userbot 🤖 AI] Nhận diện hành động từ [${sourceChat}]: ${aiResult.action} - ${aiResult.reason}`);
      const chatIds = getDefaultChatIds();

      if (aiResult.action === 'CANCEL_PENDING') {
        bridgeServer.queueCancelAllPending(`Admin ${sourceChat} yêu cầu: ${aiResult.reason}`);
        for (const cid of chatIds) {
          await sendTelegramMessage(
            `🗑️ <b>[AI TELEGRAM COPIER] HỦY LỆNH CHỜ THEO ADMIN</b>\n` +
            `• Kênh nguồn: <code>${sourceChat}</code>\n` +
            `• Tin nhắn: <i>"${rawText}"</i>\n` +
            `• Phân tích AI: ${aiResult.reason}\n` +
            `👉 <b>Đã phát lệnh hủy toàn bộ lệnh chờ Limit sang MT5!</b>`,
            cid
          ).catch(() => {});
        }
      } else if (aiResult.action === 'MOVE_SL_BE') {
        bridgeServer.queueMoveSlToBreakeven(aiResult.symbol || 'XAUUSD');
        for (const cid of chatIds) {
          await sendTelegramMessage(
            `🛡️ <b>[AI TELEGRAM COPIER] DỜI SL VỀ HÒA VỐN (BE)</b>\n` +
            `• Kênh nguồn: <code>${sourceChat}</code>\n` +
            `• Tin nhắn: <i>"${rawText}"</i>\n` +
            `• Phân tích AI: ${aiResult.reason}\n` +
            `👉 <b>Đã dời SL về điểm vào lệnh (Breakeven) cho các vị thế đang chạy!</b>`,
            cid
          ).catch(() => {});
        }
      } else if (aiResult.action === 'CLOSE_POSITION') {
        bridgeServer.queueEmergencyCloseAll(`Admin ${sourceChat} yêu cầu cắt tay: ${aiResult.reason}`);
        for (const cid of chatIds) {
          await sendTelegramMessage(
            `🚨 <b>[AI TELEGRAM COPIER] ĐÓNG VỊ THẾ THEO ADMIN</b>\n` +
            `• Kênh nguồn: <code>${sourceChat}</code>\n` +
            `• Tin nhắn: <i>"${rawText}"</i>\n` +
            `• Phân tích AI: ${aiResult.reason}\n` +
            `👉 <b>Đã gửi lệnh đóng toàn bộ vị thế trên sàn MT5!</b>`,
            cid
          ).catch(() => {});
        }
      } else if (aiResult.action === 'UPDATE_SL_TP') {
        bridgeServer.queueUpdateSlTp({
          symbol: aiResult.symbol || 'XAUUSD',
          sl: aiResult.sl || 0,
          tp: aiResult.tp || 0
        });
        for (const cid of chatIds) {
          await sendTelegramMessage(
            `🔄 <b>[AI TELEGRAM COPIER] CẬP NHẬT SL/TP THEO ADMIN</b>\n` +
            `• Kênh nguồn: <code>${sourceChat}</code>\n` +
            `• Tin nhắn: <i>"${rawText}"</i>\n` +
            `• SL mới: <b>${aiResult.sl || 'Không đổi'}</b> | TP mới: <b>${aiResult.tp || 'Không đổi'}</b>\n` +
            `👉 <b>Đã cập nhật SL/TP lên MT5!</b>`,
            cid
          ).catch(() => {});
        }
      } else if (aiResult.action === 'NEW_SIGNAL' && aiResult.signal) {
        logger(`[Userbot 🤖 AI] Nhận diện tín hiệu văn xuôi mới từ [${sourceChat}]: ${aiResult.signal.action} @ ${aiResult.signal.entry}`);
        await executeTelegramSignal(aiResult.signal, sourceChat, chatIds);
      }
    },
    logger
  }).catch(err => {
    logger(`[TelegramUserbot] Lỗi khởi động: ${err.message}`);
  });
}



