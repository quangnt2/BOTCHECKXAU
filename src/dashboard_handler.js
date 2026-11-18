import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadOrderHistory } from './order_history.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const publicDir = path.join(__dirname, '..', 'public');
const screenshotsDir = path.join(__dirname, '..', 'screenshots');
const logsDir = path.join(__dirname, '..', 'logs');

// Đảm bảo thư mục public tồn tại
if (!fs.existsSync(publicDir)) {
  fs.mkdirSync(publicDir, { recursive: true });
}

/**
 * Cập nhật biến môi trường trong file .env và nạp vào process.env
 * @param {Object} updates Các cặp key-value cần cập nhật
 */
export function updateEnvFile(updates = {}) {
  try {
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return false;
    let content = fs.readFileSync(envPath, 'utf8');

    for (const [key, val] of Object.entries(updates)) {
      const regex = new RegExp(`^${key}=.*$`, 'm');
      if (regex.test(content)) {
        content = content.replace(regex, `${key}=${val}`);
      } else {
        content += `\n${key}=${val}`;
      }
      process.env[key] = String(val);
    }

    fs.writeFileSync(envPath, content, 'utf8');
    return true;
  } catch (err) {
    console.error(`[Dashboard] Lỗi cập nhật file .env: ${err.message}`);
    return false;
  }
}

/**
 * Đọc N dòng cuối cùng của file log
 * @param {string} filePath Đường dẫn file log
 * @param {number} maxLines Số dòng tối đa cần lấy
 * @returns {Array<string>}
 */
export function getRecentLogLines(filePath, maxLines = 80) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0);
    return lines.slice(-maxLines);
  } catch (err) {
    return [`[Dashboard] Lỗi đọc file log: ${err.message}`];
  }
}

/**
 * Phục vụ file tĩnh (HTML, CSS, JS, Ảnh PNG,...)
 * @param {import('http').ServerResponse} res
 * @param {string} filePath
 * @param {string} contentType
 */
