"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CallQueue = void 0;
const ws_1 = require("ws");
const config_1 = require("./config");
const db_1 = require("./db");
const tts_1 = require("./tts");
class CallQueueManager {
    queue = [];
    currentCall = null;
    isPaused = false;
    isProcessing = false;
    wss = null;
    // Anti-spam maps
    userLastCallMap = new Map(); // userId -> timestamp
    nameLastCallMap = new Map(); // lowercaseName -> timestamp
    attachWebSocketServer(wss) {
        this.wss = wss;
        this.wss.on('connection', (ws) => {
            this.sendStateToClient(ws);
        });
    }
    checkRateLimit(userId, name, isAdmin = false) {
        const now = Date.now();
        // 1. Check duplicate name within 30 seconds
        const nameKey = name.toLowerCase();
        const lastSameName = this.nameLastCallMap.get(nameKey) || 0;
        if (now - lastSameName < 30_000) {
            const waitSec = Math.ceil((30_000 - (now - lastSameName)) / 1000);
            return { allowed: false, reason: `"${name}" was just called. Please wait ${waitSec}s before calling the same name again.` };
        }
        // 2. Check per-user rate limit (1 call per 20 seconds, bypassed for admins/demo)
        if (!isAdmin) {
            const lastUserCall = this.userLastCallMap.get(userId) || 0;
            if (now - lastUserCall < 20_000) {
                const waitSec = Math.ceil((20_000 - (now - lastUserCall)) / 1000);
                return { allowed: false, reason: `Please wait ${waitSec}s before making another call.` };
            }
        }
        this.userLastCallMap.set(userId, now);
        this.nameLastCallMap.set(nameKey, now);
        return { allowed: true };
    }
    enqueue(name, note, calledById, calledByName) {
        const record = db_1.DB.logCall(name, note, calledById, calledByName);
        const item = {
            id: record.id,
            name: record.name,
            note: record.note,
            calledBy: record.called_by_name,
            calledAt: record.called_at,
        };
        this.queue.push(item);
        this.broadcastState();
        this.processNext();
        return item;
    }
    pause() {
        this.isPaused = true;
        this.broadcastState();
    }
    resume() {
        this.isPaused = false;
        this.broadcastState();
        this.processNext();
    }
    clear() {
        this.queue = [];
        this.currentCall = null;
        this.broadcastState();
    }
    getState() {
        return {
            type: 'STATE_UPDATE',
            clinicName: config_1.CONFIG.clinicName,
            logoUrl: config_1.CONFIG.logoUrl,
            isPaused: this.isPaused,
            current: this.currentCall,
            upcoming: this.queue.map((q) => ({ id: q.id, name: q.name, note: q.note })),
            // Tukar angka 6 kepada 20 supaya ia memaparkan 20 nama terakhir
            recent: db_1.DB.getRecentHistory(20).map((h) => ({
                id: h.id,
                name: h.name,
                note: h.note,
                calledAt: h.called_at,
            })),
            audioSettings: {
                repeatCount: config_1.CONFIG.repeatCount,
                repeatGapSeconds: config_1.CONFIG.repeatGapSeconds,
                chimeVolume: config_1.CONFIG.chimeVolume,
                speechRate: config_1.CONFIG.speechRate,
            },
        };
    }
    broadcastState() {
        if (!this.wss)
            return;
        const payload = JSON.stringify(this.getState());
        for (const client of this.wss.clients) {
            if (client.readyState === ws_1.WebSocket.OPEN) {
                client.send(payload);
            }
        }
    }
    sendStateToClient(ws) {
        if (ws.readyState === ws_1.WebSocket.OPEN) {
            ws.send(JSON.stringify(this.getState()));
        }
    }
    async processNext() {
        if (this.isProcessing || this.isPaused)
            return;
        const nextItem = this.queue.shift();
        if (!nextItem) {
            if (this.currentCall !== null) {
                this.currentCall = null;
                this.broadcastState();
            }
            return;
        }
        this.isProcessing = true;
        try {
            // Synthesize or retrieve cached MP3 before displaying
            nextItem.tts = await (0, tts_1.synthesizeAnnouncement)(nextItem.name, nextItem.note);
            this.currentCall = nextItem;
            this.broadcastState();
            // Keep on screen for DISPLAY_SECONDS_PER_NAME (default 10s so 2 repeats + 3s gap finish comfortably)
            await new Promise((resolve) => setTimeout(resolve, config_1.CONFIG.displaySeconds * 1000));
        }
        catch (err) {
            console.error('[Queue] Error processing call:', err);
        }
        finally {
            this.isProcessing = false;
            if (this.queue.length > 0 && !this.isPaused) {
                this.processNext();
            }
            else {
                this.currentCall = null;
                this.broadcastState();
            }
        }
    }
}
exports.CallQueue = new CallQueueManager();
