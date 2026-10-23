import fs from 'fs';
import path from 'path';

const outputDir = path.resolve('.agents/extracted_knowledge');

function searchKeywords(filename, keywords) {
  const filePath = path.join(outputDir, filename);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  console.log(`\n================ Searching in ${filename} ===============`);
  for (const kw of keywords) {
    console.log(`\n--- Keyword: "${kw}" ---`);
    let matches = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(kw.toLowerCase())) {
        // print surrounding lines
        const start = Math.max(0, i - 1);
        const end = Math.min(lines.length - 1, i + 3);
        const snippet = lines.slice(start, end + 1).map(l => l.trim()).filter(Boolean).join(' | ');
        console.log(`[L${i}] ${snippet.slice(0, 160)}`);
        matches++;
        if (matches >= 6) {
          console.log(`  ... and more matches.`);
          break;
        }
      }
    }
  }
}

searchKeywords('jesse_livermore_2.txt', ['EMA', 'MA', 'Fibo', 'Phân kỳ', 'Đa khung', 'Cắt lỗ', 'Gom hàng']);
searchKeywords('jet_si_chan_kinh.txt', ['Dow', 'Kháng cự', 'Hỗ trợ', 'MA', 'Fibo', 'Phân kỳ', 'Quản lý vốn', 'Entry', 'Dừng lỗ']);
