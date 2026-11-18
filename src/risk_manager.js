/**
 * RISK MANAGER & TRADE VALIDATOR
 * Kiểm duyệt rủi ro, tính toán khối lượng lệnh (Lot size) và bảo vệ an toàn tài khoản
 */

import { getCurrentICTSession } from './session_helper.js';

export class RiskManager {
  /**
   * @param {Object} config Cấu hình quản trị rủi ro
   */
  constructor(config = {}) {
    this.minRR = Number(config.minRR ?? process.env.RISK_MIN_RR ?? 1.8);
    this.maxSlDistanceUSD = Number(config.maxSlUSD ?? process.env.RISK_MAX_SL_USD ?? 30.0); // Tối đa 30 USD (~300 pips cho Hold dài)
    this.minSlDistanceUSD = Number(config.minSlUSD ?? process.env.RISK_MIN_SL_USD ?? 8.0);  // Tối thiểu 8.0 USD (~80 pips, loại bỏ SL ngắn 4 giá)
    this.defaultLot = Number(config.defaultLot ?? process.env.DEFAULT_LOT ?? 0.01);
    this.maxTotalLot = Number(config.maxTotalLot ?? process.env.MAX_TOTAL_LOT ?? config.maxLot ?? process.env.MAX_LOT ?? 0.02);
    this.maxLot = Number(config.maxLot ?? process.env.MAX_LOT ?? this.maxTotalLot);
    this.allowConcurrentTrades = (config.allowConcurrentTrades ?? process.env.ALLOW_CONCURRENT_TRADES ?? 'false').toString().toLowerCase() === 'true';
    this.maxConcurrentTrades = Math.max(1, Number(
      config.maxConcurrentTrades ??
      process.env.MAX_CONCURRENT_TRADES ??
      process.env.MAX_OPEN_POSITIONS ??
      (this.allowConcurrentTrades ? 2 : 1)
    ));
    if (this.maxConcurrentTrades > 1) {
      this.allowConcurrentTrades = true;
    }
    this.fixedSlUSD = Number(config.fixedSlUSD ?? process.env.FIXED_SL_USD ?? 15.0);
    this.fixedTpUSD = Number(config.fixedTpUSD ?? process.env.FIXED_TP_USD ?? 30.0);
    this.riskPercent = Number(config.riskPercent ?? process.env.RISK_PERCENT ?? 1.0); // 1% tài khoản
    this.lotMode = config.lotMode ?? process.env.LOT_MODE ?? 'FIXED'; // 'FIXED' hoặc 'DYNAMIC'
    this.lastTradeTime = 0;
    this.lastHoldTradeTime = 0;
    this.lastScalpTradeTime = 0;
    this.tradeCooldownMs = Number(config.cooldownMinutes ?? process.env.TRADE_COOLDOWN_MINUTES ?? 15) * 60 * 1000;
    this.scalpCooldownMs = Number(config.scalpCooldownMinutes ?? process.env.SCALP_COOLDOWN_MINUTES ?? 5) * 60 * 1000;

    // Cấu hình tính năng Scalp M1 (TP 7 giá, SL 5 giá, R:R >= 1.4:1)
    this.enableScalpM1 = (config.enableScalpM1 ?? process.env.ENABLE_SCALP_M1 ?? 'false').toString().toLowerCase() === 'true';
    this.scalpM1TpUSD = Number(config.scalpM1TpUSD ?? process.env.SCALP_M1_TP_USD ?? 7.0);
    this.scalpM1SlUSD = Number(config.scalpM1SlUSD ?? process.env.SCALP_M1_SL_USD ?? 5.0);
    this.scalpM1IntervalSec = Number(config.scalpM1IntervalSec ?? process.env.SCALP_M1_INTERVAL_SEC ?? 180);

    // Cấu hình Bảo vệ vốn & Ngắt mạch khẩn cấp (Circuit Breaker: Vốn 300 USD, mất 50% vốn -150 USD thì dừng lỗ)
    this.initialCapitalUSD = Number(config.initialCapitalUSD ?? process.env.INITIAL_CAPITAL_USD ?? 300.0);
    this.maxAccountLossUSD = Number(config.maxAccountLossUSD ?? process.env.MAX_ACCOUNT_LOSS_USD ?? 150.0);
    this.maxDrawdownPercent = Number(config.maxDrawdownPercent ?? process.env.MAX_DRAWDOWN_PERCENT ?? 50.0);
    this.emergencyStopEnabled = (config.emergencyStopEnabled ?? process.env.EMERGENCY_STOP_ENABLED ?? 'true').toString().toLowerCase() === 'true';
    this.closeAllOnEmergency = (config.closeAllOnEmergency ?? process.env.CLOSE_ALL_ON_EMERGENCY ?? 'true').toString().toLowerCase() === 'true';
    this.enforceTrendAlignment = (config.enforceTrendAlignment ?? process.env.ENFORCE_TREND_ALIGNMENT ?? 'true').toString().toLowerCase() === 'true';

    // Cấu hình Bảo vệ giờ giao phiên Rollover & Bộ lọc Spread tối đa + Giờ tạm khóa tự động
    this.rolloverGuardEnabled = (config.rolloverGuardEnabled ?? process.env.ROLLOVER_GUARD_ENABLED ?? 'true').toString().toLowerCase() === 'true';
    this.maxSpreadPoints = Number(config.maxSpreadPoints ?? process.env.MAX_SPREAD_POINTS ?? 35);
    const rawBlocked = config.blockedHoursVN ?? process.env.BLOCKED_HOURS_VN ?? '';
    this.blockedHoursVN = Array.isArray(rawBlocked)
      ? rawBlocked.map(h => parseInt(h, 10)).filter(h => !isNaN(h) && h >= 0 && h <= 23)
      : String(rawBlocked).split(',').map(s => parseInt(s.trim(), 10)).filter(h => !isNaN(h) && h >= 0 && h <= 23);

    this.circuitBreakerTriggered = false;
    this.circuitBreakerReason = '';
    this.sessionStartEquity = null;
    this.peakEquity = null;

    // =====================================================================
    // KAUFMAN THEORY OF RUNS — Theo dõi chuỗi thua lỗ để cooldown bảo vệ
    // Tài liệu TSaM: Sau chuỗi thua >= maxConsecutiveLosses lệnh liên tiếp,
    // dừng giao dịch thêm consecutiveLossCooldownMs mili-giây để bảo toàn vốn
    // =====================================================================
    this.consecutiveLosses = 0;       // Số lệnh thua liên tiếp hiện tại
    this.maxConsecutiveLosses = Number(config.maxConsecutiveLosses ?? process.env.MAX_CONSECUTIVE_LOSSES ?? 3);
    this.consecutiveLossCooldownMs = Number(config.lossCooldownMinutes ?? process.env.LOSS_COOLDOWN_MINUTES ?? 30) * 60 * 1000;
    this.lastLossCooldownTriggeredAt = 0;

    // =====================================================================
    // DYNAMIC RISK — Quản lý vốn động theo equity (ICT Chương XIII)
    // Bắt đầu 0.5%/lệnh, khi lãi +2% tăng lên 1%, khi lỗ -2% giảm về 0.25%
    // Tài liệu ICT: Volume Management — không rủi ro cố định, điều chỉnh theo tài khoản
    // =====================================================================
    this.dynamicRiskEnabled = (config.dynamicRiskEnabled ?? process.env.DYNAMIC_RISK_ENABLED ?? 'false').toString().toLowerCase() === 'true';
    this.dynamicRiskBase = Number(config.dynamicRiskBase ?? process.env.DYNAMIC_RISK_BASE ?? 0.5);       // 0.5%
    this.dynamicRiskHigh = Number(config.dynamicRiskHigh ?? process.env.DYNAMIC_RISK_HIGH ?? 1.0);       // 1.0% khi lãi +2%
    this.dynamicRiskLow = Number(config.dynamicRiskLow ?? process.env.DYNAMIC_RISK_LOW ?? 0.25);         // 0.25% khi lỗ -2%
    this.dynamicRiskUpThresholdPct = Number(config.dynamicRiskUpThreshold ?? process.env.DYNAMIC_RISK_UP_THRESHOLD ?? 2.0);   // +2%
    this.dynamicRiskDownThresholdPct = Number(config.dynamicRiskDownThreshold ?? process.env.DYNAMIC_RISK_DOWN_THRESHOLD ?? 2.0); // -2%
    this._dynamicRiskCurrent = this.dynamicRiskBase; // Mức rủi ro hiện hành
  }

