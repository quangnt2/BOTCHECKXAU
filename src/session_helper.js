/**
 * ICT & TRADING SESSION HELPER
 * Xác định phiên giao dịch, ICT Kill Zones và ICT Macros theo giờ New York và Việt Nam
 */

/**
 * @typedef {Object} ICTSessionInfo
 * @property {'ASIAN_RANGE' | 'LONDON_OPEN' | 'NY_OPEN' | 'LONDON_CLOSE' | 'NY_MIDNIGHT_OPEN' | 'INTER_SESSION'} sessionCode Mã phiên ICT
 * @property {string} sessionName Tên phiên tiếng Việt
 * @property {string} nyTimeStr Giờ New York hiện tại (HH:mm)
 * @property {string} vnTimeStr Giờ Việt Nam hiện tại (HH:mm)
 * @property {boolean} isMacroActive Đang trong khung thời gian ICT Macro (20 phút) hay không
 * @property {string} macroWindow Khung macro nếu có (ví dụ '09:50 - 10:10 NY')
 * @property {string} tradingGuidance Hướng dẫn hành vi giao dịch trong phiên này
 * @property {boolean} isNYMidnightOpen Đang trong cửa sổ tạo NDOG (00:00 - 00:30 NY) hay không
 */

/**
 * Lấy thông tin phiên giao dịch ICT và ICT Kill Zone hiện tại
 * @param {Date} [date=new Date()]
 * @returns {ICTSessionInfo}
 */
