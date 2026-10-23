import fs from 'fs';
import path from 'path';

const content = fs.readFileSync('.agents/extracted_knowledge/jesse_livermore_2.txt', 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  const l = lines[i];
  if (l.match(/bài\s*[0-9]+/i) || l.includes('Hệ thống giao dịch') || l.includes('MA 34') || l.includes('EMA') || l.includes('chu kỳ')) {
    console.log(`[L${i}] ${l}`);
    console.log(lines.slice(i, i + 15).join('\n'));
    console.log('-------------------------------------------');
  }
}
