/**
 * ORDER MANAGER
 * Điều phối luồng xử lý tín hiệu: Phân tích -> Kiểm duyệt rủi ro -> Xác nhận Telegram / Tự động -> Đẩy sang MT5
 */

import dotenv from 'dotenv';
import { parseTradeSignal } from './trade_signal_parser.js';
import { RiskManager } from './risk_manager.js';

dotenv.config();

export class OrderManager {
  /**
   * @param {Object} options
   * @param {import('./mt5_bridge_server.js').MT5BridgeServer} options.bridgeServer
   * @param {function(string, any, any): Promise<any>} options.sendTelegramAlert
   * @param {function(string): void} options.logger
   */
  constructor({ bridgeServer, sendTelegramAlert, logger = console.log }) {
    this.bridge = bridgeServer;
    this.sendTelegram = sendTelegramAlert;
    this.logger = logger;
    this.riskManager = new RiskManager();

    /** @type {Map<string, any>} Lưu các lệnh đang chờ người dùng bấm xác nhận trên Telegram */
    this.pendingApprovals = new Map();
    this._emergencyCloseSent = false;
    this._alertSentForCircuitBreaker = false;

    /** Cấu hình bật/tắt chế độ Scalp và Hold dài */
    this.enableScalp = (process.env.ENABLE_SCALP || 'false').toLowerCase() === 'true';
    this.enableHold = (process.env.ENABLE_HOLD || 'true').toLowerCase() === 'true';
    this.enableScalpM1 = (process.env.ENABLE_SCALP_M1 || 'false').toLowerCase() === 'true';
    this.scalpM1TpUSD = Number(process.env.SCALP_M1_TP_USD || 2.5);
    this.scalpM1SlUSD = Number(process.env.SCALP_M1_SL_USD || 7.0);
    this.scalpM1IntervalSec = Number(process.env.SCALP_M1_INTERVAL_SEC || 60);
    this.autoCloseOnTrendReversal = (process.env.AUTO_CLOSE_ON_TREND_REVERSAL || 'true').toLowerCase() === 'true';
    this.riskManager.enableScalpM1 = this.enableScalpM1;
    this.riskManager.scalpM1TpUSD = this.scalpM1TpUSD;
    this.riskManager.scalpM1SlUSD = this.scalpM1SlUSD;
    this.lastH4Trend = 'SIDEWAY';
    this._autoExecuteOverride = null;
  }

  /**
   * Mở khóa ngắt mạch khẩn cấp khi người dùng yêu cầu tiếp tục
   */
  resetCircuitBreaker() {
    this.riskManager.resetCircuitBreaker(this.bridge.getLatestEquity());
    this._emergencyCloseSent = false;
    this._alertSentForCircuitBreaker = false;
    this.logger('[OrderManager] 🔓 Đã mở khóa ngắt mạch bảo vệ vốn (Circuit Breaker Reset).');
  }

  /**
   * Kiểm tra chế độ tự động hay duyệt tay (luôn đọc giá trị mới nhất)
   */
  get autoExecute() {
    if (this._autoExecuteOverride !== null) return this._autoExecuteOverride;
    return (process.env.AUTO_EXECUTE || 'true').toLowerCase() === 'true';
  }

  /**
   * Cập nhật chế độ tự động vào lệnh từ Dashboard hoặc Telegram
   * @param {boolean} enable
   */
  setAutoExecute(enable) {
    this._autoExecuteOverride = Boolean(enable);
    this.logger(`[OrderManager] 🤖 Đã cập nhật chế độ tự động vào lệnh: ${this._autoExecuteOverride ? 'BẬT (Auto)' : 'TẮT (Plan only)'}`);
  }

