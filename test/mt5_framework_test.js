import { parseTradeSignal } from '../src/trade_signal_parser.js';
import { RiskManager } from '../src/risk_manager.js';
import { MT5BridgeServer } from '../src/mt5_bridge_server.js';
import { PriceAlertManager } from '../src/price_alert_manager.js';
import assert from 'assert';

console.log('🧪 BẮT ĐẦU KIỂM TRA KHUNG SƯỜN MT5 EXECUTION...');

// 1. Test Signal Parser với khối JSON
const mockAiTextWithJson = `
[XAU/USD TECHNICAL BRIEF]
2. SCALP (M15):
• Vị thế: LONG
• Entry: 2725.5
• SL: 2719.0
• TP: 2738.5
• R:R: 1:2

\`\`\`json
{
  "action": "BUY",
  "symbol": "XAUUSD",
  "entry": 2725.50,
  "sl": 2719.00,
  "tp": 2738.50,
  "timeframe": "M15",
  "reason": "Test Pullback EMA50",
  "confidence": 85
}
\`\`\`
`;

const signal1 = parseTradeSignal(mockAiTextWithJson, 2725.5);
assert(signal1 !== null, 'Phải parse được tín hiệu từ JSON');
assert.strictEqual(signal1.action, 'BUY');
assert.strictEqual(signal1.entry, 2725.5);
assert.strictEqual(signal1.sl, 2719.0);
assert.strictEqual(signal1.tp, 2738.5);
assert.strictEqual(signal1.rr, 2);
console.log('✅ Test 1 Passed: Signal Parser trích xuất thành công JSON!');

// 2. Test Signal Parser với HOLD
const mockHoldText = `
\`\`\`json
{
  "action": "HOLD",
  "symbol": "XAUUSD"
}
\`\`\`
`;
const signalHold = parseTradeSignal(mockHoldText, 2725.5);
assert(signalHold === null || signalHold.action === 'HOLD', 'HOLD phải là null hoặc action = HOLD');
console.log('✅ Test 2 Passed: Xử lý chính xác khi action = HOLD!');

// 3. Test Risk Manager Hold dài (SL 15 giá, TP 30 giá, R:R 1:2)
const riskManager = new RiskManager({ minRR: 1.8, maxSlUSD: 30.0, minSlUSD: 8.0, defaultLot: 0.01, maxLot: 0.02, fixedSlUSD: 15.0, fixedTpUSD: 30.0 });

// Test chuẩn hóa an toàn SL 15 giá, TP 30 giá cho Hold dài
const validCheck = riskManager.validateSignal(signal1, 2725.5);
assert.strictEqual(validCheck.valid, true, 'Lệnh chuẩn phải pass validation');
assert.strictEqual(signal1.sl, 2710.5, 'SL phải là đúng 15 giá (2725.5 - 15)');
assert.strictEqual(signal1.tp, 2755.5, 'TP phải là đúng 30 giá (2725.5 + 30)');

// Test lot size
const lot = riskManager.calculateLotSize(signal1, 5000);
assert.strictEqual(lot, 0.01, 'Khối lượng cố định phải là 0.01');
signal1.lot = lot; // Gán lot đã tính toán vào signal như cách OrderManager thực hiện
console.log('✅ Test 3 Passed: Risk Manager kiểm duyệt rủi ro Hold dài chính xác!');

// 4. Test MT5 Bridge Server
const testPort = 3099;
const server = new MT5BridgeServer({ port: testPort, logger: () => {} });
server.start();

