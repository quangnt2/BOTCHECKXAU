/**
 * RISK MANAGER & TRADE VALIDATOR
 * Kiểm duyệt rủi ro, tính toán khối lượng lệnh (Lot size) và bảo vệ an toàn tài khoản
 */

export class RiskManager {
  /**
   * @param {Object} config Cấu hình quản trị rủi ro
   */
  constructor(config = {}) {
    this.minRR = Number(config.minRR ?? process.env.RISK_MIN_RR ?? 1.5);
    this.maxSlDistanceUSD = Number(config.maxSlUSD ?? process.env.RISK_MAX_SL_USD ?? 15.0); // Tối đa 15 USD (~150 pips)
    this.minSlDistanceUSD = Number(config.minSlUSD ?? process.env.RISK_MIN_SL_USD ?? 1.5);  // Tối thiểu 1.5 USD (~15 pips)
    this.defaultLot = Number(config.defaultLot ?? process.env.DEFAULT_LOT ?? 0.01);
    this.maxTotalLot = Number(config.maxTotalLot ?? process.env.MAX_TOTAL_LOT ?? config.maxLot ?? process.env.MAX_LOT ?? 0.02);
    this.maxLot = Number(config.maxLot ?? process.env.MAX_LOT ?? this.maxTotalLot);
    this.allowConcurrentTrades = (config.allowConcurrentTrades ?? process.env.ALLOW_CONCURRENT_TRADES ?? 'false').toString().toLowerCase() === 'true';
    this.fixedSlUSD = Number(config.fixedSlUSD ?? process.env.FIXED_SL_USD ?? 4.0);
    this.fixedTpUSD = Number(config.fixedTpUSD ?? process.env.FIXED_TP_USD ?? 6.0);
    this.riskPercent = Number(config.riskPercent ?? process.env.RISK_PERCENT ?? 1.0); // 1% tài khoản
    this.lotMode = config.lotMode ?? process.env.LOT_MODE ?? 'FIXED'; // 'FIXED' hoặc 'DYNAMIC'
    this.lastTradeTime = 0;
    this.tradeCooldownMs = Number(config.cooldownMinutes ?? process.env.TRADE_COOLDOWN_MINUTES ?? 2) * 60 * 1000;

    // Cấu hình Bảo vệ vốn & Ngắt mạch khẩn cấp (Circuit Breaker)
    this.initialCapitalUSD = Number(config.initialCapitalUSD ?? process.env.INITIAL_CAPITAL_USD ?? 1000.0);
    this.maxAccountLossUSD = Number(config.maxAccountLossUSD ?? process.env.MAX_ACCOUNT_LOSS_USD ?? 300.0);
    this.maxDrawdownPercent = Number(config.maxDrawdownPercent ?? process.env.MAX_DRAWDOWN_PERCENT ?? 30.0);
    this.emergencyStopEnabled = (config.emergencyStopEnabled ?? process.env.EMERGENCY_STOP_ENABLED ?? 'true').toString().toLowerCase() === 'true';
    this.closeAllOnEmergency = (config.closeAllOnEmergency ?? process.env.CLOSE_ALL_ON_EMERGENCY ?? 'true').toString().toLowerCase() === 'true';
    this.enforceTrendAlignment = (config.enforceTrendAlignment ?? process.env.ENFORCE_TREND_ALIGNMENT ?? 'true').toString().toLowerCase() === 'true';

    this.circuitBreakerTriggered = false;
    this.circuitBreakerReason = '';
    this.sessionStartEquity = null;
    this.peakEquity = null;
  }

  /**
   * Xóa cooldown nếu lệnh trước bị lỗi hoặc chưa khớp
   */
  resetCooldown() {
    this.lastTradeTime = 0;
  }