  /**
   * Xóa cooldown nếu lệnh trước bị lỗi hoặc chưa khớp
   */
  resetCooldown() {
    this.lastTradeTime = 0;
    this.lastHoldTradeTime = 0;
    this.lastScalpTradeTime = 0;
  }

  /**
   * Chuẩn hóa SL/TP an toàn (Scalp M1: SL 5 giá, TP 7 giá; Hold dài: SL 12-15 giá, TP 24-30 giá)
   * @param {import('./trade_signal_parser.js').TradeSignal} signal
   */
  applyFixedSlTp(signal) {
    if (!signal || signal.action === 'HOLD') return;

    const isScalpM1 = signal.tradeStyle === 'SCALP_M1' || (signal.timeframe === 'M1' && signal.tradeStyle === 'SCALP');
    if (isScalpM1) {
      signal.tradeStyle = 'SCALP_M1';
      const slDistToApply = this.scalpM1SlUSD > 0 ? this.scalpM1SlUSD : 5.0;
      const tpDistToApply = this.scalpM1TpUSD > 0 ? this.scalpM1TpUSD : 7.0;

      if (signal.action === 'BUY') {
        signal.sl = Number((signal.entry - slDistToApply).toFixed(2));
        signal.tp = Number((signal.entry + tpDistToApply).toFixed(2));
      } else if (signal.action === 'SELL') {
        signal.sl = Number((signal.entry + slDistToApply).toFixed(2));
        signal.tp = Number((signal.entry - tpDistToApply).toFixed(2));
      }
      signal.rr = Number((tpDistToApply / slDistToApply).toFixed(2));
      return;
    }

    const currentSlDist = (signal.entry > 0 && signal.sl > 0) ? Math.abs(signal.entry - signal.sl) : 0;
    const currentTpDist = (signal.entry > 0 && signal.tp > 0) ? Math.abs(signal.tp - signal.entry) : 0;

    // Kiểm tra xem AI đã đưa ra SL/TP hợp lệ chưa (SL từ minSlDistanceUSD trở lên và R:R >= minRR)
    const isAiSlValid = currentSlDist >= this.minSlDistanceUSD && currentSlDist <= this.maxSlDistanceUSD;
    const isAiTpValid = currentTpDist > 0 && currentSlDist > 0 && (currentTpDist / currentSlDist) >= this.minRR;

    // Nếu tín hiệu đã có SL/TP an toàn theo cấu trúc thị trường thì giữ nguyên
    if (isAiSlValid && isAiTpValid) {
      signal.rr = Number((currentTpDist / currentSlDist).toFixed(2));
      return;
    }

    // Nếu thiếu hoặc SL quá ngắn (< minSlDistanceUSD, ví dụ 4 giá cũ), áp dụng mức chuẩn hóa an toàn (15 giá SL, 30 giá TP)
    const slDistToApply = this.fixedSlUSD > 0 ? this.fixedSlUSD : 15.0;
    const tpDistToApply = this.fixedTpUSD > 0 ? this.fixedTpUSD : 30.0;

    if (signal.action === 'BUY') {
      signal.sl = Number((signal.entry - slDistToApply).toFixed(2));
      signal.tp = Number((signal.entry + tpDistToApply).toFixed(2));
    } else if (signal.action === 'SELL') {
      signal.sl = Number((signal.entry + slDistToApply).toFixed(2));
      signal.tp = Number((signal.entry - tpDistToApply).toFixed(2));
    }
    signal.rr = Number((tpDistToApply / slDistToApply).toFixed(2));
  }

