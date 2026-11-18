import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.join(__dirname, '..', 'data');
const alertsFile = path.join(dataDir, 'price_alerts.json');

// Đảm bảo thư mục data tồn tại
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export class PriceAlertManager {
  /**
   * @param {Object} options
   * @param {function(string): void} options.logger
   * @param {function(string): Promise<void>} options.sendTelegramAlert
   */
  constructor({ logger = console.log, sendTelegramAlert = null } = {}) {
    this.logger = logger;
    this.sendTelegramAlert = sendTelegramAlert;
    this.alerts = this.loadAlerts();
    this.lastTriggeredTime = new Map();
  }

  loadAlerts() {
    try {
      if (!fs.existsSync(alertsFile)) {
        return [];
      }
      const raw = fs.readFileSync(alertsFile, 'utf8');
      const list = JSON.parse(raw);
      return Array.isArray(list) ? list : [];
    } catch (err) {
      this.logger(`[PriceAlertManager] ⚠️ Lỗi đọc file alerts: ${err.message}`);
      return [];
    }
  }

  saveAlerts() {
    try {
      fs.writeFileSync(alertsFile, JSON.stringify(this.alerts, null, 2), 'utf8');
    } catch (err) {
      this.logger(`[PriceAlertManager] ⚠️ Lỗi lưu file alerts: ${err.message}`);
    }
  }

  getAlerts() {
    return this.alerts;
  }

  addAlert({ targetPrice, condition = 'GTE', note = '' }) {
    const priceNum = Number(targetPrice);
    if (!priceNum || priceNum <= 0) {
      throw new Error('Giá mục tiêu không hợp lệ');
    }

    const cond = condition.toUpperCase() === 'LTE' ? 'LTE' : 'GTE';
    const newAlert = {
      id: `alt_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
      targetPrice: Number(priceNum.toFixed(2)),
      condition: cond,
      note: String(note || '').trim(),
      active: true,
      triggered: false,
      triggeredAt: null,
      createdAt: new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })
    };

    this.alerts.unshift(newAlert);
    this.saveAlerts();
    this.logger(`[PriceAlertManager] 🔔 Đã thêm cảnh báo giá: XAUUSD ${cond === 'GTE' ? '≥' : '≤'} ${newAlert.targetPrice} (${newAlert.note || 'Không ghi chú'})`);
    return newAlert;
  }

  removeAlert(id) {
    const idx = this.alerts.findIndex(a => a.id === id);
    if (idx !== -1) {
      const removed = this.alerts.splice(idx, 1)[0];
      this.saveAlerts();
      this.logger(`[PriceAlertManager] 🗑️ Đã xóa cảnh báo giá #${id}`);
      return removed;
    }
    return null;
  }

  toggleAlert(id, activeState = null) {
    const alert = this.alerts.find(a => a.id === id);
    if (alert) {
      alert.active = activeState !== null ? Boolean(activeState) : !alert.active;
      this.saveAlerts();
      return alert;
    }
    return null;
  }

  resetAlert(id) {
    const alert = this.alerts.find(a => a.id === id);
    if (alert) {
      alert.triggered = false;
      alert.triggeredAt = null;
      alert.active = true;
      this.saveAlerts();
      this.logger(`[PriceAlertManager] 🔄 Đã kích hoạt lại cảnh báo #${id}`);
      return alert;
    }
    return null;
  }

  /**
   * Kiểm tra giá thị trường so với danh sách cảnh báo
   * @param {number} currentPrice Giá vàng hiện tại
   * @param {function(string): Promise<void>|null} customSender Hàm gửi tin nhắn Telegram tùy biến
   */
  async checkPrice(currentPrice, customSender = null) {
    const price = Number(currentPrice);
    if (!price || price <= 0) return [];

    const triggeredList = [];
    const sender = customSender || this.sendTelegramAlert;

    for (const alert of this.alerts) {
      if (!alert.active || alert.triggered) continue;

      let isHit = false;
      if (alert.condition === 'GTE' && price >= alert.targetPrice) {
        isHit = true;
      } else if (alert.condition === 'LTE' && price <= alert.targetPrice) {
        isHit = true;
      }

      if (isHit) {
        alert.triggered = true;
        alert.triggeredAt = new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        triggeredList.push(alert);

        const condSymbol = alert.condition === 'GTE' ? '≥ (Vượt lên)' : '≤ (Rơi xuống)';
        const msg = [
          `🔔 [CẢNH BÁO GIÁ XAUUSD ĐÃ CHẠM]`,
          `• Giá thị trường hiện tại: ${price.toFixed(2)} USD`,
          `• Mốc cảnh báo: ${condSymbol} ${alert.targetPrice.toFixed(2)} USD`,
          `• Ghi chú: ${alert.note || 'Không có ghi chú'}`,
          `• Thời gian: ${alert.triggeredAt}`,
          `👉 Kiểm tra biểu đồ và quyết định kế hoạch giao dịch!`
        ].join('\n');

        this.logger(`[PriceAlertManager] 🚨 CẢNH BÁO GIÁ KÍCH HOẠT: Giá ${price} chạm mốc ${alert.targetPrice} (${alert.condition})!`);

        if (typeof sender === 'function') {
          try {
            await sender(msg);
          } catch (err) {
            this.logger(`[PriceAlertManager] ⚠️ Gửi Telegram cảnh báo thất bại: ${err.message}`);
          }
        }
      }
    }

    if (triggeredList.length > 0) {
      this.saveAlerts();
    }

    return triggeredList;
  }
}

