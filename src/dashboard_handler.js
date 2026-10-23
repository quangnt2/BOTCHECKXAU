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

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      timestamp: Date.now(),
      timeStr: new Date().toLocaleTimeString('vi-VN'),
      account,
      price: livePrice,
      tradingModes,
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

      const { mode, value } = data; // mode: 'scalp' | 'hold' | 'auto_execute' | 'auto_reversal'
      if (mode === 'scalp') {
        orderManager.enableScalp = value !== undefined ? Boolean(value) : !orderManager.enableScalp;
      } else if (mode === 'hold') {
        orderManager.enableHold = value !== undefined ? Boolean(value) : !orderManager.enableHold;
      } else if (mode === 'auto_execute') {
        orderManager.setAutoExecute(value !== undefined ? Boolean(value) : !orderManager.autoExecute);
      } else if (mode === 'auto_reversal') {
        orderManager.autoCloseOnTrendReversal = value !== undefined ? Boolean(value) : !orderManager.autoCloseOnTrendReversal;
      }

      bridgeServer.logger(`[Dashboard] 🎛️ Người dùng thay đổi chế độ [${mode}]: ${value}`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        modes: {
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
      bridgeServer.logger('[Dashboard] 🚀 Người dùng bấm nút yêu cầu phân tích ngay từ Web Dashboard.');
      // Chạy ngầm trong tiến trình bot
      context.triggerAnalysis().catch(err => {
        bridgeServer.logger(`[Dashboard] Lỗi chạy phân tích thủ công: ${err.message}`);
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Đã phát lệnh bắt đầu chu kỳ phân tích đa khung thời gian!' }));
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

  // 9. API: Đặt lệnh kiểm thử / thủ công nhanh (POST /api/dashboard/manual-order)
  if (req.method === 'POST' && pathname === '/api/dashboard/manual-order') {
    bridgeServer.readJsonBody(req, res, (data) => {
      const action = String(data.action || 'BUY').toUpperCase();
      const symbol = data.symbol || 'XAUUSD';
      const lot = Number(data.lot || 0.01);
      const sl = Number(data.sl || 0);
      const tp = Number(data.tp || 0);
      const reason = data.reason || 'Lệnh thủ công từ Web Dashboard';

      const order = {
        id: `web_${Date.now()}`,
        action,
        symbol,
        lot,
        sl,
        tp,
        orderType: 'MARKET',
        entry: Number(data.entry || 0),
        timeframe: 'MANUAL',
        reason,
        confidence: 99
      };

      bridgeServer.queueOrder(order);
      bridgeServer.logger(`[Dashboard] 🛒 Đã đưa lệnh thủ công [${action} ${lot} lot ${symbol}] vào hàng đợi MT5.`);

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

  return false;
}