  /**
   * Chuẩn hóa SL/TP cố định theo yêu cầu (nếu bật FIXED_SL_USD)
   * @param {import('./trade_signal_parser.js').TradeSignal} signal
   */
  applyFixedSlTp(signal) {
    if (this.fixedSlUSD > 0 && this.fixedTpUSD > 0 && signal) {
      if (signal.action === 'BUY') {
        signal.sl = Number((signal.entry - this.fixedSlUSD).toFixed(2));
        signal.tp = Number((signal.entry + this.fixedTpUSD).toFixed(2));
      } else if (signal.action === 'SELL') {
        signal.sl = Number((signal.entry + this.fixedSlUSD).toFixed(2));
        signal.tp = Number((signal.entry - this.fixedTpUSD).toFixed(2));
      }
      signal.rr = Number((this.fixedTpUSD / this.fixedSlUSD).toFixed(2));
    }
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

    // 0.1 Kiểm tra đồng pha xu hướng chủ đạo H4 (Trend Alignment Filter)
    // Nếu là lệnh Scalping vi mô M1/M5 thì cho phép linh hoạt bắt sóng hồi hoặc theo sóng vi mô
    const isMicroScalp = signal.timeframe === 'M1' || signal.timeframe === 'M5';
    if (this.enforceTrendAlignment && signal.h4Trend && !isMicroScalp) {
      if (signal.h4Trend === 'DOWN' && signal.action === 'BUY') {
        return {
          valid: false,
          reason: `[BỘ LỌC XU HƯỚNG]: Từ chối lệnh BUY vì xu hướng chủ đạo H4 đang là GIẢM. Quy tắc an toàn: Tuyệt đối không bắt dao rơi ngược xu hướng lớn!`
        };
      }
      if (signal.h4Trend === 'UP' && signal.action === 'SELL') {
        return {
          valid: false,
          reason: `[BỘ LỌC XU HƯỚNG]: Từ chối lệnh SELL vì xu hướng chủ đạo H4 đang là TĂNG. Quy tắc an toàn: Tuyệt đối không chặn đầu xe lửa ngược xu hướng lớn!`
        };
      }
    }

    // Tự động áp dụng SL 4 giá và TP 6 giá cố định
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

    // 3. Kiểm tra tỷ lệ Risk : Reward
    const effectiveMinRR = (this.fixedSlUSD > 0 && this.fixedTpUSD > 0)
      ? Math.min(this.minRR, Number((this.fixedTpUSD / this.fixedSlUSD).toFixed(2)))
      : this.minRR;

    if (rr < effectiveMinRR) {
      return {
        valid: false,
        reason: `Tỷ lệ R:R (${rr}) thấp hơn mức tối thiểu cho phép (${effectiveMinRR})`
      };
    }

    // 4. Kiểm tra độ lệch giá thị trường hiện tại so với Entry (tránh vào lệnh trễ)
    if (marketPrice && marketPrice > 0) {
      const priceDiff = Math.abs(marketPrice - entry);
      const maxEntrySlippage = 2.0; // Tối đa lệch 2 USD
      if (priceDiff > maxEntrySlippage) {
        return {
          valid: false,
          reason: `Giá thị trường (${marketPrice}) đã chạy xa khỏi Entry (${entry}) quá ${priceDiff.toFixed(2)} USD`
        };
      }
    }

    // 5. Kiểm tra thời gian hồi phục (Cooldown)
    const now = Date.now();
    if (now - this.lastTradeTime < this.tradeCooldownMs) {
      const remainingMinutes = Math.ceil((this.tradeCooldownMs - (now - this.lastTradeTime)) / 60000);
      return {
        valid: false,
        reason: `Đang trong thời gian cooldown lệnh (còn ${remainingMinutes} phút nữa)`
      };
    }

    // 6. Kiểm tra các lệnh trước đó chưa đóng (Quy tắc lệnh chưa đóng thì không được vào lệnh mới)
    if (context) {
      const totalUnclosed = Number(context.totalUnclosed ?? (
        (context.openCount || 0) + (context.pendingCount || 0) + (context.executingCount || 0)
      ));

      if (!this.allowConcurrentTrades && totalUnclosed > 0) {
        const detail = context.summary ? ` (${context.summary})` : '';
        return {
          valid: false,
          reason: `Đang có lệnh trước đó chưa đóng${detail}. Quy tắc an toàn: Không cho phép vào lệnh mới khi các lệnh trước chưa đóng.`
        };
      }

      // 7. Kiểm tra tổng khối lượng các lệnh đang mở có vượt maxTotalLot (0.02) hay không
      const currentActiveLot = Number(context.totalActiveLot ?? 0);
      if (currentActiveLot >= this.maxTotalLot) {
        return {
          valid: false,
          reason: `Tổng khối lượng các lệnh đang mở (${currentActiveLot} lot) đã đạt/vượt mức tối đa cho phép (${this.maxTotalLot} lot).`
        };
      }

      // Nếu đã có lot gán trước cho signal, kiểm tra tổng lot không được vượt maxTotalLot
      if (signal.lot && Number((currentActiveLot + signal.lot).toFixed(2)) > this.maxTotalLot) {
        return {
          valid: false,
          reason: `Tổng khối lượng sau khi vào lệnh (${(currentActiveLot + signal.lot).toFixed(2)} lot) sẽ vượt mức tối đa cho phép (${this.maxTotalLot} lot).`
        };
      }
    }

    return { valid: true };
  }

