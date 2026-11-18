/**
 * SL POST-MORTEM ANALYZER & SELF-HEALING AUTO-REMEDIATION ENGINE
 * Tự động tổng hợp các lệnh cắt lỗ (SL), phân tích nguyên nhân gốc rễ,
 * tự điều chỉnh tham số an toàn (RiskManager / OrderManager / .env)
 * và cập nhật bài học trực tiếp vào prompt AI Vision mà không cần người dùng nhắc.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCurrentICTSession } from './session_helper.js';
import { loadOrderHistory } from './order_history.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const DEFAULT_LOGS_DIR = path.join(__dirname, '..', 'logs');

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;

export class SLAnalyzer {
  /**
   * @param {Object} options
   * @param {string} [options.dataDir]
   * @param {string} [options.logsDir]
   * @param {function(string): void} [options.logger]
   */
  constructor({ dataDir = DEFAULT_DATA_DIR, logsDir = DEFAULT_LOGS_DIR, logger = console.log } = {}) {
    this.dataDir = dataDir;
    this.logsDir = logsDir;
    this.logger = logger;

    if (!fs.existsSync(this.dataDir)) {
      fs.mkdirSync(this.dataDir, { recursive: true });
    }

    this.auditTradesFile = path.join(this.dataDir, 'closed_trades_audit.json');
    this.remediationRulesFile = path.join(this.dataDir, 'auto_remediation_rules.json');
    this.auditHistoryFile = path.join(this.dataDir, 'sl_audit_history.json');

    this.enabled = (process.env.AUTO_REMEDIATION_ENABLED ?? 'true').toString().toLowerCase() === 'true';
  }

  /**
   * Đọc JSON an toàn từ đĩa
   */
  _readJson(filePath, fallback) {
    try {
      if (!fs.existsSync(filePath)) return fallback;
      const raw = fs.readFileSync(filePath, 'utf8');
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  /**
   * Ghi JSON an toàn ra đĩa
   */
  _writeJson(filePath, data) {
    try {
      if (!fs.existsSync(path.dirname(filePath))) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      }
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      this.logger(`[SLAnalyzer] Lỗi ghi file ${path.basename(filePath)}: ${err.message}`);
    }
  }

  /**
   * Nạp trạng thái quy tắc tự khắc phục hiện hành
   */
  loadRemediationRules() {
    const defaults = {
      blockedHoursVN: [],       // [{ hour: number, reason: string, expiresAt: number }]
      activeLessons: [],        // string[] tiêm vào prompt Gemini Vision
      lastAuditAt: 0,
      lastRemediationSummary: '',
      appliedHistory: []        // Lịch sử các hành động đã tự khắc phục
    };
    const data = this._readJson(this.remediationRulesFile, defaults);
    const now = Date.now();

    // Tự động gỡ bỏ các khung giờ tạm khóa đã hết hạn (> 3 ngày)
    const activeBlocked = (Array.isArray(data.blockedHoursVN) ? data.blockedHoursVN : [])
      .filter(item => item && typeof item.hour === 'number' && (!item.expiresAt || item.expiresAt > now));

    return {
      ...defaults,
      ...data,
      blockedHoursVN: activeBlocked
    };
  }

  /**
   * Đồng bộ các quy tắc tự khắc phục đã lưu (giờ tạm khóa) vào RiskManager lúc khởi động
   * @param {import('./risk_manager.js').RiskManager} riskManager
   */
  applyPersistedRulesToRiskManager(riskManager) {
    if (!riskManager) return;
    const rules = this.loadRemediationRules();
    const hours = rules.blockedHoursVN.map(item => item.hour);
    if (hours.length > 0) {
      riskManager.updateConfig({ blockedHoursVN: hours });
      this.logger(`[SLAnalyzer] 🛡️ Đã nạp ${hours.length} khung giờ tạm khóa tự động (VN): ${hours.map(h => `${h}h`).join(', ')}`);
    }
  }

  /**
   * Tìm lệnh khớp gần nhất trong order_history.json tương ứng với deal vừa đóng
   */
  _matchOrderFromHistory(closedTimestamp, lot = 0.02, orderHistory = null) {
    const history = Array.isArray(orderHistory) ? orderHistory : loadOrderHistory();
    if (!history || history.length === 0) return null;

    // Lọc các lệnh FILLED mở trước thời điểm đóng lệnh (trong vòng 24 giờ)
    const MAX_HOLD_MS = 24 * 60 * 60 * 1000;
    let bestMatch = null;
    let bestDiff = Infinity;

    for (const ord of history) {
      if (!ord || ord.status !== 'FILLED') continue;
      if (!['BUY', 'SELL', 'BUY_LIMIT', 'SELL_LIMIT'].includes(ord.action)) continue;
      const ordTime = Number(ord.timestamp || 0);
      if (!ordTime || ordTime > closedTimestamp + 60000) continue;
      const diff = closedTimestamp - ordTime;
      if (diff >= -60000 && diff <= MAX_HOLD_MS) {
        // Ưu tiên lệnh có cùng khối lượng lot
        const lotPenalty = (lot && ord.lot && Math.abs(Number(ord.lot) - Number(lot)) > 0.001) ? 6 * 3600 * 1000 : 0;
        const score = Math.abs(diff) + lotPenalty;
        if (score < bestDiff) {
          bestDiff = score;
          bestMatch = ord;
        }
      }
    }
    return bestMatch;
  }

  /**
   * Phân loại nguyên nhân gốc rễ cho 1 lệnh cắt lỗ (SL)
   */
  classifyLossCause(trade) {
    const profit = Number(trade.profit || 0);
    if (profit >= -0.5) {
      return { code: 'WIN_OR_BE', label: 'Lãi / Hòa vốn' };
    }

    const absLoss = Math.abs(profit);
    const expectedSlLoss = Number(trade.expectedSlLossUSD || 0);
    const slippageRatio = expectedSlLoss > 0 ? Number((absLoss / expectedSlLoss).toFixed(2)) : 1.0;

    // 1. Giãn Spread / GAP giờ giao phiên Rollover (16:30 - 18:15 NY) HOẶC lỗ thực tế >= 1.5x SL thiết kế
    if (trade.isRolloverWindow || (expectedSlLoss > 0 && slippageRatio >= 1.5)) {
      return {
        code: 'ROLLOVER_SLIPPAGE',
        label: trade.isRolloverWindow
          ? `Giãn Spread / GAP giờ giao phiên Rollover (${trade.vnTimeStr} VN | Trượt ${slippageRatio}x SL)`
          : `Trượt giá SL nghiêm trọng (${slippageRatio}x SL dự kiến: -$${absLoss.toFixed(2)} vs -$${expectedSlLoss.toFixed(2)})`
      };
    }

    // 2. Copy Trade từ kênh Telegram ngoài
    if (trade.tradeStyle === 'COPY_TRADE' || String(trade.orderReason || '').toLowerCase().includes('copy trade')) {
      return {
        code: 'COPY_TRADE_SL',
        label: 'Lệnh Copy Trade từ kênh Telegram chạm SL'
      };
    }

    // 3. Trượt giá do Spread rộng ngoài giờ rollover (vượt > 20% SL thiết kế hoặc spread > 30 pts)
    if ((expectedSlLoss > 0 && slippageRatio >= 1.2) || Number(trade.spread || 0) > 30) {
      return {
        code: 'HIGH_SPREAD_SLIPPAGE',
        label: `Spread rộng / trượt giá lúc khớp (Spread: ${trade.spread || 'N/A'} pts | Lỗ ${slippageRatio}x SL)`
      };
    }

    // 4. Lệnh Scalp M1 bị quét râu (Whipsaw)
    if (trade.tradeStyle === 'SCALP_M1') {
      return {
        code: 'SCALP_M1_WHIPSAW',
        label: `Scalp M1 bị quét SL ngắn (${trade.sessionCode || 'N/A'} | ${trade.vnTimeStr} VN)`
      };
    }

    // 5. Thanh khoản thấp (Inter-session / Phiên Á)
    if (trade.sessionCode === 'INTER_SESSION' || trade.sessionCode === 'ASIAN_RANGE') {
      return {
        code: 'LOW_LIQUIDITY_SESSION',
        label: `Vào lệnh phiên thanh khoản thấp (${trade.sessionName || trade.sessionCode})`
      };
    }

    // 6. Lệnh Hold dài H1/H4 chạm SL cấu trúc
    return {
      code: 'HOLD_SL',
      label: `Lệnh Hold H1/H4 chạm SL (${trade.sessionCode || 'N/A'} | ${trade.vnTimeStr} VN)`
    };
  }

  /**
   * Ghi nhận 1 lệnh vừa đóng từ MT5 vào file audit (tự động gắn metadata + nguyên nhân SL)
   */
  recordClosedDeal(deal, { spread = null, orderHistory = null, closedAt = Date.now() } = {}) {
    if (!deal || !deal.ticket) return null;

    const trades = this._readJson(this.auditTradesFile, []);
    const ticketStr = String(deal.ticket);
    if (trades.some(t => String(t.ticket) === ticketStr)) {
      return trades.find(t => String(t.ticket) === ticketStr);
    }

    const closedDate = new Date(closedAt);
    const session = getCurrentICTSession(closedDate);
    const matchedOrder = this._matchOrderFromHistory(closedAt, deal.lot, orderHistory);

    const lot = Number(deal.lot || matchedOrder?.lot || 0.02);
    const entry = Number(matchedOrder?.entry || 0);
    const sl = Number(matchedOrder?.sl || 0);
    const tp = Number(matchedOrder?.tp || 0);
    const slDist = (entry > 0 && sl > 0) ? Number(Math.abs(entry - sl).toFixed(2)) : 0;
    const expectedSlLossUSD = slDist > 0 ? Number((slDist * lot * 100).toFixed(2)) : 0;

    let tradeStyle = 'HOLD';
    if (matchedOrder) {
      const reasonLower = String(matchedOrder.reason || '').toLowerCase();
      if (reasonLower.includes('copy trade')) {
        tradeStyle = 'COPY_TRADE';
      } else if (
        matchedOrder.tradeStyle === 'SCALP_M1' ||
        matchedOrder.timeframe === 'M1' ||
        (slDist > 0 && slDist <= 7.5)
      ) {
        tradeStyle = 'SCALP_M1';
      }
    }

    const profit = Number(deal.profit || 0);
    const record = {
      ticket: ticketStr,
      symbol: deal.symbol || 'XAUUSD',
      type: deal.type || matchedOrder?.action || 'UNKNOWN',
      lot,
      entry,
      sl,
      tp,
      closePrice: Number(deal.price || 0),
      profit,
      expectedSlLossUSD,
      slippageRatio: (profit < -0.5 && expectedSlLossUSD > 0)
        ? Number((Math.abs(profit) / expectedSlLossUSD).toFixed(2))
        : 1.0,
      spread: spread !== null ? Number(spread) : null,
      tradeStyle,
      orderTicket: matchedOrder?.ticket ? String(matchedOrder.ticket) : null,
      orderReason: matchedOrder?.reason || '',
      closedAt,
      vnHour: session.vnHour,
      vnTimeStr: session.vnTimeStr,
      nyTimeStr: session.nyTimeStr,
      sessionCode: session.sessionCode,
      sessionName: session.sessionName,
      isRolloverWindow: session.isRolloverWindow
    };

    const cause = this.classifyLossCause(record);
    record.rootCause = cause.code;
    record.rootCauseLabel = cause.label;

    trades.push(record);
    // Giữ tối đa 500 lệnh gần nhất (hoặc trong vòng 30 ngày)
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const trimmed = trades.filter(t => (t.closedAt || 0) >= thirtyDaysAgo).slice(-500);
    this._writeJson(this.auditTradesFile, trimmed);

    return record;
  }

  /**
   * Quét bổ sung các lệnh đã đóng từ file logs/bot_*.log trong 3 ngày gần nhất
   * để đảm bảo không sót lệnh SL nào từ trước khi khởi động lại bot
   */
  importRecentDealsFromLogs(windowDays = 3) {
    let importedCount = 0;
    try {
      if (!fs.existsSync(this.logsDir)) return 0;
      const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
      const logFiles = fs.readdirSync(this.logsDir)
        .filter(f => /^bot_\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort();

      const orderHistory = loadOrderHistory();
      const dealRegex = /^\[(\d{2}):(\d{2}):(\d{2})\s+(\d{2})\/(\d{2})\/(\d{4})\]\s+\[MT5\].*Lệnh\s+#(\d+)\s+vừa đóng:\s+([+-])\$?([\d.]+)\s+USD/;

      for (const file of logFiles) {
        const fullPath = path.join(this.logsDir, file);
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs < cutoff) continue;

        const lines = fs.readFileSync(fullPath, 'utf8').split('\n');
        for (const line of lines) {
          const m = line.match(dealRegex);
          if (!m) continue;
          const [, hh, mm, ss, dd, mo, yyyy, ticket, sign, amtStr] = m;
          // Tạo timestamp chính xác theo giờ VN (+07:00)
          const isoStr = `${yyyy}-${mo}-${dd}T${hh}:${mm}:${ss}+07:00`;
          const closedAt = Date.parse(isoStr);
          if (isNaN(closedAt) || closedAt < cutoff) continue;

          const profit = (sign === '-' ? -1 : 1) * parseFloat(amtStr);
          const beforeCount = this._readJson(this.auditTradesFile, []).length;
          this.recordClosedDeal(
            { ticket, symbol: 'XAUUSD', profit },
            { orderHistory, closedAt }
          );
          const afterCount = this._readJson(this.auditTradesFile, []).length;
          if (afterCount > beforeCount) importedCount++;
        }
      }
    } catch (err) {
      this.logger(`[SLAnalyzer] Lỗi đọc bổ sung log lệnh đóng: ${err.message}`);
    }
    return importedCount;
  }

  /**
   * Tổng hợp các lệnh SL trong cửa sổ thời gian (mặc định 3 ngày), phân tích nguyên nhân
   * và TỰ ĐỘNG KHẮC PHỤC mà không cần người dùng yêu cầu.
   *
   * @param {Object} params
   * @param {import('./order_manager.js').OrderManager} [params.orderManager]
   * @param {function(Object): boolean} [params.updateEnvFile]
   * @param {number} [params.windowDays=3]
   * @param {string} [params.trigger='SCHEDULED']
   * @param {boolean} [params.importLogs=true]
   * @param {boolean} [params.applyRemediation=true]
   */
  analyzeAndAutoRemediate({
    orderManager = null,
    updateEnvFile = null,
    windowDays = 3,
    trigger = 'SCHEDULED',
    importLogs = true,
    applyRemediation = true
  } = {}) {
    if (importLogs) {
      const imported = this.importRecentDealsFromLogs(windowDays);
      if (imported > 0) {
        this.logger(`[SLAnalyzer] 📥 Đã tổng hợp bổ sung ${imported} lệnh đóng từ file log trong ${windowDays} ngày qua.`);
      }
    }

    const now = Date.now();
    const cutoff = now - windowDays * 24 * 60 * 60 * 1000;
    const allTrades = this._readJson(this.auditTradesFile, []);
    const recentTrades = allTrades.filter(t => (t.closedAt || 0) >= cutoff);

    const wins = recentTrades.filter(t => Number(t.profit || 0) > 0.5);
    const losses = recentTrades.filter(t => Number(t.profit || 0) < -0.5);
    const breakevens = recentTrades.filter(t => Math.abs(Number(t.profit || 0)) <= 0.5);

    const totalProfitUSD = Number(wins.reduce((s, t) => s + Number(t.profit || 0), 0).toFixed(2));
    const totalLossUSD = Number(losses.reduce((s, t) => s + Math.abs(Number(t.profit || 0)), 0).toFixed(2));
    const netPnL = Number(recentTrades.reduce((s, t) => s + Number(t.profit || 0), 0).toFixed(2));
    const decidedCount = wins.length + losses.length;
    const winRate = decidedCount > 0 ? Number(((wins.length / decidedCount) * 100).toFixed(1)) : 0;

    // Nhóm các lệnh SL theo nguyên nhân gốc rễ
    const causeCounts = {};
    const causeLossUSD = {};
    const hourStats = {}; // { [vnHour]: { wins, losses, lossUSD } }
    let scalpWins = 0, scalpLosses = 0, scalpNetPnL = 0;
    let holdWins = 0, holdLosses = 0, holdNetPnL = 0;

    for (const t of recentTrades) {
      const h = Number(t.vnHour);
      if (!isNaN(h)) {
        if (!hourStats[h]) hourStats[h] = { wins: 0, losses: 0, lossUSD: 0 };
        if (t.profit > 0.5) hourStats[h].wins++;
        else if (t.profit < -0.5) {
          hourStats[h].losses++;
          hourStats[h].lossUSD = Number((hourStats[h].lossUSD + Math.abs(t.profit)).toFixed(2));
        }
      }

      if (t.tradeStyle === 'SCALP_M1') {
        if (t.profit > 0.5) scalpWins++;
        else if (t.profit < -0.5) scalpLosses++;
        scalpNetPnL = Number((scalpNetPnL + Number(t.profit || 0)).toFixed(2));
      } else if (t.tradeStyle === 'HOLD') {
        if (t.profit > 0.5) holdWins++;
        else if (t.profit < -0.5) holdLosses++;
        holdNetPnL = Number((holdNetPnL + Number(t.profit || 0)).toFixed(2));
      }

      if (t.profit < -0.5) {
        const code = t.rootCause || this.classifyLossCause(t).code;
        causeCounts[code] = (causeCounts[code] || 0) + 1;
        causeLossUSD[code] = Number(((causeLossUSD[code] || 0) + Math.abs(t.profit)).toFixed(2));
      }
    }

    const actionsApplied = [];
    const newLessons = [];
    const rules = this.loadRemediationRules();
    const riskUpdates = {};
    const envUpdates = {};

    const canRemediate = applyRemediation && this.enabled && losses.length > 0;

    if (canRemediate) {
      const rm = orderManager?.riskManager || null;

      // ================================================================
      // KHẮC PHỤC 1: Lỗi giãn Spread / GAP giờ giao phiên Rollover
      // ================================================================
      if ((causeCounts.ROLLOVER_SLIPPAGE || 0) >= 1) {
        const curSpreadCap = rm?.maxSpreadPoints ?? Number(process.env.MAX_SPREAD_POINTS || 40);
        const nextSpreadCap = Math.min(curSpreadCap, 35);

        riskUpdates.rolloverGuardEnabled = true;
        riskUpdates.maxSpreadPoints = nextSpreadCap;
        envUpdates.ROLLOVER_GUARD_ENABLED = 'true';
        envUpdates.AUTO_CLOSE_BEFORE_ROLLOVER = 'true';
        envUpdates.MAX_SPREAD_POINTS = String(nextSpreadCap);

        actionsApplied.push(
          `🛡️ [ROLLOVER GUARD]: Phát hiện ${causeCounts.ROLLOVER_SLIPPAGE} lệnh SL trượt giá/Rollover (-$${causeLossUSD.ROLLOVER_SLIPPAGE} USD) ➔ Đã kích hoạt cấm vào lệnh 16:30–18:15 NY (04:30–06:15 VN), tự động đóng lệnh Scalp lúc 16:50 NY và khóa Max Spread ≤ ${nextSpreadCap} pts.`
        );
        newLessons.push('CẤM vào lệnh sát giờ giao phiên Rollover (16:30-18:15 NY / 04:30-06:15 VN) do từng dính trượt giá SL nặng.');
      }

      // ================================================================
      // KHẮC PHỤC 2: Trượt giá do Spread giãn rộng ngoài giờ Rollover
      // ================================================================
      if ((causeCounts.HIGH_SPREAD_SLIPPAGE || 0) >= 2) {
        const curSpreadCap = riskUpdates.maxSpreadPoints ?? rm?.maxSpreadPoints ?? Number(process.env.MAX_SPREAD_POINTS || 35);
        const tightenedSpread = Math.max(25, curSpreadCap - 5);
        if (tightenedSpread < curSpreadCap) {
          riskUpdates.maxSpreadPoints = tightenedSpread;
          envUpdates.MAX_SPREAD_POINTS = String(tightenedSpread);
          actionsApplied.push(
            `📏 [SPREAD FILTER]: Phát hiện ${causeCounts.HIGH_SPREAD_SLIPPAGE} lệnh trượt SL do spread rộng ➔ Đã siết trần Spread tối đa xuống ${tightenedSpread} pts.`
          );
        }
        newLessons.push('Tránh vào lệnh khi nến giật mạnh / spread giãn rộng gây trượt SL.');
      }

      // ================================================================
      // KHẮC PHỤC 3: Scalp M1 bị quét SL liên tục (Whipsaw)
      // ================================================================
      const scalpDecided = scalpWins + scalpLosses;
      const scalpWinRate = scalpDecided > 0 ? Number(((scalpWins / scalpDecided) * 100).toFixed(1)) : 100;
      if (scalpLosses >= 3 && scalpWinRate < 45) {
        const curCooldownMin = rm ? Math.round(rm.scalpCooldownMs / 60000) : Number(process.env.SCALP_COOLDOWN_MINUTES || 5);
        const nextCooldownMin = Math.min(15, curCooldownMin + 2);
        const curIntervalSec = orderManager?.scalpM1IntervalSec ?? Number(process.env.SCALP_M1_INTERVAL_SEC || 180);
        const nextIntervalSec = Math.min(300, curIntervalSec + 60);

        if (nextCooldownMin > curCooldownMin) {
          riskUpdates.scalpCooldownMinutes = nextCooldownMin;
          envUpdates.SCALP_COOLDOWN_MINUTES = String(nextCooldownMin);
        }
        if (orderManager && nextIntervalSec > curIntervalSec) {
          orderManager.scalpM1IntervalSec = nextIntervalSec;
          if (rm) rm.scalpM1IntervalSec = nextIntervalSec;
          envUpdates.SCALP_M1_INTERVAL_SEC = String(nextIntervalSec);
        }

        actionsApplied.push(
          `⏱️ [GIÃN NHỊP SCALP M1]: Scalp M1 đang thua ${scalpLosses}/${scalpDecided} lệnh (WR ${scalpWinRate}%, Net ${scalpNetPnL >= 0 ? '+' : '-'}$${Math.abs(scalpNetPnL).toFixed(2)}) ➔ Tăng Cooldown Scalp lên ${nextCooldownMin} phút & giãn chu kỳ quét M1 lên ${nextIntervalSec}s.`
        );
        newLessons.push('Scalp M1 gần đây hay bị quét SL 5 giá -> Chỉ vào lệnh khi nến M1 đóng dứt khoát tại EMA/OB thuận xu hướng H4, tuyệt đối HOLD khi giá đi ngang nén.');

        // Nếu Scalp M1 lỗ nặng (từ 5 lệnh SL trở lên VÀ lỗ ròng <= -25 USD hoặc WR < 35%) -> Tự động tạm tắt Scalp M1 để bảo toàn vốn
        if (scalpLosses >= 5 && (scalpNetPnL <= -25 || scalpWinRate < 35)) {
          if (orderManager && orderManager.enableScalpM1) {
            orderManager.setScalpM1(false);
            envUpdates.ENABLE_SCALP_M1 = 'false';
            actionsApplied.push(
              `🛑 [TẠM TẮT SCALP M1]: Scalp M1 thua lỗ nặng (${scalpLosses} SL, Net -$${Math.abs(scalpNetPnL).toFixed(2)} USD, WR ${scalpWinRate}%) ➔ Đã TỰ ĐỘNG TẮT Scalp M1 để cắt chuỗi lỗ, chỉ giữ Hold dài H1/H4 an toàn.`
            );
          }
        }
      }

      // ================================================================
      // KHẮC PHỤC 4: Khung giờ VN thường xuyên dính SL (0 thắng, >= 3 thua)
      // ================================================================
      const existingBlockedMap = new Map(rules.blockedHoursVN.map(item => [item.hour, item]));
      const newlyBlockedHours = [];

      for (const [hourKey, st] of Object.entries(hourStats)) {
        const hourNum = parseInt(hourKey, 10);
        // Bỏ qua giờ Rollover (4, 5, 6h sáng) vì đã có Rollover Guard xử lý chuyên biệt
        if ([4, 5, 6].includes(hourNum)) continue;
        if (st.losses >= 3 && st.wins === 0) {
          if (!existingBlockedMap.has(hourNum)) {
            newlyBlockedHours.push(hourNum);
          }
          existingBlockedMap.set(hourNum, {
            hour: hourNum,
            reason: `Thua ${st.losses}/0 lệnh (-$${st.lossUSD} USD)`,
            expiresAt: now + THREE_DAYS_MS
          });
        }
      }

      rules.blockedHoursVN = Array.from(existingBlockedMap.values()).sort((a, b) => a.hour - b.hour);
      const blockedHourNums = rules.blockedHoursVN.map(x => x.hour);
      riskUpdates.blockedHoursVN = blockedHourNums;
      envUpdates.BLOCKED_HOURS_VN = blockedHourNums.join(',');

      if (newlyBlockedHours.length > 0) {
        actionsApplied.push(
          `🚫 [KHÓA KHUNG GIỜ XẤU]: Phát hiện khung giờ VN [${newlyBlockedHours.map(h => `${h}h`).join(', ')}] có tỷ lệ thua 100% (≥3 SL, 0 thắng) ➔ Đã tự động chặn giao dịch các giờ này trong 3 ngày.`
        );
        newLessons.push(`Hạn chế giao dịch các khung giờ hay quét SL (${blockedHourNums.map(h => `${h}h VN`).join(', ')}).`);
      }

      // ================================================================
      // KHẮC PHỤC 5: Lệnh Hold H1/H4 dính chuỗi SL
      // ================================================================
      const holdDecided = holdWins + holdLosses;
      const holdWinRate = holdDecided > 0 ? Number(((holdWins / holdDecided) * 100).toFixed(1)) : 100;
      if (holdLosses >= 2 && holdWinRate < 50) {
        const curHoldCooldown = rm ? Math.round(rm.tradeCooldownMs / 60000) : Number(process.env.TRADE_COOLDOWN_MINUTES || 15);
        const nextHoldCooldown = Math.min(30, curHoldCooldown + 5);
        const curMinRR = rm?.minRR ?? Number(process.env.RISK_MIN_RR || 2.0);
        const nextMinRR = Math.max(2.0, curMinRR);

        riskUpdates.enforceTrendAlignment = true;
        riskUpdates.minRR = nextMinRR;
        if (nextHoldCooldown > curHoldCooldown) {
          riskUpdates.tradeCooldownMinutes = nextHoldCooldown;
          envUpdates.TRADE_COOLDOWN_MINUTES = String(nextHoldCooldown);
        }
        envUpdates.ENFORCE_TREND_ALIGNMENT = 'true';
        envUpdates.RISK_MIN_RR = nextMinRR.toFixed(2);

        actionsApplied.push(
          `🎯 [SIẾT KỶ LUẬT HOLD]: Lệnh Hold đang có ${holdLosses} SL (WR ${holdWinRate}%) ➔ Giữ chặt đồng pha H4, R:R ≥ 1:${nextMinRR} và nâng Cooldown Hold lên ${nextHoldCooldown} phút.`
        );
        newLessons.push('Lệnh Hold gần đây dính SL -> Chỉ chọn setup ICT Unicorn/OTE/OB cực sạch tại Discount (BUY) / Premium (SELL), SL đặt sau đỉnh/đáy cấu trúc rõ ràng.');
      }

      // Áp dụng các thay đổi vào RiskManager runtime và lưu .env
      if (rm && Object.keys(riskUpdates).length > 0) {
        rm.updateConfig(riskUpdates);
      }
      if (typeof updateEnvFile === 'function' && Object.keys(envUpdates).length > 0) {
        updateEnvFile(envUpdates);
      }
    }

    // Cập nhật danh sách bài học AI (giữ tối đa 5 bài học gần nhất, không trùng lặp)
    if (newLessons.length > 0) {
      const merged = [...newLessons, ...(rules.activeLessons || [])];
      rules.activeLessons = [...new Set(merged)].slice(0, 5);
    }

    rules.lastAuditAt = now;

    // Tạo bản tóm tắt báo cáo
    const reportLines = [
      `🧠 [TỔNG HỢP LỆNH SL & TỰ ĐỘNG KHẮC PHỤC (${windowDays} NGÀY QUA)]`,
      `• Nguồn kích hoạt: ${trigger}`,
      `• Tổng lệnh đã đóng: ${recentTrades.length} lệnh (Thắng: ${wins.length} | SL: ${losses.length} | Hòa: ${breakevens.length})`,
      `• Tỷ lệ thắng (Winrate): ${winRate}% | Net P&L: ${netPnL >= 0 ? '+' : '-'}$${Math.abs(netPnL).toFixed(2)} USD`,
      `• Tổng tiền lãi: +$${totalProfitUSD.toFixed(2)} USD | Tổng tiền SL: -$${totalLossUSD.toFixed(2)} USD`
    ];

    if (losses.length > 0) {
      reportLines.push(`\n📌 PHÂN TÍCH NGUYÊN NHÂN SL:`);
      const causeLabels = {
        ROLLOVER_SLIPPAGE: 'Giãn Spread / GAP giờ Rollover (trượt SL nặng)',
        HIGH_SPREAD_SLIPPAGE: 'Spread sàn giãn rộng lúc khớp',
        SCALP_M1_WHIPSAW: 'Scalp M1 bị quét râu (Whipsaw)',
        LOW_LIQUIDITY_SESSION: 'Vào lệnh phiên thanh khoản thấp',
        HOLD_SL: 'Lệnh Hold H1/H4 chạm SL cấu trúc',
        COPY_TRADE_SL: 'Lệnh Copy Trade từ Telegram chạm SL'
      };
      for (const [code, count] of Object.entries(causeCounts)) {
        reportLines.push(`• ${causeLabels[code] || code}: ${count} lệnh (-$${causeLossUSD[code].toFixed(2)} USD)`);
      }

      // Liệt kê top 3 lệnh SL lớn nhất
      const topLosses = [...losses].sort((a, b) => a.profit - b.profit).slice(0, 3);
      reportLines.push(`\n🔻 TOP LỆNH SL NẶNG NHẤT:`);
      topLosses.forEach((l, idx) => {
        reportLines.push(`${idx + 1}. #${l.ticket} [${l.tradeStyle}] -$${Math.abs(l.profit).toFixed(2)} USD lúc ${l.vnTimeStr} VN — ${l.rootCauseLabel}`);
      });
    } else {
      reportLines.push(`\n✅ Không có lệnh SL nào trong ${windowDays} ngày qua!`);
    }

    if (actionsApplied.length > 0) {
      reportLines.push(`\n🛠️ ĐÃ TỰ ĐỘNG KHẮC PHỤC (KHÔNG CẦN THAO TÁC TAY):`);
      actionsApplied.forEach(a => reportLines.push(a));
    } else if (losses.length > 0) {
      reportLines.push(`\n🛡️ Trạng thái phòng thủ hiện tại đã tối ưu (Rollover Guard: BẬT, Max Spread ≤ ${orderManager?.riskManager?.maxSpreadPoints || process.env.MAX_SPREAD_POINTS || 35} pts).`);
    }

    if (rules.activeLessons.length > 0) {
      reportLines.push(`\n📚 BÀI HỌC ĐANG NẠP TỰ ĐỘNG CHO AI VISION (${rules.activeLessons.length}):`);
      rules.activeLessons.forEach((ls, i) => reportLines.push(`${i + 1}. ${ls}`));
    }

    const reportText = reportLines.join('\n');
    rules.lastRemediationSummary = reportText;

    if (actionsApplied.length > 0) {
      rules.appliedHistory = [
        {
          timestamp: now,
          timeStr: new Date(now).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
          trigger,
          lossCount: losses.length,
          totalLossUSD,
          actions: actionsApplied
        },
        ...(rules.appliedHistory || [])
      ].slice(0, 30);
    }

    this._writeJson(this.remediationRulesFile, rules);

    // Lưu lịch sử báo cáo audit
    const history = this._readJson(this.auditHistoryFile, []);
    history.unshift({
      timestamp: now,
      timeStr: new Date(now).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' }),
      trigger,
      windowDays,
      stats: {
        totalTrades: recentTrades.length,
        wins: wins.length,
        losses: losses.length,
        winRate,
        totalProfitUSD,
        totalLossUSD,
        netPnL
      },
      causeCounts,
      causeLossUSD,
      actionsApplied
    });
    this._writeJson(this.auditHistoryFile, history.slice(0, 30));

    return {
      stats: {
        totalTrades: recentTrades.length,
        wins: wins.length,
        losses: losses.length,
        breakevens: breakevens.length,
        winRate,
        totalProfitUSD,
        totalLossUSD,
        netPnL
      },
      causeCounts,
      causeLossUSD,
      actionsApplied,
      activeLessons: rules.activeLessons,
      blockedHoursVN: rules.blockedHoursVN,
      reportText
    };
  }
}

/**
 * Đọc nhanh danh sách bài học SL đang có hiệu lực để tiêm vào prompt Gemini Vision
 * @returns {string}
 */
export function getActiveLessonsPrompt(dataDir = DEFAULT_DATA_DIR) {
  try {
    const filePath = path.join(dataDir, 'auto_remediation_rules.json');
    if (!fs.existsSync(filePath)) return '';
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const lessons = Array.isArray(data?.activeLessons) ? data.activeLessons : [];
    if (lessons.length === 0) return '';
    return [
      `\nBÀI HỌC TỰ RÚT KINH NGHIỆM TỪ CÁC LỆNH SL GẦN ĐÂY (BẮT BUỘC TUÂN THỦ, KHÔNG ĐƯỢC LẶP LẠI):`,
      ...lessons.map((l, idx) => `- ${idx + 1}. ${l}`)
    ].join('\n');
  } catch {
    return '';
  }
}
