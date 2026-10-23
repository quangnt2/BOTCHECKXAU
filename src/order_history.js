import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const historyFile = path.join(__dirname, '..', 'logs', 'order_history.json');

/**
 * Đọc toàn bộ danh sách lịch sử lệnh từ file JSON
 * @returns {Array<any>}
 */
export function loadOrderHistory() {
  try {
    if (!fs.existsSync(historyFile)) {
      return [];
    }
    const data = fs.readFileSync(historyFile, 'utf8');
    return JSON.parse(data) || [];
  } catch (err) {
    return [];
  }
}

/**
 * Lưu hoặc cập nhật một lệnh vào lịch sử
 * @param {any} order Thông tin lệnh
 */
export function recordOrder(order) {
  if (!order || !order.id) return;

  try {
    const list = loadOrderHistory();
    const index = list.findIndex(item => item.id === order.id);

    const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
    const orderRecord = {
      ...order,
      updatedAt: nowStr,
      timestamp: Date.now()
    };

    if (index >= 0) {
      list[index] = { ...list[index], ...orderRecord };
    } else {
      list.unshift(orderRecord);
    }

    // Giữ tối đa 100 lệnh gần nhất
    const trimmed = list.slice(0, 100);

    const dir = path.dirname(historyFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(historyFile, JSON.stringify(trimmed, null, 2), 'utf8');
  } catch (err) {
    console.error('[OrderHistory] Lỗi lưu lịch sử lệnh:', err.message);
  }
}

/**
 * Định dạng tin nhắn báo cáo lịch sử lệnh và vị thế cho Telegram
 * @param {object} accountInfo Thông tin tài khoản và vị thế từ MT5
 * @returns {string} Nội dung tin nhắn
 */
export function formatHistoryReport(accountInfo = {}) {
  const nowStr = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
  const openPositions = accountInfo.openPositionsList || [];
  const closedDeals = accountInfo.closedDealsList || [];
  const botOrders = loadOrderHistory().slice(0, 5);

  const lines = [
    `📊 [LỊCH SỬ GIAO DỊCH MT5]`,
    `Cập nhật: ${nowStr}`,
    `----------------------------------------`
  ];

  // 1. Tổng quan tài khoản & Lợi nhuận hôm nay
  const balance = Number(accountInfo.balance || 0).toFixed(2);
  const equity = Number(accountInfo.equity || 0).toFixed(2);
  const todayProfit = Number(accountInfo.todayProfit || 0).toFixed(2);
  const profitIcon = Number(todayProfit) >= 0 ? '🟢 +' : '🔴 ';

  lines.push(`💰 Số dư (Balance): $${balance}`);
  lines.push(`📈 Vốn ròng (Equity): $${equity}`);
  lines.push(`💵 P&L chốt hôm nay: ${profitIcon}$${todayProfit}`);
  lines.push(`----------------------------------------`);

  // 2. Vị thế đang chạy (Open Positions)
  lines.push(`🎯 VỊ THẾ ĐANG CHẠY (${openPositions.length}):`);
  if (openPositions.length === 0) {
    lines.push(`• Hiện không có lệnh nào đang mở.`);
  } else {
    openPositions.forEach((pos, idx) => {
      const pIcon = pos.type === 'BUY' ? '🟢 MUA' : '🔴 BÁN';
      const profitNum = Number(pos.profit || 0);
      const posPl = profitNum >= 0 ? `+$${profitNum.toFixed(2)}` : `-$${Math.abs(profitNum).toFixed(2)}`;
      lines.push(`${idx + 1}. #${pos.ticket} ${pIcon} ${pos.lot} ${pos.symbol}`);
      lines.push(`   Entry: ${pos.open} | Hiện tại: ${pos.current}`);
      lines.push(`   SL: ${pos.sl || '-'} | TP: ${pos.tp || '-'} | Lời/Lỗ: ${posPl}`);
    });
  }
  lines.push(`----------------------------------------`);

  // 3. Lịch sử lệnh đã đóng hôm nay (Closed Deals từ MT5)
  lines.push(`📜 LỆNH ĐÃ ĐÓNG HÔM NAY (${closedDeals.length}):`);
  if (closedDeals.length === 0) {
    lines.push(`• Chưa có lệnh nào đóng chốt lời/lỗ hôm nay.`);
  } else {
    closedDeals.slice(0, 5).forEach((deal, idx) => {
      const dIcon = deal.type === 'BUY' ? 'BUY' : 'SELL';
      const dProfit = Number(deal.profit || 0);
      const dProfitStr = dProfit >= 0 ? `🟢 +$${dProfit.toFixed(2)}` : `🔴 -$${Math.abs(dProfit).toFixed(2)}`;
      lines.push(`${idx + 1}. #${deal.ticket} ${dIcon} ${deal.lot} lot @ ${deal.price} ➔ ${dProfitStr} (${deal.time})`);
    });
  }
  lines.push(`----------------------------------------`);

  // 4. Lịch sử tín hiệu gần nhất từ Bot AI
  lines.push(`🤖 TÍN HIỆU BOT ĐÃ BẮN GẦN NHẤT:`);
  if (botOrders.length === 0) {
    lines.push(`• Chưa có dữ liệu lệnh bot lưu trữ.`);
  } else {
    botOrders.forEach((o, idx) => {
      const isFilled = o.status === 'FILLED';
      const statusIcon = isFilled ? '✅ ĐÃ KHỚP' : o.status === 'QUEUED' ? '⏳ ĐANG CHỜ' : '❌ THẤT BẠI';
      const ticketStr = o.ticket ? ` (#${o.ticket})` : '';
      lines.push(`• [${statusIcon}] ${o.action} ${o.lot} lot @ ${o.executedPrice || o.entry}${ticketStr}`);
      if (o.error && !isFilled) {
        lines.push(`  Lỗi: ${o.error.slice(0, 35)}`);
      }
    });
  }

  return lines.join('\n');
}

/**
 * Định dạng danh sách riêng các vị thế đang chạy
 */
export function formatOpenPositions(accountInfo = {}) {
  const openPositions = accountInfo.openPositionsList || [];
  const lines = [
    `🎯 [DANH SÁCH LỆNH ĐANG CHẠY TRÊN MT5]`,
    `Server: ${accountInfo.serverName || 'MT5'} | TK: #${accountInfo.accountNumber || '-'}`,
    `Tổng số lệnh: ${openPositions.length} vị thế`,
    `----------------------------------------`
  ];

  if (openPositions.length === 0) {
    lines.push(`Hiện tại tài khoản đang trống, không có lệnh nào đang chạy.`);
    return lines.join('\n');
  }

  let totalFloating = 0;
  openPositions.forEach((pos, idx) => {
    const pIcon = pos.type === 'BUY' ? '🟢 BUY' : '🔴 SELL';
    const profitNum = Number(pos.profit || 0);
    totalFloating += profitNum;
    const posPl = profitNum >= 0 ? `+$${profitNum.toFixed(2)}` : `-$${Math.abs(profitNum).toFixed(2)}`;

    lines.push(`${idx + 1}. [${pIcon} ${pos.lot} Lot ${pos.symbol}] - Ticket: #${pos.ticket}`);
    lines.push(`   • Giá vào: ${pos.open} ➔ Giá hiện tại: ${pos.current}`);
    lines.push(`   • Cắt lỗ (SL): ${pos.sl || 'Không đặt'}`);
    lines.push(`   • Chốt lời (TP): ${pos.tp || 'Không đặt'}`);
    lines.push(`   • Lời/Lỗ thả nổi: ${posPl}`);
    lines.push(``);
  });

  const totalPlStr = totalFloating >= 0 ? `🟢 +$${totalFloating.toFixed(2)}` : `🔴 -$${Math.abs(totalFloating).toFixed(2)}`;
  lines.push(`----------------------------------------`);
  lines.push(`💵 TỔNG LỜI/LỖ THẢ NỔI: ${totalPlStr}`);
  lines.push(`💰 Số dư: $${Number(accountInfo.balance || 0).toFixed(2)} | Vốn: $${Number(accountInfo.equity || 0).toFixed(2)}`);

  return lines.join('\n');
}
