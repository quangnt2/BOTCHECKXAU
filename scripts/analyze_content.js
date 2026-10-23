import fs from 'fs';
import path from 'path';

const outputDir = path.resolve('.agents/extracted_knowledge');

function summarizeText(filename, maxSampleLines = 100) {
  const filePath = path.join(outputDir, filename);
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, 'utf8');
  console.log(`\n================== ${filename} (Total length: ${content.length}) ==================`);
  
  // Find lines that look like headings or key terms
  const lines = content.split('\n');
  const headings = [];
  const keyTerms = new Set();
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    // Check if line looks like a title/heading or topic
    if (line.match(/^(bài|chương|phần|mục|quy tắc|nguyên tắc|lý thuyết|công thức|setup|bước|phase|stage|khái niệm|định nghĩa|tổng kết|chú ý|lưu ý|tại sao|làm sao|chiến lược|phương pháp)/i) ||
        line.match(/^[0-9]+[\.\:\-]/) ||
        (line.toUpperCase() === line && line.length > 5 && line.length < 80)) {
      if (headings.length < 60) {
        headings.push(`Line ${i}: ${line.slice(0, 100)}`);
      }
    }
  }
  
  console.log(`Sample headings (${headings.length}):`);
  headings.slice(0, 35).forEach(h => console.log('  ' + h));
}

summarizeText('jesse_livermore_2.txt');
summarizeText('jet_si_chan_kinh.txt');
