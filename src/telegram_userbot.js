/**
 * TELEGRAM USERBOT LISTENER (GramJS)
 * Tự động lắng nghe tin nhắn từ các nhóm VIP kín mà người dùng đang tham gia
 * Bóc tách tín hiệu và tự động đẩy lệnh sang MT5 mà không cần người dùng can thiệp
 */

import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import { NewMessage } from 'telegram/events/index.js';
import input from 'input';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { parseTelegramSignal } from './telegram_signal_parser.js';
import { interpretChannelMessageWithAI } from './ai_message_interpreter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sessionFilePath = path.join(__dirname, '..', 'data', 'telegram_user.session');

/**
 * Khởi động Userbot lắng nghe tự động từ kênh Telegram
 * @param {Object} options
 * @param {number} options.apiId
 * @param {string} options.apiHash
 * @param {string|string[]} options.targetChannels Danh sách tên hoặc ID nhóm/kênh cần nghe (ví dụ: 'nhom_keo_vip')
 * @param {function(Object): Promise<any>} options.onSignalDetected Hàm xử lý khi bắt được tín hiệu vào lệnh mới
 * @param {function(Object): Promise<any>} [options.onAdminInstruction] Hàm xử lý khi AI nhận diện hành động quản lý lệnh từ Admin
 * @param {function(): Object} [options.getTradingState] Hàm lấy trạng thái lệnh đang chờ / vị thế mở
 * @param {function(string): void} [options.logger]
 */
export async function startTelegramUserbot({
  apiId,
  apiHash,
  targetChannels = [],
  onSignalDetected,
  onAdminInstruction,
  getTradingState,
  logger = console.log
}) {
  if (!apiId || !apiHash) {
    logger('[TelegramUserbot] ℹ️ Chưa cấu hình TELEGRAM_API_ID hoặc TELEGRAM_API_HASH. Bỏ qua Userbot.');
    return null;
  }

  // Đảm bảo thư mục data tồn tại để lưu session
  const dataDir = path.dirname(sessionFilePath);
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // Đọc session string đã lưu (để không phải đăng nhập lại ở các lần sau)
  let savedSession = '';
  if (fs.existsSync(sessionFilePath)) {
    try {
      savedSession = fs.readFileSync(sessionFilePath, 'utf8').trim();
    } catch {}
  }

  if (!savedSession) {
    logger('[TelegramUserbot] ⚠️ Chưa có phiên đăng nhập (chưa tạo file session).');
    logger('[TelegramUserbot] 👉 Vui lòng mở terminal chạy: npm run auth:telegram để xác thực Telegram lần đầu tiên.');
    return null;
  }

  const stringSession = new StringSession(savedSession);
  const client = new TelegramClient(stringSession, Number(apiId), String(apiHash), {
    connectionRetries: 5
  });

  logger('[TelegramUserbot] 🔄 Đang kết nối tới Telegram bằng tài khoản cá nhân...');

  try {
    await client.connect();

    if (!await client.checkAuthorization()) {
      logger('[TelegramUserbot] ⚠️ Phiên đăng nhập đã hết hạn hoặc không hợp lệ.');
      logger('[TelegramUserbot] 👉 Vui lòng chạy lại: npm run auth:telegram');
      return null;
    }

    const me = await client.getMe();
    logger(`[TelegramUserbot] 🟢 ĐĂNG NHẬP THÀNH CÔNG! Đang chạy dưới tên: ${me.firstName} (@${me.username || me.id})`);
    logger(`[TelegramUserbot] 🎧 Bắt đầu chế độ TÀNG HÌNH: Tự động lắng nghe tin nhắn bắn kèo 24/7...`);

    // Chuẩn hóa danh sách kênh mục tiêu
    const targets = (Array.isArray(targetChannels) ? targetChannels : [targetChannels])
      .map(s => String(s || '').trim().toLowerCase().replace(/^@/, ''))
      .filter(Boolean);

    // Lắng nghe tin nhắn mới từ Telegram
    client.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || !message.text) return;

        const text = message.text;
        const chat = await message.getChat();
        const chatTitle = chat?.title || chat?.username || String(chat?.id || '');
        const chatUsername = (chat?.username || '').toLowerCase();
        const chatIdStr = String(chat?.id || '');

        // Nếu có chỉ định nhóm cụ thể, kiểm tra xem tin nhắn có đến từ nhóm đó không
        if (targets.length > 0) {
          const matchTarget = targets.some(t => 
            chatUsername.includes(t) || 
            (chat?.title && chat.title.toLowerCase().includes(t)) ||
            chatIdStr.includes(t)
          );
          if (!matchTarget) {
            return; // Bỏ qua tin nhắn từ các nhóm bạn bè/gia đình khác
          }
        }

        // 1. Kiểm tra xem tin nhắn có cấu trúc tín hiệu giao dịch mới không (Regex siêu tốc)
        const parsed = parseTelegramSignal(text);
        if (parsed) {
          logger(`\n[TelegramUserbot] 🚨 PHÁT HIỆN TÍN HIỆU TỪ NHÓM [${chatTitle}]!`);
          logger(`• Lệnh: ${parsed.action} ${parsed.symbol} | Entry: ${parsed.entry} (Vùng: ${parsed.entryMin || ''}-${parsed.entryMax || ''})`);
          logger(`• SL: ${parsed.sl} | TP1: ${parsed.tp1 || parsed.tp} | TP2: ${parsed.tp2 || '-'} | TP3: ${parsed.tp3 || '-'}`);

          if (onSignalDetected) {
            await onSignalDetected({
              signal: parsed,
              sourceChat: chatTitle,
              rawText: text
            });
          }
          return;
        }

        // 2. Nếu không phải cú pháp vào lệnh chuẩn, đẩy vào Gemini AI để nhận diện hành động Admin (Hủy kèo, dời SL hòa vốn, cắt tay...)
        if (onAdminInstruction) {
          const tradingState = getTradingState ? getTradingState() : {};
          const aiResult = await interpretChannelMessageWithAI({
            text,
            sourceChat: chatTitle,
            pendingOrders: tradingState.pendingOrders || [],
            openPositions: tradingState.openPositions || [],
            logger
          });

          if (aiResult && aiResult.action && aiResult.action !== 'NO_ACTION' && (aiResult.confidence || 0) >= 70) {
            logger(`\n[TelegramUserbot 🤖 AI] Nhận diện hành động từ Admin [${chatTitle}]: ${aiResult.action} (Độ tin cậy: ${aiResult.confidence}%)`);
            logger(`• Lý do AI: ${aiResult.reason}`);

            await onAdminInstruction({
              aiResult,
              sourceChat: chatTitle,
              rawText: text
            });
          }
        }
      } catch (err) {
        logger(`[TelegramUserbot] Lỗi xử lý tin nhắn: ${err.message}`);
      }
    }, new NewMessage({}));

    return client;
  } catch (err) {
    logger(`[TelegramUserbot] ❌ Không thể khởi động Userbot: ${err.message}`);
    return null;
  }
}
