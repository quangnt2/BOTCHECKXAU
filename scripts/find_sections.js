import fs from 'fs';
const content = fs.readFileSync('.agents/extracted_knowledge/jet_si_chan_kinh.txt', 'utf8');
const lines = content.split('\n');

// Find major section starts
for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (l.includes('LỚP BỔ TÚC') || 
      l.includes('LÝ THUYẾT DOW') || 
      l.includes('KHÁNG CỰ - HỖ TRỢ') || 
      l.includes('TRENDLINE') || 
      l.includes('SỰ HỘI TỤ VÀ PHÂN KỲ') ||
      l.includes('HÀNH VI TÂM LÝ') ||
      l.includes('VÙNG GIÁ TRỊ') ||
      l.includes('QUY TẮC VÀO LỆNH') ||
      l.includes('HỆ THỐNG GIAO DỊCH')) {
    if (l.length < 80) {
      console.log(`[Line ${i}] ${l}`);
    }
  }
}
