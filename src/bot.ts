import { Bot, Context, InlineKeyboard } from 'grammy';
import { CONFIG } from './config';
import { DB } from './db';
import { parseCallInput } from './sanitizer';
import { CallQueue } from './queue';
import { setTtsAlertCallback } from './tts';

export let botInstance: Bot | null = null;

const CLASS_MAP: Record<string, string> = {
  '-1004489868462': '1M',
  '-1004401742347': '1B',
  '-1003999184959': '2M',
  '-1004296366731': '2B',
  '-1004325853565': '3M',
  '-1003774694048': '3B',
  '-1003908078025': '4M',
  '-1004403898258': '4B',
  '-1004265834582': '5M',
  '-1003968315996': '5B',
  '-1004242714202': '6M',
  '-1004443546057': '6B',
};

function getClassLabelFromChat(ctx: Context): string {
  if (!ctx.chat) return '';
  const chatIdStr = String(ctx.chat.id);
  if (CLASS_MAP[chatIdStr]) return CLASS_MAP[chatIdStr];
  if ('title' in ctx.chat && ctx.chat.title) return ctx.chat.title.slice(0, 20).trim();
  return '';
}

async function isGroupAdmin(ctx: Context): Promise<boolean> {
  if (!ctx.chat || !ctx.from) return false;
  if (ctx.chat.type === 'private') return false;
  try {
    const member = await ctx.getChatMember(ctx.from.id);
    return member.status === 'administrator' || member.status === 'creator';
  } catch {
    return false;
  }
}

function isAllowedChat(chatId: number): boolean {
  if (CONFIG.allowedChatIds.length === 0) return true;
  return CONFIG.allowedChatIds.includes(String(chatId));
}