setTimeout(async () => {
  try {
    // Test Heartbeat
    const hbRes = await fetch(`http://127.0.0.1:${testPort}/api/mt5/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ balance: 5000, equity: 5120, positions_count: 0, server: 'Demo', account: 12345 })
    });
    const hbData = await hbRes.json();
    assert.strictEqual(hbData.ok, true);

    // Queue order & Fetch
    server.queueOrder(signal1);
    const signalRes = await fetch(`http://127.0.0.1:${testPort}/api/mt5/signal`);
    const signalData = await signalRes.json();
    assert.strictEqual(signalData.has_order, true);
    assert.strictEqual(signalData.order.action, 'BUY');
    assert.strictEqual(signalData.order.lot, 0.01);

    // MT5 gửi báo cáo khớp lệnh xong
    await fetch(`http://127.0.0.1:${testPort}/api/mt5/execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: signal1.id, status: 'FILLED', ticket: 11001, price: 2725.5 })
    });

    console.log('✅ Test 4 Passed: MT5 Bridge Server giao tiếp HTTP chuẩn xác!');

    // 5. Test chặn lệnh mới khi lệnh trước đó chưa đóng
    const unclosedCheck1 = server.checkUnclosedOrders('XAUUSD');
    assert.strictEqual(unclosedCheck1.hasUnclosed, false, 'Khi không có lệnh mở hoặc pending thì hasUnclosed phải false');

    // Giả lập MT5 báo có 1 lệnh đang mở 0.01 lot
    server.accountInfo.openPositionsList = [
      { ticket: 112233, symbol: 'XAUUSD', type: 'BUY', lot: 0.01, profit: 5.0 }
    ];
    server.accountInfo.openPositions = 1;

    const unclosedCheck2 = server.checkUnclosedOrders('XAUUSD');
    assert.strictEqual(unclosedCheck2.hasUnclosed, true, 'Phải phát hiện có vị thế đang chạy');
    assert.strictEqual(unclosedCheck2.openCount, 1);
    assert.strictEqual(unclosedCheck2.totalActiveLot, 0.01);

    // Kiểm tra validateSignal từ chối khi lệnh trước chưa đóng
    const blockSignal = { ...signal1, id: 'sig_block_test' };
    const validateUnclosed = riskManager.validateSignal(blockSignal, 2725.5, unclosedCheck2);
    assert.strictEqual(validateUnclosed.valid, false, 'Phải từ chối vào lệnh khi lệnh trước chưa đóng');
    assert(validateUnclosed.reason.includes('chưa đóng'), 'Lý do từ chối phải ghi rõ lệnh trước chưa đóng');
    console.log('✅ Test 5 Passed: Chặn thành công lệnh mới khi lệnh trước đó chưa đóng!');

    // 6. Test kiểm soát trần tổng volume maxTotalLot = 0.02
    // Giả lập tài khoản đã mở 0.02 lot (đầy hạn mức)
    server.accountInfo.openPositionsList = [
      { ticket: 112233, symbol: 'XAUUSD', type: 'BUY', lot: 0.02, profit: 10.0 }
    ];
    const unclosedCheckFull = server.checkUnclosedOrders('XAUUSD');
    assert.strictEqual(unclosedCheckFull.totalActiveLot, 0.02);

    const validateFullLot = riskManager.validateSignal(blockSignal, 2725.5, unclosedCheckFull);
    assert.strictEqual(validateFullLot.valid, false, 'Phải từ chối khi tổng volume đã chạm 0.02');
    assert(validateFullLot.reason.includes('0.02'), 'Lý do từ chối phải ghi rõ đã chạm mức tối đa 0.02 lot');

    // Kiểm tra tính toán lot size khi đã có 0.01 lot đang mở
    const remainingLot = riskManager.calculateLotSize(blockSignal, 5000, 0.01);
    assert.strictEqual(remainingLot, 0.01, 'Chỉ được phép vào thêm tối đa 0.01 lot để tổng không vượt 0.02');

    const noRemainingLot = riskManager.calculateLotSize(blockSignal, 5000, 0.02);
    assert.strictEqual(noRemainingLot, 0, 'Khi đã đạt 0.02 lot thì lot tính toán phải bằng 0');

    // Kiểm tra lệnh đơn lẻ không bao giờ vượt quá maxTotalLot 0.02 dù defaultLot cấu hình lớn hơn
    const highRiskManager = new RiskManager({ defaultLot: 0.05, maxTotalLot: 0.02 });
    const cappedLot = highRiskManager.calculateLotSize(blockSignal, 5000, 0);
    assert.strictEqual(cappedLot, 0.02, 'Khối lượng lệnh phải bị trần ở mức maxTotalLot = 0.02');
    console.log('✅ Test 6 Passed: Kiểm soát trần tổng volume max 0.02 lot chính xác tuyệt đối!');

    // 7. Test cơ chế ngắt mạch bảo vệ tài khoản (Circuit Breaker: Vốn 300 USD, mất 50% vốn -150 USD thì dừng lỗ)
    const circuitBreakerManager = new RiskManager({
      initialCapitalUSD: 300.0,
      maxAccountLossUSD: 150.0,
      maxDrawdownPercent: 50.0,
      emergencyStopEnabled: true
    });

    // Ban đầu tài khoản có 300 USD -> Không vi phạm
    const check1 = circuitBreakerManager.checkAccountProtection({ equity: 300.0, balance: 300.0 });
    assert.strictEqual(check1.isBreached, false, 'Khi tài khoản đủ 300 USD không được ngắt mạch');

    // Khi vốn giảm xuống 220 USD (lỗ 80 USD / 26.7%) -> Vẫn trong ngưỡng cho phép
    const check2 = circuitBreakerManager.checkAccountProtection({ equity: 220.0, balance: 220.0 });
    assert.strictEqual(check2.isBreached, false, 'Lỗ 80 USD chưa chạm ngưỡng 50% vốn (150 USD) thì chưa ngắt mạch');

    // Khi vốn giảm xuống 180 USD (lỗ 120 USD / 40%) -> Vẫn chưa chạm 50%, tiếp tục cho chạy
    const check3 = circuitBreakerManager.checkAccountProtection({ equity: 180.0, balance: 180.0 });
    assert.strictEqual(check3.isBreached, false, 'Lỗ 120 USD (40%) vẫn được phép tiếp tục giao dịch, chưa dừng');

    // Khi vốn giảm xuống 150 USD (lỗ 150 USD / 50% vốn) -> PHẢI NGẮT MẠCH DỪNG LỖ!
    const check4 = circuitBreakerManager.checkAccountProtection({ equity: 150.0, balance: 150.0 });
    assert.strictEqual(check4.isBreached, true, 'Lỗ 50% vốn (150 USD) phải kích hoạt ngắt mạch khẩn cấp dừng lỗ!');
    assert(check4.reason.includes('50%'), 'Lý do phải ghi rõ vi phạm ngưỡng dừng lỗ 50% vốn');

    // Khi đã ngắt mạch, validateSignal phải chặn 100% mọi tín hiệu
    const testSig = { action: 'BUY', entry: 2700, sl: 2696, tp: 2706, rr: 1.5 };
    const validateBlocked = circuitBreakerManager.validateSignal(testSig, 2700);
    assert.strictEqual(validateBlocked.valid, false, 'Khi Circuit Breaker kích hoạt, mọi lệnh phải bị chặn');
    assert(validateBlocked.reason.includes('NGẮT MẠCH'), 'Lý do phải ghi rõ ngắt mạch bảo vệ vốn');

    // Kiểm tra chức năng resetCircuitBreaker (mở khóa)
    circuitBreakerManager.resetCircuitBreaker(150.0);
    assert.strictEqual(circuitBreakerManager.circuitBreakerTriggered, false, 'Sau khi reset thì trạng thái phải mở khóa');
    console.log('✅ Test 7 Passed: Cơ chế ngắt mạch Circuit Breaker bảo vệ vốn (vốn 300u, mất 50% vốn 150u thì dừng lỗ) hoạt động chuẩn xác!');

    // 8. Test bộ lọc đồng pha xu hướng lớn (Trend Alignment Filter)
    const trendFilterManager = new RiskManager({ enforceTrendAlignment: true, fixedSlUSD: 15.0, fixedTpUSD: 30.0 });
    
    // Khi H4 là DOWN: BUY phải bị chặn tuyệt đối (cấm bắt dao rơi)
    const buyInDownTrend = { action: 'BUY', entry: 4090, sl: 4075, tp: 4120, rr: 2.0, h4Trend: 'DOWN' };
    const checkBuyInDown = trendFilterManager.validateSignal(buyInDownTrend, 4090);
    assert.strictEqual(checkBuyInDown.valid, false, 'Không được phép BUY khi xu hướng H4 là GIẢM');
    assert(checkBuyInDown.reason.includes('BỘ LỌC XU HƯỚNG'), 'Lý do phải ghi rõ vi phạm bộ lọc xu hướng');

    // Khi H4 là DOWN: SELL phải được duyệt hợp lệ
    const sellInDownTrend = { action: 'SELL', entry: 4090, sl: 4105, tp: 4060, rr: 2.0, h4Trend: 'DOWN' };
    const checkSellInDown = trendFilterManager.validateSignal(sellInDownTrend, 4090);
    assert.strictEqual(checkSellInDown.valid, true, 'Lệnh SELL thuận theo xu hướng GIẢM của H4 phải hợp lệ');

    // Khi H4 là UP: SELL phải bị chặn tuyệt đối (cấm chặn đầu xe lửa)
    const sellInUpTrend = { action: 'SELL', entry: 4090, sl: 4105, tp: 4060, rr: 2.0, h4Trend: 'UP' };
    const checkSellInUp = trendFilterManager.validateSignal(sellInUpTrend, 4090);
    assert.strictEqual(checkSellInUp.valid, false, 'Không được phép SELL khi xu hướng H4 là TĂNG');

    // Khi H4 là UP: BUY phải được duyệt hợp lệ
    const buyInUpTrend = { action: 'BUY', entry: 4090, sl: 4075, tp: 4120, rr: 2.0, h4Trend: 'UP' };
    const checkBuyInUp = trendFilterManager.validateSignal(buyInUpTrend, 4090);
    assert.strictEqual(checkBuyInUp.valid, true, 'Lệnh BUY thuận theo xu hướng TĂNG của H4 phải hợp lệ');
    console.log('✅ Test 8 Passed: Bộ lọc đồng pha xu hướng H4 (Trend Alignment) chặn 100% lệnh bắt dao rơi & chặn đầu xe lửa!');

    // 9. Test Quy tắc ICT PD Array Gate (Chặn BUY ở Premium, Chặn SELL ở Discount)
    const ictRiskManager = new RiskManager({ enforceTrendAlignment: true, fixedSlUSD: 15.0, fixedTpUSD: 30.0 });
    const buyInPremium = { action: 'BUY', entry: 2750, sl: 2735, tp: 2780, rr: 2.0, h4Trend: 'UP', pdaZone: 'PREMIUM' };
    const checkBuyPremium = ictRiskManager.validateSignal(buyInPremium, 2750);
    assert.strictEqual(checkBuyPremium.valid, false, 'ICT: Cấm tuyệt đối BUY ở vùng Premium');
    assert(checkBuyPremium.reason.includes('PREMIUM'), 'Lý do phải ghi rõ vi phạm vùng Premium');

    const sellInDiscount = { action: 'SELL', entry: 2710, sl: 2725, tp: 2680, rr: 2.0, h4Trend: 'DOWN', pdaZone: 'DISCOUNT' };
    const checkSellDiscount = ictRiskManager.validateSignal(sellInDiscount, 2710);
    assert.strictEqual(checkSellDiscount.valid, false, 'ICT: Cấm tuyệt đối SELL ở vùng Discount');
    assert(checkSellDiscount.reason.includes('DISCOUNT'), 'Lý do phải ghi rõ vi phạm vùng Discount');

    const validIctBuy = { action: 'BUY', entry: 2710, sl: 2695, tp: 2740, rr: 2.0, h4Trend: 'UP', pdaZone: 'DISCOUNT' };
    const checkValidIctBuy = ictRiskManager.validateSignal(validIctBuy, 2710);
    assert.strictEqual(checkValidIctBuy.valid, true, 'BUY ở Discount thuận xu hướng UP phải hợp lệ');
    console.log('✅ Test 9 Passed: Bộ lọc ICT PD Array (Premium vs Discount) hoạt động chuẩn xác!');

    // 10. Test Bộ lọc nhiễu Kaufman (Efficiency Ratio & Market Noise Filter) & Parser trường mở rộng
    const kaufmanChopSignal = { action: 'BUY', entry: 2720, sl: 2705, tp: 2750, rr: 2.0, h4Trend: 'UP', pdaZone: 'DISCOUNT', marketRegime: 'CHOP_HIGH_NOISE' };
    const checkChop = ictRiskManager.validateSignal(kaufmanChopSignal, 2720);
    assert.strictEqual(checkChop.valid, false, 'Kaufman: Cấm breakout khi thị trường rơi vào CHOP_HIGH_NOISE');
    assert(checkChop.reason.includes('BỘ LỌC NHIỄU KAUFMAN'), 'Lý do phải ghi rõ vi phạm bộ lọc nhiễu Kaufman');

    const kaufmanLowErSignal = { action: 'BUY', entry: 2720, sl: 2705, tp: 2750, rr: 2.0, h4Trend: 'UP', pdaZone: 'DISCOUNT', efficiencyRatioEst: 0.15 };
    const checkLowEr = ictRiskManager.validateSignal(kaufmanLowErSignal, 2720);
    assert.strictEqual(checkLowEr.valid, false, 'Kaufman: Cấm vào lệnh khi Efficiency Ratio < 0.25');

    // Test parse TradeSignal với đầy đủ trường ICT & Kaufman
    const mockIctJsonText = `
\`\`\`json
{
  "action": "BUY",
  "trade_style": "HOLD",
  "trend": "UP",
  "setup_model": "UNICORN",
  "pda_zone": "DISCOUNT",
  "market_regime": "TRENDING_LOW_NOISE",
  "session_killzone": "LONDON_OPEN",
  "efficiency_ratio_est": 0.68,
  "symbol": "XAUUSD",
  "entry": 2720.0,
  "sl": 2708.0,
  "tp": 2744.0,
  "timeframe": "M15",
  "reason": "Unicorn BB FVG overlap",
  "confidence": 90
}
\`\`\`
`;
    const parsedIct = parseTradeSignal(mockIctJsonText, 2720.0);
    assert.strictEqual(parsedIct.action, 'BUY');
    assert.strictEqual(parsedIct.setupModel, 'UNICORN');
    assert.strictEqual(parsedIct.pdaZone, 'DISCOUNT');
    assert.strictEqual(parsedIct.marketRegime, 'TRENDING_LOW_NOISE');
    assert.strictEqual(parsedIct.sessionKillzone, 'LONDON_OPEN');
    assert.strictEqual(parsedIct.efficiencyRatioEst, 0.68);
    assert.strictEqual(parsedIct.sl, 2708.0);
    assert.strictEqual(parsedIct.tp, 2744.0);
    assert.strictEqual(parsedIct.rr, 2);

    const checkParsedValid = ictRiskManager.validateSignal(parsedIct, 2720.0);
    assert.strictEqual(checkParsedValid.valid, true, 'Tín hiệu Unicorn chuẩn ICT & Kaufman phải được duyệt!');
    // Cấu trúc SL 12 giá (2720 - 2708) và TP 24 giá nằm trong khoảng an toàn (8 - 30 giá) -> Phải được bảo toàn!
    assert.strictEqual(parsedIct.sl, 2708.0, 'SL cấu trúc của AI phải được bảo toàn, không bị ép về 15 giá');
    assert.strictEqual(parsedIct.tp, 2744.0, 'TP cấu trúc của AI phải được bảo toàn, không bị ép về 30 giá');
    console.log('✅ Test 10 Passed: Bộ lọc Kaufman Noise Filter & Bảo toàn SL/TP Cấu trúc ICT hoàn hảo!');

    // 11. Test Cấu hình linh động tỷ lệ R:R & Quản lý vốn (updateConfig)
    const dynamicRiskManager = new RiskManager();
    dynamicRiskManager.updateConfig({
      initialCapitalUSD: 300.0,
      maxDrawdownPercent: 50.0,
      minRR: 2.5,
      fixedSlUSD: 10.0,
      fixedTpUSD: 25.0
    });
    const updatedStatus = dynamicRiskManager.getRiskStatus(300.0);
    assert.strictEqual(updatedStatus.initialCapitalUSD, 300.0);
    assert.strictEqual(updatedStatus.maxDrawdownPercent, 50.0);
    assert.strictEqual(updatedStatus.maxAccountLossUSD, 150.0, '50% của 300 USD phải là 150 USD');
    assert.strictEqual(updatedStatus.minRR, 2.5);
    assert.strictEqual(updatedStatus.fixedSlUSD, 10.0);
    assert.strictEqual(updatedStatus.fixedTpUSD, 25.0);
    console.log('✅ Test 11 Passed: Cấu hình linh động tỷ lệ R:R & Vốn/Cắt lỗ (updateConfig) hoạt động chuẩn xác!');

    // 12. Test Quản lý Cảnh báo giá thời gian thực (PriceAlertManager)
    const alertTestManager = new PriceAlertManager({ logger: () => {} });
    const triggeredMessages = [];
    const dummySender = async (msg) => { triggeredMessages.push(msg); };

    // Thêm 2 cảnh báo: 1 tăng vượt >= 3920, 1 giảm thủng <= 3880
    const alertGTE = alertTestManager.addAlert({ targetPrice: 3920.0, condition: 'GTE', note: 'Test Đỉnh H4' });
    const alertLTE = alertTestManager.addAlert({ targetPrice: 3880.0, condition: 'LTE', note: 'Test Đáy H4' });
    assert.strictEqual(alertTestManager.getAlerts().length >= 2, true);

    // Khi giá ở 3900 -> Chưa chạm cảnh báo nào
    const hitNone = await alertTestManager.checkPrice(3900.0, dummySender);
    assert.strictEqual(hitNone.length, 0);
    assert.strictEqual(triggeredMessages.length, 0);

    // Khi giá tăng lên 3920.5 -> Chạm alert GTE!
    const hitGTE = await alertTestManager.checkPrice(3920.5, dummySender);
    assert.strictEqual(hitGTE.length, 1);
    assert.strictEqual(hitGTE[0].id, alertGTE.id);
    assert.strictEqual(triggeredMessages.length, 1);
    assert(triggeredMessages[0].includes('3920.00'), 'Tin nhắn phải có mốc 3920.00');

    // Chạy lại với giá 3925 -> Không được trigger trùng lặp!
    const hitDup = await alertTestManager.checkPrice(3925.0, dummySender);
    assert.strictEqual(hitDup.length, 0, 'Cảnh báo đã kích hoạt không được gửi lặp lại');

    // Xóa alert LTE
    alertTestManager.removeAlert(alertLTE.id);
    alertTestManager.removeAlert(alertGTE.id);
    console.log('✅ Test 12 Passed: Hệ thống cảnh báo giá (Price Alerts) kiểm tra mốc & gửi tin nhắn chuẩn xác!');

    // 13. Test 13: Kiểm tra luồng lệnh chờ Pending Limit (BUY_LIMIT / SELL_LIMIT) và Hủy Lệnh Chờ
    const limitOrder = {
      id: `limit_test_${Date.now()}`,
      action: 'BUY_LIMIT',
      symbol: 'XAUUSD',
      lot: 0.01,
      entry: 3890.0,
      sl: 3880.0,
      tp: 3915.0,
      orderType: 'LIMIT',
      reason: 'Test Buy Limit OTE Zone'
    };
    server.queueOrder(limitOrder);
    assert.strictEqual(server.pendingQueue.length >= 1, true);

    const cancelOrderId = server.queueCancelOrder({ ticket: 12345678, symbol: 'XAUUSD', reason: 'Hủy lệnh chờ test' });
    assert.strictEqual(typeof cancelOrderId, 'string');
    assert.strictEqual(server.pendingQueue[0].action, 'CANCEL_PENDING');
    assert.strictEqual(server.pendingQueue[0].ticket, 12345678);
    console.log('✅ Test 13 Passed: Cơ chế lệnh chờ Pending Limit (BUY_LIMIT / SELL_LIMIT) & Hủy Lệnh Chờ chuẩn xác!');

    // 14. Test 14: Cấu hình linh động số lệnh tối đa (maxConcurrentTrades) và khối lượng Lot (defaultLot, maxLot, maxTotalLot)
    const multiOrderRiskManager = new RiskManager({
      maxConcurrentTrades: 2,
      defaultLot: 0.02,
      maxLot: 0.02,
      maxTotalLot: 0.05,
      minRR: 1.5,
      fixedSlUSD: 10.0,
      fixedTpUSD: 20.0
    });

    assert.strictEqual(multiOrderRiskManager.maxConcurrentTrades, 2);
    assert.strictEqual(multiOrderRiskManager.allowConcurrentTrades, true);
    assert.strictEqual(multiOrderRiskManager.defaultLot, 0.02);
    assert.strictEqual(multiOrderRiskManager.maxLot, 0.02);
    assert.strictEqual(multiOrderRiskManager.maxTotalLot, 0.05);

    // Khi có 1 lệnh đang mở: vì maxConcurrentTrades = 2, lệnh thứ 2 vẫn PHẢI HỢP LỆ
    const context1Order = { totalUnclosed: 1, totalActiveLot: 0.02, openCount: 1, summary: '1 BUY 0.02 lot' };
    const secondOrderSig = { action: 'BUY', entry: 2730, sl: 2720, tp: 2750, rr: 2.0, lot: 0.02 };
    const checkSecondOrder = multiOrderRiskManager.validateSignal(secondOrderSig, 2730, context1Order);
    assert.strictEqual(checkSecondOrder.valid, true, 'Lệnh thứ 2 phải hợp lệ khi maxConcurrentTrades = 2');

    // Khi đã có 2 lệnh đang mở: chạm trần maxConcurrentTrades = 2 -> PHẢI TỪ CHỐI
    const context2Orders = { totalUnclosed: 2, totalActiveLot: 0.04, openCount: 2, summary: '2 BUY 0.04 lot' };
    const thirdOrderSig = { action: 'BUY', entry: 2730, sl: 2720, tp: 2750, rr: 2.0, lot: 0.01 };
    const checkThirdOrder = multiOrderRiskManager.validateSignal(thirdOrderSig, 2730, context2Orders);
    assert.strictEqual(checkThirdOrder.valid, false, 'Lệnh thứ 3 phải bị chặn khi đã đủ 2 lệnh');
    assert(checkThirdOrder.reason.includes('số lệnh tối đa'), 'Lý do phải ghi rõ đạt số lệnh tối đa');

    // Kiểm tra chặn khi lot của 1 lệnh vượt quá maxLot (0.02)
    const excessiveLotSig = { action: 'BUY', entry: 2730, sl: 2720, tp: 2750, rr: 2.0, lot: 0.05 };
    const checkExcessiveLot = multiOrderRiskManager.validateSignal(excessiveLotSig, 2730, { totalUnclosed: 0, totalActiveLot: 0 });
    assert.strictEqual(checkExcessiveLot.valid, false, 'Lệnh với lot 0.05 phải bị chặn khi maxLot = 0.02');
    assert(checkExcessiveLot.reason.includes('tối đa cho 1 lệnh'), 'Lý do phải ghi rõ vượt quá maxLot');

    // Kiểm tra cập nhật động qua updateConfig
    multiOrderRiskManager.updateConfig({
      defaultLot: 0.03,
      maxLot: 0.05,
      maxTotalLot: 0.10,
      maxConcurrentTrades: 3
    });
    const statusAfterUpdate = multiOrderRiskManager.getRiskStatus(1000);
    assert.strictEqual(statusAfterUpdate.defaultLot, 0.03);
    assert.strictEqual(statusAfterUpdate.maxLot, 0.05);
    assert.strictEqual(statusAfterUpdate.maxTotalLot, 0.10);
    assert.strictEqual(statusAfterUpdate.maxConcurrentTrades, 3);
    console.log('✅ Test 14 Passed: Cấu hình số lệnh tối đa (maxConcurrentTrades) và khối lượng Lot (defaultLot, maxLot, maxTotalLot) hoạt động hoàn hảo!');

    console.log('\n🎉 TOÀN BỘ 14 BỘ TEST VÀ TÍNH NĂNG MỚI HOẠT ĐỘNG HOÀN HẢO!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Lỗi Test:', err);
    process.exit(1);
  }
}, 500);
