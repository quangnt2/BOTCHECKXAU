import fs from 'fs';
const content = fs.readFileSync('.agents/extracted_knowledge/bo_gau_extracted.txt', 'utf8');
const lines = content.split('\n').filter(l => l.trim().length > 0);
console.log(`Total non-empty lines: ${lines.length}`);
console.log('--- Sample lines from Bo Gau ---');
for (let i = 0; i < Math.min(60, lines.length); i++) {
  console.log(`[${i}] ${lines[i]}`);
}
