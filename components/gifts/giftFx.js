/**
 * giftFx — [gift-premium 2026-10-16] celebração de presente (confete +
 * haptic) e o diamante MONOCROMÁTICO (mesmo traço do cartão da Carteira no
 * perfil) usado pela bolha JS e pelo cartão da lista nativa.
 *
 *   celebrateGiftSent()        → quem enviou (folha de presente, sucesso)
 *   celebrateGiftReceived(msg) → mensagem 'gift' de OUTRA pessoa chegando ao
 *                                vivo na conversa aberta (1× por id)
 *   DIAMOND_MONO_PATHS         → paths (viewBox 24) p/ iconPaths() nativo
 *   <DiamondMono size color /> → SVG RN
 */
import { memo } from 'react';
import Svg, { Path } from 'react-native-svg';

export const DIAMOND_MONO_D1 = 'M6.5 3.5h11l4 5.5L12 20.5 2.5 9l4-5.5Z';
export const DIAMOND_MONO_D2 = 'M2.8 9h18.4M9 3.8 12 9l3-5.2M12 9v11';

export function diamondMonoPaths(color) {
  return [{ d: DIAMOND_MONO_D1, k: color, w: 1.8 }, { d: DIAMOND_MONO_D2, k: color, w: 1.4 }];
}

export const DiamondMono = memo(function DiamondMono({ size = 14, color = '#111111' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path d={DIAMOND_MONO_D1} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" />
      <Path d={DIAMOND_MONO_D2} fill="none" stroke={color} strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round" opacity={0.75} />
    </Svg>
  );
});

function _haptic() {
  try {
    const H = require('../../services/haptics').HapticsCompat;
    H.notificationAsync(H.NotificationFeedbackType.Success);
  } catch {}
}
function _confetti(y) {
  try { require('../mascot/ConfettiHost').celebrate({ x: 0.5, y, mono: true }); } catch {}
}

export function celebrateGiftSent() {
  _haptic();
  _confetti(0.72);
}

const _seen = new Set();
export function celebrateGiftReceived(msg) {
  if (!msg || msg.type !== 'gift') return;
  const k = String(msg.id || msg.client_message_id || '');
  if (!k || k.startsWith('tmp_') || _seen.has(k)) return;
  _seen.add(k);
  if (_seen.size > 200) _seen.clear();
  _haptic();
  _confetti(0.45);
}

/**
 * Cabeçalho "Você enviou {amount} a {name}" → partes p/ renderizar o diamante
 * como ícone no lugar de {amount} (sem emoji na UI).
 * @returns {{before:string, after:string}}
 */
export function giftHeadParts(t, own, name, fallbackOwn, fallbackOther) {
  const tr = (k, fb) => { try { const v = t ? t(k) : ''; return v && v !== k ? v : fb; } catch { return fb; } };
  const nm = String(name || '').trim();
  let tpl;
  if (own) tpl = nm ? tr('gifts.sentTo', 'Você enviou {amount} a {name}') : tr('gifts.sentNoName', 'Você enviou {amount}');
  else tpl = nm ? tr('gifts.receivedFrom', '{name} enviou {amount} para você') : tr('gifts.receivedNoName', 'Enviou {amount} para você');
  tpl = tpl.replace('{name}', nm);
  const i = tpl.indexOf('{amount}');
  if (i < 0) return { before: tpl || (own ? fallbackOwn : fallbackOther), after: '' };
  return { before: tpl.slice(0, i).trim(), after: tpl.slice(i + 8).trim() };
}
