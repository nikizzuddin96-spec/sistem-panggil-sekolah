import express, { Request, Response, NextFunction } from 'express';
import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { webhookCallback } from 'grammy';
import { CONFIG } from './config';
import { DB } from './db';
import { CallQueue } from './queue';
import { synthesizeAnnouncement, prewarmFixedPhrases } from './tts';
import { initTelegramBot } from './bot';
import { parseCallInput } from './sanitizer';

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

CallQueue.attachWebSocketServer(wss);

app.use(express.json());
app.use('/cache/tts', express.static(CONFIG.cacheDir, { maxAge: '7d' }));
app.use('/public', express.static(path.join(process.cwd(), 'public')));

// --- Public TV Display & History Endpoints ---
app.get(['/', '/display'], (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'display.html'));
});

app.get('/history', (_req, res) => {
  res.json({
    history: DB.getRecentHistory(30),
  });
});

// Internal endpoint used by Display or Admin to synthesize speech on demand
app.post('/tts', async (req, res) => {
  const { name, note } = req.body || {};
  const parsed = parseCallInput(note ? `${name} - ${note}` : String(name || ''));
  if (!parsed.valid) {
    return res.status(400).json({ error: parsed.error });
  }
  const result = await synthesizeAnnouncement(parsed.name, parsed.note);
  res.json(result);
});

// --- Admin Authentication Middleware ---
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const headerPass = req.headers['x-admin-password'] || req.query.password;
  if (headerPass !== CONFIG.adminPassword) {
    return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
  }
  next();
}

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'admin.html'));
});

app.get('/api/admin/status', requireAdmin, (_req, res) => {
  const usage = DB.getTtsUsage();
  res.json({
    month: DB.getCurrentYearMonth(),
    ttsCharCount: usage.char_count,
    ttsMonthlyCap: CONFIG.ttsMonthlyCap,
    ttsPercent: Math.min(100, Math.round((usage.char_count / CONFIG.ttsMonthlyCap) * 1000) / 10),
    ttsEnabled: DB.getSetting('tts_enabled', String(CONFIG.ttsEnabled)) === 'true',
    lang: DB.getLang(),
    allowPlainText: DB.getSetting('allow_plain_text', String(CONFIG.allowPlainTextCall)) === 'true',
    demoMode: isDemoRunning(),
    queueState: CallQueue.getState(),
    overrides: DB.getOverrides(),
    bannedUsers: DB.getBannedUsers(),
  });
});

app.post('/api/admin/call', requireAdmin, (req, res) => {
  const { input } = req.body || {};
  const parsed = parseCallInput(String(input || ''));
  if (!parsed.valid) return res.status(400).json({ error: parsed.error });
  const item = CallQueue.enqueue(parsed.name, parsed.note, 'admin', 'Admin Panel');
  res.json({ ok: true, item });
});

app.post('/api/admin/override', requireAdmin, (req, res) => {
  const { name, replacement, type } = req.body || {};
  if (!name || !replacement) return res.status(400).json({ error: 'Name and replacement required' });
  DB.setOverride(String(name), String(replacement), type === 'ipa' ? 'ipa' : 'sub');
  res.json({ ok: true, overrides: DB.getOverrides() });
});

app.delete('/api/admin/override/:name', requireAdmin, (req, res) => {
  DB.deleteOverride(req.params.name);
  res.json({ ok: true, overrides: DB.getOverrides() });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { lang, ttsEnabled, allowPlainText, action } = req.body || {};
  if (lang && ['ms', 'en', 'auto'].includes(lang)) DB.setLang(lang);
  if (typeof ttsEnabled === 'boolean') DB.setSetting('tts_enabled', String(ttsEnabled));
  if (typeof allowPlainText === 'boolean') DB.setSetting('allow_plain_text', String(allowPlainText));

  if (action === 'pause') CallQueue.pause();
  if (action === 'resume') CallQueue.resume();
  if (action === 'clear') CallQueue.clear();
  if (action === 'toggle_demo') toggleDemoMode();

  res.json({ ok: true });
});

