"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.DB = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const config_1 = require("./config");
if (!fs_1.default.existsSync(config_1.CONFIG.dataDir)) {
    fs_1.default.mkdirSync(config_1.CONFIG.dataDir, { recursive: true });
}
const db = new better_sqlite3_1.default(path_1.default.join(config_1.CONFIG.dataDir, 'clinic.db'));
db.pragma('journal_mode = WAL');
// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS saved_kids (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, name COLLATE NOCASE)
  );

  CREATE TABLE IF NOT EXISTS saved_kids_v2 (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id, chat_id, name COLLATE NOCASE)
  );

  CREATE TABLE IF NOT EXISTS call_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    note TEXT DEFAULT '',
    called_by_id TEXT NOT NULL,
    called_by_name TEXT NOT NULL,
    called_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS banned_users (
    user_id TEXT PRIMARY KEY,
    reason TEXT DEFAULT '',
    banned_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tts_usage (
    year_month TEXT PRIMARY KEY,
    char_count INTEGER NOT NULL DEFAULT 0,
    alert_80_sent INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pronunciation_overrides (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    replacement TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'sub'
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);
exports.DB = {
    // --- Settings ---
    getSetting(key, fallback) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        return row ? row.value : fallback;
    },
    setSetting(key, value) {
        db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
    },
    getLang() {
        return this.getSetting('lang', config_1.CONFIG.defaultLang);
    },
    setLang(lang) {
        this.setSetting('lang', lang);
    },
    // --- Saved Kids (Berasingan mengikut Grup Kelas / chat_id) ---
    addKid(userId, chatId, name) {
        try {
            const count = db.prepare('SELECT COUNT(*) as c FROM saved_kids_v2 WHERE user_id = ? AND chat_id = ?').get(userId, chatId);
            if (count.c >= 8)
                return false;
            db.prepare('INSERT OR IGNORE INTO saved_kids_v2 (user_id, chat_id, name, created_at) VALUES (?, ?, ?, ?)').run(userId, chatId, name, Date.now());
            return true;
        }
        catch {
            return false;
        }
    },
    removeKid(userId, chatId, name) {
        const res = db.prepare('DELETE FROM saved_kids_v2 WHERE user_id = ? AND chat_id = ? AND name = ? COLLATE NOCASE').run(userId, chatId, name);
        return res.changes > 0;
    },
    getKids(userId, chatId) {
        const rows = db.prepare('SELECT name FROM saved_kids_v2 WHERE user_id = ? AND chat_id = ? ORDER BY name ASC').all(userId, chatId);
        return rows.map((r) => r.name);
    },
    // --- Banned Users ---
    banUser(userId, reason = 'Spam/Abuse') {
        db.prepare('INSERT OR REPLACE INTO banned_users (user_id, reason, banned_at) VALUES (?, ?, ?)').run(userId, reason, Date.now());
    },
    unbanUser(userId) {
        db.prepare('DELETE FROM banned_users WHERE user_id = ?').run(userId);
    },
    isBanned(userId) {
        const row = db.prepare('SELECT 1 FROM banned_users WHERE user_id = ?').get(userId);
        return !!row;
    },
    getBannedUsers() {
        return db.prepare('SELECT user_id, reason, banned_at FROM banned_users ORDER BY banned_at DESC').all();
    },
    // --- Call History & 1-Day Auto Cleanup ---
    logCall(name, note, calledById, calledByName) {
        const now = Date.now();
        const info = db
            .prepare('INSERT INTO call_history (name, note, called_by_id, called_by_name, called_at) VALUES (?, ?, ?, ?, ?)')
            .run(name, note, calledById, calledByName, now);
        return {
            id: Number(info.lastInsertRowid),
            name,
            note,
            called_by_id: calledById,
            called_by_name: calledByName,
            called_at: now,
        };
    },
    getRecentHistory(limit = 20) {
        // Dapatkan waktu tepat jam 12:00:00 AM (tengah malam) hari ini
        const startOfDay = new Date().setHours(0, 0, 0, 0);
        // Hanya tarik nama yang dipanggil HARI INI
        return db.prepare('SELECT * FROM call_history WHERE called_at >= ? ORDER BY called_at DESC LIMIT ?').all(startOfDay, limit);
    },
    clearHistory() {
        db.prepare('DELETE FROM call_history').run();
    },
    pruneOldHistory() {
        // Padam semua memori panggilan dari semalam dan hari-hari sebelumnya
        const startOfDay = new Date().setHours(0, 0, 0, 0);
        const res = db.prepare('DELETE FROM call_history WHERE called_at < ?').run(startOfDay);
        return res.changes;
    },
    // --- TTS Monthly Usage Tracking ---
    getCurrentYearMonth() {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    },
    getTtsUsage(yearMonth) {
        const targetMonth = yearMonth || this.getCurrentYearMonth();
        db.prepare('INSERT OR IGNORE INTO tts_usage (year_month, char_count, alert_80_sent) VALUES (?, 0, 0)').run(targetMonth);
        return db.prepare('SELECT char_count, alert_80_sent FROM tts_usage WHERE year_month = ?').get(targetMonth);
    },
    incrementTtsUsage(chars) {
        const ym = this.getCurrentYearMonth();
        this.getTtsUsage(ym);
        db.prepare('UPDATE tts_usage SET char_count = char_count + ? WHERE year_month = ?').run(chars, ym);
        return this.getTtsUsage(ym);
    },
    mark80AlertSent() {
        const ym = this.getCurrentYearMonth();
        db.prepare('UPDATE tts_usage SET alert_80_sent = 1 WHERE year_month = ?').run(ym);
    },
    // --- Pronunciation Overrides ---
    getOverrides() {
        return db.prepare('SELECT name, replacement, type FROM pronunciation_overrides ORDER BY name ASC').all();
    },
    setOverride(name, replacement, type = 'sub') {
        db.prepare('INSERT INTO pronunciation_overrides (name, replacement, type) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET replacement = excluded.replacement, type = excluded.type').run(name.trim(), replacement.trim(), type);
    },
    deleteOverride(name) {
        db.prepare('DELETE FROM pronunciation_overrides WHERE name = ? COLLATE NOCASE').run(name.trim());
    },
};
// Jalankan pembersihan sejarah secara automatik setiap 1 jam (ganti 6 jam sebelum ini)
exports.DB.pruneOldHistory();
setInterval(() => {
    const deleted = exports.DB.pruneOldHistory();
    if (deleted > 0) {
        console.log(`[Privacy] Auto-deleted ${deleted} call history records from previous days.`);
    }
}, 1 * 60 * 60 * 1000);