  /**
   * Kiểm tra tính hợp lệ của tín hiệu giao dịch
   * @param {import('./trade_signal_parser.js').TradeSignal} signal
   * @param {number|null} marketPrice Giá thị trường hiện tại
   * @param {Object|null} context Ngữ cảnh tài khoản / vị thế MT5 hiện tại
   * @returns {{ valid: boolean, reason?: string }}
   */
  validateSignal(signal, marketPrice = null, context = null) {
    if (!signal) {
      return { valid: false, reason: 'Tín hiệu rỗng' };
    }

    // 0. Kiểm tra ngắt mạch khẩn cấp (Circuit Breaker / Max Loss)
    if (this.circuitBreakerTriggered) {
      return {
        valid: false,
        reason: `[NGẮT MẠCH BẢO VỆ TÀI KHOẢN]: ${this.circuitBreakerReason}. Toàn bộ giao dịch đang bị tạm khóa để bảo toàn vốn!`
      };
    }

    // 0.0 Kiểm tra Bảo vệ giờ giao phiên Rollover (16:30-18:15 NY), Spread tối đa & Giờ tạm khóa tự động
    if (context && !context.bypassSessionCheck) {
      const session = getCurrentICTSession(context.nowDate || new Date());
      if (this.rolloverGuardEnabled && session.isRolloverWindow) {
        return {
          valid: false,
          reason: `[ROLLOVER GUARD]: Đang trong khung giờ giao phiên / giãn Spread (${session.nyTimeStr} NY | ${session.vnTimeStr} VN). Cấm mở lệnh mới để tránh GAP & trượt giá SL!`
        };
      }

      if (context.spread !== undefined && context.spread !== null && !isNaN(Number(context.spread))) {
        const curSpread = Number(context.spread);
        if (this.maxSpreadPoints > 0 && curSpread > this.maxSpreadPoints) {
          return {
            valid: false,
            reason: `[BỘ LỌC SPREAD]: Spread hiện tại (${curSpread} pts) vượt ngưỡng an toàn tối đa (${this.maxSpreadPoints} pts). Chờ spread ổn định!`
          };
        }
      }

      if (Array.isArray(this.blockedHoursVN) && this.blockedHoursVN.includes(session.vnHour)) {
        return {
          valid: false,
          reason: `[AUTO-REMEDIATION]: Khung giờ ${String(session.vnHour).padStart(2, '0')}:00 VN đang tạm khóa tự động do lịch sử tỷ lệ SL cao gần đây.`
        };
      }
    }

    // 0.1 Kiểm tra đồng pha xu hướng chủ đạo H4 (Trend Alignment Filter)
    // Chế độ Hold dài: Bắt buộc tuân thủ 100% xu hướng H4/H1, tuyệt đối không đánh ngược
    if (this.enforceTrendAlignment && signal.h4Trend) {
      if (signal.h4Trend === 'DOWN' && signal.action === 'BUY') {
        return {
          valid: false,
          reason: `[BỘ LỌC XU HƯỚNG]: Từ chối lệnh BUY vì xu hướng chủ đạo H4 đang là GIẢM. Quy tắc Hold dài: Tuyệt đối không bắt dao rơi ngược xu hướng lớn!`
        };
      }
      if (signal.h4Trend === 'UP' && signal.action === 'SELL') {
        return {
          valid: false,
          reason: `[BỘ LỌC XU HƯỚNG]: Từ chối lệnh SELL vì xu hướng chủ đạo H4 đang là TĂNG. Quy tắc Hold dài: Tuyệt đối không chặn đầu xe lửa ngược xu hướng lớn!`
        };
      }
    }

    // 0.2 Kiểm tra vùng giá trị ICT PD Array (Premium vs Discount Gate)
    if (signal.pdaZone) {
      const isTrendingContinuation = signal.marketRegime === 'TRENDING_LOW_NOISE' || signal.tradeStyle === 'SCALP';

      if (signal.pdaZone === 'PREMIUM' && signal.action === 'BUY') {
        // Trong siêu xu hướng tăng (H4 UP, low noise) hoặc lệnh Scalp, cho phép BUY theo đà tiếp diễn nếu RSI chưa quá cực đoan (> 80)
        const allowContinuation = isTrendingContinuation && signal.h4Trend === 'UP' && (!signal.h1Rsi || signal.h1Rsi < 80);
        if (!allowContinuation) {
          return {
            valid: false,
            reason: `[QUY TẮC ICT]: Từ chối lệnh BUY vì giá đang ở vùng PREMIUM (> 50% Dealing Range). Nguy cơ đu đỉnh thanh khoản (BSL) của cá mập!`
          };
        }
      }

      if (signal.pdaZone === 'DISCOUNT' && signal.action === 'SELL') {
        // Trong siêu xu hướng giảm (H4 DOWN, low noise) hoặc lệnh Scalp, cho phép SELL theo đà tiếp diễn nếu RSI chưa quá cực đoan (< 20)
        const allowContinuation = isTrendingContinuation && signal.h4Trend === 'DOWN' && (!signal.h1Rsi || signal.h1Rsi > 20);
        if (!allowContinuation) {
          return {
            valid: false,
            reason: `[QUY TẮC ICT]: Từ chối lệnh SELL vì giá đang ở vùng DISCOUNT (< 50% Dealing Range). Nguy cơ bán tháo tại đáy thanh khoản (SSL) của cá mập!`
          };
        }
      }
    }

    // 0.3 Bộ lọc nhiễu Kaufman (Kaufman Efficiency Ratio / Noise Filter)
    if (signal.marketRegime === 'CHOP_HIGH_NOISE' && signal.action !== 'HOLD' && signal.setupModel !== 'LIQUIDITY_SWEEP') {
      return {
        valid: false,
        reason: `[BỘ LỌC NHIỄU KAUFMAN]: Thị trường nhiễu động cao (High Noise / Low ER). Cấu trúc nến giằng co không có lực dịch chuyển (Displacement), từ chối vào lệnh breakout!`
      };
    }
    if (signal.efficiencyRatioEst !== null && signal.efficiencyRatioEst < 0.25 && signal.action !== 'HOLD' && signal.setupModel !== 'LIQUIDITY_SWEEP') {
      return {
        valid: false,
        reason: `[BỘ LỌC NHIỄU KAUFMAN]: Chỉ số hiệu quả Kaufman quá thấp (${signal.efficiencyRatioEst} < 0.25). Nhiễu giá quá lớn so với sóng định hướng, ưu tiên HOLD!`
      };
    }

    // Tự động áp dụng chuẩn hóa an toàn SL 15 giá và TP 30 giá cho Hold dài
    this.applyFixedSlTp(signal);

    const { action, entry, sl, tp, rr } = signal;

    // 1. Kiểm tra logic hướng giá SL/TP
    if (action === 'BUY') {
      if (sl >= entry) {
        return { valid: false, reason: `Lệnh BUY không hợp lệ: SL (${sl}) phải nhỏ hơn Entry (${entry})` };
      }
      if (tp <= entry) {
        return { valid: false, reason: `Lệnh BUY không hợp lệ: TP (${tp}) phải lớn hơn Entry (${entry})` };
      }
    } else if (action === 'SELL') {
      if (sl <= entry) {
        return { valid: false, reason: `Lệnh SELL không hợp lệ: SL (${sl}) phải lớn hơn Entry (${entry})` };
      }
      if (tp >= entry) {
        return { valid: false, reason: `Lệnh SELL không hợp lệ: TP (${tp}) phải nhỏ hơn Entry (${entry})` };
      }
    } else {
      return { valid: false, reason: `Hành động không hỗ trợ: ${action}` };
    }

    // 2. Kiểm tra khoảng cách dừng lỗ (Stop Loss distance)
    const slDistance = Math.abs(entry - sl);
    const isScalpM1 = signal.tradeStyle === 'SCALP_M1' || (signal.timeframe === 'M1' && signal.tradeStyle === 'SCALP');

    if (isScalpM1) {
      if (slDistance < 3.0) {
        return {
          valid: false,
          reason: `SL Scalp M1 quá gần (${slDistance.toFixed(2)} USD < 3.0 USD), dễ bị quét spread`
        };
      }
      if (slDistance > 12.0) {
        return {
          valid: false,
          reason: `SL Scalp M1 quá xa (${slDistance.toFixed(2)} USD > 12.0 USD), vi phạm cấu hình Scalp 7 giá`
        };
      }
    } else {
      if (slDistance < this.minSlDistanceUSD) {
        return {
          valid: false,
          reason: `SL quá gần (${slDistance.toFixed(2)} USD < mức tối thiểu ${this.minSlDistanceUSD} USD), dễ bị quét spread`
        };
      }
      if (slDistance > this.maxSlDistanceUSD) {
        return {
          valid: false,
          reason: `SL quá xa (${slDistance.toFixed(2)} USD > mức tối đa cho phép ${this.maxSlDistanceUSD} USD), rủi ro quá lớn`
        };
      }
    }

    // 3. Kiểm tra tỷ lệ Risk : Reward
    if (isScalpM1) {
      // Chế độ Scalp M1: Bắt buộc R:R tối thiểu 1.2:1 để bù đắp phí spread và trượt giá của Vàng
      if (rr < 1.2) {
        return {
          valid: false,
          reason: `Tỷ lệ R:R Scalp M1 (${rr}) thấp hơn mức tối thiểu 1.2 (cần R:R dương kỳ vọng để bù trừ spread)`
        };
      }
    } else {
      const effectiveMinRR = (this.fixedSlUSD > 0 && this.fixedTpUSD > 0)
        ? Math.min(this.minRR, Number((this.fixedTpUSD / this.fixedSlUSD).toFixed(2)))
        : this.minRR;

      if (rr < effectiveMinRR) {
        return {
          valid: false,
          reason: `Tỷ lệ R:R (${rr}) thấp hơn mức tối thiểu cho phép (${effectiveMinRR})`
        };
      }
    }

    // 4. Kiểm tra độ lệch giá thị trường hiện tại so với Entry (tránh vào lệnh trễ)
    if (marketPrice && marketPrice > 0) {
      const priceDiff = Math.abs(marketPrice - entry);
      const maxEntrySlippage = isScalpM1 ? 1.5 : 2.0; // Scalp M1 tối đa lệch 1.5 USD
      if (priceDiff > maxEntrySlippage) {
        return {
          valid: false,
          reason: `Giá thị trường (${marketPrice}) đã chạy xa khỏi Entry (${entry}) quá ${priceDiff.toFixed(2)} USD`
        };
      }
    }

    // 5. Kiểm tra thời gian hồi phục (Cooldown)
    const now = Date.now();
    if (isScalpM1) {
      // Scalp M1: Cần ít nhất scalpCooldownMs (5 phút) để tránh spam lệnh liên tục trên cùng 1 con sóng nhiễu
      if (this.lastScalpTradeTime > 0 && (now - this.lastScalpTradeTime < this.scalpCooldownMs)) {
        const remainingSec = Math.ceil((this.scalpCooldownMs - (now - this.lastScalpTradeTime)) / 1000);
        return {
          valid: false,
          reason: `Đang trong thời gian cooldown lệnh Scalp M1 (còn ${remainingSec}s nữa để thị trường ổn định)`
        };
      }
    } else {
      // Hold dài: Chỉ kiểm tra cooldown với lệnh Hold trước đó (không bị chiếm quyền bởi lệnh Scalp M1)
      if (this.lastHoldTradeTime > 0 && (now - this.lastHoldTradeTime < this.tradeCooldownMs)) {
        const remainingMinutes = Math.ceil((this.tradeCooldownMs - (now - this.lastHoldTradeTime)) / 60000);
        return {
          valid: false,
          reason: `Đang trong thời gian cooldown lệnh Hold dài (còn ${remainingMinutes} phút nữa)`
        };
      }
    }

    // 5.1 KAUFMAN THEORY OF RUNS — Cooldown bảo vệ sau chuỗi thua liên tiếp
    // Tài liệu TSaM: Nếu thua >= maxConsecutiveLosses lệnh liên tiếp, dừng giao dịch
    // thêm lossCooldownMinutes phút để tránh "tilt trading" / giao dịch cảm xúc
    const lossCooldown = this.checkLossCooldown();
    if (lossCooldown.inCooldown) {
      return {
        valid: false,
        reason: `[KAUFMAN THEORY OF RUNS]: Chuỗi thua ${lossCooldown.consecutiveLosses} lệnh liên tiếp! Cooldown bảo vệ vốn đang kích hoạt (còn ${lossCooldown.remainingMinutes} phút). Đừng đánh cảm xúc!`
      };
    }

    // 6. Kiểm tra các lệnh trước đó chưa đóng & số lệnh tối đa cho phép
    if (context) {
      const totalUnclosed = Number(context.totalUnclosed ?? (
        (context.openCount || 0) + (context.pendingCount || 0) + (context.executingCount || 0)
      ));

      if (totalUnclosed >= this.maxConcurrentTrades) {
        const detail = context.summary ? ` (${context.summary})` : '';
        return {
          valid: false,
          reason: `Đang có ${totalUnclosed} lệnh trước đó chưa đóng${detail}. Đã đạt số lệnh tối đa cho phép cùng lúc (${this.maxConcurrentTrades} lệnh).`
        };
      }

      if (!this.allowConcurrentTrades && totalUnclosed > 0) {
        const detail = context.summary ? ` (${context.summary})` : '';
        return {
          valid: false,
          reason: `Đang có lệnh trước đó chưa đóng${detail}. Quy tắc an toàn: Không cho phép vào lệnh mới khi các lệnh trước chưa đóng.`
        };
      }

      // 7. Kiểm tra tổng khối lượng các lệnh đang mở có vượt maxTotalLot hay không
      const currentActiveLot = Number(context.totalActiveLot ?? 0);
      if (currentActiveLot >= this.maxTotalLot) {
        return {
          valid: false,
          reason: `Tổng khối lượng các lệnh đang mở (${currentActiveLot} lot) đã đạt/vượt mức tối đa cho phép (${this.maxTotalLot} lot).`
        };
      }

      // 7.1 Kiểm tra khối lượng dự kiến vào lệnh so với maxLot và maxTotalLot
      const targetLot = signal.lot || this.defaultLot;
      if (targetLot > this.maxLot) {
        return {
          valid: false,
          reason: `Khối lượng dự kiến vào lệnh (${targetLot} lot) vượt quá mức tối đa cho 1 lệnh (${this.maxLot} lot).`
        };
      }

      if (Number((currentActiveLot + targetLot).toFixed(2)) > this.maxTotalLot) {
        return {
          valid: false,
          reason: `Tổng khối lượng sau khi vào lệnh (${(currentActiveLot + targetLot).toFixed(2)} lot) sẽ vượt mức tối đa cho phép (${this.maxTotalLot} lot).`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Tính toán khối lượng giao dịch an toàn (Lot size)
   * Đảm bảo không vượt quá maxLot của lệnh và không làm tổng volume vượt quá maxTotalLot (0.02)
   * Khi DYNAMIC_RISK_ENABLED=true, dùng getEffectiveRiskPercent() thay vì riskPercent cố định
   * (ICT Chương XIII — Volume Management / Dynamic Risk theo equity thực tế)
   * @param {import('./trade_signal_parser.js').TradeSignal} signal
   * @param {number|null} accountEquity Vốn tài khoản hiện tại từ MT5
   * @param {number} currentOpenLot Tổng volume các vị thế đang mở và lệnh chờ
   * @returns {number} Khối lượng Lot chuẩn (trả về 0 nếu không đủ điều kiện vào lệnh)
   */
  calculateLotSize(signal, accountEquity = null, currentOpenLot = 0) {
    const currentLot = Number(currentOpenLot || 0);
    // Khối lượng tối đa còn được phép vào lệnh để không vượt maxTotalLot
    const remainingLot = Math.max(0, Number((this.maxTotalLot - currentLot).toFixed(2)));

    if (remainingLot < 0.01) {
      return 0;
    }

    let calculatedLot = this.defaultLot;

    if (this.lotMode === 'DYNAMIC' && accountEquity && accountEquity > 0) {
      // DYNAMIC RISK: Dùng getEffectiveRiskPercent() thay vì this.riskPercent cố định
      // — khi dynamicRiskEnabled=true, tự động điều chỉnh % rủi ro theo equity vs vốn ban đầu
      // — khi dynamicRiskEnabled=false, trả về this.riskPercent tĩnh như cũ
      const effectiveRiskPct = this.getEffectiveRiskPercent(accountEquity);
      const riskAmountUSD = accountEquity * (effectiveRiskPct / 100);
      const slDistanceUSD = Math.abs(signal.entry - signal.sl);

      // Đối với Vàng (XAUUSD chuẩn 1 lot = 100 oz): 1 USD di chuyển trên 1 lot = 100 USD
      if (slDistanceUSD > 0) {
        const lotPerDollar = riskAmountUSD / (slDistanceUSD * 100);
        calculatedLot = Math.floor(lotPerDollar * 100) / 100;
      }
    }

    // Giới hạn trong khoảng cho phép [0.01 - maxLot] và không vượt quá remainingLot
    calculatedLot = Math.max(0.01, Math.min(this.maxLot, calculatedLot));
    calculatedLot = Math.min(calculatedLot, remainingLot);
    return Number(calculatedLot.toFixed(2));
  }

  /**
   * Đánh dấu đã khớp 1 lệnh mới để tính thời gian cooldown
   * @param {'HOLD' | 'SCALP_M1' | 'SCALP'} tradeStyle
   */
  recordTradeExecution(tradeStyle = 'HOLD') {
    const now = Date.now();
    this.lastTradeTime = now;
    if (tradeStyle === 'SCALP_M1' || tradeStyle === 'SCALP') {
      this.lastScalpTradeTime = now;
    } else {
      this.lastHoldTradeTime = now;
    }
  }

  /**
   * Kiểm tra mức sụt giảm tài khoản và kích hoạt Circuit Breaker nếu chạm ngưỡng lỗ (Mất 50% vốn)
   * @param {{ balance?: number, equity?: number, todayProfit?: number }} account
   * @returns {{ isBreached: boolean, reason?: string, currentDrawdown?: number, peakEquity?: number, currentEquity?: number }}
   */
  checkAccountProtection(account) {
    if (!this.emergencyStopEnabled || !account) {
      return { isBreached: this.circuitBreakerTriggered, reason: this.circuitBreakerReason };
    }

    if (this.circuitBreakerTriggered) {
      return { isBreached: true, reason: this.circuitBreakerReason };
    }

    const equity = Number(account.equity || account.balance || 0);
    if (equity <= 0) return { isBreached: false };

    if (this.sessionStartEquity === null) {
      this.sessionStartEquity = equity;
      this.peakEquity = equity;
    } else {
      if (equity > this.peakEquity) {
        this.peakEquity = equity;
      }
    }

    // 1. Sụt giảm từ đỉnh (Peak Drawdown)
    const peakDrawdown = Number((this.peakEquity - equity).toFixed(2));
    // 2. Sụt giảm từ đầu phiên chạy (Session Drawdown)
    const sessionDrawdown = Number((this.sessionStartEquity - equity).toFixed(2));
    const currentDrawdown = Math.max(0, peakDrawdown, sessionDrawdown);

    let isBreached = false;
    let breachReason = '';

    // Vốn cơ sở tính toán: Ưu tiên vốn cơ sở cấu hình (300 USD) hoặc vốn bắt đầu phiên
    const baseCapital = (this.initialCapitalUSD > 0 && Math.abs(this.sessionStartEquity - this.initialCapitalUSD) <= (this.initialCapitalUSD * 0.5))
      ? this.initialCapitalUSD
      : (this.sessionStartEquity || this.initialCapitalUSD || 300.0);

    // Ngưỡng dừng lỗ cho phép: Mất 50% vốn cơ sở
    const effectiveMaxLoss = (this.maxDrawdownPercent > 0 && baseCapital > 0)
      ? Number((baseCapital * (this.maxDrawdownPercent / 100.0)).toFixed(2))
      : (this.maxAccountLossUSD > 0 ? this.maxAccountLossUSD : 150.0);

    // Kích hoạt Circuit Breaker nếu sụt giảm chạm hoặc vượt ngưỡng 50% vốn
    if (effectiveMaxLoss > 0 && currentDrawdown >= effectiveMaxLoss) {
      isBreached = true;
      const ddPercent = baseCapital > 0 ? Number(((currentDrawdown / baseCapital) * 100).toFixed(1)) : 50.0;
      breachReason = `Tài khoản sụt giảm -$${currentDrawdown.toFixed(2)} USD (-${ddPercent}%), chạm ngưỡng dừng lỗ tối đa 50% vốn (Vốn cơ sở: $${baseCapital.toFixed(2)} USD, Ngưỡng dừng lỗ: -$${effectiveMaxLoss.toFixed(2)} USD)`;
    }

    if (isBreached) {
      this.triggerCircuitBreaker(breachReason);
      return {
        isBreached: true,
        reason: breachReason,
        currentDrawdown,
        peakEquity: this.peakEquity,
        currentEquity: equity
      };
    }

    return {
      isBreached: false,
      currentDrawdown,
      peakEquity: this.peakEquity,
      currentEquity: equity
    };
  }

  triggerCircuitBreaker(reason) {
    this.circuitBreakerTriggered = true;
    this.circuitBreakerReason = reason;
  }

  resetCircuitBreaker(newStartEquity = null) {
    this.circuitBreakerTriggered = false;
    this.circuitBreakerReason = '';
    if (newStartEquity && newStartEquity > 0) {
      this.sessionStartEquity = newStartEquity;
      this.peakEquity = newStartEquity;
    } else {
      this.sessionStartEquity = null;
      this.peakEquity = null;
    }
  }

  /**
   * Cập nhật linh động các thông số quản trị rủi ro & tỷ lệ R:R
   * @param {Object} newConfig
   */
  updateConfig(newConfig = {}) {
    if (newConfig.minRR !== undefined && Number(newConfig.minRR) > 0) {
      this.minRR = Number(Number(newConfig.minRR).toFixed(2));
    }
    if (newConfig.fixedSlUSD !== undefined && Number(newConfig.fixedSlUSD) > 0) {
      this.fixedSlUSD = Number(Number(newConfig.fixedSlUSD).toFixed(2));
    }
    if (newConfig.fixedTpUSD !== undefined && Number(newConfig.fixedTpUSD) > 0) {
      this.fixedTpUSD = Number(Number(newConfig.fixedTpUSD).toFixed(2));
    }
    if (newConfig.minSlUSD !== undefined && Number(newConfig.minSlUSD) > 0) {
      this.minSlDistanceUSD = Number(Number(newConfig.minSlUSD).toFixed(2));
    }
    if (newConfig.maxSlUSD !== undefined && Number(newConfig.maxSlUSD) > 0) {
      this.maxSlDistanceUSD = Number(Number(newConfig.maxSlUSD).toFixed(2));
    }
    if (newConfig.initialCapitalUSD !== undefined && Number(newConfig.initialCapitalUSD) > 0) {
      this.initialCapitalUSD = Number(Number(newConfig.initialCapitalUSD).toFixed(2));
    }
    if (newConfig.maxDrawdownPercent !== undefined && Number(newConfig.maxDrawdownPercent) > 0) {
      this.maxDrawdownPercent = Number(Number(newConfig.maxDrawdownPercent).toFixed(1));
    }
    if (newConfig.maxAccountLossUSD !== undefined && Number(newConfig.maxAccountLossUSD) > 0) {
      this.maxAccountLossUSD = Number(Number(newConfig.maxAccountLossUSD).toFixed(2));
    } else if (this.initialCapitalUSD > 0 && this.maxDrawdownPercent > 0) {
      this.maxAccountLossUSD = Number((this.initialCapitalUSD * (this.maxDrawdownPercent / 100.0)).toFixed(2));
    }
    if (newConfig.defaultLot !== undefined && Number(newConfig.defaultLot) > 0) {
      this.defaultLot = Number(Number(newConfig.defaultLot).toFixed(2));
    }
    if (newConfig.maxLot !== undefined && Number(newConfig.maxLot) > 0) {
      this.maxLot = Number(Number(newConfig.maxLot).toFixed(2));
    }
    if (newConfig.maxTotalLot !== undefined && Number(newConfig.maxTotalLot) > 0) {
      this.maxTotalLot = Number(Number(newConfig.maxTotalLot).toFixed(2));
    }
    if (newConfig.maxConcurrentTrades !== undefined && Number(newConfig.maxConcurrentTrades) >= 1) {
      this.maxConcurrentTrades = Math.max(1, parseInt(newConfig.maxConcurrentTrades, 10));
      this.allowConcurrentTrades = this.maxConcurrentTrades > 1;
    }
    if (newConfig.allowConcurrentTrades !== undefined) {
      this.allowConcurrentTrades = Boolean(newConfig.allowConcurrentTrades);
      if (!this.allowConcurrentTrades && this.maxConcurrentTrades > 1) {
        this.maxConcurrentTrades = 1;
      }
    }
    if (newConfig.rolloverGuardEnabled !== undefined) {
      this.rolloverGuardEnabled = Boolean(newConfig.rolloverGuardEnabled);
    }
    if (newConfig.maxSpreadPoints !== undefined && Number(newConfig.maxSpreadPoints) > 0) {
      this.maxSpreadPoints = Math.max(15, parseInt(newConfig.maxSpreadPoints, 10));
    }
    if (newConfig.blockedHoursVN !== undefined) {
      this.blockedHoursVN = Array.isArray(newConfig.blockedHoursVN)
        ? [...new Set(newConfig.blockedHoursVN.map(h => parseInt(h, 10)).filter(h => !isNaN(h) && h >= 0 && h <= 23))].sort((a, b) => a - b)
        : String(newConfig.blockedHoursVN).split(',').map(s => parseInt(s.trim(), 10)).filter(h => !isNaN(h) && h >= 0 && h <= 23);
    }
    if (newConfig.scalpCooldownMinutes !== undefined && Number(newConfig.scalpCooldownMinutes) >= 1) {
      this.scalpCooldownMs = Math.min(30, Number(newConfig.scalpCooldownMinutes)) * 60 * 1000;
    }
    if (newConfig.tradeCooldownMinutes !== undefined && Number(newConfig.tradeCooldownMinutes) >= 1) {
      this.tradeCooldownMs = Math.min(60, Number(newConfig.tradeCooldownMinutes)) * 60 * 1000;
    }
    if (newConfig.enforceTrendAlignment !== undefined) {
      this.enforceTrendAlignment = Boolean(newConfig.enforceTrendAlignment);
    }
  }

  getRiskStatus(currentEquity = null) {
    const eq = currentEquity || this.peakEquity || this.initialCapitalUSD;
    const peak = this.peakEquity || eq;
    const dd = peak > eq ? Number((peak - eq).toFixed(2)) : 0;
    return {
      initialCapitalUSD: this.initialCapitalUSD,
      maxAccountLossUSD: this.maxAccountLossUSD,
      maxDrawdownPercent: this.maxDrawdownPercent,
      minRR: this.minRR,
      fixedSlUSD: this.fixedSlUSD,
      fixedTpUSD: this.fixedTpUSD,
      minSlDistanceUSD: this.minSlDistanceUSD,
      maxSlDistanceUSD: this.maxSlDistanceUSD,
      defaultLot: this.defaultLot,
      maxLot: this.maxLot,
      maxTotalLot: this.maxTotalLot,
      maxConcurrentTrades: this.maxConcurrentTrades,
      allowConcurrentTrades: this.allowConcurrentTrades,
      rolloverGuardEnabled: this.rolloverGuardEnabled,
      maxSpreadPoints: this.maxSpreadPoints,
      blockedHoursVN: this.blockedHoursVN,
      emergencyStopEnabled: this.emergencyStopEnabled,
      closeAllOnEmergency: this.closeAllOnEmergency,
      isTriggered: this.circuitBreakerTriggered,
      reason: this.circuitBreakerReason,
      currentDrawdown: dd,
      peakEquity: peak,
      currentEquity: eq
    };
  }

  // =====================================================================
  // KAUFMAN THEORY OF RUNS — Ghi nhận kết quả lệnh, theo dõi chuỗi thua
  // Tài liệu TSaM: Theory of Runs — Phân tích thống kê chuỗi thắng/thua
  // để nhận biết khi hệ thống đang hoạt động ngoài biên kỳ vọng
  // =====================================================================

  /**
   * Ghi nhận kết quả lệnh vừa đóng (Profit/Loss).
   * Nếu thua >= maxConsecutiveLosses lệnh liên tiếp -> kích hoạt cooldown bảo vệ
   * @param {number} profit Lời/lỗ thực tế (USD). Dương = lãi, âm = thua.
   */
  recordTradeResult(profit) {
    const profitNum = Number(profit || 0);
    // Chỉ tính chuỗi thua nếu thực sự lỗ đáng kể (< -0.5 USD), bỏ qua trượt giá hòa vốn nhỏ (-$0.05, -$0.2)
    if (profitNum < -0.5) {
      this.consecutiveLosses++;
      if (this.consecutiveLosses >= this.maxConsecutiveLosses) {
        this.lastLossCooldownTriggeredAt = Date.now();
        console.warn(
          `[RiskManager] [KAUFMAN THEORY OF RUNS] Chuỗi thua ${this.consecutiveLosses} lệnh liên tiếp! ` +
          `Kích hoạt cooldown bảo vệ thêm ${this.consecutiveLossCooldownMs / 60000} phút.`
        );
      }
    } else if (profitNum > 0.5) {
      // Lệnh thắng thực sự: reset chuỗi thua
      this.consecutiveLosses = 0;
    }
  }

  /**
   * Kiểm tra xem có đang trong cooldown do chuỗi thua liên tiếp không
   * @returns {{ inCooldown: boolean, remainingMinutes: number, consecutiveLosses: number }}
   */
  checkLossCooldown() {
    if (this.consecutiveLosses < this.maxConsecutiveLosses || this.lastLossCooldownTriggeredAt === 0) {
      return { inCooldown: false, remainingMinutes: 0, consecutiveLosses: this.consecutiveLosses };
    }
    const elapsed = Date.now() - this.lastLossCooldownTriggeredAt;
    if (elapsed < this.consecutiveLossCooldownMs) {
      const remainingMinutes = Math.ceil((this.consecutiveLossCooldownMs - elapsed) / 60000);
      return { inCooldown: true, remainingMinutes, consecutiveLosses: this.consecutiveLosses };
    }
    return { inCooldown: false, remainingMinutes: 0, consecutiveLosses: this.consecutiveLosses };
  }

  // =====================================================================
  // DYNAMIC RISK — Điều chỉnh rủi ro % theo equity thực tế (ICT Chương XIII)
  // Bắt đầu 0.5%/lệnh | Lãi +2% -> tăng 1% | Lỗ -2% -> giảm 0.25%
  // Tài liệu ICT: "Volume Management — Risk scales with account performance"
  // =====================================================================

  /**
   * Cập nhật mức rủi ro động dựa trên equity so với vốn ban đầu
   * @param {number} currentEquity Vốn tài khoản hiện tại (USD)
   * @returns {number} Mức rủi ro % hiện hành
   */
  updateDynamicRisk(currentEquity) {
    if (!this.dynamicRiskEnabled || !currentEquity || currentEquity <= 0) {
      return this._dynamicRiskCurrent;
    }
    const base = this.initialCapitalUSD > 0 ? this.initialCapitalUSD : (this.sessionStartEquity || currentEquity);
    if (base <= 0) return this._dynamicRiskCurrent;

    const changePct = ((currentEquity - base) / base) * 100;

    if (changePct >= this.dynamicRiskUpThresholdPct) {
      this._dynamicRiskCurrent = this.dynamicRiskHigh;
    } else if (changePct <= -this.dynamicRiskDownThresholdPct) {
      this._dynamicRiskCurrent = this.dynamicRiskLow;
    } else {
      this._dynamicRiskCurrent = this.dynamicRiskBase;
    }

    return this._dynamicRiskCurrent;
  }

  /**
   * Lấy mức rủi ro % hiện hành (dynamic hoặc tĩnh tuỳ cấu hình)
   * @param {number|null} currentEquity
   * @returns {number}
   */
  getEffectiveRiskPercent(currentEquity = null) {
    if (this.dynamicRiskEnabled && currentEquity) {
      return this.updateDynamicRisk(currentEquity);
    }
    return this.riskPercent;
  }

  /**
   * Trả về trạng thái quản lý rủi ro động và chuỗi thua
   */
  getDynamicRiskStatus() {
    const lossCooldown = this.checkLossCooldown();
    return {
      dynamicRiskEnabled: this.dynamicRiskEnabled,
      currentRiskPercent: this._dynamicRiskCurrent,
      baseRiskPercent: this.dynamicRiskBase,
      highRiskPercent: this.dynamicRiskHigh,
      lowRiskPercent: this.dynamicRiskLow,
      consecutiveLosses: this.consecutiveLosses,
      maxConsecutiveLosses: this.maxConsecutiveLosses,
      lossCooldownActive: lossCooldown.inCooldown,
      lossCooldownRemainingMinutes: lossCooldown.remainingMinutes
    };
  }
}
