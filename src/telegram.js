import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

// Bỏ qua lỗi SSL do proxy/antivirus trên máy tính
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

/**
 * Gửi Album ảnh đa khung thời gian (H4, H1, M15) kèm bài phân tích về Telegram
 * @param {Array<{ tf: string, path: string }>} chartImages Danh sách ảnh các khung thời gian
 * @param {string} analysisText Bài phân tích Trading Plan (Scalp & Hold)
 * @param {{ price: string, change: string } | null} priceInfo Giá hiện tại
 * @param {string|number|null} customChatId Tùy chọn chat ID người nhận
 */
export async function sendTelegramMultiReport(chartImages, analysisText, priceInfo = null, customChatId = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = customChatId || process.env.TELEGRAM_CHAT_ID;

  if (!token) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN trong .env');
  if (!chatId) throw new Error('Chưa cấu hình TELEGRAM_CHAT_ID trong .env');

  console.log(`[Telegram] Đang gửi Album biểu đồ đa khung thời gian về Chat ID: ${chatId}...`);

  // 1. Gửi Media Group (Album ảnh gồm H4, H1, M15)
  const formData = new FormData();
  formData.append('chat_id', chatId);

  const captionText = priceInfo
    ? `[XAU/USD] Giá hiện tại: ${priceInfo.price} USD (${priceInfo.change}) | H4 - H1 - M15 - M5 - M1`
    : `[XAU/USD] H4 - H1 - M15 - M5 - M1`;

  const media = [];
  chartImages.forEach((item, index) => {
    const attachName = `photo_${index}`;
    const fileData = fs.readFileSync(item.path);
    const blob = new Blob([fileData], { type: 'image/png' });
    formData.append(attachName, blob, path.basename(item.path));

    media.push({
      type: 'photo',
      media: `attach://${attachName}`,
      caption: index === 0 ? captionText : ''
    });
  });

  formData.append('media', JSON.stringify(media));

  try {
    const albumRes = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
      method: 'POST',
      body: formData
    });
    const albumJson = await albumRes.json();
    if (albumJson.ok) {
      console.log('[Telegram] Đã gửi Album ảnh đa khung thời gian thành công!');
    } else {
      console.warn('[Telegram] Gửi Album ảnh bị lỗi, thử fallback:', albumJson.description);
    }
  } catch (err) {
    console.error('[Telegram] Lỗi khi gửi MediaGroup:', err.message);
  }

  // 2. Gửi Kế hoạch Giao dịch (Scalp + Hold) ngay sau Album ảnh
  console.log('[Telegram] Đang gửi Bảng Kế hoạch Scalp & Hold chi tiết...');
  const msgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: analysisText
    })
  });

  const msgJson = await msgRes.json();
  if (msgJson.ok) {
    console.log('[Telegram] Đã gửi Kế hoạch Giao dịch thành công!');
  } else {
    console.error('[Telegram] Lỗi khi gửi tin nhắn bài phân tích:', msgJson);
  }

  return true;
}

/**
 * Gửi tin nhắn văn bản thông thường về Telegram (hỗ trợ Inline Keyboard Buttons)
 * @param {string} text Nội dung tin nhắn
 * @param {string|number|null} chatId Chat ID người nhận (mặc định lấy từ env)
 * @param {object|null} replyMarkup Tùy chọn bàn phím tương tác inline_keyboard
 */
export async function sendTelegramMessage(text, chatId = null, replyMarkup = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const targetChatIds = (chatId || process.env.TELEGRAM_CHAT_ID || '')
    .toString()
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (!token) throw new Error('Chưa cấu hình TELEGRAM_BOT_TOKEN');
  if (targetChatIds.length === 0) throw new Error('Chưa cấu hình TELEGRAM_CHAT_ID');

  const results = [];
  for (const cid of targetChatIds) {
    try {
      const payload = {
        chat_id: cid,
        text: text
      };
      if (replyMarkup) {
        payload.reply_markup = replyMarkup;
      }

      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      results.push(await res.json());
    } catch (err) {
      console.error(`[Telegram] Lỗi gửi tin nhắn về Chat ID ${cid}:`, err.message);
    }
  }
  return results.length === 1 ? results[0] : results;
}

/**
 * Lắng nghe tin nhắn đến và sự kiện bấm nút từ người dùng qua Telegram Long Polling
 * @param {function({ text: string, chatId: number|string, rawMessage: object }): Promise<void>} onMessageCallback
 * @param {function({ id: string, data: string, chatId: number|string, messageId: number }): Promise<void>} onCallbackQueryCallback
 */
export async function startTelegramListener(onMessageCallback, onCallbackQueryCallback = null) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn('[TelegramListener] Không có token, bỏ qua listener.');
    return;
  }

  let offset = 0;
  // Bỏ qua tin nhắn cũ trước thời điểm bot khởi động để tránh trả lời dồn
  try {
    const initRes = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`);
    const initJson = await initRes.json();
    if (initJson.ok && initJson.result.length > 0) {
      offset = initJson.result[initJson.result.length - 1].update_id + 1;
    }
  } catch (err) {
    console.warn('[TelegramListener] Lỗi lấy offset ban đầu:', err.message);
  }

  console.log(`[TelegramListener] 🎧 Đã kích hoạt lắng nghe tin nhắn & tương tác Telegram (offset: ${offset})...`);

  // Polling loop
  (async () => {
    while (true) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=20`);
        const json = await res.json();
        if (json.ok && Array.isArray(json.result)) {
          for (const item of json.result) {
            offset = item.update_id + 1;

            // Xử lý tin nhắn văn bản thông thường
            if (item.message && item.message.text) {
              const text = item.message.text.trim();
              const chatId = item.message.chat.id;
              await onMessageCallback({ text, chatId, rawMessage: item.message });
            }

            // Xử lý sự kiện bấm nút Inline Button
            if (item.callback_query) {
              const cq = item.callback_query;
              // Báo cho Telegram tắt spinner xoay tròn
              fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callback_query_id: cq.id })
              }).catch(() => {});

              if (onCallbackQueryCallback) {
                await onCallbackQueryCallback({
                  id: cq.id,
                  data: cq.data,
                  chatId: cq.message?.chat?.id,
                  messageId: cq.message?.message_id
                });
              }
            }
          }
        }
      } catch (err) {
        // Chờ 3s nếu có gián đoạn mạng
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  })();
}
