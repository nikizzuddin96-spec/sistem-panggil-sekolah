"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const path_1 = __importDefault(require("path"));
const ws_1 = require("ws");
const grammy_1 = require("grammy");
const config_1 = require("./config");
const db_1 = require("./db");
const queue_1 = require("./queue");
const tts_1 = require("./tts");
const bot_1 = require("./bot");
const sanitizer_1 = require("./sanitizer");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server, path: '/ws' });
queue_1.CallQueue.attachWebSocketServer(wss);
app.use(express_1.default.json());
app.use('/cache/tts', express_1.default.static(config_1.CONFIG.cacheDir, { maxAge: '7d' }));
app.use('/public', express_1.default.static(path_1.default.join(process.cwd(), 'public')));
// --- Public TV Display & History Endpoints ---
app.get(['/', '/display'], (_req, res) => {
    res.sendFile(path_1.default.join(process.cwd(), 'public', 'display.html'));
});
app.get('/history', (_req, res) => {
    res.json({
        history: db_1.DB.getRecentHistory(30),
    });
});
// Internal endpoint used by Display or Admin to synthesize speech on demand
app.post('/tts', async (req, res) => {
    const { name, note } = req.body || {};
    const parsed = (0, sanitizer_1.parseCallInput)(note ? `${name} - ${note}` : String(name || ''));
    if (!parsed.valid) {
        return res.status(400).json({ error: parsed.error });
    }
    const result = await (0, tts_1.synthesizeAnnouncement)(parsed.name, parsed.note);
    res.json(result);
});
// --- Admin Authentication Middleware ---
function requireAdmin(req, res, next) {
    const headerPass = req.headers['x-admin-password'] || req.query.password;
    if (headerPass !== config_1.CONFIG.adminPassword) {
        return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
    }
    next();
}
app.get('/admin', (_req, res) => {
    res.sendFile(path_1.default.join(process.cwd(), 'public', 'admin.html'));
});
app.get('/api/admin/status', requireAdmin, (_req, res) => {
    const usage = db_1.DB.getTtsUsage();
    res.json({
        month: db_1.DB.getCurrentYearMonth(),
        ttsCharCount: usage.char_count,
        ttsMonthlyCap: config_1.CONFIG.ttsMonthlyCap,
        ttsPercent: Math.min(100, Math.round((usage.char_count / config_1.CONFIG.ttsMonthlyCap) * 1000) / 10),
        ttsEnabled: db_1.DB.getSetting('tts_enabled', String(config_1.CONFIG.ttsEnabled)) === 'true',
        lang: db_1.DB.getLang(),
        allowPlainText: db_1.DB.getSetting('allow_plain_text', String(config_1.CONFIG.allowPlainTextCall)) === 'true',
        demoMode: isDemoRunning(),
        queueState: queue_1.CallQueue.getState(),
        overrides: db_1.DB.getOverrides(),
        bannedUsers: db_1.DB.getBannedUsers(),
    });
});
app.post('/api/admin/call', requireAdmin, (req, res) => {
    const { input } = req.body || {};
    const parsed = (0, sanitizer_1.parseCallInput)(String(input || ''));
    if (!parsed.valid)
        return res.status(400).json({ error: parsed.error });
    const item = queue_1.CallQueue.enqueue(parsed.name, parsed.note, 'admin', 'Admin Panel');
    res.json({ ok: true, item });
});
app.post('/api/admin/override', requireAdmin, (req, res) => {
    const { name, replacement, type } = req.body || {};
    if (!name || !replacement)
        return res.status(400).json({ error: 'Name and replacement required' });
    db_1.DB.setOverride(String(name), String(replacement), type === 'ipa' ? 'ipa' : 'sub');
    res.json({ ok: true, overrides: db_1.DB.getOverrides() });
});
app.delete('/api/admin/override/:name', requireAdmin, (req, res) => {
    db_1.DB.deleteOverride(req.params.name);
    res.json({ ok: true, overrides: db_1.DB.getOverrides() });
});
app.post('/api/admin/settings', requireAdmin, (req, res) => {
    const { lang, ttsEnabled, allowPlainText, action } = req.body || {};
    if (lang && ['ms', 'en', 'auto'].includes(lang))
        db_1.DB.setLang(lang);
    if (typeof ttsEnabled === 'boolean')
        db_1.DB.setSetting('tts_enabled', String(ttsEnabled));
    if (typeof allowPlainText === 'boolean')
        db_1.DB.setSetting('allow_plain_text', String(allowPlainText));
    if (action === 'pause')
        queue_1.CallQueue.pause();
    if (action === 'resume')
        queue_1.CallQueue.resume();
    if (action === 'clear')
        queue_1.CallQueue.clear();
    if (action === 'toggle_demo')
        toggleDemoMode();
    res.json({ ok: true });
});
app.delete('/api/admin/ban/:userId', requireAdmin, (req, res) => {
    db_1.DB.unbanUser(req.params.userId);
    res.json({ ok: true, bannedUsers: db_1.DB.getBannedUsers() });
});
// --- API untuk Telegram Mini App ---
app.get('/miniapp', (_req, res) => {
    res.sendFile(path_1.default.join(process.cwd(), 'public', 'miniapp.html'));
});
app.get('/api/miniapp/kids', (req, res) => {
    const { userId, chatId } = req.query;
    if (!userId || !chatId)
        return res.json({ kids: [] });
    res.json({ kids: db_1.DB.getKids(String(userId), String(chatId)) });
});
app.post('/api/miniapp/add', (req, res) => {
    const { userId, chatId, name } = req.body || {};
    const parsed = (0, sanitizer_1.parseCallInput)(String(name || ''));
    if (!parsed.valid)
        return res.json({ error: parsed.error });
    const ok = db_1.DB.addKid(String(userId), String(chatId), parsed.name);
    if (!ok)
        return res.json({ error: 'Had maksimum 8 orang anak.' });
    res.json({ ok: true });
});
app.post('/api/miniapp/remove', (req, res) => {
    const { userId, chatId, name } = req.body || {};
    db_1.DB.removeKid(String(userId), String(chatId), String(name));
    res.json({ ok: true });
});
app.post('/api/miniapp/call', (req, res) => {
    const { userId, name, parentName } = req.body || {};
    // Semak halangan spam/rate limit
    const rateCheck = queue_1.CallQueue.checkRateLimit(String(userId), String(name), false);
    if (!rateCheck.allowed)
        return res.json({ error: rateCheck.reason });
    // Masukkan ke dalam giliran panggilan TV
    queue_1.CallQueue.enqueue(String(name), '', String(userId), String(parentName || 'Ibu Bapa'));
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
let demoTimer = null;
let demoIndex = 0;
function isDemoRunning() {
    return demoTimer !== null;
}
function startDemoMode() {
    if (demoTimer)
        return;
    console.log('🎉 [Demo Mode] Started! Simulating a new child call every 18 seconds...');
    const triggerSample = () => {
        const sample = DEMO_SAMPLES[demoIndex % DEMO_SAMPLES.length];
        demoIndex++;
        queue_1.CallQueue.enqueue(sample.name, sample.note, 'demo', 'Demo Simulator');
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
    if (demoTimer)
        stopDemoMode();
    else
        startDemoMode();
}
// --- Startup ---
async function bootstrap() {
    await (0, tts_1.prewarmFixedPhrases)();
    const bot = (0, bot_1.initTelegramBot)();
    if (bot) {
        if (config_1.CONFIG.webhookUrl) {
            app.use('/telegram-webhook', (0, grammy_1.webhookCallback)(bot, 'express'));
            await bot.api.setWebhook(`${config_1.CONFIG.webhookUrl}/telegram-webhook`);
            console.log(`[Telegram] Webhook registered at ${config_1.CONFIG.webhookUrl}/telegram-webhook`);
        }
        else {
            bot.start({
                onStart: (info) => console.log(`[Telegram] Bot @${info.username} running via long polling`),
            });
        }
    }
    if (config_1.CONFIG.demoMode) {
        startDemoMode();
    }
    server.listen(config_1.CONFIG.port, () => {
        console.log(`========================================================`);
        console.log(`📺 TV Display Page : http://localhost:${config_1.CONFIG.port}/display`);
        console.log(`🛠️  Admin Dashboard : http://localhost:${config_1.CONFIG.port}/admin`);
        console.log(`========================================================`);
    });
}
bootstrap().catch(console.error);
