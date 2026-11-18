import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import input from 'input';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sessionFilePath = path.join(__dirname, '..', 'data', 'telegram_user.session');

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error('❌ Chưa có TELEGRAM_API_ID hoặc TELEGRAM_API_HASH trong file .env!');
  process.exit(1);
}

const dataDir = path.dirname(sessionFilePath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

let savedSession = '';
if (fs.existsSync(sessionFilePath)) {
  savedSession = fs.readFileSync(sessionFilePath, 'utf8').trim();
}

const stringSession = new StringSession(savedSession);
const client = new TelegramClient(stringSession, apiId, apiHash, {
  connectionRetries: 5
});

console.log('========================================================');
console.log('🚀 ĐĂNG NHẬP TELEGRAM USERBOT (CHỈ LÀM 1 LẦN DUY NHẤT)');
console.log('========================================================\n');

await client.start({
  phoneNumber: async () => {
    const raw = await input.text('📱 Nhập số điện thoại Telegram của bạn: ');
    let phone = raw.trim().replace(/[\s\-\(\)]+/g, '');
    // Tự động chuẩn hóa số điện thoại Việt Nam sang định dạng quốc tế Telegram yêu cầu (+84...)
    if (phone.startsWith('0')) {
      phone = '+84' + phone.substring(1);
    } else if (phone.startsWith('84') && !phone.startsWith('+84')) {
      phone = '+' + phone;
    } else if (!phone.startsWith('+')) {
      phone = '+84' + phone;
    }
    console.log(`➡️ Định dạng số chuẩn gửi Telegram: ${phone}`);
    return phone;
  },
  password: async () => await input.text('🔑 Nhập mật khẩu 2FA (nếu có, không thì cứ nhấn Enter): '),
  phoneCode: async () => await input.text('💬 Nhập mã xác nhận (Code) Telegram vừa gửi về App: '),
  onError: (err) => console.error('Lỗi đăng nhập:', err)
});

const newSession = client.session.save();
fs.writeFileSync(sessionFilePath, newSession, 'utf8');

const me = await client.getMe();
console.log('\n========================================================');
console.log(`🎉 ĐĂNG NHẬP THÀNH CÔNG!`);
console.log(`• Tên tài khoản: ${me.firstName} ${me.lastName || ''} (@${me.username || me.id})`);
console.log(`• Đã lưu phiên đăng nhập vĩnh viễn tại: ${sessionFilePath}`);
console.log('• Từ bây giờ, bot sẽ tự động đọc tin nhắn từ nhóm mà không cần hỏi lại mã!');
console.log('========================================================\n');

await client.disconnect();
process.exit(0);
