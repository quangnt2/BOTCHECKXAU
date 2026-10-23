import fs from 'fs';
import path from 'path';

const outputDir = path.resolve('.agents/extracted_knowledge');

function inspectSection(filename, startKeyword, numLines = 80) {
  const filePath = path.join(outputDir, filename);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(startKeyword)) {
      console.log(`\n=== Found "${startKeyword}" at Line ${i} in ${filename} ===`);
      console.log(lines.slice(i, i + numLines).join('\n'));
      break;
    }
  }
}

inspectSection('jesse_livermore_2.txt', '2. ĐƯỜNG TRUNG BÌNH MA', 60);
inspectSection('jesse_livermore_2.txt', '5. HỆ THỐNG GIAO DỊCH THEO 2 ĐƯỜNG MA', 60);
inspectSection('jesse_livermore_2.txt', '6. CÁC NHẬN BIẾT CÁ GOM HÀNG', 50);
