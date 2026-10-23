import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';

const inputDir = path.resolve('.agents/input');
const outputDir = path.resolve('.agents/extracted_knowledge');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// 1. Extract docx text
function extractDocx(fileName) {
  try {
    const filePath = path.join(inputDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.log(`File not found: ${filePath}`);
      return;
    }
    const zip = new AdmZip(filePath);
    const xmlContent = zip.readAsText('word/document.xml');
    
    // Extract w:p paragraphs
    const paragraphs = [];
    const pRegex = /<w:p(?:\s|>).*?<\/w:p>/gs;
    const tRegex = /<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g;
    
    let pMatch;
    while ((pMatch = pRegex.exec(xmlContent)) !== null) {
      const pXml = pMatch[0];
      let pText = '';
      let tMatch;
      while ((tMatch = tRegex.exec(pXml)) !== null) {
        pText += tMatch[1];
      }
      if (pText.trim()) {
        paragraphs.push(pText.trim());
      }
    }
    
    const outTxt = path.join(outputDir, 'bo_gau_extracted.txt');
    fs.writeFileSync(outTxt, paragraphs.join('\n\n'), 'utf8');
    console.log(`[DOCX] Extracted ${paragraphs.length} paragraphs from ${fileName} (${paragraphs.join(' ').length} chars)`);
  } catch (err) {
    console.error(`Error extracting docx ${fileName}:`, err);
  }
}

// Extract the docx file
const files = fs.readdirSync(inputDir);
for (const f of files) {
  if (f.endsWith('.docx') && f.includes('Bò gấu')) {
    console.log(`Found docx: ${f}`);
    extractDocx(f);
  }
}
