// services/waImport/match.js — [import-ordem 2026-10-13] pontuação de nome para vincular o export do
// WhatsApp à pessoa certa (mesma regra do servidor, wa-import.php _waNameScore):
//   sem acento, minúsculas, sem emoji/símbolo ("Thalisa 🌿" = "thalisa"); 0..100; < 70 = sem relação.
//   igual 100 · igual sem espaços 95 · mesmo 1º nome (um lado só 1º nome, ou sobrenome compatível) 88 ·
//   1º nome com 1 letra de diferença (Thalissa × Thalisa) 78 · resto 0 (Carol × Thalisa = 0).

export const NAME_MIN_SCORE = 70;

export function nameKey(s) {
  return String(s || '')
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF~]/g, '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    // só letras/dígitos (latim, grego, cirílico, hebraico, árabe, índicas, tailandês, CJK, hangul) — emoji/símbolo vira espaço
    .replace(/[^0-9a-z\u00C0-\u024F\u0370-\u03FF\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0900-\u0DFF\u0E00-\u0EFF\u1100-\u11FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lev(a, b) {
  const x = Array.from(a); const y = Array.from(b);
  const n = x.length; const m = y.length;
  if (!n) return m; if (!m) return n;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[m];
}

export function nameScore(a, b) {
  const x = nameKey(a); const y = nameKey(b);
  if (!x || !y || /^\d+$/.test(x.replace(/ /g, '')) || /^\d+$/.test(y.replace(/ /g, ''))) return 0;
  if (x === y) return 100;
  if (x.replace(/ /g, '') === y.replace(/ /g, '')) return 95;
  const tx = x.split(' '); const ty = y.split(' ');
  const fx = tx[0]; const fy = ty[0];
  const single = tx.length === 1 || ty.length === 1;
  const sx = tx[1] || ''; const sy = ty[1] || '';
  const restOk = single || sx === sy || (sx[0] === sy[0] && (sx.length === 1 || sy.length === 1));
  if (fx === fy && Array.from(fx).length >= 3) return restOk ? 88 : 55;
  const lf = Math.min(Array.from(fx).length, Array.from(fy).length);
  if (lf >= 4) {
    const d = lev(fx, fy);
    if (d <= 1 || (d <= 2 && lf >= 7)) return restOk ? 78 : 50;
  }
  return 0;
}

/**
 * Melhor pessoa (conversas diretas locais) para os nomes do export (sem o "eu") + título do arquivo.
 * convs: [{ email, name, convId }] → { ...conv, score, matched } | null (nunca abaixo do mínimo).
 */
export function bestLocalMatch(names, convs) {
  let best = null;
  for (const c of convs || []) {
    for (const n of names || []) {
      const sc = nameScore(n, c.name);
      if (sc >= NAME_MIN_SCORE && (!best || sc > best.score)) best = { ...c, score: sc, matched: n };
    }
  }
  return best;
}

/**
 * [wa-remetente 2026-10-13] Lista ranqueada para escolher a pessoa da conversa (tela de importar).
 * Fontes: server = candidatos do wa_import_match (telefone/nome, com motivo), search = resultados da busca
 * no servidor (nome/@/telefone, universo fechado), recent = conversas diretas recentes, local = conversas
 * diretas do aparelho. query filtra (nome/@usuário/e-mail; dígitos casam o telefone só via servidor).
 * Ordem: número confirmado > busca por número > nome parecido (pontuação) > busca > recentes > aparelho.
 * Nunca inventa candidato: só reordena/filtra o que veio dessas fontes. → [{ email, name, handle, convId, reason, matched, tail, rank }]
 */
export function rankCandidates({ server = [], search = [], recent = [], local = [], query = '' } = {}) {
  const q = nameKey(String(query || '').replace(/^@/, ''));
  const qRaw = String(query || '').trim().toLowerCase().replace(/^@/, '');
  const qDigits = /^[\d\s()+.-]+$/.test(String(query || '').trim()) && String(query || '').replace(/\D/g, '').length >= 4;
  const matchesQuery = (c) => {
    if (!qRaw) return true;
    if (qDigits) return false; // telefone: só o servidor confere (hash) — nada local finge que bate
    const nk = nameKey(c.name);
    return (q && (nk.startsWith(q) || nk.includes(' ' + q) || (q.length >= 3 && nk.includes(q))))
      || (c.handle && String(c.handle).toLowerCase().startsWith(qRaw))
      || (qRaw.length >= 3 && String(c.email || '').toLowerCase().startsWith(qRaw));
  };
  const out = new Map();
  const put = (c, rank) => {
    const email = String(c?.email || '').toLowerCase();
    if (!email) return;
    const prev = out.get(email);
    if (prev && prev.rank >= rank) return;
    out.set(email, {
      email, name: c.name || email, handle: c.handle || '',
      convId: c.convId != null && c.convId !== '' ? String(c.convId) : (c.conversation_id ? String(c.conversation_id) : (prev?.convId || '')),
      reason: c.reason || prev?.reason || '', matched: c.matched || '', tail: c.tail || c.phone_tail || '', rank,
    });
  };
  for (const c of search || []) put(c, c.reason === 'phone' ? 950 : 500 + Math.min(99, Number(c.score) || 0));
  for (const c of server || []) { if (matchesQuery(c)) put(c, c.reason === 'phone' ? 1000 : 600 + Math.min(99, Number(c.score) || 0)); }
  (recent || []).forEach((c, i) => { if (matchesQuery(c)) put({ ...c, reason: c.reason || 'recent' }, 300 - i); });
  (local || []).forEach((c, i) => { if (matchesQuery(c)) put(c, 100 - Math.min(99, i)); });
  return Array.from(out.values()).sort((a, b) => b.rank - a.rank);
}

export default { nameKey, nameScore, bestLocalMatch, rankCandidates, NAME_MIN_SCORE };
