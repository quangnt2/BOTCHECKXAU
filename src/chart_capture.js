import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Chụp ảnh biểu đồ đa khung thời gian (Multi-Timeframe Capture)
 * @param {string} symbol Ví dụ: "OANDA:XAUUSD"
 * @param {string[]} timeframes Danh sách khung: ['240', '60', '15'] (H4, H1, M15)
 * @returns {Promise<Array<{ tf: string, path: string }>>}
 */
export async function captureMultiTimeframeCharts(symbol = 'OANDA:XAUUSD', timeframes = ['240', '60', '15']) {
  const screenshotsDir = path.join(__dirname, '..', 'screenshots');
  if (!fs.existsSync(screenshotsDir)) {
    fs.mkdirSync(screenshotsDir, { recursive: true });
  } else {
    // Tự động dọn dẹp ảnh cũ theo ngày: Xóa tất cả ảnh đã chụp quá 24 giờ (1 ngày)
    try {
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();
      const files = fs.readdirSync(screenshotsDir).filter(f => f.endsWith('.png'));
      let deletedImages = 0;
      files.forEach(f => {
        try {
          const filePath = path.join(screenshotsDir, f);
          const stat = fs.statSync(filePath);
          if (now - stat.mtimeMs > ONE_DAY_MS) {
            fs.unlinkSync(filePath);
            deletedImages++;
          }
        } catch {}
      });
      if (deletedImages > 0) {
        console.log(`[Cleaner] Đã xóa ${deletedImages} ảnh biểu đồ cũ hơn 24 giờ.`);
      }
    } catch {}
  }

  const htmlPath = path.resolve(__dirname, 'chart_template.html');
  const timestamp = Date.now();

  console.log(`[MultiCapture] Khởi động trình duyệt chụp đa khung thời gian: ${timeframes.join(', ')}...`);
  
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--window-size=1920,1080'
    ]
  });

  const results = [];

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 2 });

    for (const tf of timeframes) {
      const tfLabel = tf === '240' ? 'H4' : tf === '60' ? 'H1' : tf === '15' ? 'M15' : tf === '5' ? 'M5' : tf === '1' ? 'M1' : tf;
      const fileUrl = `file://${htmlPath.replace(/\\/g, '/')}?symbol=${encodeURIComponent(symbol)}&interval=${tf}`;
      const outputPath = path.join(screenshotsDir, `xauusd_${tfLabel}_${timestamp}.png`);

      console.log(`[MultiCapture] Đang tải & chụp khung ${tfLabel}...`);
      await page.goto(fileUrl, { waitUntil: 'networkidle2', timeout: 45000 });
      await page.waitForSelector('iframe', { timeout: 30000 });
      
      // Chờ TradingView load nến và vẽ chỉ báo
      await new Promise(r => setTimeout(r, 6500));

      await page.screenshot({ path: outputPath, type: 'png' });
      console.log(`[MultiCapture] Đã chụp xong khung ${tfLabel} -> ${path.basename(outputPath)}`);

      results.push({ tf: tfLabel, path: outputPath });
    }

    return results;
  } finally {
    await browser.close();
  }
}
