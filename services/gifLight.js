// [2026-10-24 midia-wa2] GIF leve (WhatsApp manda GIF como vídeo curto sem som — muito menor).
//
// Medido 24/10 (11 GIFs reais do Giphy enviados no chat, 30 dias): giphy.gif 17,2 MB no total ·
// giphy.webp ~3,4x menor (mesma resolução, animado) · 200w.webp ~11x menor · giphy.mp4 ~5x menor.
// O remetente continua mandando a URL .gif (app antigo entende); o DESTINATÁRIO com este JS troca
// a rendição na hora de baixar/pintar a bolha:
//   rede boa → giphy.webp (resolução original) · enlace fraco (networkInfo.isSlowLink) → 200w.webp
//   Android < 9 (API 28) não anima WebP no Glide → fica o .gif.
// MP4 em loop dentro da célula nativa = BUILD (proposta no relatório); aqui só OTA.
// Flag: mediaWaFlags.mediaWaOn('gif_light') (allowlist) · kill __chatyy_mwa2_gif_light=false.
import { Platform } from 'react-native';

const GIPHY_RE = /^(https:\/\/(?:media\d*|i)\.giphy\.com\/media\/[^?#]+\/)(giphy(?:-downsized(?:-medium|-large|-small)?)?|200w?|100w?)\.gif((?:[?#].*)?)$/i;

function _on() {
  try { return require('./mediaWaFlags').mediaWaOn('gif_light'); } catch { return false; }
}
function _androidOld() {
  if (Platform.OS !== 'android') return false;
  const v = Number(Platform.Version) || 0;
  return v > 0 && v < 28;
}
function _saveData() {
  try {
    const ni = require('./networkInfo');
    if (typeof ni.isSlowLink === 'function' && ni.isSlowLink()) return true;
  } catch {}
  return false;
}

/** URL da rendição leve para a bolha (ou a própria URL quando não se aplica). */
export function lightGifUrl(url) {
  const u = String(url || '');
  if (!u || u.indexOf('giphy.com') < 0) return u;
  if (!_on() || _androidOld()) return u;
  const m = GIPHY_RE.exec(u);
  if (!m) return u;
  return m[1] + (_saveData() ? '200w' : 'giphy') + '.webp' + (m[3] || '');
}

/** MP4 sem som (tela cheia / futura célula nativa de vídeo em loop). */
export function gifMp4Url(url) {
  const m = GIPHY_RE.exec(String(url || ''));
  return m ? m[1] + 'giphy.mp4' + (m[3] || '') : '';
}

export default { lightGifUrl, gifMp4Url };
