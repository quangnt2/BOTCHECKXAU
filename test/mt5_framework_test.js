import { parseTradeSignal } from '../src/trade_signal_parser.js';
import { RiskManager } from '../src/risk_manager.js';
import { MT5BridgeServer } from '../src/mt5_bridge_server.js';
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
assert.strictEqual(signalHold, null, 'HOLD phải trả về null (không vào lệnh)');
console.log('✅ Test 2 Passed: Bỏ qua khi action = HOLD!');

// 3. Test Risk Manager (SL 4 giá, TP 6 giá, R:R 1:1.5)
const riskManager = new RiskManager({ minRR: 1.5, maxSlUSD: 15.0, minSlUSD: 1.5, defaultLot: 0.01, maxLot: 0.02, fixedSlUSD: 4.0, fixedTpUSD: 6.0 });

// Test chuẩn hóa SL 4 giá, TP 6 giá
const validCheck = riskManager.validateSignal(signal1, 2725.5);
assert.strictEqual(validCheck.valid, true, 'Lệnh chuẩn phải pass validation');
assert.strictEqual(signal1.sl, 2721.5, 'SL phải là đúng 4 giá (2725.5 - 4)');
assert.strictEqual(signal1.tp, 2731.5, 'TP phải là đúng 6 giá (2725.5 + 6)');

// Test lot size
const lot = riskManager.calculateLotSize(signal1, 5000);
assert.strictEqual(lot, 0.01, 'Khối lượng cố định phải là 0.01');
signal1.lot = lot; // Gán lot đã tính toán vào signal như cách OrderManager thực hiện
console.log('✅ Test 3 Passed: Risk Manager kiểm duyệt rủi ro chính xác!');

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

    // 7. Test cơ chế ngắt mạch bảo vệ tài khoản (Circuit Breaker: Lỗ 300 USD / 30% vốn 1000 USD)
    const circuitBreakerManager = new RiskManager({
      initialCapitalUSD: 1000.0,
      maxAccountLossUSD: 300.0,
      maxDrawdownPercent: 30.0,
      emergencyStopEnabled: true
    });

    // Ban đầu tài khoản có 1000 USD -> Không vi phạm
    const check1 = circuitBreakerManager.checkAccountProtection({ equity: 1000.0, balance: 1000.0 });
    assert.strictEqual(check1.isBreached, false, 'Khi tài khoản đủ 1000 USD không được ngắt mạch');

    // Khi vốn giảm xuống 800 USD (lỗ 200 USD) -> Vẫn trong ngưỡng cho phép
    const check2 = circuitBreakerManager.checkAccountProtection({ equity: 800.0, balance: 800.0 });
    assert.strictEqual(check2.isBreached, false, 'Lỗ 200 USD chưa chạm ngưỡng 300 USD thì chưa ngắt mạch');

    // Khi vốn giảm xuống 700 USD (lỗ 300 USD / 30%) -> PHẢI NGẮT MẠCH!
    const check3 = circuitBreakerManager.checkAccountProtection({ equity: 700.0, balance: 700.0 });
    assert.strictEqual(check3.isBreached, true, 'Lỗ 300 USD phải kích hoạt ngắt mạch khẩn cấp!');
    assert(check3.reason.includes('300'), 'Lý do phải ghi rõ vi phạm ngưỡng lỗ 300 USD');

    // Khi đã ngắt mạch, validateSignal phải chặn 100% mọi tín hiệu
    const testSig = { action: 'BUY', entry: 2700, sl: 2696, tp: 2706, rr: 1.5 };
    const validateBlocked = circuitBreakerManager.validateSignal(testSig, 2700);
    assert.strictEqual(validateBlocked.valid, false, 'Khi Circuit Breaker kích hoạt, mọi lệnh phải bị chặn');
    assert(validateBlocked.reason.includes('NGẮT MẠCH'), 'Lý do phải ghi rõ ngắt mạch bảo vệ vốn');

    // Kiểm tra chức năng resetCircuitBreaker (mở khóa)
    circuitBreakerManager.resetCircuitBreaker(700.0);
    assert.strictEqual(circuitBreakerManager.circuitBreakerTriggered, false, 'Sau khi reset thì trạng thái phải mở khóa');
    console.log('✅ Test 7 Passed: Cơ chế ngắt mạch Circuit Breaker bảo vệ vốn (lỗ 300u/1000u) hoạt động chuẩn xác!');

    // 8. Test bộ lọc đồng pha xu hướng lớn (Trend Alignment Filter)
    const trendFilterManager = new RiskManager({ enforceTrendAlignment: true, fixedSlUSD: 4.0, fixedTpUSD: 6.0 });
    
    // Khi H4 là DOWN: BUY phải bị chặn tuyệt đối (cấm bắt dao rơi)
    const buyInDownTrend = { action: 'BUY', entry: 4090, sl: 4086, tp: 4096, rr: 1.5, h4Trend: 'DOWN' };
    const checkBuyInDown = trendFilterManager.validateSignal(buyInDownTrend, 4090);
    assert.strictEqual(checkBuyInDown.valid, false, 'Không được phép BUY khi xu hướng H4 là GIẢM');
    assert(checkBuyInDown.reason.includes('BỘ LỌC XU HƯỚNG'), 'Lý do phải ghi rõ vi phạm bộ lọc xu hướng');

    // Khi H4 là DOWN: SELL phải được duyệt hợp lệ
    const sellInDownTrend = { action: 'SELL', entry: 4090, sl: 4094, tp: 4084, rr: 1.5, h4Trend: 'DOWN' };
    const checkSellInDown = trendFilterManager.validateSignal(sellInDownTrend, 4090);
    assert.strictEqual(checkSellInDown.valid, true, 'Lệnh SELL thuận theo xu hướng GIẢM của H4 phải hợp lệ');

    // Khi H4 là UP: SELL phải bị chặn tuyệt đối (cấm chặn đầu xe lửa)
    const sellInUpTrend = { action: 'SELL', entry: 4090, sl: 4094, tp: 4084, rr: 1.5, h4Trend: 'UP' };
    const checkSellInUp = trendFilterManager.validateSignal(sellInUpTrend, 4090);
    assert.strictEqual(checkSellInUp.valid, false, 'Không được phép SELL khi xu hướng H4 là TĂNG');

    // Khi H4 là UP: BUY phải được duyệt hợp lệ
    const buyInUpTrend = { action: 'BUY', entry: 4090, sl: 4086, tp: 4096, rr: 1.5, h4Trend: 'UP' };
    const checkBuyInUp = trendFilterManager.validateSignal(buyInUpTrend, 4090);
    assert.strictEqual(checkBuyInUp.valid, true, 'Lệnh BUY thuận theo xu hướng TĂNG của H4 phải hợp lệ');
    console.log('✅ Test 8 Passed: Bộ lọc đồng pha xu hướng H4 (Trend Alignment) chặn 100% lệnh bắt dao rơi & chặn đầu xe lửa!');

    console.log('\n🎉 TOÀN BỘ 8 BỘ TEST VÀ QUY TẮC RỦI RO HOẠT ĐỘNG HOÀN HẢO!');
    process.exit(0);
  } catch (err) {
    console.error('❌ Lỗi Test:', err);
    process.exit(1);
  }
}, 500);
