import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { GoogleAuth } from 'google-auth-library';
import { CONFIG } from './config';
import { DB } from './db';

if (!fs.existsSync(CONFIG.cacheDir)) {
  fs.mkdirSync(CONFIG.cacheDir, { recursive: true });
}

let alertCallback: ((msg: string) => void) | null = null;
export function setTtsAlertCallback(cb: (msg: string) => void) {
  alertCallback = cb;
}

/**
 * Memastikan HANYA suara di bawah Pelan Percuma (Standard atau WaveNet) dipohon.
 * Menyekat Neural2, Studio, Chirp, Journey, Polyglot, dll.
 */
export function enforceFreeTierVoice(requestedVoice: string, lang: 'ms' | 'en'): { primary: string; fallbackStandard: string; langCode: string } {
  const defaultPrimary = lang === 'ms' ? 'ms-MY-Wavenet-A' : 'en-GB-Wavenet-A';
  const defaultStandard = lang === 'ms' ? 'ms-MY-Standard-A' : 'en-GB-Standard-A';

  let voice = requestedVoice.trim() || defaultPrimary;
  const isAllowed = /^([a-z]{2}-[A-Z]{2})-(Wavenet|Standard)-[A-Z]$/i.test(voice);

  if (!isAllowed) {
    console.warn(`[TTS Guard] Suara "${voice}" bukan suara Standard/WaveNet. Menetapkan "${defaultPrimary}" secara automatik.`);
    voice = defaultPrimary;
  }

  const langCode = voice.split('-').slice(0, 2).join('-');
  const fallbackStandard = voice.replace(/Wavenet/i, 'Standard');

  return { primary: voice, fallbackStandard, langCode };
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

/**
 * Menjana teks sebutan dan menyokong gantian sebutan SSML (<sub> atau <phoneme>)
 */
export function buildSpokenPayload(name: string, note: string, langPref: 'ms' | 'en' | 'auto'): {
  plainText: string;
  ssml: string;
  lang: 'ms' | 'en';
  charCount: number;
} {
  // Tentukan bahasa
  let lang: 'ms' | 'en' = langPref === 'auto' ? 'ms' : langPref;
  if (langPref === 'auto' && note && /\b(room|counter|doctor|dr)\b/i.test(note)) {
    lang = 'en';
  }

  // Bina ayat ringkas (< 80 aksara) khusus untuk panggilan murid bersurai sekolah
  let plainText = '';
  if (lang === 'ms') {
    plainText = note ? `${name}, ${note}, sila bersedia.` : `${name}, sila bersedia.`;
  } else {
    plainText = note ? `${name}, ${note}, please get ready.` : `${name}, please get ready.`;
  }

  if (plainText.length > 79) {
    plainText = plainText.slice(0, 78) + '.';
  }

  // Gunakan gantian sebutan nama (pronunciation overrides) jika ada
  const overrides = DB.getOverrides();
  let processedName = escapeXml(name);

  for (const ov of overrides) {
    const regex = new RegExp(`\\b${ov.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (regex.test(name)) {
      if (ov.type === 'ipa') {
        processedName = processedName.replace(regex, `<phoneme alphabet="ipa" ph="${escapeXml(ov.replacement)}">$&</phoneme>`);
      } else {
        processedName = processedName.replace(regex, `<sub alias="${escapeXml(ov.replacement)}">$&</sub>`);
      }
    }
  }

  const safeNote = escapeXml(note);
  let ssmlBody = '';
  if (lang === 'ms') {
    ssmlBody = safeNote ? `${processedName}, ${safeNote}, sila bersedia.` : `${processedName}, sila bersedia.`;
  } else {
    ssmlBody = safeNote ? `${processedName}, ${safeNote}, please get ready.` : `${processedName}, please get ready.`;
  }

  const ssml = `<speak>${ssmlBody}</speak>`;
  const charCount = ssml.length;

  return { plainText, ssml, lang, charCount };
}

// Panggilan REST ke Google Cloud Text-to-Speech menggunakan google-auth-library
async function callGoogleTtsRest(ssml: string, voiceName: string, langCode: string, speakingRate: number): Promise<Buffer> {
  let audioContent: string;

  // Pilihan A: Menggunakan Service Account JSON
  if (CONFIG.googleCredentialsPath) {
    const auth = new GoogleAuth({
      keyFilename: CONFIG.googleCredentialsPath,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    const client = await auth.getClient();

    const res = await client.request({
      url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
      method: 'POST',
      timeout: 3000, // Had masa tamat 3 saat
      data: {
        input: { ssml },
        voice: { languageCode: langCode, name: voiceName },
        audioConfig: { audioEncoding: 'MP3', speakingRate },
      },
    });

    audioContent = (res.data as any).audioContent;
  } 
  // Pilihan B: Menggunakan Google Cloud API Key
  else if (CONFIG.googleApiKey) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    
    try {
      const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(CONFIG.googleApiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          input: { ssml },
          voice: { languageCode: langCode, name: voiceName },
          audioConfig: { audioEncoding: 'MP3', speakingRate },
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as any;
      audioContent = data.audioContent;
    } finally {
      clearTimeout(timeout);
    }
  } else {
    throw new Error('Tiada pengesahan Google Cloud TTS ditetapkan dalam .env');
  }

  if (!audioContent) {
    throw new Error('Respons audioContent daripada Google TTS kosong');
  }

  return Buffer.from(audioContent, 'base64');
}

export interface TtsResult {
  audioUrl: string | null;
  plainText: string;
  lang: string;
  cached: boolean;
  fallbackReason?: string;
}

export async function synthesizeAnnouncement(name: string, note: string): Promise<TtsResult> {
  const langSetting = DB.getLang();
  const { plainText, ssml, lang, charCount } = buildSpokenPayload(name, note, langSetting);

  const requestedVoice = lang === 'ms' ? CONFIG.ttsVoiceMs : CONFIG.ttsVoiceEn;
  const { primary, fallbackStandard, langCode } = enforceFreeTierVoice(requestedVoice, lang);

  // Jana hash unik berdasarkan (ssml + voice + rate)
  const hash = crypto
    .createHash('sha256')
    .update(`${ssml}|${primary}|${CONFIG.speechRate}`)
    .digest('hex')
    .slice(0, 24);

  const fileName = `${hash}.mp3`;
  const filePath = path.join(CONFIG.cacheDir, fileName);

  // 1. Semak fail dalam cache terlebih dahulu (Jimat kuota API kepada 0 aksara)
  if (fs.existsSync(filePath)) {
    return {
      audioUrl: `/cache/tts/${fileName}`,
      plainText,
      lang: langCode,
      cached: true,
    };
  }

  // 2. Semak status penetapan TTS dan kelayakan API
  const ttsEnabled = DB.getSetting('tts_enabled', String(CONFIG.ttsEnabled)) === 'true';
  if (!ttsEnabled || (!CONFIG.googleApiKey && !CONFIG.googleCredentialsPath)) {
    return {
      audioUrl: null,
      plainText,
      lang: langCode,
      cached: false,
      fallbackReason: 'TTS dinyahaktifkan atau tiada kunci API disahkan',
    };
  }

  // 3. Semak had kuota bulanan aksara
  const usage = DB.getTtsUsage();
  if (usage.char_count + charCount > CONFIG.ttsMonthlyCap) {
    console.warn(`[TTS Guard] Had kuota bulanan dicapai (${usage.char_count}/${CONFIG.ttsMonthlyCap}). Beralih ke suara pelayar web.`);
    return {
      audioUrl: null,
      plainText,
      lang: langCode,
      cached: false,
      fallbackReason: 'Had kuota bulanan aksara telah dicapai',
    };
  }

  // 4. Buat panggilan ke Google Cloud TTS
  let audioBuffer: Buffer | null = null;
  try {
    audioBuffer = await callGoogleTtsRest(ssml, primary, langCode, CONFIG.speechRate);
  } catch (primaryErr: any) {
    console.warn(`[TTS] Suara utama (${primary}) gagal: ${primaryErr.message}. Mencuba suara sandaran Standard (${fallbackStandard})...`);
    if (primary !== fallbackStandard) {
      try {
        audioBuffer = await callGoogleTtsRest(ssml, fallbackStandard, langCode, CONFIG.speechRate);
      } catch (stdErr: any) {
        console.error(`[TTS] Suara sandaran Standard turut gagal: ${stdErr.message}`);
      }
    }
  }

  if (!audioBuffer) {
    return {
      audioUrl: null,
      plainText,
      lang: langCode,
      cached: false,
      fallbackReason: 'Ralat API Google TTS atau tamat masa (3 saat)',
    };
  }

  // 5. Simpan fail MP3 ke dalam folder cache dan kemas kini rekod kuota
  fs.writeFileSync(filePath, audioBuffer);
  const updatedUsage = DB.incrementTtsUsage(charCount);

  // Amaran sekiranya kuota mencapai 80%
  const threshold80 = Math.floor(CONFIG.ttsMonthlyCap * 0.8);
  if (updatedUsage.char_count >= threshold80 && !updatedUsage.alert_80_sent) {
    DB.mark80AlertSent();
    if (alertCallback) {
      alertCallback(
        `⚠️ *Amaran Kuota TTS*: Penggunaan Google Cloud TTS bulanan telah mencecah 80% (${updatedUsage.char_count.toLocaleString()} / ${CONFIG.ttsMonthlyCap.toLocaleString()} aksara).`
      );
    }
  }

  return {
    audioUrl: `/cache/tts/${fileName}`,
    plainText,
    lang: langCode,
    cached: false,
  };
}

/**
 * Menjana fail audio frasa asas ke dalam cache semasa sistem mula dijalankan
 */
export async function prewarmFixedPhrases(): Promise<void> {
  if (!CONFIG.ttsEnabled || (!CONFIG.googleApiKey && !CONFIG.googleCredentialsPath)) {
    console.log('[TTS] Menolak penjanaan awal cache (tiada pengesahan Google TTS; menggunakan fallback suara pelayar).');
    return;
  }
  console.log('[TTS] Membina frasa contoh ke dalam cache cakera...');
  const sampleNames = ['Aiman', 'Aisyah'];
  for (const name of sampleNames) {
    await synthesizeAnnouncement(name, '');
  }
}