export function getCurrentICTSession(date = new Date()) {
  // Lấy giờ New York (tự động điều chỉnh DST Summer/Winter)
  const nyFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });
  
  const vnFormatter = new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  });

  const nyParts = nyFormatter.formatToParts(date);
  const nyHour = parseInt(nyParts.find(p => p.type === 'hour')?.value || '0', 10);
  const nyMinute = parseInt(nyParts.find(p => p.type === 'minute')?.value || '0', 10);
  const nyTotalMins = nyHour * 60 + nyMinute;

  const nyTimeStr = `${String(nyHour).padStart(2, '0')}:${String(nyMinute).padStart(2, '0')}`;
  const vnParts = vnFormatter.formatToParts(date);
  const vnHour = parseInt(vnParts.find(p => p.type === 'hour')?.value || '0', 10);
  const vnMinute = parseInt(vnParts.find(p => p.type === 'minute')?.value || '0', 10);
  const vnTimeStr = `${String(vnHour).padStart(2, '0')}:${String(vnMinute).padStart(2, '0')}`;

  // 1. Phân loại ICT Kill Zones theo giờ New York:
  // - London Open Kill Zone (LOKZ): 02:00 - 05:00 NY (120 - 300 mins)
  // - New York Open Kill Zone (NYOKZ): 07:00 - 10:00 NY (420 - 600 mins)
  // - London Close Kill Zone (LCKZ): 10:00 - 12:00 NY (600 - 720 mins)
  // - Asian Range: 19:00 - 00:00 NY (1140 - 1440 mins)

  let sessionCode = 'INTER_SESSION';
  let sessionName = 'Phiên chuyển tiếp (Inter-session)';
  let tradingGuidance = 'Khối lượng giao dịch thấp, giá có xu hướng sideway hoặc quét râu. Ưu tiên quan sát.';

  // NY Midnight Open: 00:00 NY (0 mins) — Mốc NDOG tạo Opening Gap đầu ngày
  const isNYMidnightOpen = nyTotalMins >= 0 && nyTotalMins < 30;

  if (nyTotalMins >= 120 && nyTotalMins < 300) {
    sessionCode = 'LONDON_OPEN';
    sessionName = 'London Open Kill Zone (Săn thanh khoản)';
    tradingGuidance = 'Kịch bản Judas Swing thường quét đỉnh/đáy Asian Range. Chờ quét ERL rồi tìm FVG/OB vào lệnh thuận xu hướng ngày. Chú ý NDOG từ NY Midnight Open 00:00 NY chưa fill.';
  } else if (nyTotalMins >= 420 && nyTotalMins < 600) {
    sessionCode = 'NY_OPEN';
    sessionName = 'New York Open Kill Zone (Bùng nổ thanh khoản)';
    tradingGuidance = 'Phiên có biến động và khối lượng tổ chức mạnh nhất. Chờ phản ứng tại PD Array H1, tìm OTE hoặc Unicorn Model trên M15/M5. Đây là cửa sổ fill NDOG / NWOG ưu tiên nhất trong ngày.';
  } else if (nyTotalMins >= 600 && nyTotalMins < 720) {
    sessionCode = 'LONDON_CLOSE';
    sessionName = 'London Close Kill Zone (Thoái lui / Chốt lời)';
    tradingGuidance = 'Các quỹ châu Âu chốt lời, thị trường thường có nhịp hồi (Retracement) về FVG nội vùng. Thích hợp dời SL hòa vốn hoặc chốt lời từng phần. Không mở lệnh mới nếu NDOG đã fill hoàn toàn.';
  } else if (isNYMidnightOpen) {
    sessionCode = 'NY_MIDNIGHT_OPEN';
    sessionName = 'NY Midnight Open - NDOG Alert (00:00 NY)';
    tradingGuidance = 'Thời điểm tạo New Day Opening Gap (NDOG). Ghi nhận giá mở cửa ngày mới làm mốc tham chiếu. Không vào lệnh tại đây, quan sát Gap được tạo ra để lên kế hoạch fill về phiên London/New York.';
  } else if (nyTotalMins >= 1140 || nyTotalMins < 60) {
    sessionCode = 'ASIAN_RANGE';
    sessionName = 'Phiên Á (Tích lũy thanh khoản)';
    tradingGuidance = 'Biên độ tích lũy hẹp tạo ra các mốc Asian High/Low (ERL). Không đánh breakout, ưu tiên bảo toàn vốn chờ phiên London.';
  }

  // 2. Kiểm tra ICT Macros (Cửa sổ thuật toán 20 phút của nhà cái)
  // Các khung Macro quan trọng (NY Time):
  // 08:50 - 09:10 (530 - 550)
  // 09:50 - 10:10 (590 - 610)
  // 10:50 - 11:10 (650 - 670)
  // 11:50 - 12:10 (710 - 730)
  // 13:10 - 13:40 (790 - 820)
  // 15:15 - 15:45 (915 - 945)
  let isMacroActive = false;
  let macroWindow = '';

  const macros = [
    { start: 530, end: 550, label: '08:50 - 09:10 NY (Macro trước mở cửa chứng khoán Mỹ)' },
    { start: 590, end: 610, label: '09:50 - 10:10 NY (Macro New York AM Open)' },
    { start: 650, end: 670, label: '10:50 - 11:10 NY (Macro London Close setup)' },
    { start: 710, end: 730, label: '11:50 - 12:10 NY (Macro trưa New York)' },
    { start: 790, end: 820, label: '13:10 - 13:40 NY (Macro đầu chiều New York)' },
    { start: 915, end: 945, label: '15:15 - 15:45 NY (Macro New York Close)' }
  ];

  for (const m of macros) {
    if (nyTotalMins >= m.start && nyTotalMins <= m.end) {
      isMacroActive = true;
      macroWindow = m.label;
      break;
    }
  }

  // 3. Cửa sổ giao phiên Rollover hàng ngày (Daily Market Break: 17:00 - 18:00 NY)
  // Cấm mở lệnh mới từ 16:30 - 18:15 NY (tự động đúng cả giờ mùa hè 03:30-05:15 VN và mùa đông 04:30-06:15 VN)
  const isRolloverWindow = nyTotalMins >= 990 && nyTotalMins <= 1095;
  // Cửa sổ tự động đóng lệnh Scalp trước giờ sàn nghỉ 10 phút: 16:50 - 16:59 NY
  const isPreRolloverCloseWindow = nyTotalMins >= 1010 && nyTotalMins < 1020;

  return {
    sessionCode,
    sessionName,
    nyTimeStr,
    vnTimeStr,
    nyHour,
    nyMinute,
    vnHour,
    vnMinute,
    isMacroActive,
    macroWindow,
    tradingGuidance,
    isNYMidnightOpen,
    isRolloverWindow,
    isPreRolloverCloseWindow
  };
}

