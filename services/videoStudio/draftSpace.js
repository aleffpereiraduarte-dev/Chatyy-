// [2026-10-24 reels-marcar] Rascunhos que nunca somem: limite por ESPAÇO com confirmação.
// confirmDraftSpace({ t, excludeId }) mede (draftStore.draftSpace) e, se passou do limite
// (ou o aparelho está quase cheio), AVISA e pergunta se pode apagar o MAIS ANTIGO — um por vez,
// cada um confirmado. "Manter" = não pergunta de novo por 10 min. Nunca apaga sozinho, nunca
// mexe no rascunho aberto (excludeId) nem num que está sendo publicado.
import { Alert, Platform } from 'react-native';
import { draftSpace, deleteDraft } from './draftStore';
import { isDraftPublishing } from './renderQueue';
import { fmtTime } from './edlOps';

let _asking = false;
let _snoozeUntil = 0;

export function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB`;
  if (b >= 1024 ** 2) return `${Math.max(1, Math.round(b / 1024 ** 2))} MB`;
  return `${Math.max(0, Math.round(b / 1024))} KB`;
}

function fmtDate(ms) {
  try { return new Date(ms).toLocaleDateString(undefined, { day: '2-digit', month: 'short' }); } catch { return ''; }
}

function ask(title, body, keep, del) {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    Alert.alert(title, body, [
      { text: keep, style: 'cancel', onPress: () => fin(false) },
      { text: del, style: 'destructive', onPress: () => fin(true) },
    ], { cancelable: true, onDismiss: () => fin(false) });
  });
}

/** → { asked, deleted } */
export async function confirmDraftSpace({ t, excludeId = null, force = false } = {}) {
  const out = { asked: false, deleted: 0 };
  if (Platform.OS === 'web' || _asking || typeof t !== 'function') return out;
  if (!force && Date.now() < _snoozeUntil) return out;
  _asking = true;
  try {
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      const s = await draftSpace();
      if (!s.over) break;
      const cand = s.items.find((x) => x.id !== excludeId && x.bytes > 0 && !isDraftPublishing(x.id));
      if (!cand) break;
      out.asked = true;
      const body = (s.lowDisk ? t('studio.drafts.spaceLowDisk').replace('{free}', fmtBytes(s.free)) : t('studio.drafts.spaceOver').replace('{used}', fmtBytes(s.used)).replace('{limit}', fmtBytes(s.limit)))
        + '\n\n' + t('studio.drafts.spaceAsk').replace('{date}', fmtDate(cand.updatedAt)).replace('{dur}', fmtTime(cand.duration || 0)).replace('{size}', fmtBytes(cand.bytes));
      // eslint-disable-next-line no-await-in-loop
      const yes = await ask(t('studio.drafts.spaceTitle'), body, t('studio.drafts.spaceKeep'), t('studio.drafts.spaceDelete'));
      if (!yes) { _snoozeUntil = Date.now() + 10 * 60 * 1000; break; }
      // eslint-disable-next-line no-await-in-loop
      await deleteDraft(cand.id);
      out.deleted += 1;
    }
  } catch {} finally { _asking = false; }
  return out;
}

export default { confirmDraftSpace, fmtBytes };