  /**
   * Xử lý kết quả phân tích từ Gemini để tìm và thực thi lệnh
   * @param {string} analysisText Bài phân tích trả về từ Gemini
   * @param {number|null} currentPrice Giá vàng thời gian thực
   * @param {Array<string>} notifyChatIds Danh sách Chat ID nhận thông báo
   */
  async processAnalysisResult(analysisText, currentPrice, notifyChatIds = []) {
    // 0. Kiểm tra cơ chế bảo vệ vốn & ngắt mạch khẩn cấp (Circuit Breaker)
    const currentEquity = this.bridge.getLatestEquity();
    const currentBalance = this.bridge.accountInfo?.balance;
    const protection = this.riskManager.checkAccountProtection({ equity: currentEquity, balance: currentBalance });

    if (protection.isBreached) {
      this.logger(`[OrderManager] 🚨 BẢO VỆ TÀI KHOẢN: ${protection.reason}. Từ chối toàn bộ lệnh mới!`);

      // Nếu cấu hình tự động cắt toàn bộ lệnh mở khi vi phạm ngưỡng lỗ
      if (this.riskManager.closeAllOnEmergency && !this._emergencyCloseSent) {
        this._emergencyCloseSent = true;
        this.bridge.queueEmergencyCloseAll(protection.reason);
      }

      // Gửi cảnh báo Telegram nếu chưa gửi
      if (!this._alertSentForCircuitBreaker) {
        this._alertSentForCircuitBreaker = true;
        const msg = [
          `🚨 [CẢNH BÁO BẢO VỆ VỐN: NGẮT MẠCH KHẨN CẤP]`,
          `• Trạng thái: ĐÃ KHÓA GIAO DỊCH TOÀN BỘ`,
          `• Vốn cơ sở: $${this.riskManager.initialCapitalUSD.toFixed(2)} USD`,
          `• Giới hạn lỗ tối đa: -$${this.riskManager.maxAccountLossUSD.toFixed(2)} USD (${this.riskManager.maxDrawdownPercent}%)`,
          `• Sụt giảm thực tế: -$${(protection.currentDrawdown || 0).toFixed(2)} USD`,
          `• Vốn hiện tại (Equity): $${(currentEquity || currentBalance || 0).toFixed(2)} USD`,
          `• Lý do: ${protection.reason}`,
          `• Hành động: Bot tự động dừng mọi lệnh mới để bảo toàn vốn còn lại!`,
          `• Hướng dẫn: Gõ /unlock trên Telegram để mở khóa khi bạn sẵn sàng.`
        ].join('\n');

        const targetChatIds = (notifyChatIds && notifyChatIds.length > 0)
          ? notifyChatIds
          : (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

        for (const cid of targetChatIds) {
          await this.sendTelegram(msg, cid);
        }
      }

      return null;
    }

    // 1. Trích xuất tín hiệu có cấu trúc
    const signal = parseTradeSignal(analysisText, currentPrice);
    if (!signal) {
      this.logger('[OrderManager] ℹ️ Không phát hiện tín hiệu vào lệnh (Thị trường đi ngang / Hold).');
      return null;
    }

    const style = signal.tradeStyle || 'SCALP';
    const isMtfCycle = style === 'HOLD' || ['H1', 'H4', 'D1'].includes(signal.timeframe);

    // Cập nhật xu hướng H4 chủ đạo từ chu kỳ phân tích đa khung thời gian
    if (isMtfCycle && signal.h4Trend && signal.h4Trend !== 'SIDEWAY') {
      this.lastH4Trend = signal.h4Trend;
    }

    // Nếu là Scalp M1 nhưng chưa có xu hướng H4 từ signal, kế thừa xu hướng H4 chủ đạo đã lưu
    if (style === 'SCALP_M1') {
      if ((!signal.h4Trend || signal.h4Trend === 'SIDEWAY') && this.lastH4Trend && this.lastH4Trend !== 'SIDEWAY') {
        signal.h4Trend = this.lastH4Trend;
      }
      signal.comment = 'AI_SCALP_M1';
    }

    // 1.1 Quét xu hướng & Tự động ngắt lệnh nếu xu hướng đảo chiều ngược vị thế đang mở
    await this.checkAndHandleTrendReversal(signal, currentPrice, notifyChatIds);

    if (signal.action === 'HOLD') {
      this.logger(`[OrderManager] ℹ️ Không phát hiện tín hiệu vào lệnh mới (Thị trường quan sát / Hold | Xu hướng: ${signal.trend || 'N/A'}).`);
      return null;
    }

    // 1.2 Kiểm tra bộ lọc bật/tắt chế độ SCALP M1, SCALP và HOLD DÀI
    if (style === 'SCALP_M1' && !this.enableScalpM1) {
      this.logger(`[OrderManager] ⏸️ Tín hiệu SCALP M1 (${signal.action} @ ${signal.entry}) bị bỏ qua vì tính năng SCALP M1 đang TẮT. Gõ /scalpm1 on để bật.`);
      return null;
    }
    if (style === 'SCALP' && !this.enableScalp && !this.enableScalpM1) {
      this.logger(`[OrderManager] ⏸️ Tín hiệu SCALP (${signal.action} @ ${signal.entry}) bị bỏ qua vì chế độ SCALP đang TẮT. Gõ /scalp on để bật.`);
      return null;
    }
    if (style === 'HOLD' && !this.enableHold) {
      this.logger(`[OrderManager] ⏸️ Tín hiệu HOLD DÀI (${signal.action} @ ${signal.entry}) bị bỏ qua vì chế độ HOLD đang TẮT. Gõ /hold on để bật.`);
      return null;
    }

    this.logger(`[OrderManager] 💡 Phát hiện tín hiệu sơ bộ [${style}]: [${signal.action}] @ ${signal.entry} (SL: ${signal.sl}, TP: ${signal.tp}, R:R: ${signal.rr}) | Xu hướng: ${signal.trend || 'N/A'}`);

    // 2. Kiểm tra lệnh đang chạy, spread hiện tại và kiểm duyệt an toàn qua Risk Manager
    const unclosedContext = this.bridge.checkUnclosedOrders(signal.symbol);
    const liveMarket = this.bridge.getLatestMarketPrice ? this.bridge.getLatestMarketPrice() : null;
    if (liveMarket && liveMarket.spread !== undefined) {
      unclosedContext.spread = Number(liveMarket.spread);
    }
    const validation = this.riskManager.validateSignal(signal, currentPrice, unclosedContext);
    if (!validation.valid) {
      this.logger(`[OrderManager] ⚠️ Tín hiệu bị từ chối bởi Risk Manager: ${validation.reason}`);
      return null;
    }

    // 3. Tính toán khối lượng vào lệnh (Lot size) không vượt quá maxTotalLot (0.02)
    const equity = this.bridge.getLatestEquity();
    signal.lot = this.riskManager.calculateLotSize(signal, equity, unclosedContext.totalActiveLot);

    if (!signal.lot || signal.lot < 0.01) {
      this.logger(`[OrderManager] ⚠️ Tín hiệu bị từ chối: Khối lượng tính toán (${signal.lot} lot) không hợp lệ hoặc đã chạm hạn mức tổng tối đa (${this.riskManager.maxTotalLot} lot).`);
      return null;
    }

    if (Number((unclosedContext.totalActiveLot + signal.lot).toFixed(2)) > this.riskManager.maxTotalLot) {
      this.logger(`[OrderManager] ⚠️ Tín hiệu bị từ chối: Tổng volume (${(unclosedContext.totalActiveLot + signal.lot).toFixed(2)} lot) sẽ vượt mức tối đa ${this.riskManager.maxTotalLot} lot.`);
      return null;
    }

    // 4. Quyết định luồng khớp lệnh: Tự động (Full-Auto) hoặc Bán tự động (Semi-Auto via Telegram)
    if (this.autoExecute) {
      this.logger(`[OrderManager] ⚡ Chế độ AUTO_EXECUTE=true: Đang đẩy lệnh trực tiếp sang MT5...`);
      this.riskManager.recordTradeExecution(signal.tradeStyle);
      this.bridge.queueOrder(signal);

      const tpStr = signal.tp1 ? `TP1: ${signal.tp1} | TP2: ${signal.tp}` : `TP: ${signal.tp}`;
      const setupStr = (signal.setupModel && signal.setupModel !== 'NONE') ? `\n• Setup ICT: ${signal.setupModel} [${signal.pdaZone || 'EQ'}]` : '';
      const rsiStr = signal.h1Rsi ? `\n• Elder Triple Screen H1 RSI: ${signal.h1Rsi} (${signal.h1OscillatorFilter || 'PASS'})` : '';

      const msg = [
        `[MT5 AUTO EXECUTE]`,
        `• Lệnh: ${signal.action} ${signal.lot} Lot ${signal.symbol}`,
        `• Entry: ${signal.entry}`,
        `• SL: ${signal.sl} | ${tpStr}`,
        `• R:R: 1:${signal.rr}${setupStr}${rsiStr}`,
        `• Lý do: ${signal.reason}`
      ].join('\n');

      const targetChatIds = (notifyChatIds && notifyChatIds.length > 0)
        ? notifyChatIds
        : (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

      for (const cid of targetChatIds) {
        await this.sendTelegram(msg, cid);
      }
    } else {
      // Chế độ Bán tự động: Gửi nút bấm duyệt lên Telegram
      this.logger(`[OrderManager] Chế độ Bán tự động: Đang gửi yêu cầu duyệt lệnh về Telegram...`);
      const targetChatIds = (notifyChatIds && notifyChatIds.length > 0)
        ? notifyChatIds
        : (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

      this.pendingApprovals.set(signal.id, {
        signal,
        createdAt: Date.now(),
        chatIds: targetChatIds
      });

      const semiTpStr = signal.tp1 ? `TP1: ${signal.tp1} | TP2: ${signal.tp}` : `TP: ${signal.tp}`;
      const semiSetupStr = (signal.setupModel && signal.setupModel !== 'NONE') ? `\n• Setup ICT: ${signal.setupModel} [${signal.pdaZone || 'EQ'}]` : '';
      const semiRsiStr = signal.h1Rsi ? `\n• Elder Triple Screen H1 RSI: ${signal.h1Rsi} (${signal.h1OscillatorFilter || 'PASS'})` : '';

      const promptMsg = [
        `[TÍN HIỆU MT5]`,
        `• Lệnh: ${signal.action} ${signal.lot} Lot`,
        `• Entry: ${signal.entry}`,
        `• SL: ${signal.sl} | ${semiTpStr}`,
        `• R:R: 1:${signal.rr}${semiSetupStr}${semiRsiStr}`,
        `• Khung: ${signal.timeframe}`,
        `• Lý do: ${signal.reason}`
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
        await this.sendTelegram(promptMsg, cid, inlineKeyboard);
      }
    }

    return signal;
  }

  /**
   * Xử lý khi người dùng bấm nút duyệt lệnh từ Telegram
   * @param {string} callbackData
   * @param {string|number} chatId
   * @returns {Promise<string>} Tin nhắn phản hồi
   */
  async handleCallbackAction(callbackData, chatId) {
    if (callbackData.startsWith('APPROVE_')) {
      const signalId = callbackData.replace('APPROVE_', '');
      const item = this.pendingApprovals.get(signalId);

      if (!item) {
        return '[MT5] Tín hiệu đã hết hạn hoặc đã xử lý.';
      }

      // Kiểm tra tín hiệu không quá 5 phút
      if (Date.now() - item.createdAt > 5 * 60 * 1000) {
        this.pendingApprovals.delete(signalId);
        return '[MT5] Tín hiệu quá 5 phút, đã hủy.';
      }

      // Kiểm tra các lệnh trước đó chưa đóng
      const unclosed = this.bridge.checkUnclosedOrders(item.signal.symbol);
      if (!this.riskManager.allowConcurrentTrades && unclosed.hasUnclosed) {
        return `[MT5] ⚠️ Không thể duyệt lệnh: Đang có lệnh trước đó chưa đóng (${unclosed.summary}). Vui lòng chờ lệnh cũ đóng xong.`;
      }

      // Kiểm tra tổng khối lượng không vượt maxTotalLot (0.02)
      const targetLot = Number(item.signal.lot || 0.01);
      if (Number((unclosed.totalActiveLot + targetLot).toFixed(2)) > this.riskManager.maxTotalLot) {
        return `[MT5] ⚠️ Không thể duyệt lệnh: Tổng volume (${(unclosed.totalActiveLot + targetLot).toFixed(2)} lot) sẽ vượt mức tối đa ${this.riskManager.maxTotalLot} lot.`;
      }

      this.pendingApprovals.delete(signalId);
      this.riskManager.recordTradeExecution(item.signal.tradeStyle);
      this.bridge.queueOrder(item.signal);

      return `[MT5] Đã duyệt lệnh: ${item.signal.action} ${item.signal.lot} Lot.`;
    }

    if (callbackData.startsWith('REJECT_')) {
      const signalId = callbackData.replace('REJECT_', '');
      this.pendingApprovals.delete(signalId);
      return '[MT5] Đã hủy tín hiệu.';
    }

    // Xử lý các nút bấm chuyển đổi chế độ giao dịch
    if (callbackData === 'TOGGLE_SCALP_M1') {
      this.toggleScalpM1();
      return this.getTradingModeStatus();
    }
    if (callbackData === 'TOGGLE_SCALP') {
      this.toggleScalp();
      return this.getTradingModeStatus();
    }
    if (callbackData === 'TOGGLE_HOLD') {
      this.toggleHold();
      return this.getTradingModeStatus();
    }
    if (callbackData === 'MODE_SCALP_M1_ONLY') {
      this.setScalpM1(true);
      this.setHold(false);
      this.setScalp(false);
      return this.getTradingModeStatus();
    }
    if (callbackData === 'MODE_BOTH') {
      this.setScalpM1(true);
      this.setHold(true);
      return this.getTradingModeStatus();
    }
    if (callbackData === 'MODE_SCALP_ONLY') {
      this.setScalp(true);
      this.setHold(false);
      return this.getTradingModeStatus();
    }
    if (callbackData === 'MODE_HOLD_ONLY') {
      this.setScalpM1(false);
      this.setScalp(false);
      this.setHold(true);
      return this.getTradingModeStatus();
    }
    if (callbackData === 'MODE_OFF') {
      this.setScalpM1(false);
      this.setScalp(false);
      this.setHold(false);
      return this.getTradingModeStatus();
    }

    return null;
  }

  /**
   * Thiết lập tính năng SCALP M1 liên tục (TP 2-3 giá, SL 7 giá)
   * @param {boolean} enabled
   */
  setScalpM1(enabled) {
    this.enableScalpM1 = Boolean(enabled);
    this.riskManager.enableScalpM1 = this.enableScalpM1;
    this.logger(`[OrderManager] ⚡ Tính năng SCALP M1 liên tục đã chuyển sang: ${this.enableScalpM1 ? 'BẬT' : 'TẮT'} (TP: ${this.scalpM1TpUSD}U, SL: ${this.scalpM1SlUSD}U)`);
    return this.enableScalpM1;
  }

  toggleScalpM1() {
    return this.setScalpM1(!this.enableScalpM1);
  }

  /**
   * Cấu hình khoảng cách TP và SL cho Scalp M1
   * @param {number} tp
   * @param {number} sl
   */
  setScalpM1Config(tp, sl) {
    if (tp && tp > 0) {
      this.scalpM1TpUSD = Number(tp);
      this.riskManager.scalpM1TpUSD = this.scalpM1TpUSD;
    }
    if (sl && sl > 0) {
      this.scalpM1SlUSD = Number(sl);
      this.riskManager.scalpM1SlUSD = this.scalpM1SlUSD;
    }
    this.logger(`[OrderManager] ⚙️ Đã cấu hình Scalp M1: TP = ${this.scalpM1TpUSD} giá | SL = ${this.scalpM1SlUSD} giá`);
    return { tp: this.scalpM1TpUSD, sl: this.scalpM1SlUSD };
  }

  /**
   * Thiết lập trạng thái chế độ SCALP
   * @param {boolean} enabled
   */
  setScalp(enabled) {
    this.enableScalp = Boolean(enabled);
    this.logger(`[OrderManager] ⚙️ Chế độ SCALP đã chuyển sang: ${this.enableScalp ? 'BẬT' : 'TẮT'}`);
    return this.enableScalp;
  }

  /**
   * Thiết lập trạng thái chế độ HOLD DÀI
   * @param {boolean} enabled
   */
  setHold(enabled) {
    this.enableHold = Boolean(enabled);
    this.logger(`[OrderManager] ⚙️ Chế độ HOLD DÀI đã chuyển sang: ${this.enableHold ? 'BẬT' : 'TẮT'}`);
    return this.enableHold;
  }

  toggleScalp() {
    return this.setScalp(!this.enableScalp);
  }

  toggleHold() {
    return this.setHold(!this.enableHold);
  }

  /**
   * Cập nhật cấu hình khối lượng (lot) và số lệnh tối đa cho phép
   * @param {{ defaultLot?: number, maxLot?: number, maxTotalLot?: number, maxConcurrentTrades?: number }} config
   */
  setLotConfig({ defaultLot, maxLot, maxTotalLot, maxConcurrentTrades } = {}) {
    const updates = {};
    if (defaultLot !== undefined && Number(defaultLot) > 0) updates.defaultLot = Number(defaultLot);
    if (maxLot !== undefined && Number(maxLot) > 0) updates.maxLot = Number(maxLot);
    if (maxTotalLot !== undefined && Number(maxTotalLot) > 0) updates.maxTotalLot = Number(maxTotalLot);
    if (maxConcurrentTrades !== undefined && Number(maxConcurrentTrades) >= 1) updates.maxConcurrentTrades = Number(maxConcurrentTrades);

    this.riskManager.updateConfig(updates);
    this.logger(`[OrderManager] 📊 Cập nhật cấu hình Lot & Số lệnh: Default Lot: ${this.riskManager.defaultLot} | Max Lot/Lệnh: ${this.riskManager.maxLot} | Max Tổng Lot: ${this.riskManager.maxTotalLot} | Số lệnh tối đa: ${this.riskManager.maxConcurrentTrades}`);
    return this.getLotConfig();
  }

  /**
   * Lấy cấu hình lot và số lệnh hiện hành
   */
  getLotConfig() {
    return {
      defaultLot: this.riskManager.defaultLot,
      maxLot: this.riskManager.maxLot,
      maxTotalLot: this.riskManager.maxTotalLot,
      maxConcurrentTrades: this.riskManager.maxConcurrentTrades,
      allowConcurrentTrades: this.riskManager.allowConcurrentTrades
    };
  }

  /**
   * Trả về bảng thông tin trực quan trạng thái chế độ giao dịch
   */
  getTradingModeStatus() {
    const scalpM1Tag = this.enableScalpM1 ? '🟢 BẬT' : '🔴 TẮT';
    const holdTag = this.enableHold ? '🟢 BẬT' : '🔴 TẮT';
    const scalpTag = this.enableScalp ? '🟢 BẬT' : '🔴 TẮT';

    let currentModeText = 'TẮT TẤT CẢ (CHỈ THEO DÕI)';
    if (this.enableScalpM1 && this.enableHold) currentModeText = 'SCALP M1 + HOLD DÀI';
    else if (this.enableScalpM1) currentModeText = 'CHUYÊN SCALP M1 LIÊN TỤC (TP 2.5U, SL 7U)';
    else if (this.enableHold) currentModeText = 'CHỈ GIAO DỊCH HOLD DÀI (H1/H4)';
    else if (this.enableScalp) currentModeText = 'CHỈ GIAO DỊCH SCALP M15';

    const lotCfg = this.getLotConfig();

    return [
      `⚙️ [CẤU HÌNH CHẾ ĐỘ GIAO DỊCH & QUẢN TRỊ LOT]`,
      `• Tính năng SCALP M1 LIÊN TỤC: ${scalpM1Tag}`,
      `  - Cấu hình: TP ${this.scalpM1TpUSD} giá (2-3 USD) | SL ${this.scalpM1SlUSD} giá (7 USD)`,
      `  - Tần suất: Quét nến liên tục mỗi ${this.scalpM1IntervalSec}s trên M1`,
      `• Chế độ HOLD DÀI (H1/H4 - Chuẩn): ${holdTag}`,
      `  - Đặc điểm: Gồng theo xu hướng lớn, SL 15 giá, TP 30 giá (R:R 1:2), dời BE khi +10u, khóa lãi +6u khi +15u`,
      `• Chế độ SCALP M15: ${scalpTag}`,
      `• Trạng thái hiện tại: 👉 ${currentModeText}`,
      ``,
      `📊 [CẤU HÌNH LOT & SỐ LỆNH VÀO]`,
      `• Khối lượng vào lệnh mặc định: ${lotCfg.defaultLot} lot`,
      `• Khối lượng tối đa 1 lệnh: ${lotCfg.maxLot} lot`,
      `• Khối lượng tổng tối đa: ${lotCfg.maxTotalLot} lot`,
      `• Số lệnh tối đa cùng lúc: ${lotCfg.maxConcurrentTrades} lệnh (${lotCfg.maxConcurrentTrades > 1 ? 'Cho phép nhiều lệnh' : 'Chỉ 1 lệnh duy nhất'})`,
      `\n💡 Lệnh nhanh: /lot <số>, /maxorders <số>, /scalpm1 on|off, /scalp config <tp> <sl>, /hold on|off:`
    ].join('\n');
  }

  /**
   * Trả về inline keyboard chuyển đổi chế độ giao dịch
   */
  getModeInlineKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: `⚡ Scalp M1 (TP 2.5u | SL 7u): ${this.enableScalpM1 ? 'BẬT 🟢' : 'TẮT 🔴'}`, callback_data: 'TOGGLE_SCALP_M1' },
          { text: `📈 Hold dài: ${this.enableHold ? 'BẬT 🟢' : 'TẮT 🔴'}`, callback_data: 'TOGGLE_HOLD' }
        ],
        [
          { text: '⚡ Chuyên Scalp M1', callback_data: 'MODE_SCALP_M1_ONLY' },
          { text: '🎯 Chuyên Hold H1', callback_data: 'MODE_HOLD_ONLY' }
        ],
        [
          { text: '⏸️ Tắt Hết (Chỉ Xem)', callback_data: 'MODE_OFF' }
        ]
      ]
    };
  }

  /**
   * Quét và kiểm tra xem vị thế đang mở có bị vi phạm do đảo chiều xu hướng hay không.
   * Nếu xu hướng đảo chiều ngược hướng với vị thế đang giữ, tự động ngắt lệnh ngay lập tức!
   * @param {import('./trade_signal_parser.js').TradeSignal} signal Tín hiệu và xu hướng phân tích mới nhất
   * @param {number|null} currentPrice Giá thị trường hiện tại
   * @param {Array<string>} notifyChatIds Danh sách chat ID nhận thông báo
   */
  async checkAndHandleTrendReversal(signal, currentPrice, notifyChatIds = []) {
    if (!this.autoCloseOnTrendReversal || !signal) return;

    // QUY TẮC AN TOÀN: Chu kỳ Scalp M1 tuyệt đối không can thiệp đóng vị thế đang chạy!
    // Chỉ chu kỳ phân tích đa khung thời gian H4/H1 mới có thẩm quyền đánh giá đảo chiều xu hướng lớn.
    if (signal.tradeStyle === 'SCALP_M1' || signal.timeframe === 'M1') {
      return;
    }

    const openPositions = this.bridge.accountInfo?.openPositionsList || [];
    if (!Array.isArray(openPositions) || openPositions.length === 0) return;

    const h4Trend = signal.h4Trend || signal.trend || 'SIDEWAY';

    const targetChatIds = (notifyChatIds && notifyChatIds.length > 0)
      ? notifyChatIds
      : (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

    for (const pos of openPositions) {
      const posType = String(pos.type || '').toUpperCase();
      const posSymbol = pos.symbol || 'XAUUSD';
      const posComment = String(pos.comment || '');

      // QUY TẮC BẢO VỆ LỆNH SCALP:
      // Lệnh Scalp M1 có SL/TP ngắn cố định riêng. Tuyệt đối không can thiệp ngắt sớm lệnh Scalp bằng xu hướng H4!
      if (posComment.includes('SCALP') || posComment.includes('AI_SCALP_M1')) {
        continue;
      }

      let shouldClose = false;
      let closeReason = '';

      // Chỉ ngắt vị thế HOLD khi AI xác nhận ĐẢO CHIỀU CẤU TRÚC (MSS / ChoCH)
      // TUYỆT ĐỐI không ngắt lệnh khi thị trường chỉ đang pullback điều chỉnh tự nhiên trong sóng!
      if (signal.reversalDetected) {
        if (posType === 'SELL' && h4Trend === 'UP') {
          shouldClose = true;
          closeReason = signal.reversalReason || `Xu hướng H4/H1 đảo chiều phá vỡ cấu trúc giảm sang TĂNG (MSS)`;
        } else if (posType === 'BUY' && h4Trend === 'DOWN') {
          shouldClose = true;
          closeReason = signal.reversalReason || `Xu hướng H4/H1 đảo chiều phá vỡ cấu trúc tăng sang GIẢM (MSS)`;
        }
      }

      if (shouldClose) {
        this.logger(`[OrderManager] 🚨 PHÁT HIỆN ĐẢO CHIỀU XU HƯỚNG CẤU TRÚC! Tiến hành tự động ngắt vị thế #${pos.ticket} (${posType} ${pos.lot} lot ${posSymbol}). Lý do: ${closeReason}`);

        // Đẩy lệnh đóng sang MT5
        this.bridge.queueCloseOrder({
          ticket: pos.ticket,
          symbol: posSymbol,
          reason: closeReason
        });

        // Gửi cảnh báo Telegram ngay lập tức
        const profitNum = Number(pos.profit || 0);
        const profitStr = profitNum >= 0 ? `+$${profitNum.toFixed(2)}` : `-$${Math.abs(profitNum).toFixed(2)}`;
        const msg = [
          `⚠️ [MT5 TỰ ĐỘNG NGẮT LỆNH DO ĐẢO CHIỀU XU HƯỚNG]`,
          `• Ticket: #${pos.ticket}`,
          `• Vị thế: ${posType} ${pos.lot} Lot ${posSymbol}`,
          `• Giá vào: ${pos.open || '-'} USD | Hiện tại: ${pos.current || currentPrice || '-'} USD`,
          `• Lời/Lỗ tạm tính: ${profitStr} USD`,
          `• Xu hướng mới: ${h4Trend}`,
          `• Lý do ngắt lệnh: ${closeReason}`,
          `• Hành động: Đã đóng lệnh ngay để bảo toàn vốn, tránh nguy cơ chạm Stop Loss!`
        ].join('\n');

        for (const cid of targetChatIds) {
          await this.sendTelegram(msg, cid);
        }
      }
    }
  }
}
