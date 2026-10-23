import cron from 'node-cron';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { captureMultiTimeframeCharts } from './chart_capture.js';
import { analyzeMultiTimeframeCharts } from './ai_analyst.js';
import { sendTelegramMultiReport, sendTelegramMessage, startTelegramListener } from './telegram.js';
import { getCurrentXAUPrice } from './market_data.js';
import { MT5BridgeServer } from './mt5_bridge_server.js';
import { OrderManager } from './order_manager.js';
import { formatHistoryReport, formatOpenPositions } from './order_history.js';

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
      const msg = [
        `🛡️ [MT5 DỜI SL HÒA VỐN]`,
        `• Ticket: #${ticket}`,
        `• Lãi đạt điều kiện: ≥ +$2.0 USD`,
        `• SL mới đã dời về: ${price} USD (Hòa vốn + phí)`,
        `• Trạng thái: Lệnh an toàn 0% rủi ro, tiếp tục giữ về TP 6.0 USD`,
        `• Giờ: ${timeStr}`
      ].join('\n');
      logger(`[MT5 Bridge] 🛡️ Thông báo Telegram: Ticket #${ticket} đã dời SL về hòa vốn ${price} USD.`);
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
    const profitTag = profitNum >= 5.5 ? '🎯 CHẠM TP (+6U)' : profitNum >= 1.8 ? '🟢 CHỐT LỜI' : profitNum >= 0 ? '🛡️ HÒA VỐN' : '🔴 CẮT LỖ';
    const profitStr = profitNum >= 0 ? `+$${profitNum.toFixed(2)}` : `-$${Math.abs(profitNum).toFixed(2)}`;
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
  getAnalysisState: () => latestAnalysisData,
  triggerAnalysis: (targetChatIds = null) => runMultiAnalysisCycle(targetChatIds)
});

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
  logger(`\n======================================================`);
  logger(`[${now}] BẮT ĐẦU CHU KỲ PHÂN TÍCH ĐA KHUNG THỜI GIAN...`);
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
 * Xử lý tin nhắn tương tác từ người dùng gửi tới Telegram Bot
 */
async function handleTelegramCommand({ text, chatId }) {
  const norm = normalizeText(text);
  logger(`[TelegramListener] Nhận tin nhắn từ Chat ID ${chatId}: "${text}"`);

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

  // 5. Kiểm tra trạng thái MT5 (/mt5, mt5)
  if (norm.startsWith('/mt5') || norm === 'mt5') {
    const status = bridgeServer.accountInfo;
    const isAlive = Date.now() - status.lastHeartbeat < 20000;
    const todayPlNum = Number(status.todayProfit || 0);
    const todayPlStr = todayPlNum >= 0 ? `+$${todayPlNum.toFixed(2)}` : `-$${Math.abs(todayPlNum).toFixed(2)}`;

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
      const slP = (curP - 4.0).toFixed(2);
      const tpP = (curP + 8.0).toFixed(2);

      const mockAnalysis = `
[TEST ORDER] Giá: ${curP}
\`\`\`json
{
  "action": "BUY",
  "symbol": "XAUUSD",
  "entry": ${curP.toFixed(2)},
  "sl": ${slP},
  "tp": ${tpP},
  "timeframe": "M15",
  "reason": "Test MT5",
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
    const risk = orderManager.riskManager.getRiskStatus(bridgeServer.getLatestEquity());
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

  // Lệnh bật/tắt Scalp (/scalp, /scalp on, /scalp off)
  if (norm.startsWith('/scalp') || norm.includes('scalp on') || norm.includes('scalp off') || norm.includes('bat scalp') || norm.includes('tat scalp')) {
    if (norm.includes('off') || norm.includes('tat') || norm.includes('0')) {
      orderManager.setScalp(false);
    } else if (norm.includes('on') || norm.includes('bat') || norm.includes('1')) {
      orderManager.setScalp(true);
    } else {
      orderManager.toggleScalp();
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

  // 11. Lệnh trợ giúp / Start (/start, /help, menu)
  if (norm.startsWith('/start') || norm.startsWith('/help') || norm === 'help' || norm === 'menu') {
    const helpMsg = [
      `[XAU/USD BOT - MENU LỆNH]`,
      `• /gia: Xem giá vàng thời gian thực (Ưu tiên MT5)`,
      `• /plan: Chụp ảnh & phân tích Gemini đa khung`,
      `• /mode: Xem & đổi chế độ SCALP / HOLD dài`,
      `• /scalp on|off: Bật hoặc tắt lệnh Scalp M1/M5`,
      `• /hold on|off: Bật hoặc tắt lệnh Hold dài H1/H4`,
      `• /mt5: Kiểm tra kết nối & số dư MT5`,
      `• /positions: Xem các lệnh đang chạy trên MT5`,
      `• /history: Xem lịch sử giao dịch & P&L hôm nay`,
      `• /risk: Xem trạng thái bảo vệ vốn & Circuit Breaker`,
      `• /unlock: Mở khóa giao dịch khi bị ngắt mạch`,
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

// Cấu hình chu kỳ quét thị trường (mặc định 5 phút để giảm nhiễu và tránh over-trading)
const SCAN_INTERVAL_MINUTES = Math.max(1, parseInt(process.env.SCAN_INTERVAL_MINUTES || '5', 10));

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

// Kích hoạt lắng nghe tin nhắn tương tác và sự kiện bấm nút từ Telegram
startTelegramListener(handleTelegramCommand, handleTelegramCallbackQuery);