  /**
   * Tính toán khối lượng giao dịch an toàn (Lot size)
   * Đảm bảo không vượt quá maxLot của lệnh và không làm tổng volume vượt quá maxTotalLot (0.02)
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
      const riskAmountUSD = accountEquity * (this.riskPercent / 100);
      const slDistanceUSD = Math.abs(signal.entry - signal.sl);

      // Đối với Vàng (XAUUSD chuẩn 1 lot = 100 oz): 1 USD di chuyển trên 1 lot = 100 USD
      const lotPerDollar = riskAmountUSD / (slDistanceUSD * 100);
      calculatedLot = Math.floor(lotPerDollar * 100) / 100;
    }

    // Giới hạn trong khoảng cho phép [0.01 - maxLot] và không vượt quá remainingLot
    calculatedLot = Math.max(0.01, Math.min(this.maxLot, calculatedLot));
    calculatedLot = Math.min(calculatedLot, remainingLot);
    return Number(calculatedLot.toFixed(2));
  }

  /**
   * Đánh dấu đã khớp 1 lệnh mới để tính thời gian cooldown
   */
  recordTradeExecution() {
    this.lastTradeTime = Date.now();
  }

  /**
   * Kiểm tra mức sụt giảm tài khoản và kích hoạt Circuit Breaker nếu chạm ngưỡng lỗ (300 USD / 30%)
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

    // Kiểm tra ngưỡng lỗ tuyệt đối (mặc định 300 USD)
    if (this.maxAccountLossUSD > 0 && currentDrawdown >= this.maxAccountLossUSD) {
      isBreached = true;
      breachReason = `Tài khoản sụt giảm -$${currentDrawdown.toFixed(2)} USD, vượt quá mức lỗ tối đa cho phép (-$${this.maxAccountLossUSD.toFixed(2)} USD)`;
    }

    // Kiểm tra theo % sụt giảm (nếu có tính theo vốn cơ sở 1000 USD hoặc peakEquity)
    if (!isBreached && this.maxDrawdownPercent > 0) {
      const baseCapital = (this.initialCapitalUSD > 0 && Math.abs(equity - this.initialCapitalUSD) < this.initialCapitalUSD)
        ? this.initialCapitalUSD
        : this.peakEquity;

      if (baseCapital > 0) {
        const ddPercent = Number(((baseCapital - equity) / baseCapital * 100).toFixed(2));
        if (ddPercent >= this.maxDrawdownPercent) {
          isBreached = true;
          breachReason = `Mức sụt giảm -${ddPercent}% đã chạm ngưỡng tối đa -${this.maxDrawdownPercent}% vốn (Cơ sở: $${baseCapital.toFixed(2)} USD)`;
        }
      }
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

  getRiskStatus(currentEquity = null) {
    const eq = currentEquity || this.peakEquity || this.initialCapitalUSD;
    const peak = this.peakEquity || eq;
    const dd = peak > eq ? Number((peak - eq).toFixed(2)) : 0;
    return {
      initialCapitalUSD: this.initialCapitalUSD,
      maxAccountLossUSD: this.maxAccountLossUSD,
      maxDrawdownPercent: this.maxDrawdownPercent,
      emergencyStopEnabled: this.emergencyStopEnabled,
      closeAllOnEmergency: this.closeAllOnEmergency,
      isTriggered: this.circuitBreakerTriggered,
      reason: this.circuitBreakerReason,
      currentDrawdown: dd,
      peakEquity: peak,
      currentEquity: eq
    };
  }
}

