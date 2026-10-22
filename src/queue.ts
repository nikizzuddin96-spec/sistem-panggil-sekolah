import { WebSocket, WebSocketServer } from 'ws';
import { CONFIG } from './config';
import { DB } from './db';
import { synthesizeAnnouncement, TtsResult } from './tts';

export interface QueuedCall {
  id: number;
  name: string;
  note: string;
  calledBy: string;
  calledAt: number;
  tts?: TtsResult;
}

class CallQueueManager {
  private queue: QueuedCall[] = [];
  private currentCall: QueuedCall | null = null;
  private isPaused = false;
  private isProcessing = false;
  private wss: WebSocketServer | null = null;

  // Anti-spam maps
  private userLastCallMap = new Map<string, number>(); // userId -> timestamp
  private nameLastCallMap = new Map<string, number>(); // lowercaseName -> timestamp

  public attachWebSocketServer(wss: WebSocketServer) {
    this.wss = wss;
    this.wss.on('connection', (ws) => {
      this.sendStateToClient(ws);
    });
  }

  public checkRateLimit(userId: string, name: string, isAdmin = false): { allowed: boolean; reason?: string } {
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

  public enqueue(name: string, note: string, calledById: string, calledByName: string): QueuedCall {
    const record = DB.logCall(name, note, calledById, calledByName);
    const item: QueuedCall = {
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

  public pause() {
    this.isPaused = true;
    this.broadcastState();
  }

  public resume() {
    this.isPaused = false;
    this.broadcastState();
    this.processNext();
  }

  public clear() {
    this.queue = [];
    this.currentCall = null;
    this.broadcastState();
  }

  public getState() {
    return {
      type: 'STATE_UPDATE',
      clinicName: CONFIG.clinicName,
      logoUrl: CONFIG.logoUrl,
      isPaused: this.isPaused,
      current: this.currentCall,
      upcoming: this.queue.map((q) => ({ id: q.id, name: q.name, note: q.note })),
      // Tukar angka 6 kepada 20 supaya ia memaparkan 20 nama terakhir
      recent: DB.getRecentHistory(20).map((h) => ({
        id: h.id,
        name: h.name,
        note: h.note,
        calledAt: h.called_at,
      })),
      audioSettings: {
        repeatCount: CONFIG.repeatCount,
        repeatGapSeconds: CONFIG.repeatGapSeconds,
        chimeVolume: CONFIG.chimeVolume,
        speechRate: CONFIG.speechRate,
      },
    };
  }

  public broadcastState() {
    if (!this.wss) return;
    const payload = JSON.stringify(this.getState());
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  private sendStateToClient(ws: WebSocket) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(this.getState()));
    }
  }

  private async processNext() {
    if (this.isProcessing || this.isPaused) return;
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
      nextItem.tts = await synthesizeAnnouncement(nextItem.name, nextItem.note);
      this.currentCall = nextItem;
      this.broadcastState();

      // Keep on screen for DISPLAY_SECONDS_PER_NAME (default 10s so 2 repeats + 3s gap finish comfortably)
      await new Promise((resolve) => setTimeout(resolve, CONFIG.displaySeconds * 1000));
    } catch (err) {
      console.error('[Queue] Error processing call:', err);
    } finally {
      this.isProcessing = false;
      if (this.queue.length > 0 && !this.isPaused) {
        this.processNext();
      } else {
        this.currentCall = null;
        this.broadcastState();
      }
    }
  }
}

export const CallQueue = new CallQueueManager();