export function initTelegramBot() {
  if (!CONFIG.telegramBotToken) {
    console.log('[Telegram] No TELEGRAM_BOT_TOKEN set. Bot disabled.');
    return null;
  }

  const bot = new Bot(CONFIG.telegramBotToken);
  botInstance = bot;

  setTtsAlertCallback((msg: string) => {
    const targetChat = CONFIG.allowedChatIds[0];
    if (targetChat) {
      bot.api.sendMessage(targetChat, msg, { parse_mode: 'Markdown' }).catch(console.error);
    }
  });

  bot.use(async (ctx, next) => {
    if (!ctx.chat || !ctx.from) return;
    if (!isAllowedChat(ctx.chat.id)) return;
    if (DB.isBanned(String(ctx.from.id))) return;
    await next();
  });

  async function handleCallRequest(ctx: Context, rawInput: string) {
    const userId = String(ctx.from!.id);
    const parentName = ctx.from!.first_name || 'Parent';
    const parsed = parseCallInput(rawInput);
    
    if (!parsed.valid) {
      await ctx.reply(`❌ ${parsed.error}`, { reply_to_message_id: ctx.msg?.message_id });
      return;
    }

    const admin = await isGroupAdmin(ctx);
    const rateCheck = CallQueue.checkRateLimit(userId, parsed.name, admin);
    if (!rateCheck.allowed) {
      await ctx.reply(`⏳ ${rateCheck.reason}`, { reply_to_message_id: ctx.msg?.message_id });
      return;
    }

    const autoClass = getClassLabelFromChat(ctx);
    const finalNote = parsed.note || autoClass;

    CallQueue.enqueue(parsed.name, finalNote, userId, parentName);
    const label = finalNote ? `${parsed.name} (${finalNote})` : parsed.name;
    await ctx.reply(`✅ Memanggil *${label}* ke skrin utama`, { 
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.msg?.message_id 
    });
  }

  // --- Arahan Biasa (Sistem Mini App) ---
  bot.command(['start', 'help'], async (ctx) => {
    if (!CONFIG.webhookUrl) {
       return ctx.reply('Sistem Mini App memerlukan HTTPS URL di dalam fail .env (WEBHOOK_URL). Sila hubungi admin.');
    }

    const appUrl = `${CONFIG.webhookUrl}/miniapp?chat_id=${ctx.chat!.id}`;
    const kb = new InlineKeyboard().webApp('📱 Buka Sistem Panggilan', appUrl);
    
    await ctx.reply(
      `🏫 *Selamat Datang ke Sistem Panggilan Murid*\n\nSila tekan butang di bawah untuk membuka aplikasi pintar dan memanggil anak anda secara terus.`,
      { 
        parse_mode: 'Markdown', 
        reply_markup: kb,
        reply_to_message_id: ctx.msg?.message_id
      }
    );
  });

  // Arahan manual /call dimasukkan semula
  bot.command('call', async (ctx) => {
    const arg = ctx.match.trim();
    if (!arg) {
      return ctx.reply('Sila berikan nama. Contoh: `/call Aiman`', { parse_mode: 'Markdown', reply_to_message_id: ctx.msg?.message_id });
    }
    await handleCallRequest(ctx, arg);
  });

  bot.command('addkid', async (ctx) => {
    const raw = ctx.match;
    if (!raw) {
      return ctx.reply('Sila berikan nama. Contoh: `/addkid Aiman`', { parse_mode: 'Markdown', reply_to_message_id: ctx.msg?.message_id });
    }
    const parsed = parseCallInput(raw);
    if (!parsed.valid) return ctx.reply(`❌ Format: \`/addkid Aiman\` (${parsed.error})`, { parse_mode: 'Markdown', reply_to_message_id: ctx.msg?.message_id });
    
    const ok = DB.addKid(String(ctx.from!.id), String(ctx.chat!.id), parsed.name);
    if (ok) {
      await ctx.reply(`✅ Berjaya menyimpan *${parsed.name}* untuk kelas ini. Sila buka Mini App untuk melihat senarai.`, { 
        parse_mode: 'Markdown', 
        reply_to_message_id: ctx.msg?.message_id 
      });
    } else {
      await ctx.reply(`❌ Tidak dapat menyimpan (had maksimum 8 orang anak untuk kelas ini).`, { reply_to_message_id: ctx.msg?.message_id });
    }
  });

  bot.command('removekid', async (ctx) => {
    const parsed = parseCallInput(ctx.match);
    if (!parsed.valid) return ctx.reply(`Format: \`/removekid Aiman\``, { parse_mode: 'Markdown', reply_to_message_id: ctx.msg?.message_id });
    
    const removed = DB.removeKid(String(ctx.from!.id), String(ctx.chat!.id), parsed.name);
    await ctx.reply(removed ? `🗑️ Berjaya memadam *${parsed.name}* daripada kelas ini.` : `Nama *${parsed.name}* tiada dalam senarai kelas ini.`, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.msg?.message_id
    });
  });

  // --- Arahan Admin ---
  bot.command('clear', async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.reply('⛔ Arahan ini hanya untuk Admin.');
    CallQueue.clear();
    await ctx.reply('🧹 Giliran panggilan dan paparan TV telah dikosongkan.');
  });
  
  bot.command('pause', async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.reply('⛔ Arahan ini hanya untuk Admin.');
    CallQueue.pause();
    await ctx.reply('⏸️ Pengumuman TV telah dijeda.');
  });
  
  bot.command('resume', async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.reply('⛔ Arahan ini hanya untuk Admin.');
    CallQueue.resume();
    await ctx.reply('▶️ Pengumuman TV telah disambung semula.');
  });
  
  bot.command('ban', async (ctx) => {
    if (!(await isGroupAdmin(ctx))) return ctx.reply('⛔ Arahan ini hanya untuk Admin.');
    const replyUser = ctx.message?.reply_to_message?.from;
    const targetId = replyUser ? String(replyUser.id) : ctx.match.trim();
    if (!targetId) return ctx.reply('Balas (reply) mesej pengguna dengan `/ban` atau hantar `/ban <user_id>`.');
    DB.banUser(targetId, 'Disekat oleh admin grup');
    await ctx.reply(`🚫 Pengguna \`${targetId}\` telah disekat.`);
  });

  // Mesej Utama (Menangkap input teks biasa)
  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();

    if (text.startsWith('/')) return;

    // Teks biasa (Plain Text) - Membolehkan ibu bapa terus taip nama di grup jika dibenarkan
    const allowPlain = DB.getSetting('allow_plain_text', String(CONFIG.allowPlainTextCall)) === 'true';
    if (!allowPlain) return;
    await handleCallRequest(ctx, text);
  });

  bot.catch((err) => {
    console.error('[Telegram Bot Error]:', err.error);
  });

  return bot;
}