app.delete('/api/admin/ban/:userId', requireAdmin, (req, res) => {
  DB.unbanUser(req.params.userId);
  res.json({ ok: true, bannedUsers: DB.getBannedUsers() });
});

// --- API untuk Telegram Mini App ---
app.get('/miniapp', (_req, res) => {
  res.sendFile(path.join(process.cwd(), 'public', 'miniapp.html'));
});

app.get('/api/miniapp/kids', (req, res) => {
  const { userId, chatId } = req.query;
  if (!userId || !chatId) return res.json({ kids: [] });
  res.json({ kids: DB.getKids(String(userId), String(chatId)) });
});

app.post('/api/miniapp/add', (req, res) => {
  const { userId, chatId, name } = req.body || {};
  const parsed = parseCallInput(String(name || ''));
  if (!parsed.valid) return res.json({ error: parsed.error });
  const ok = DB.addKid(String(userId), String(chatId), parsed.name);
  if (!ok) return res.json({ error: 'Had maksimum 8 orang anak.' });
  res.json({ ok: true });
});

app.post('/api/miniapp/remove', (req, res) => {
  const { userId, chatId, name } = req.body || {};
  DB.removeKid(String(userId), String(chatId), String(name));
  res.json({ ok: true });
});

app.post('/api/miniapp/call', (req, res) => {
  const { userId, name, parentName } = req.body || {};
  
  // Semak halangan spam/rate limit
  const rateCheck = CallQueue.checkRateLimit(String(userId), String(name), false);
  if (!rateCheck.allowed) return res.json({ error: rateCheck.reason });
  
  // Masukkan ke dalam giliran panggilan TV
  CallQueue.enqueue(String(name), '', String(userId), String(parentName || 'Ibu Bapa'));
  res.json({ ok: true });
});

// --- Demo Mode Simulator ---
const DEMO_SAMPLES = [
  { name: 'Aiman', note: 'Bilik 1' },
  { name: 'Nur Aisyah', note: 'Bilik 2' },
  { name: 'Muhammad Rayyan', note: 'Kaunter Farmasi' },
  { name: 'Chloe', note: 'Room 3' },
  { name: 'Harith', note: 'Bilik 1' },
  { name: 'Putri Zara', note: 'Kaunter 2' },
];
let demoTimer: NodeJS.Timeout | null = null;
let demoIndex = 0;

function isDemoRunning(): boolean {
  return demoTimer !== null;
}

function startDemoMode() {
  if (demoTimer) return;
  console.log('🎉 [Demo Mode] Started! Simulating a new child call every 18 seconds...');
  const triggerSample = () => {
    const sample = DEMO_SAMPLES[demoIndex % DEMO_SAMPLES.length];
    demoIndex++;
    CallQueue.enqueue(sample.name, sample.note, 'demo', 'Demo Simulator');
  };
  triggerSample();
  demoTimer = setInterval(triggerSample, 18_000);
}

function stopDemoMode() {
  if (demoTimer) {
    clearInterval(demoTimer);
    demoTimer = null;
    console.log('🛑 [Demo Mode] Stopped.');
  }
}

function toggleDemoMode() {
  if (demoTimer) stopDemoMode();
  else startDemoMode();
}

// --- Startup ---
async function bootstrap() {
  await prewarmFixedPhrases();

  const bot = initTelegramBot();
  if (bot) {
    if (CONFIG.webhookUrl) {
      app.use('/telegram-webhook', webhookCallback(bot, 'express'));
      await bot.api.setWebhook(`${CONFIG.webhookUrl}/telegram-webhook`);
      console.log(`[Telegram] Webhook registered at ${CONFIG.webhookUrl}/telegram-webhook`);
    } else {
      bot.start({
        onStart: (info) => console.log(`[Telegram] Bot @${info.username} running via long polling`),
      });
    }
  }

  if (CONFIG.demoMode) {
    startDemoMode();
  }

  server.listen(CONFIG.port, () => {
    console.log(`========================================================`);
    console.log(`📺 TV Display Page : http://localhost:${CONFIG.port}/display`);
    console.log(`🛠️  Admin Dashboard : http://localhost:${CONFIG.port}/admin`);
    console.log(`========================================================`);
  });
}

bootstrap().catch(console.error);