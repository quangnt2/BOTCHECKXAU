import fs from 'fs';
const content = fs.readFileSync('.agents/extracted_knowledge/jet_si_chan_kinh.txt', 'utf8');
const lines = content.split('\n');

for (let i = 0; i < lines.length; i++) {
  const l = lines[i].trim();
  if (l.match(/^BÀI\s+[0-9]+/i) || l.match(/^BÀI\s+(MỘT|HAI|BA|BỐN|NĂM|SÁU|BẢY|TÁM|CHÍN|MƯỜI)/i)) {
    console.log(`[L${i}] ${l}`);
    console.log(lines.slice(i, i + 8).map(x => x.trim()).join(' | '));
    console.log('---');
  }
}
