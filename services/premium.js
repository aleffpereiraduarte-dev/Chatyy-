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
// ALL FEATURES FREE — no limits. Chatyy is 100% free for everyone.
// Monetization via Business API + Ads + Pix fees when at scale.
const FREE_LIMITS = {
  // No limits — everything unlimited
};

export function isPremium() { return true; } // Everyone is premium now — 100% free
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
  // toLocaleDateString('en-CA') retorna YYYY-MM-DD no fuso local — antes
  // toISOString() usava UTC e o reset diário virava à meia-noite UTC.
  const today = new Date().toLocaleDateString('en-CA');
  const usageKey = `usage_${featureKey}_${today}`;
  try {
    const val = await AsyncStorage.getItem(usageKey);
    // parseInt pode retornar NaN — usar Number.isFinite p/ evitar remaining: NaN.
    const parsed = val ? Number(val) : 0;
    const count = Number.isFinite(parsed) ? parsed : 0;
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
  // toLocaleDateString('en-CA') retorna YYYY-MM-DD no fuso local — antes
  // toISOString() usava UTC e o reset diário virava à meia-noite UTC.
  const today = new Date().toLocaleDateString('en-CA');
  const usageKey = `usage_${featureKey}_${today}`;
  try {
    const val = await AsyncStorage.getItem(usageKey);
    const parsed = val ? Number(val) : 0;
    const count = Number.isFinite(parsed) ? parsed : 0;
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

/**
 * Structured contextual upsell — returns the data the UI needs to render
 * a tailored upgrade sheet instead of a generic /plans redirect. The
 * shape mirrors what the new Plans page is being designed to consume:
 * { title, body, recommendedTier, ctaLabel, deepLinkTo, contextKey }.
 *
 * Call sites: storage 95% full, AI daily limit, file > 2GB, sticker
 * reaction on free, family invite without Pro plan, etc. Each context
 * picks its own tier (Plus or Pro) so the sheet pre-selects what the
 * user actually needs.
 */
export function getContextualUpsell(contextKey, t) {
  const tx = (k, fb) => (t?.(k) || fb);
  const base = {
    contextKey,
    deepLinkTo: '/plans',
    ctaLabel: tx('plans.startTrial', 'Experimentar 7 dias grátis'),
  };
  switch (contextKey) {
    case 'storage_full':
      return { ...base, recommendedTier: 'plus', highlightFeature: 'storage_limit',
        title: tx('upsell.storageFullTitle', 'Você está quase sem espaço'),
        body:  tx('upsell.storageFullBody',  'Plus dobra seu espaço para 200GB e libera backup de 30 dias por R$24,90/mês.') };
    case 'ai_translate_limit':
      return { ...base, recommendedTier: 'plus', highlightFeature: 'ai_daily_limit',
        title: tx('upsell.aiLimitTitle', 'Acabou seu limite diário de IA'),
        body:  tx('upsell.aiTranslateBody', 'Plus libera traduções, transcrições e resumos ilimitados.') };
    case 'file_too_big':
      return { ...base, recommendedTier: 'pro', highlightFeature: 'max_file_size',
        title: tx('upsell.fileTooBigTitle', 'Arquivo maior do que o limite gratuito'),
        body:  tx('upsell.fileTooBigBody', 'Pro aceita uploads de até 5GB e armazena 1TB total.') };
    case 'sticker_reaction':
      return { ...base, recommendedTier: 'plus', highlightFeature: 'sticker_reactions',
        title: tx('upsell.stickerReactTitle', 'Reagir com figurinhas é Plus'),
        body:  tx('upsell.stickerReactBody', 'Reaja com qualquer figurinha dos seus pacotes — exclusivo Plus.') };
    case 'family_invite':
      return { ...base, recommendedTier: 'pro', highlightFeature: 'max_members',
        title: tx('upsell.familyInviteTitle', 'Convite para família precisa do Pro'),
        body:  tx('upsell.familyInviteBody', 'Pro inclui até 6 membros compartilhando 1TB e gravação de chamadas.') };
    case 'call_recording':
      return { ...base, recommendedTier: 'pro', highlightFeature: 'call_recording',
        title: tx('upsell.callRecordTitle', 'Gravação de chamadas é Pro'),
        body:  tx('upsell.callRecordBody', 'Grave qualquer ligação 1:1 ou em grupo no Chatyy Pro.') };
    default:
      return { ...base, recommendedTier: 'plus', highlightFeature: null,
        title: tx('plans.title', 'Faça upgrade'),
        body:  tx('premium.upgrade', 'Desbloqueie tudo com Chatyy Plus') };
  }
}

export default { isPremium, getPlanName, loadPremiumStatus, canUseFeature, trackFeatureUsage, getUpsellMessage, getContextualUpsell };
