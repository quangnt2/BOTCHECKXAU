import http from 'http';
import { recordOrder } from './order_history.js';
import { handleDashboardRequest } from './dashboard_handler.js';

/**
 * MT5 LOCAL BRIDGE SERVER
 * Cung cấp cổng giao tiếp HTTP cục bộ (localhost) giữa Bot Node.js và MT5 Expert Advisor (EA)
 */
export class MT5BridgeServer {
  /**
   * @param {Object} options
   * @param {number} options.port Cổng kết nối (mặc định 3000)
   * @param {function(string): void} options.logger Hàm ghi log
   * @param {function(object): Promise<void>} options.onExecutionComplete Callback khi MT5 khớp lệnh xong
   * @param {function(object): Promise<void>} options.onDealClosed Callback khi có lệnh vừa đóng trên MT5
   */
  constructor({ port = 3000, logger = console.log, onExecutionComplete = null, onDealClosed = null }) {
    this.port = Number(port);
    this.logger = logger;
    this.onExecutionComplete = onExecutionComplete;
    this.onDealClosed = onDealClosed;
    this.knownDealTickets = new Set();
    this.server = null;

    /** @type {Array<any>} Danh sách lệnh đang chờ MT5 lấy về khớp */
    this.pendingQueue = [];

    /** @type {Map<string, any>} Lưu vết các lệnh đang xử lý */
    this.activeOrders = new Map();

    /** Thông tin tài khoản cập nhật từ MT5 EA */
    this.accountInfo = {
      connected: false,
      lastHeartbeat: 0,
      balance: 0,
      equity: 0,
      openPositions: 0,
      openPositionsList: [],
      closedDealsList: [],
      todayProfit: 0,
      serverName: '',
      accountNumber: ''
    };

    /** Giá thị trường thời gian thực (Bid, Ask, Spread) từ MT5 EA */
    this.marketPrice = null;

    /** Ngữ cảnh phục vụ dữ liệu cho Web Dashboard */
    this.dashboardContext = {};
  }

  /**
   * Thiết lập ngữ cảnh kết nối dữ liệu từ Bot sang Web Dashboard
   * @param {Object} context
   */
  setDashboardContext(context) {
    this.dashboardContext = context;
  }

  /**
   * Khởi động HTTP Server
   */
  start() {
    this.server = http.createServer((req, res) => {
      // Thiết lập CORS header cho localhost
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
      const pathname = url.pathname;

      // 0. Phục vụ Web Dashboard & Dashboard APIs
      if (
        pathname === '/' ||
        pathname === '/dashboard' ||
        pathname === '/index.html' ||
        pathname.startsWith('/api/dashboard') ||
        pathname.startsWith('/screenshots') ||
        pathname.startsWith('/public')
      ) {
        handleDashboardRequest(req, res, this, this.dashboardContext)
          .then(handled => {
            if (!handled && !res.writableEnded) {
              res.writeHead(404, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Dashboard endpoint not found' }));
            }
          })
          .catch(err => {
            this.logger(`[MT5 Bridge] Lỗi Dashboard: ${err.message}`);
            if (!res.writableEnded) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Dashboard internal error' }));
            }
          });
        return;
      }

      // 1. Endpoint: MT5 EA kiểm tra có lệnh mới cần khớp không
      if (req.method === 'GET' && url.pathname === '/api/mt5/signal') {
        this.handleGetSignal(res);
        return;
      }

      // 2. Endpoint: MT5 EA báo cáo kết quả khớp lệnh (thành công hoặc thất bại)
      if (req.method === 'POST' && url.pathname === '/api/mt5/execution') {
        this.readJsonBody(req, res, (data) => this.handleExecutionResult(data, res));
        return;
      }

      // 3. Endpoint: MT5 EA gửi nhịp tim (Heartbeat) định kỳ đồng bộ số dư, equity
      if (req.method === 'POST' && url.pathname === '/api/mt5/heartbeat') {
        this.readJsonBody(req, res, (data) => this.handleHeartbeat(data, res));
        return;
      }

      // 4. Endpoint: Kiểm tra trạng thái kết nối Bridge
      if (req.method === 'GET' && url.pathname === '/api/mt5/status') {
        this.handleGetStatus(res);
        return;
      }

      // 5. Endpoint: Bắn lệnh kiểm thử trực tiếp
      if (req.method === 'POST' && url.pathname === '/api/mt5/test-order') {
        this.readJsonBody(req, res, (data) => {
          const testOrder = {
            id: `test_${Date.now()}`,
            action: (data.action || 'BUY').toUpperCase(),
            symbol: data.symbol || 'XAUUSD',
            lot: Number(data.lot || process.env.DEFAULT_LOT || 0.01),
            sl: Number(data.sl || 0),
            tp: Number(data.tp || 0),
            orderType: 'MARKET',
            entry: Number(data.entry || 0),
            timeframe: 'TEST',
            reason: data.reason || 'Test khớp lệnh MT5 tự động',
            confidence: 99
          };
          this.queueOrder(testOrder);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, queued: testOrder }));
        });
        return;
      }

