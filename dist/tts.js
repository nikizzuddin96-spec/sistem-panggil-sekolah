"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setTtsAlertCallback = setTtsAlertCallback;
exports.enforceFreeTierVoice = enforceFreeTierVoice;
exports.buildSpokenPayload = buildSpokenPayload;
exports.synthesizeAnnouncement = synthesizeAnnouncement;
exports.prewarmFixedPhrases = prewarmFixedPhrases;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const google_auth_library_1 = require("google-auth-library");
const config_1 = require("./config");
const db_1 = require("./db");
if (!fs_1.default.existsSync(config_1.CONFIG.cacheDir)) {
    fs_1.default.mkdirSync(config_1.CONFIG.cacheDir, { recursive: true });
}
let alertCallback = null;
function setTtsAlertCallback(cb) {
    alertCallback = cb;
}
/**
 * Memastikan HANYA suara di bawah Pelan Percuma (Standard atau WaveNet) dipohon.
 * Menyekat Neural2, Studio, Chirp, Journey, Polyglot, dll.
 */
function enforceFreeTierVoice(requestedVoice, lang) {
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
function escapeXml(unsafe) {
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
function buildSpokenPayload(name, note, langPref) {
    // Tentukan bahasa
    let lang = langPref === 'auto' ? 'ms' : langPref;
    if (langPref === 'auto' && note && /\b(room|counter|doctor|dr)\b/i.test(note)) {
        lang = 'en';
    }
    // Bina ayat ringkas (< 80 aksara) khusus untuk panggilan murid bersurai sekolah
    let plainText = '';
    if (lang === 'ms') {
        plainText = note ? `${name}, ${note}, sila bersedia.` : `${name}, sila bersedia.`;
    }
    else {
        plainText = note ? `${name}, ${note}, please get ready.` : `${name}, please get ready.`;
    }
    if (plainText.length > 79) {
        plainText = plainText.slice(0, 78) + '.';
    }
    // Gunakan gantian sebutan nama (pronunciation overrides) jika ada
    const overrides = db_1.DB.getOverrides();
    let processedName = escapeXml(name);
    for (const ov of overrides) {
        const regex = new RegExp(`\\b${ov.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
        if (regex.test(name)) {
            if (ov.type === 'ipa') {
                processedName = processedName.replace(regex, `<phoneme alphabet="ipa" ph="${escapeXml(ov.replacement)}">$&</phoneme>`);
            }
            else {
                processedName = processedName.replace(regex, `<sub alias="${escapeXml(ov.replacement)}">$&</sub>`);
            }
        }
    }
    const safeNote = escapeXml(note);
    let ssmlBody = '';
    if (lang === 'ms') {
        ssmlBody = safeNote ? `${processedName}, ${safeNote}, sila bersedia.` : `${processedName}, sila bersedia.`;
    }
    else {
        ssmlBody = safeNote ? `${processedName}, ${safeNote}, please get ready.` : `${processedName}, please get ready.`;
    }
    const ssml = `<speak>${ssmlBody}</speak>`;
    const charCount = ssml.length;
    return { plainText, ssml, lang, charCount };
}
// Panggilan REST ke Google Cloud Text-to-Speech menggunakan google-auth-library
async function callGoogleTtsRest(ssml, voiceName, langCode, speakingRate) {
    let audioContent;
    // Pilihan A: Menggunakan Service Account JSON
    if (config_1.CONFIG.googleCredentialsPath) {
        const auth = new google_auth_library_1.GoogleAuth({
            keyFilename: config_1.CONFIG.googleCredentialsPath,
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
        audioContent = res.data.audioContent;
    }
    // Pilihan B: Menggunakan Google Cloud API Key
    else if (config_1.CONFIG.googleApiKey) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 3000);
        try {
            const res = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(config_1.CONFIG.googleApiKey)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: controller.signal,
                body: JSON.stringify({
                    input: { ssml },
                    voice: { languageCode: langCode, name: voiceName },
                    audioConfig: { audioEncoding: 'MP3', speakingRate },
                }),
            });
            if (!res.ok)
                throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            audioContent = data.audioContent;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    else {
        throw new Error('Tiada pengesahan Google Cloud TTS ditetapkan dalam .env');
    }
    if (!audioContent) {
        throw new Error('Respons audioContent daripada Google TTS kosong');
    }
    return Buffer.from(audioContent, 'base64');
}
async function synthesizeAnnouncement(name, note) {
    const langSetting = db_1.DB.getLang();
    const { plainText, ssml, lang, charCount } = buildSpokenPayload(name, note, langSetting);
    const requestedVoice = lang === 'ms' ? config_1.CONFIG.ttsVoiceMs : config_1.CONFIG.ttsVoiceEn;
    const { primary, fallbackStandard, langCode } = enforceFreeTierVoice(requestedVoice, lang);
    // Jana hash unik berdasarkan (ssml + voice + rate)
    const hash = crypto_1.default
        .createHash('sha256')
        .update(`${ssml}|${primary}|${config_1.CONFIG.speechRate}`)
        .digest('hex')
        .slice(0, 24);
    const fileName = `${hash}.mp3`;
    const filePath = path_1.default.join(config_1.CONFIG.cacheDir, fileName);
    // 1. Semak fail dalam cache terlebih dahulu (Jimat kuota API kepada 0 aksara)
    if (fs_1.default.existsSync(filePath)) {
        return {
            audioUrl: `/cache/tts/${fileName}`,
            plainText,
            lang: langCode,
            cached: true,
        };
    }
    // 2. Semak status penetapan TTS dan kelayakan API
    const ttsEnabled = db_1.DB.getSetting('tts_enabled', String(config_1.CONFIG.ttsEnabled)) === 'true';
    if (!ttsEnabled || (!config_1.CONFIG.googleApiKey && !config_1.CONFIG.googleCredentialsPath)) {
        return {
            audioUrl: null,
            plainText,
            lang: langCode,
            cached: false,
            fallbackReason: 'TTS dinyahaktifkan atau tiada kunci API disahkan',
        };
    }
    // 3. Semak had kuota bulanan aksara
    const usage = db_1.DB.getTtsUsage();
    if (usage.char_count + charCount > config_1.CONFIG.ttsMonthlyCap) {
        console.warn(`[TTS Guard] Had kuota bulanan dicapai (${usage.char_count}/${config_1.CONFIG.ttsMonthlyCap}). Beralih ke suara pelayar web.`);
        return {
            audioUrl: null,
            plainText,
            lang: langCode,
            cached: false,
            fallbackReason: 'Had kuota bulanan aksara telah dicapai',
        };
    }
    // 4. Buat panggilan ke Google Cloud TTS
    let audioBuffer = null;
    try {
        audioBuffer = await callGoogleTtsRest(ssml, primary, langCode, config_1.CONFIG.speechRate);
    }
    catch (primaryErr) {
        console.warn(`[TTS] Suara utama (${primary}) gagal: ${primaryErr.message}. Mencuba suara sandaran Standard (${fallbackStandard})...`);
        if (primary !== fallbackStandard) {
            try {
                audioBuffer = await callGoogleTtsRest(ssml, fallbackStandard, langCode, config_1.CONFIG.speechRate);
            }
            catch (stdErr) {
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
    fs_1.default.writeFileSync(filePath, audioBuffer);
    const updatedUsage = db_1.DB.incrementTtsUsage(charCount);
    // Amaran sekiranya kuota mencapai 80%
    const threshold80 = Math.floor(config_1.CONFIG.ttsMonthlyCap * 0.8);
    if (updatedUsage.char_count >= threshold80 && !updatedUsage.alert_80_sent) {
        db_1.DB.mark80AlertSent();
        if (alertCallback) {
            alertCallback(`⚠️ *Amaran Kuota TTS*: Penggunaan Google Cloud TTS bulanan telah mencecah 80% (${updatedUsage.char_count.toLocaleString()} / ${config_1.CONFIG.ttsMonthlyCap.toLocaleString()} aksara).`);
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
async function prewarmFixedPhrases() {
    if (!config_1.CONFIG.ttsEnabled || (!config_1.CONFIG.googleApiKey && !config_1.CONFIG.googleCredentialsPath)) {
        console.log('[TTS] Menolak penjanaan awal cache (tiada pengesahan Google TTS; menggunakan fallback suara pelayar).');
        return;
    }
    console.log('[TTS] Membina frasa contoh ke dalam cache cakera...');
    const sampleNames = ['Aiman', 'Aisyah'];
    for (const name of sampleNames) {
        await synthesizeAnnouncement(name, '');
    }
}