function serveFile(res, filePath, contentType) {
  try {
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'File not found' }));
      return;
    }
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Server error: ${err.message}` }));
  }
}

/**
 * Dashboard Request Router & Handler
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 * @param {import('./mt5_bridge_server.js').MT5BridgeServer} bridgeServer
 * @param {Object} context Các hàm tiện ích và đối tượng trạng thái từ bot
 * @returns {Promise<boolean>} true nếu đã xử lý request, false nếu bỏ qua
 */
export async function handleDashboardRequest(req, res, bridgeServer, context = {}) {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  // 1. Phục vụ trang chủ Dashboard (GET / hoặc GET /dashboard)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/dashboard' || pathname === '/index.html')) {
    const indexPath = path.join(publicDir, 'index.html');
    serveFile(res, indexPath, 'text/html; charset=utf-8');
    return true;
  }

  // 2. Phục vụ ảnh biểu đồ từ thư mục screenshots (GET /screenshots/:filename)
  if (req.method === 'GET' && pathname.startsWith('/screenshots/')) {
    const filename = path.basename(pathname);
    const imgPath = path.join(screenshotsDir, filename);
    serveFile(res, imgPath, 'image/png');
    return true;
  }

  // 3. Phục vụ tài nguyên tĩnh khác trong public (GET /public/:filename)
  if (req.method === 'GET' && pathname.startsWith('/public/')) {
    const filename = pathname.replace('/public/', '');
    const safePath = path.join(publicDir, path.normalize(filename).replace(/^(\.\.[\/\\])+/, ''));
    let mime = 'text/plain';
    if (filename.endsWith('.css')) mime = 'text/css';
    else if (filename.endsWith('.js')) mime = 'application/javascript';
    else if (filename.endsWith('.json')) mime = 'application/json';
    else if (filename.endsWith('.png')) mime = 'image/png';
    else if (filename.endsWith('.svg')) mime = 'image/svg+xml';
    serveFile(res, safePath, mime);
    return true;
  }

  // 4. API: Lấy toàn bộ dữ liệu thống kê thời gian thực (GET /api/dashboard/stats)
  if (req.method === 'GET' && pathname === '/api/dashboard/stats') {
    const isAlive = Date.now() - (bridgeServer.accountInfo?.lastHeartbeat || 0) < 45000;
    const orderManager = context.getOrderManager ? context.getOrderManager() : null;
    const analysisState = context.getAnalysisState ? context.getAnalysisState() : {};

    // Chuẩn bị danh sách ảnh biểu đồ với URL truy cập được
    const formattedCharts = (analysisState.lastChartImages || []).map(img => {
      const filename = path.basename(img.path);
      return {
        tf: img.tf,
        label: img.tf === '240' ? 'H4' : img.tf === '60' ? 'H1' : img.tf === '15' ? 'M15' : img.tf === '5' ? 'M5' : img.tf === '1' ? 'M1' : img.tf,
        filename,
        url: `/screenshots/${filename}`
      };
    });

    // Lấy giá thị trường (MT5 hoặc TradingView)
    const livePrice = bridgeServer.getLatestMarketPrice() || analysisState.lastPriceInfo || null;

    // Lấy thông tin tài khoản MT5
    const account = {
      ...bridgeServer.accountInfo,
      connected: isAlive
    };

    // Chế độ giao dịch
    const tradingModes = {
      enableScalp: orderManager ? orderManager.enableScalp : true,
      enableHold: orderManager ? orderManager.enableHold : true,
      enableScalpM1: orderManager ? orderManager.enableScalpM1 : true,
      scalpM1TpUSD: orderManager ? orderManager.scalpM1TpUSD : 2.5,
      scalpM1SlUSD: orderManager ? orderManager.scalpM1SlUSD : 7.0,
      scalpM1IntervalSec: orderManager ? orderManager.scalpM1IntervalSec : 60,
      autoExecute: orderManager ? orderManager.autoExecute : true,
      autoCloseOnTrendReversal: orderManager ? orderManager.autoCloseOnTrendReversal : true,
      circuitBreakerTriggered: orderManager?.riskManager?.circuitBreakerTriggered || false,
      maxDrawdownPercent: orderManager?.riskManager?.maxDrawdownPercent || 5,
      maxDailyLossUSD: orderManager?.riskManager?.maxAccountLossUSD || 50
    };

    // Vị thế và deals
    const openPositions = account.openPositionsList || [];
    const closedDeals = account.closedDealsList || [];
    const recentOrders = loadOrderHistory().slice(0, 15);

    // Tính toán thống kê cơ bản hôm nay
    let winCount = 0;
    let lossCount = 0;
    let totalProfitFromDeals = 0;
    closedDeals.forEach(deal => {
      const p = Number(deal.profit || 0);
      totalProfitFromDeals += p;
      if (p > 0) winCount++;
      else if (p < 0) lossCount++;
    });
    const totalDeals = winCount + lossCount;
    const winRate = totalDeals > 0 ? Number(((winCount / totalDeals) * 100).toFixed(1)) : 0;

    // Thông số rủi ro, tỷ lệ R:R và bảo vệ vốn
    const riskConfig = orderManager?.riskManager?.getRiskStatus(account.equity) || {
      initialCapitalUSD: Number(process.env.INITIAL_CAPITAL_USD || 300.0),
      maxAccountLossUSD: Number(process.env.MAX_ACCOUNT_LOSS_USD || 150.0),
      maxDrawdownPercent: Number(process.env.MAX_DRAWDOWN_PERCENT || 50.0),
      minRR: Number(process.env.RISK_MIN_RR || 1.8),
      fixedSlUSD: Number(process.env.FIXED_SL_USD || 15.0),
      fixedTpUSD: Number(process.env.FIXED_TP_USD || 30.0),
      minSlDistanceUSD: Number(process.env.RISK_MIN_SL_USD || 8.0),
      maxSlDistanceUSD: Number(process.env.RISK_MAX_SL_USD || 30.0),
      isTriggered: false
    };

    // Danh sách cảnh báo giá
    const priceAlertManager = context.getPriceAlertManager ? context.getPriceAlertManager() : null;
    const priceAlerts = priceAlertManager ? priceAlertManager.getAlerts() : [];

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString('vi-VN'),
      account,
      price: livePrice,
      tradingModes,
      riskConfig,
      priceAlerts,
      botState: {
        isAnalyzing: Boolean(analysisState.isAnalyzing),
        lastAnalysisTime: analysisState.lastAnalysisTime,
        lastAnalysisTimeStr: analysisState.lastAnalysisTimeStr,
        symbol: process.env.SYMBOL || 'OANDA:XAUUSD',
        timeframes: ['H4', 'H1', 'M15', 'M5', 'M1']
      },
      analysis: {
        report: analysisState.lastAnalysisReport || 'Chưa có chu kỳ phân tích nào kể từ khi khởi động.',
        timestamp: analysisState.lastAnalysisTime,
        timeStr: analysisState.lastAnalysisTimeStr,
        charts: formattedCharts
      },
      positions: openPositions,
      pendingOrders: account.pendingOrdersList || [],
      deals: closedDeals,
      recentOrders,
      stats: {
        todayProfit: account.todayProfit || totalProfitFromDeals,
        winCount,
        lossCount,
        totalDeals,
        winRate,
        pendingQueueCount: bridgeServer.pendingQueue.length
      }
    }));
    return true;
  }

  // 5. API: Bật/Tắt chế độ (POST /api/dashboard/toggle-mode)
  if (req.method === 'POST' && pathname === '/api/dashboard/toggle-mode') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const orderManager = context.getOrderManager ? context.getOrderManager() : null;
      if (!orderManager) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'OrderManager is not available' }));
        return;
      }

      const { mode, value } = data; // mode: 'scalp_m1' | 'scalp_m1_config' | 'scalp' | 'hold' | 'auto_execute' | 'auto_reversal'
      if (mode === 'scalp_m1') {
        orderManager.setScalpM1(value !== undefined ? Boolean(value) : !orderManager.enableScalpM1);
        updateEnvFile({ ENABLE_SCALP_M1: orderManager.enableScalpM1 });
      } else if (mode === 'scalp_m1_config') {
        const { tp, sl } = data;
        orderManager.setScalpM1Config(tp, sl);
        updateEnvFile({
          SCALP_M1_TP_USD: orderManager.scalpM1TpUSD,
          SCALP_M1_SL_USD: orderManager.scalpM1SlUSD
        });
      } else if (mode === 'scalp') {
        orderManager.enableScalp = value !== undefined ? Boolean(value) : !orderManager.enableScalp;
      } else if (mode === 'hold') {
        orderManager.enableHold = value !== undefined ? Boolean(value) : !orderManager.enableHold;
      } else if (mode === 'auto_execute') {
        orderManager.setAutoExecute(value !== undefined ? Boolean(value) : !orderManager.autoExecute);
      } else if (mode === 'auto_reversal') {
        orderManager.autoCloseOnTrendReversal = value !== undefined ? Boolean(value) : !orderManager.autoCloseOnTrendReversal;
      }

      bridgeServer.logger(`[Dashboard] 🎛️ Người dùng thay đổi chế độ [${mode}]: ${value || JSON.stringify(data)}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        modes: {
          enableScalpM1: orderManager.enableScalpM1,
          scalpM1TpUSD: orderManager.scalpM1TpUSD,
          scalpM1SlUSD: orderManager.scalpM1SlUSD,
          scalpM1IntervalSec: orderManager.scalpM1IntervalSec,
          enableScalp: orderManager.enableScalp,
          enableHold: orderManager.enableHold,
          autoExecute: orderManager.autoExecute,
          autoCloseOnTrendReversal: orderManager.autoCloseOnTrendReversal
        }
      }));
    });
    return true;
  }

  // 6. API: Kích hoạt chu kỳ phân tích AI ngay lập tức (POST /api/dashboard/trigger-analysis)
  if (req.method === 'POST' && pathname === '/api/dashboard/trigger-analysis') {
    const analysisState = context.getAnalysisState ? context.getAnalysisState() : {};
    if (analysisState.isAnalyzing) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, message: 'Chu kỳ phân tích đang chạy, vui lòng chờ trong giây lát!' }));
      return true;
    }

    if (typeof context.triggerAnalysis === 'function') {
      const teleTargets = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
      bridgeServer.logger(`[Dashboard] 🚀 Người dùng bấm nút yêu cầu phân tích ngay từ Web Dashboard (Gửi kết quả về Telegram: ${teleTargets.join(', ')}).`);
      // Chạy ngầm trong tiến trình bot kèm danh sách Chat ID nhận thông báo Telegram
      context.triggerAnalysis(teleTargets).catch(err => {
        bridgeServer.logger(`[Dashboard] Lỗi chạy phân tích thủ công: ${err.message}`);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Đã phát lệnh bắt đầu chu kỳ phân tích đa khung thời gian & gửi kết quả về Telegram!' }));
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'triggerAnalysis handler not found' }));
    }
    return true;
  }

  // 7. API: Đóng 1 vị thế cụ thể (POST /api/dashboard/close-position)
  if (req.method === 'POST' && pathname === '/api/dashboard/close-position') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const ticket = Number(data.ticket);
      const symbol = data.symbol || 'XAUUSD';
      const reason = data.reason || 'Đóng thủ công từ Web Dashboard';

      if (!ticket) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing ticket parameter' }));
        return;
      }

      const orderId = bridgeServer.queueCloseOrder({ ticket, symbol, reason });
      bridgeServer.logger(`[Dashboard] ✂️ Đã phát lệnh đóng vị thế #${ticket} sang MT5 từ Web Dashboard.`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, orderId, ticket }));
    });
    return true;
  }

  // 8. API: Đóng toàn bộ vị thế khẩn cấp (POST /api/dashboard/close-all)
  if (req.method === 'POST' && pathname === '/api/dashboard/close-all') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const reason = data.reason || 'Đóng toàn bộ khẩn cấp từ Web Dashboard';
      bridgeServer.queueEmergencyCloseAll(reason);
      bridgeServer.logger(`[Dashboard] 🚨 NGƯỜI DÙNG BẤM ĐÓNG TOÀN BỘ VỊ THẾ KHẨN CẤP TỪ WEB!`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Đã phát lệnh CLOSE_ALL sang MT5' }));
    });
    return true;
  }

  // 8b. API: Hủy 1 lệnh chờ cụ thể (POST /api/dashboard/cancel-pending-order)
  if (req.method === 'POST' && pathname === '/api/dashboard/cancel-pending-order') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const ticket = Number(data.ticket);
      const symbol = data.symbol || 'XAUUSD';
      const reason = data.reason || 'Hủy lệnh chờ thủ công từ Web Dashboard';

      if (!ticket) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Missing ticket parameter' }));
        return;
      }

      const orderId = bridgeServer.queueCancelOrder({ ticket, symbol, reason });
      bridgeServer.logger(`[Dashboard] 🗑️ Đã phát lệnh hủy lệnh chờ #${ticket} sang MT5 từ Web Dashboard.`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, orderId, ticket }));
    });
    return true;
  }

  // 9. API: Đặt lệnh kiểm thử / thủ công nhanh (POST /api/dashboard/manual-order)
  if (req.method === 'POST' && pathname === '/api/dashboard/manual-order') {
    bridgeServer.readJsonBody(req, res, (data) => {
      let action = String(data.action || 'BUY').toUpperCase();
      const symbol = data.symbol || 'XAUUSD';
      const lot = Number(data.lot || 0.01);
      const sl = Number(data.sl || 0);
      const tp = Number(data.tp || 0);
      const orderType = String(data.orderType || 'MARKET').toUpperCase();
      const entry = Number(data.entry || 0);
      const reason = data.reason || 'Lệnh thủ công từ Web Dashboard';

      if (orderType === 'LIMIT') {
        if (!action.includes('_LIMIT')) {
          action = `${action}_LIMIT`;
        }
      }

      const order = {
        id: `web_${Date.now()}`,
        action,
        symbol,
        lot,
        sl,
        tp,
        orderType,
        entry,
        timeframe: 'MANUAL',
        reason,
        confidence: 99
      };

      bridgeServer.queueOrder(order);
      bridgeServer.logger(`[Dashboard] 🛒 Đã đưa lệnh thủ công [${action} ${lot} lot ${symbol} @ ${entry}] vào hàng đợi MT5.`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, order }));
    });
    return true;
  }

  // 10. API: Lấy các dòng log mới nhất (GET /api/dashboard/logs)
  if (req.method === 'GET' && pathname === '/api/dashboard/logs') {
    const todayLogFile = path.join(logsDir, 'bot.log');
    const lines = getRecentLogLines(todayLogFile, 90);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, lines }));
    return true;
  }

  // 11. API: Mở khóa ngắt mạch bảo vệ vốn (POST /api/dashboard/reset-circuit-breaker)
  if (req.method === 'POST' && pathname === '/api/dashboard/reset-circuit-breaker') {
    const orderManager = context.getOrderManager ? context.getOrderManager() : null;
    if (orderManager) {
      orderManager.resetCircuitBreaker();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, message: 'Đã mở khóa Circuit Breaker' }));
    return true;
  }

  // 12. API: Cập nhật thông số rủi ro, R:R và bảo vệ vốn (POST /api/dashboard/update-risk-config)
  if (req.method === 'POST' && pathname === '/api/dashboard/update-risk-config') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const orderManager = context.getOrderManager ? context.getOrderManager() : null;
      if (!orderManager || !orderManager.riskManager) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'RiskManager is not available' }));
        return;
      }

      const updates = {};
      const envUpdates = {};

      if (data.initialCapitalUSD !== undefined && Number(data.initialCapitalUSD) > 0) {
        updates.initialCapitalUSD = Number(data.initialCapitalUSD);
        envUpdates.INITIAL_CAPITAL_USD = updates.initialCapitalUSD.toFixed(1);
      }
      if (data.maxDrawdownPercent !== undefined && Number(data.maxDrawdownPercent) > 0) {
        updates.maxDrawdownPercent = Number(data.maxDrawdownPercent);
        envUpdates.MAX_DRAWDOWN_PERCENT = updates.maxDrawdownPercent.toFixed(1);
      }
      if (data.maxAccountLossUSD !== undefined && Number(data.maxAccountLossUSD) > 0) {
        updates.maxAccountLossUSD = Number(data.maxAccountLossUSD);
        envUpdates.MAX_ACCOUNT_LOSS_USD = updates.maxAccountLossUSD.toFixed(1);
      } else if (updates.initialCapitalUSD && updates.maxDrawdownPercent) {
        updates.maxAccountLossUSD = Number((updates.initialCapitalUSD * (updates.maxDrawdownPercent / 100.0)).toFixed(2));
        envUpdates.MAX_ACCOUNT_LOSS_USD = updates.maxAccountLossUSD.toFixed(1);
      }
      if (data.minRR !== undefined && Number(data.minRR) > 0) {
        updates.minRR = Number(data.minRR);
        envUpdates.RISK_MIN_RR = updates.minRR.toFixed(2);
      }
      if (data.fixedSlUSD !== undefined && Number(data.fixedSlUSD) > 0) {
        updates.fixedSlUSD = Number(data.fixedSlUSD);
        envUpdates.FIXED_SL_USD = updates.fixedSlUSD.toFixed(1);
      }
      if (data.fixedTpUSD !== undefined && Number(data.fixedTpUSD) > 0) {
        updates.fixedTpUSD = Number(data.fixedTpUSD);
        envUpdates.FIXED_TP_USD = updates.fixedTpUSD.toFixed(1);
      }
      if (data.defaultLot !== undefined && Number(data.defaultLot) > 0) {
        updates.defaultLot = Number(data.defaultLot);
        envUpdates.DEFAULT_LOT = updates.defaultLot.toFixed(2);
      }
      if (data.maxLot !== undefined && Number(data.maxLot) > 0) {
        updates.maxLot = Number(data.maxLot);
        envUpdates.MAX_LOT = updates.maxLot.toFixed(2);
      }
      if (data.maxTotalLot !== undefined && Number(data.maxTotalLot) > 0) {
        updates.maxTotalLot = Number(data.maxTotalLot);
        envUpdates.MAX_TOTAL_LOT = updates.maxTotalLot.toFixed(2);
      }
      if (data.maxConcurrentTrades !== undefined && Number(data.maxConcurrentTrades) >= 1) {
        updates.maxConcurrentTrades = parseInt(data.maxConcurrentTrades, 10);
        envUpdates.MAX_CONCURRENT_TRADES = updates.maxConcurrentTrades;
        envUpdates.ALLOW_CONCURRENT_TRADES = updates.maxConcurrentTrades > 1 ? 'true' : 'false';
      }

      // Cập nhật runtime instance
      orderManager.riskManager.updateConfig(updates);
      orderManager.riskManager.resetCircuitBreaker(bridgeServer.getLatestEquity());

      // Phát lệnh mở khóa Circuit Breaker sang MT5 EA
      bridgeServer.queueUnlockCircuitBreaker();

      // Lưu file .env để không bị mất khi khởi động lại
      updateEnvFile(envUpdates);

      bridgeServer.logger(`[Dashboard] ⚙️ Đã cập nhật cấu hình rủi ro: Vốn cơ sở: $${orderManager.riskManager.initialCapitalUSD} USD | Cắt lỗ: ${orderManager.riskManager.maxDrawdownPercent}% (-$${orderManager.riskManager.maxAccountLossUSD} USD) | R:R min: 1:${orderManager.riskManager.minRR} | SL: ${orderManager.riskManager.fixedSlUSD}U | TP: ${orderManager.riskManager.fixedTpUSD}U | Lot mặc định: ${orderManager.riskManager.defaultLot} | Max Lot: ${orderManager.riskManager.maxLot} | Max Tổng: ${orderManager.riskManager.maxTotalLot} | Max Lệnh: ${orderManager.riskManager.maxConcurrentTrades} | Mở khóa Circuit Breaker`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        message: 'Đã lưu cấu hình rủi ro & tỷ lệ R:R thành công!',
        riskConfig: orderManager.riskManager.getRiskStatus(bridgeServer.getLatestEquity())
      }));
    });
    return true;
  }

  // 13. API: Mở khóa Circuit Breaker (POST /api/dashboard/unlock-circuit-breaker)
  if (req.method === 'POST' && pathname === '/api/dashboard/unlock-circuit-breaker') {
    const orderManager = context.getOrderManager ? context.getOrderManager() : null;
    const latestEq = bridgeServer.getLatestEquity();
    if (orderManager && orderManager.riskManager) {
      orderManager.riskManager.resetCircuitBreaker(latestEq);
    }
    bridgeServer.queueUnlockCircuitBreaker();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      message: 'Đã mở khóa bảo vệ vốn và gửi lệnh UNLOCK sang MT5 EA thành công!',
      riskStatus: orderManager?.riskManager ? orderManager.riskManager.getRiskStatus(latestEq) : null
    }));
    return true;
  }

  // 14. API: Thêm cảnh báo giá (POST /api/dashboard/add-alert)
  if (req.method === 'POST' && pathname === '/api/dashboard/add-alert') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const priceAlertManager = context.getPriceAlertManager ? context.getPriceAlertManager() : null;
      if (!priceAlertManager) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'PriceAlertManager not available' }));
        return;
      }

      try {
        const newAlert = priceAlertManager.addAlert({
          targetPrice: data.targetPrice,
          condition: data.condition,
          note: data.note
        });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, alert: newAlert, alerts: priceAlertManager.getAlerts() }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
      }
    });
    return true;
  }

  // 14. API: Xóa cảnh báo giá (POST /api/dashboard/delete-alert)
  if (req.method === 'POST' && pathname === '/api/dashboard/delete-alert') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const priceAlertManager = context.getPriceAlertManager ? context.getPriceAlertManager() : null;
      if (!priceAlertManager) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'PriceAlertManager not available' }));
        return;
      }

      priceAlertManager.removeAlert(data.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, alerts: priceAlertManager.getAlerts() }));
    });
    return true;
  }

  // 15. API: Bật/Tắt cảnh báo giá (POST /api/dashboard/toggle-alert)
  if (req.method === 'POST' && pathname === '/api/dashboard/toggle-alert') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const priceAlertManager = context.getPriceAlertManager ? context.getPriceAlertManager() : null;
      if (!priceAlertManager) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'PriceAlertManager not available' }));
        return;
      }

      priceAlertManager.toggleAlert(data.id, data.active);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, alerts: priceAlertManager.getAlerts() }));
    });
    return true;
  }

  // 16. API: Kích hoạt lại cảnh báo giá đã chạm (POST /api/dashboard/reset-alert)
  if (req.method === 'POST' && pathname === '/api/dashboard/reset-alert') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const priceAlertManager = context.getPriceAlertManager ? context.getPriceAlertManager() : null;
      if (!priceAlertManager) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'PriceAlertManager not available' }));
        return;
      }

      priceAlertManager.resetAlert(data.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, alerts: priceAlertManager.getAlerts() }));
    });
    return true;
  }

  return false;
}
