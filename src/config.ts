import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
  clinicName: process.env.CLINIC_NAME || 'Children Waiting Hall',
  logoUrl: process.env.LOGO_URL || '',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  demoMode: process.env.DEMO_MODE === 'true',

  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
  allowedChatIds: (process.env.ALLOWED_CHAT_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  allowPlainTextCall: process.env.ALLOW_PLAIN_TEXT_CALL === 'true',
  webhookUrl: process.env.WEBHOOK_URL || '',

  defaultLang: (process.env.DEFAULT_LANG || 'ms') as 'ms' | 'en' | 'auto',
  displaySeconds: parseInt(process.env.DISPLAY_SECONDS_PER_NAME || '10', 10),
  repeatCount: parseInt(process.env.REPEAT_COUNT || '2', 10),
  repeatGapSeconds: parseInt(process.env.REPEAT_GAP_SECONDS || '3', 10),
  chimeVolume: parseFloat(process.env.CHIME_VOLUME || '0.8'),
  speechRate: parseFloat(process.env.SPEECH_RATE || '0.95'),

  ttsEnabled: process.env.TTS_ENABLED !== 'false',
  googleCredentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS || '',
  googleApiKey: process.env.GOOGLE_TTS_API_KEY || '',
  ttsVoiceMs: process.env.TTS_VOICE_MS || 'ms-MY-Wavenet-A',
  ttsVoiceEn: process.env.TTS_VOICE_EN || 'en-GB-Wavenet-A',
  ttsMonthlyCap: parseInt(process.env.TTS_MONTHLY_CHAR_CAP || '800000', 10),

  dataDir: path.join(process.cwd(), 'data'),
  cacheDir: path.join(process.cwd(), 'cache', 'tts'),
};