      // 404 Not Found
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Endpoint not found' }));
    });

    this.server.listen(this.port, '127.0.0.1', () => {
      this.logger(`[MT5 Bridge] 🚀 Đã mở cổng HTTP kết nối MT5 tại http://127.0.0.1:${this.port}`);
    });

    this.server.on('error', (err) => {
      this.logger(`[MT5 Bridge] ❌ Lỗi server: ${err.message}`);
    });
  }

  /**
   * Đọc dữ liệu JSON từ body của POST request
   */
  readJsonBody(req, res, callback) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        callback(data);
      } catch (e) {
        this.logger(`[MT5 Bridge] ❌ Lỗi parse JSON body từ ${req.url}: ${e.message} | Raw: ${body.slice(0, 300)}`);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON body' }));
      }
    });
  }

  /**
   * Đẩy 1 lệnh đã duyệt vào hàng đợi để MT5 lấy về khớp
   * @param {any} order
   */
  queueOrder(order) {
    this.pendingQueue.push(order);
    const active = {
      ...order,
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    this.activeOrders.set(order.id, active);
    recordOrder(active);
    this.logger(`[MT5 Bridge] 📥 Đã đưa lệnh [${order.id}] (${order.action} ${order.lot} lot) vào hàng đợi MT5.`);
  }

  /**
   * Đưa lệnh đóng toàn bộ vị thế khẩn cấp sang MT5 (Circuit Breaker)
   * @param {string} reason
   */
  queueEmergencyCloseAll(reason = 'Khẩn cấp bảo vệ tài khoản') {
    const emergencyOrder = {
      id: `emer_${Date.now()}`,
      action: 'CLOSE_ALL',
      symbol: 'XAUUSD',
      lot: 0,
      sl: 0,
      tp: 0,
      reason,
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    // Đưa lên đầu hàng đợi để MT5 lấy ngay lập tức trong lần poll tiếp theo
    this.pendingQueue.unshift(emergencyOrder);
    this.activeOrders.set(emergencyOrder.id, emergencyOrder);
    this.logger(`[MT5 Bridge] 🚨 ĐÃ PHÁT LỆNH KHẨN CẤP [CLOSE_ALL] SANG MT5! Lý do: ${reason}`);
  }

  /**
   * Đưa lệnh đóng 1 vị thế cụ thể sang MT5 (do đảo chiều xu hướng)
   * @param {Object} params
   * @param {number|string} params.ticket Mã vé vị thế cần đóng
   * @param {string} params.symbol Cặp tiền (XAUUSD)
   * @param {string} params.reason Lý do đóng lệnh (đảo chiều xu hướng)
   */
  queueCloseOrder({ ticket, symbol = 'XAUUSD', reason = 'Đảo chiều xu hướng' }) {
    const closeOrder = {
      id: `close_${ticket || 'all'}_${Date.now()}`,
      action: 'CLOSE',
      ticket: Number(ticket || 0),
      symbol,
      lot: 0,
      sl: 0,
      tp: 0,
      orderType: 'MARKET',
      entry: 0,
      timeframe: 'CLOSE',
      reason,
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    this.pendingQueue.unshift(closeOrder);
    this.activeOrders.set(closeOrder.id, closeOrder);
    this.logger(`[MT5 Bridge] ⚠️ ĐÃ ĐƯA LỆNH ĐÓNG VỊ THẾ #${ticket || 'ALL'} SANG MT5! Lý do: ${reason}`);
    return closeOrder.id;
  }

  /**
   * Đưa yêu cầu hủy 1 lệnh chờ Pending Limit sang MT5
   * @param {Object} params
   * @param {number|string} params.ticket
   * @param {string} params.symbol
   * @param {string} params.reason
   */
  queueCancelOrder({ ticket, symbol = 'XAUUSD', reason = 'Hủy lệnh chờ' }) {
    const cancelOrder = {
      id: `cancel_${ticket}_${Date.now()}`,
      action: 'CANCEL_PENDING',
      ticket: Number(ticket || 0),
      symbol,
      lot: 0,
      sl: 0,
      tp: 0,
      orderType: 'PENDING',
      entry: 0,
      timeframe: 'CANCEL',
      reason,
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    this.pendingQueue.unshift(cancelOrder);
    this.activeOrders.set(cancelOrder.id, cancelOrder);
    this.logger(`[MT5 Bridge] 🗑️ ĐÃ ĐƯA LỆNH HỦY LỆNH CHỜ #${ticket} SANG MT5! Lý do: ${reason}`);
    return cancelOrder.id;
  }

  /**
   * Đưa lệnh mở khóa Circuit Breaker sang MT5 EA
   */
  queueUnlockCircuitBreaker() {
    const unlockOrder = {
      id: `unlock_${Date.now()}`,
      action: 'UNLOCK',
      symbol: 'XAUUSD',
      lot: 0,
      sl: 0,
      tp: 0,
      comment: 'Reset Circuit Breaker tu Node.js',
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    this.pendingQueue.unshift(unlockOrder);
    this.activeOrders.set(unlockOrder.id, unlockOrder);
    this.logger(`[MT5 Bridge] 🔓 ĐÃ ĐƯA LỆNH MỞ KHÓA [UNLOCK] SANG MT5!`);
    return unlockOrder.id;
  }

  /**
   * Đưa lệnh hủy tất cả lệnh chờ sang MT5 EA
   */
  queueCancelAllPending(reason = 'Hủy tất cả lệnh chờ') {
    const cancelAllOrder = {
      id: `cancelall_${Date.now()}`,
      action: 'CANCEL_ALL_PENDING',
      symbol: 'XAUUSD',
      lot: 0,
      sl: 0,
      tp: 0,
      reason,
      comment: 'Cancel all pending from AI',
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    this.pendingQueue.unshift(cancelAllOrder);
    this.activeOrders.set(cancelAllOrder.id, cancelAllOrder);
    this.logger(`[MT5 Bridge] 🗑️ ĐÃ ĐƯA LỆNH [CANCEL_ALL_PENDING] SANG MT5! Lý do: ${reason}`);
    return cancelAllOrder.id;
  }

  /**
   * Đưa lệnh dời SL về hòa vốn sang MT5 EA
   */
  queueMoveSlToBreakeven(symbol = 'XAUUSD') {
    const beOrder = {
      id: `be_${Date.now()}`,
      action: 'MOVE_SL_BE',
      symbol,
      lot: 0,
      sl: 0,
      tp: 0,
      comment: 'Move SL to BE from AI',
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    this.pendingQueue.unshift(beOrder);
    this.activeOrders.set(beOrder.id, beOrder);
    this.logger(`[MT5 Bridge] 🛡️ ĐÃ ĐƯA LỆNH DỜI SL HÒA VỐN [MOVE_SL_BE] SANG MT5!`);
    return beOrder.id;
  }

  /**
   * Lấy danh sách lệnh chờ và vị thế mở thời gian thực
   */
  getTradingState() {
    return {
      pendingOrders: this.latestHeartbeat?.pendingOrdersList || [],
      openPositions: this.latestHeartbeat?.openPositionsList || []
    };
  }

  /**
   * Đưa lệnh cập nhật SL/TP sang MT5 EA
   */
  queueUpdateSlTp({ symbol = 'XAUUSD', sl = 0, tp = 0 }) {
    const updateOrder = {
      id: `updatesltp_${Date.now()}`,
      action: 'UPDATE_SL_TP',
      symbol,
      lot: 0,
      sl: Number(sl || 0),
      tp: Number(tp || 0),
      comment: 'Update SL/TP from AI',
      queuedAt: Date.now(),
      status: 'QUEUED'
    };
    this.pendingQueue.unshift(updateOrder);
    this.activeOrders.set(updateOrder.id, updateOrder);
    this.logger(`[MT5 Bridge] 🔄 ĐÃ ĐƯA LỆNH [UPDATE_SL_TP] (SL: ${sl}, TP: ${tp}) SANG MT5!`);
    return updateOrder.id;
  }

  /**
   * Xử lý khi MT5 EA hỏi lệnh mới
   */
  handleGetSignal(res) {
    if (this.pendingQueue.length > 0) {
      const order = this.pendingQueue.shift();
      const active = this.activeOrders.get(order.id);
      if (active) active.status = 'EXECUTING';

      this.logger(`[MT5 Bridge] 📤 MT5 EA đã lấy lệnh [${order.id}] (${order.action} ${order.ticket ? '#' + order.ticket : (order.lot + ' lot')} @ SL: ${order.sl}, TP: ${order.tp}) để khớp.`);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        has_order: true,
        order: {
          id: order.id,
          action: order.action,
          symbol: order.symbol,
          lot: order.lot,
          sl: order.sl,
          tp: order.tp,
          ticket: Number(order.ticket || 0),
          reason: order.reason || '',
          order_type: order.orderType || 'MARKET',
          entry_price: order.entry,
          magic: Number(process.env.MT5_MAGIC_NUMBER || 888999),
          comment: order.comment || (order.action === 'CLOSE' ? `CLOSE_${order.ticket}` : `AI_${order.timeframe || 'M15'}`)
        }
      }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ has_order: false }));
    }
  }

  /**
   * Xử lý khi MT5 EA báo cáo kết quả khớp lệnh
   */
  async handleExecutionResult(data, res) {
    const { id, status, ticket, price, error } = data;
    this.logger(`[MT5 Bridge] 🎯 MT5 báo cáo kết quả lệnh [${id}]: Trạng thái: ${status} | Ticket: ${ticket || 'N/A'} | Giá khớp: ${price || 'N/A'} | ${error ? 'Lỗi: ' + error : ''}`);

    const active = this.activeOrders.get(id);
    if (active) {
      active.status = status;
      active.ticket = ticket;
      active.executedPrice = price;
      active.error = error;
      active.executedAt = Date.now();
      recordOrder(active);
    }

    if (this.onExecutionComplete) {
      try {
        await this.onExecutionComplete({ id, status, ticket, price, error, originalOrder: active });
      } catch (err) {
        this.logger(`[MT5 Bridge] Lỗi gọi callback onExecutionComplete: ${err.message}`);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ acknowledged: true }));
  }

  /**
   * Xử lý nhịp tim từ MT5 EA
   */
  handleHeartbeat(data, res) {
    const incomingDeals = Array.isArray(data.closed_deals) ? data.closed_deals : [];

    // Nếu có deal mới đóng, kích hoạt callback onDealClosed để báo Telegram
    if (this.knownDealTickets.size === 0) {
      incomingDeals.forEach(d => this.knownDealTickets.add(String(d.ticket)));
    } else {
      for (const deal of incomingDeals) {
        const ticketStr = String(deal.ticket);
        if (!this.knownDealTickets.has(ticketStr)) {
          this.knownDealTickets.add(ticketStr);
          if (this.onDealClosed) {
            try {
              this.onDealClosed(deal);
            } catch (err) {
              this.logger(`[MT5 Bridge] Lỗi gọi callback onDealClosed: ${err.message}`);
            }
          }
        }
      }
    }

    this.accountInfo = {
      connected: true,
      lastHeartbeat: Date.now(),
      balance: Number(data.balance || 0),
      equity: Number(data.equity || 0),
      openPositions: Number(data.positions_count || 0),
      openPositionsList: Array.isArray(data.open_positions) ? data.open_positions : [],
      pendingOrdersList: Array.isArray(data.pending_orders) ? data.pending_orders : [],
      closedDealsList: incomingDeals,
      todayProfit: Number(data.today_profit || 0),
      serverName: data.server || '',
      accountNumber: String(data.account || ''),
      terminalAlgo: data.terminal_algo === true || data.terminal_algo === 'true',
      eaAlgo: data.ea_algo === true || data.ea_algo === 'true',
      accountAlgo: data.account_algo === true || data.account_algo === 'true'
    };

    // Lưu giá thị trường thời gian thực (Bid, Ask, Spread) từ MT5
    if (data.market_price && typeof data.market_price === 'object') {
      this.marketPrice = {
        symbol: data.market_price.symbol || 'XAUUSD',
        bid: Number(data.market_price.bid || 0),
        ask: Number(data.market_price.ask || 0),
        spread: Number(data.market_price.spread || 0),
        updatedAt: Date.now()
      };
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      config: {
        breakeven_trigger_usd: Number(process.env.BREAKEVEN_TRIGGER_USD || 10.0),
        breakeven_offset_usd: Number(process.env.BREAKEVEN_OFFSET_USD || 1.0),
        lock_profit_trigger_usd: Number(process.env.LOCK_PROFIT_TRIGGER_USD || 15.0),
        lock_profit_offset_usd: Number(process.env.LOCK_PROFIT_OFFSET_USD || 6.0)
      }
    }));
  }

  /**
   * Trả về tình trạng kết nối Bridge
   */
  handleGetStatus(res) {
    const isAlive = Date.now() - (this.accountInfo.lastHeartbeat || 0) < 45000; // Còn nhịp tim trong 45s
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      bridge: 'online',
      mt5_connected: isAlive,
      account: {
        ...this.accountInfo,
        connected: isAlive
      },
      market_price: this.getLatestMarketPrice(),
      pending_queue_size: this.pendingQueue.length
    }));
  }

  /**
   * Lấy giá thị trường thời gian thực (Bid, Ask, Spread) từ MT5 EA
   * @param {number} maxAgeMs Giới hạn độ trễ (mặc định 15 giây)
   */
  getLatestMarketPrice(maxAgeMs = 15000) {
    const isAlive = Date.now() - (this.accountInfo.lastHeartbeat || 0) < 45000;
    if (!isAlive || !this.accountInfo.connected) return null;
    if (!this.marketPrice || !this.marketPrice.bid || this.marketPrice.bid <= 0) return null;
    if (Date.now() - (this.marketPrice.updatedAt || 0) > maxAgeMs) return null;
    return {
      ...this.marketPrice,
      server: this.accountInfo.serverName || 'MT5 Live'
    };
  }

  /**
   * Lấy vốn Equity hiện tại từ MT5
   */
  getLatestEquity() {
    return this.accountInfo.connected ? this.accountInfo.equity : null;
  }

  /**
   * Tính tổng volume các vị thế và lệnh đang mở hoặc đang chờ khớp
   * @param {string|null} symbol Lọc theo symbol (hoặc null để tính tất cả)
   * @returns {number}
   */
  getTotalActiveLot(symbol = null) {
    let total = 0;

    // 1. Các vị thế đang mở trên MT5
    for (const pos of this.accountInfo.openPositionsList || []) {
      if (!symbol || !pos.symbol || pos.symbol.includes(symbol) || symbol.includes(pos.symbol)) {
        total += Number(pos.lot) || 0;
      }
    }

    // 2. Các lệnh trong hàng đợi pendingQueue
    for (const order of this.pendingQueue) {
      if (!symbol || !order.symbol || order.symbol.includes(symbol) || symbol.includes(order.symbol)) {
        total += Number(order.lot) || 0;
      }
    }

    // 3. Các lệnh đang thực thi (EXECUTING)
    for (const active of this.activeOrders.values()) {
      if (active.status === 'EXECUTING') {
        if (!symbol || !active.symbol || active.symbol.includes(symbol) || symbol.includes(active.symbol)) {
          // Tránh cộng trùng nếu lệnh vẫn còn trong pendingQueue
          const inQueue = this.pendingQueue.some(q => q.id === active.id);
          if (!inQueue) {
            total += Number(active.lot) || 0;
          }
        }
      }
    }

    return Number(total.toFixed(2));
  }

  /**
   * Kiểm tra xem có lệnh hoặc vị thế nào trước đó chưa đóng hay không
   * @param {string|null} symbol Lọc theo symbol (hoặc null để kiểm tra toàn bộ tài khoản)
   * @returns {{
   *   hasUnclosed: boolean,
   *   openCount: number,
   *   pendingCount: number,
   *   executingCount: number,
   *   totalUnclosed: number,
   *   currentOpenLot: number,
   *   pendingLot: number,
   *   totalActiveLot: number,
   *   summary: string,
   *   openList: Array<any>,
   *   pendingList: Array<any>
   * }}
   */
  checkUnclosedOrders(symbol = null) {
    const rawOpenList = this.accountInfo.openPositionsList || [];
    const openList = rawOpenList.filter(pos => {
      if (!symbol) return true;
      return pos.symbol && (pos.symbol.includes(symbol) || symbol.includes(pos.symbol));
    });

    const pendingList = this.pendingQueue.filter(order => {
      if (!symbol) return true;
      return order.symbol && (order.symbol.includes(symbol) || symbol.includes(order.symbol));
    });

    const executingOrders = Array.from(this.activeOrders.values()).filter(o => {
      if (o.status !== 'EXECUTING') return false;
      if (pendingList.some(p => p.id === o.id)) return false;
      if (!symbol) return true;
      return o.symbol && (o.symbol.includes(symbol) || symbol.includes(o.symbol));
    });

    const currentOpenLot = Number(openList.reduce((sum, p) => sum + (Number(p.lot) || 0), 0).toFixed(2));
    const pendingLot = Number((
      pendingList.reduce((sum, o) => sum + (Number(o.lot) || 0), 0) +
      executingOrders.reduce((sum, o) => sum + (Number(o.lot) || 0), 0)
    ).toFixed(2));
    const totalActiveLot = Number((currentOpenLot + pendingLot).toFixed(2));

    const openCount = openList.length;
    const pendingCount = pendingList.length;
    const executingCount = executingOrders.length;
    const totalUnclosed = openCount + pendingCount + executingCount;
    const hasUnclosed = totalUnclosed > 0;

    const parts = [];
    if (openCount > 0) {
      const tickets = openList.map(p => `#${p.ticket} [${p.type} ${p.lot} lot]`).join(', ');
      parts.push(`${openCount} vị thế đang mở: ${tickets}`);
    }
    if (pendingCount > 0) {
      parts.push(`${pendingCount} lệnh trong hàng đợi (${pendingLot} lot)`);
    }
    if (executingCount > 0) {
      parts.push(`${executingCount} lệnh đang khớp trên MT5`);
    }

    const summary = parts.join(' | ');

    return {
      hasUnclosed,
      openCount,
      pendingCount,
      executingCount,
      totalUnclosed,
      currentOpenLot,
      pendingLot,
      totalActiveLot,
      summary,
      openList,
      pendingList
    };
  }
}
