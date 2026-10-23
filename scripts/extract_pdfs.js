import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const pdf = require('pdf-parse');

const inputDir = path.resolve('.agents/input');
const outputDir = path.resolve('.agents/extracted_knowledge');

async function extractPdf(filename, outName) {
  try {
    const filePath = path.join(inputDir, filename);
    if (!fs.existsSync(filePath)) {
      console.log(`Not found: ${filePath}`);
      return;
    }
    console.log(`Reading ${filename}...`);
    const dataBuffer = fs.readFileSync(filePath);
    const data = await pdf(dataBuffer);
    const outTxt = path.join(outputDir, outName);
    fs.writeFileSync(outTxt, data.text, 'utf8');
    console.log(`[PDF] Extracted ${data.numpages} pages from ${filename} (${data.text.length} chars) -> ${outName}`);
  } catch (err) {
    console.error(`Error on ${filename}:`, err.message);
  }
}

async function main() {
  await extractPdf('Jesse Livermore - 2.pdf', 'jesse_livermore_2.txt');
  await extractPdf('Jesse Livermore - Trường Đại Học Underground.pdf', 'jesse_livermore_underground.txt');
  await extractPdf('Jét si chân kinh quyển sơ cấp FULL HD (FINAL OF FINAL).pdf', 'jet_si_chan_kinh.txt');
}

main();
