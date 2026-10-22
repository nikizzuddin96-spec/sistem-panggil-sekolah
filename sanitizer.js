"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripEmojisLinksMentions = stripEmojisLinksMentions;
exports.containsProfanity = containsProfanity;
exports.extractPrivacyFirstName = extractPrivacyFirstName;
exports.parseCallInput = parseCallInput;
// Basic English & Malay profanity blocklist
const PROFANITY_LIST = [
    'fuck', 'shit', 'bitch', 'asshole', 'dick', 'pussy', 'cunt', 'bastard',
    'babi', 'celaka', 'sial', 'pantat', 'puki', 'pukimak', 'lancau', 'butoh',
    'bodoh', 'bangang', 'haramjadah', 'keparat', 'anjing', 'kote', 'tetek'
];
// Honorific prefixes that require the second word to be meaningful in Malaysia
const COMPOUND_PREFIXES = new Set([
    'muhammad', 'mohd', 'muhd', 'nur', 'noor', 'nor', 'siti', 'wan',
    'nik', 'tengku', 'raja', 'syed', 'sharifah', 'abdul', 'abd', 'putra', 'putri', 'che'
]);
function stripEmojisLinksMentions(input) {
    return input
        // Remove URLs
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/www\.\S+/gi, '')
        // Remove @mentions and #hashtags
        .replace(/[@#]\S+/g, '')
        // Remove emojis and miscellaneous symbols
        .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
        // Only allow letters, numbers, spaces, hyphens, and apostrophes
        .replace(/[^a-zA-Z0-9\s\-'/]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function containsProfanity(text) {
    const lower = text.toLowerCase();
    const words = lower.split(/[\s\-']+/).filter(Boolean);
    for (const bad of PROFANITY_LIST) {
        if (words.includes(bad) || lower.includes(bad)) {
            return true;
        }
    }
    return false;
}
/**
 * Privacy: Keep only first name (or prefix + first name, e.g., "Nur Aisyah" or "Aiman")
 * Strips bin/binti/a/l/a/p and family names.
 */
function extractPrivacyFirstName(rawName) {
    const cleaned = stripEmojisLinksMentions(rawName);
    const parts = cleaned
        .split(/\s+/)
        .filter((w) => !['bin', 'binti', 'bt', 'b', 'al', 'ap', 'a/l', 'a/p'].includes(w.toLowerCase()));
    if (parts.length === 0)
        return '';
    // Ambil sehingga 3 patah perkataan
    const selected = parts.slice(0, 3);
    // Formatkan kepada Huruf Besar di awal perkataan (Title Case)
    const formatted = selected
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    return formatted.slice(0, 50).trim();
}
/**
 * Parses input like "Aiman - Room 2" or "Nur Aisyah"
 */
function parseCallInput(rawText) {
    if (!rawText || !rawText.trim()) {
        return { valid: false, name: '', note: '', error: 'Empty input.' };
    }
    // Split by " - " or "|" for optional note
    const segments = rawText.split(/\s+-\s+|\s*\|\s*/);
    const rawNamePart = segments[0] || '';
    const rawNotePart = segments.slice(1).join(' ').trim();
    if (containsProfanity(rawNamePart) || containsProfanity(rawNotePart)) {
        return { valid: false, name: '', note: '', error: 'Inappropriate language detected.' };
    }
    const name = extractPrivacyFirstName(rawNamePart);
    const note = stripEmojisLinksMentions(rawNotePart).slice(0, 25);
    if (!name || name.length < 2) {
        return { valid: false, name: '', note: '', error: 'Please provide a valid name (2-30 characters).' };
    }
    return { valid: true, name, note };
}
