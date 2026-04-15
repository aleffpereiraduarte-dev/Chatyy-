/**
 * Chatyy Plus Premium — subtle monetization layer.
 *
 * Free users get the full app. Premium users get:
 * - Unlimited AI features (translate, summarize, transcribe, text-to-sticker)
 * - Custom themes & wallpapers
 * - HD media quality
 * - Verified badge on profile
 * - Priority message delivery
 * - Larger file uploads (2GB vs 100MB)
 * - No ads in channels
 * - Custom emoji reactions
 * - Extended status (48h instead of 24h)
 * - Auto-reply (business feature)
 *
 * Free limits per day:
 * - AI translate: 5
 * - AI summarize: 3
 * - AI text-to-sticker: 3
 * - AI transcribe: 2
 * - File upload: 100MB max
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

let _isPremium = false;
let _planName = 'free';
let _dailyUsage = {};
const FREE_LIMITS = {
  ai_translate: 5,
  ai_summarize: 3,
  ai_text_to_sticker: 3,
  ai_transcribe: 2,
  ai_quick_replies: 10,
};

export function isPremium() { return _isPremium; }
export function getPlanName() { return _planName; }

export async function loadPremiumStatus() {
  try {
    const stored = await AsyncStorage.getItem('chatyy_premium');
    if (stored) {
      const data = JSON.parse(stored);
      _isPremium = !!data.active;
      _planName = data.plan || 'free';
    }
  } catch {}
  // Check server via plan_info (the real source of truth)
  try {
    const api = require('./api');
    const r = await api.planInfo();
    if (r?.success && r.data) {
      const plan = r.data.plan || 'free';
      _isPremium = plan !== 'free';
      _planName = plan;
      await AsyncStorage.setItem('chatyy_premium', JSON.stringify({ active: _isPremium, plan: _planName }));
    }
  } catch {}
  return _isPremium;
}

// Check if a feature is available (returns true if premium or under free limit)
export async function canUseFeature(featureKey) {
  if (_isPremium) return { allowed: true, remaining: Infinity };
  const limit = FREE_LIMITS[featureKey];
  if (!limit) return { allowed: true, remaining: Infinity }; // No limit for this feature

  // Load today's usage
  const today = new Date().toISOString().slice(0, 10);
  const usageKey = `usage_${featureKey}_${today}`;
  try {
    const val = await AsyncStorage.getItem(usageKey);
    const count = val ? parseInt(val, 10) : 0;
    if (count >= limit) {
      return { allowed: false, remaining: 0, limit, used: count };
    }
    return { allowed: true, remaining: limit - count, limit, used: count };
  } catch {
    return { allowed: true, remaining: limit };
  }
}

// Track usage of a feature
export async function trackFeatureUsage(featureKey) {
  if (_isPremium) return;
  const today = new Date().toISOString().slice(0, 10);
  const usageKey = `usage_${featureKey}_${today}`;
  try {
    const val = await AsyncStorage.getItem(usageKey);
    const count = val ? parseInt(val, 10) : 0;
    await AsyncStorage.setItem(usageKey, String(count + 1));
  } catch {}
}

// Get premium upsell message for a feature
export function getUpsellMessage(featureKey, t) {
  const messages = {
    ai_translate: t?.('premium.translateLimit') || 'Traduza ilimitado com Chatyy Plus',
    ai_summarize: t?.('premium.summarizeLimit') || 'Resuma ilimitado com Chatyy Plus',
    ai_text_to_sticker: t?.('premium.stickerLimit') || 'Crie stickers ilimitados com Chatyy Plus',
    ai_transcribe: t?.('premium.transcribeLimit') || 'Transcreva ilimitado com Chatyy Plus',
    ai_quick_replies: t?.('premium.quickReplyLimit') || 'Respostas IA ilimitadas com Chatyy Plus',
    file_size: t?.('premium.fileSizeLimit') || 'Envie arquivos de até 2GB com Chatyy Plus',
    themes: t?.('premium.themesLocked') || 'Temas exclusivos — Chatyy Plus',
    badge: t?.('premium.badge') || 'Ganhe o badge verificado com Chatyy Plus',
  };
  return messages[featureKey] || (t?.('premium.upgrade') || 'Upgrade para Chatyy Plus');
}

export default { isPremium, getPlanName, loadPremiumStatus, canUseFeature, trackFeatureUsage, getUpsellMessage };
