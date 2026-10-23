import fs from 'fs';
const content = fs.readFileSync('.agents/extracted_knowledge/bo_gau_extracted.txt', 'utf8');
const lines = content.split('\n').filter(l => l.trim().length > 0);
for (let i = 60; i < Math.min(180, lines.length); i++) {
  console.log(`[${i}] ${lines[i]}`);
}
