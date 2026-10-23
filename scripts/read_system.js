import fs from 'fs';
const content = fs.readFileSync('.agents/extracted_knowledge/jet_si_chan_kinh.txt', 'utf8');
const lines = content.split('\n');

console.log(lines.slice(20030, 20120).join('\n'));
