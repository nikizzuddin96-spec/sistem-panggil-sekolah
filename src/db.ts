import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { CONFIG } from './config';

if (!fs.existsSync(CONFIG.dataDir)) {
  fs.mkdirSync(CONFIG.dataDir, { recursive: true });
}

const db = new Database(path.join(CONFIG.dataDir, 'clinic.db'));
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

export interface CallRecord {
  id: number;
  name: string;
  note: string;
  called_by_id: string;
  called_by_name: string;
  called_at: number;
}

export interface PronunciationOverride {
  name: string;
  replacement: string;
  type: 'sub' | 'ipa';
}

export const DB = {
  // --- Settings ---
  getSetting(key: string, fallback: string): string {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : fallback;
  },

  setSetting(key: string, value: string): void {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  },

  getLang(): 'ms' | 'en' | 'auto' {
    return this.getSetting('lang', CONFIG.defaultLang) as 'ms' | 'en' | 'auto';
  },

  setLang(lang: 'ms' | 'en' | 'auto'): void {
    this.setSetting('lang', lang);
  },

  // --- Saved Kids (Berasingan mengikut Grup Kelas / chat_id) ---
  addKid(userId: string, chatId: string, name: string): boolean {
    try {
      const count = db.prepare('SELECT COUNT(*) as c FROM saved_kids_v2 WHERE user_id = ? AND chat_id = ?').get(userId, chatId) as { c: number };
      if (count.c >= 8) return false; 
      db.prepare('INSERT OR IGNORE INTO saved_kids_v2 (user_id, chat_id, name, created_at) VALUES (?, ?, ?, ?)').run(userId, chatId, name, Date.now());
      return true;
    } catch {
      return false;
    }
  },

  removeKid(userId: string, chatId: string, name: string): boolean {
    const res = db.prepare('DELETE FROM saved_kids_v2 WHERE user_id = ? AND chat_id = ? AND name = ? COLLATE NOCASE').run(userId, chatId, name);
    return res.changes > 0;
  },

  getKids(userId: string, chatId: string): string[] {
    const rows = db.prepare('SELECT name FROM saved_kids_v2 WHERE user_id = ? AND chat_id = ? ORDER BY name ASC').all(userId, chatId) as { name: string }[];
    return rows.map((r) => r.name);
  },

  // --- Banned Users ---
  banUser(userId: string, reason = 'Spam/Abuse'): void {
    db.prepare('INSERT OR REPLACE INTO banned_users (user_id, reason, banned_at) VALUES (?, ?, ?)').run(userId, reason, Date.now());
  },

  unbanUser(userId: string): void {
    db.prepare('DELETE FROM banned_users WHERE user_id = ?').run(userId);
  },

  isBanned(userId: string): boolean {
    const row = db.prepare('SELECT 1 FROM banned_users WHERE user_id = ?').get(userId);
    return !!row;
  },

  getBannedUsers(): { user_id: string; reason: string; banned_at: number }[] {
    return db.prepare('SELECT user_id, reason, banned_at FROM banned_users ORDER BY banned_at DESC').all() as any[];
  },

  // --- Call History & 1-Day Auto Cleanup ---
  logCall(name: string, note: string, calledById: string, calledByName: string): CallRecord {
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

  getRecentHistory(limit = 20): CallRecord[] {
    // Dapatkan waktu tepat jam 12:00:00 AM (tengah malam) hari ini
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    // Hanya tarik nama yang dipanggil HARI INI
    return db.prepare('SELECT * FROM call_history WHERE called_at >= ? ORDER BY called_at DESC LIMIT ?').all(startOfDay, limit) as CallRecord[];
  },

  clearHistory(): void {
    db.prepare('DELETE FROM call_history').run();
  },

  pruneOldHistory(): number {
    // Padam semua memori panggilan dari semalam dan hari-hari sebelumnya
    const startOfDay = new Date().setHours(0, 0, 0, 0);
    const res = db.prepare('DELETE FROM call_history WHERE called_at < ?').run(startOfDay);
    return res.changes;
  },

  // --- TTS Monthly Usage Tracking ---
  getCurrentYearMonth(): string {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  },

  getTtsUsage(yearMonth?: string): { char_count: number; alert_80_sent: number } {
    const targetMonth = yearMonth || this.getCurrentYearMonth();
    db.prepare('INSERT OR IGNORE INTO tts_usage (year_month, char_count, alert_80_sent) VALUES (?, 0, 0)').run(targetMonth);
    return db.prepare('SELECT char_count, alert_80_sent FROM tts_usage WHERE year_month = ?').get(targetMonth) as {
      char_count: number;
      alert_80_sent: number;
    };
  },

  incrementTtsUsage(chars: number): { char_count: number; alert_80_sent: number } {
    const ym = this.getCurrentYearMonth();
    this.getTtsUsage(ym);
    db.prepare('UPDATE tts_usage SET char_count = char_count + ? WHERE year_month = ?').run(chars, ym);
    return this.getTtsUsage(ym);
  },

  mark80AlertSent(): void {
    const ym = this.getCurrentYearMonth();
    db.prepare('UPDATE tts_usage SET alert_80_sent = 1 WHERE year_month = ?').run(ym);
  },

  // --- Pronunciation Overrides ---
  getOverrides(): PronunciationOverride[] {
    return db.prepare('SELECT name, replacement, type FROM pronunciation_overrides ORDER BY name ASC').all() as PronunciationOverride[];
  },

  setOverride(name: string, replacement: string, type: 'sub' | 'ipa' = 'sub'): void {
    db.prepare(
      'INSERT INTO pronunciation_overrides (name, replacement, type) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET replacement = excluded.replacement, type = excluded.type'
    ).run(name.trim(), replacement.trim(), type);
  },

  deleteOverride(name: string): void {
    db.prepare('DELETE FROM pronunciation_overrides WHERE name = ? COLLATE NOCASE').run(name.trim());
  },
};

// Jalankan pembersihan sejarah secara automatik setiap 1 jam (ganti 6 jam sebelum ini)
DB.pruneOldHistory();
setInterval(() => {
  const deleted = DB.pruneOldHistory();
  if (deleted > 0) {
    console.log(`[Privacy] Auto-deleted ${deleted} call history records from previous days.`);
  }
}, 1 * 60 * 60 * 1000);