// [2026-10-24 coment-mencao] @menção em comentários (nível Instagram), JS-first.
//
//   useCommentMentions({ postId, text, setText })  → estado da lista "@" do campo:
//       onSelectionChange (passe ao TextInput), query (null = fechada), users, loading,
//       pick(user) insere "@token " no lugar do "@pa…" digitado, mentionsFor(text) = dicas
//       [{u,email}] p/ mandar ao servidor (só de quem ainda está no texto), reset().
//   <MentionSuggestList …/>  lista flutuante (acima do campo) com foto, nome e @token.
//   <MentionText text mentions style mentionStyle />  texto do comentário com @usuario em
//       destaque e tocável (abre /u/<email|token>); sem `mentions` (servidor antigo/visitante)
//       ainda destaca e abre pelo token.
//   useMentionCloser(active, fn)  folha/modal que precisa fechar antes de abrir o perfil
//       (senão a rota abriria por baixo do Modal).
// Servidor: comment_mention_search (comment-mentions.php). Ação desconhecida (kit não
// aplicado) → lista vazia, nada quebra. Kill OTA: globalThis.__chatyy_comment_mentions = false.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, ActivityIndicator, Platform, StyleSheet } from 'react-native';
import AvatarCircle from '../AvatarCircle';

export function commentMentionsOn() {
  try { if (globalThis.__chatyy_comment_mentions === false) return false; } catch {}
  return true;
}

// "@token" no texto: não conta e-mail no meio da frase (a@b.com).
const TOKEN_RE = /(^|[^A-Za-z0-9._@\-])@([A-Za-z0-9][A-Za-z0-9._\-]{0,63})/g;
const ACTIVE_RE = /(^|[^A-Za-z0-9._@\-])@([A-Za-z0-9._\-]{0,40})$/;

function _api() { try { return require('../../services/api'); } catch { return null; } }
function _local(email) { return String(email || '').toLowerCase().split('@')[0]; }
export function mentionTokenFor(u) {
  if (!u) return '';
  const h = String(u.mention || u.username || '').replace(/^@/, '').toLowerCase();
  return h || _local(u.email);
}

// cache curto por (post, consulta) — a lista abre de novo sem ir ao servidor
const _cache = new Map();
const _CACHE_MS = 60 * 1000;
let _unsupported = false;
async function searchMentions(postId, q) {
  if (_unsupported) return [];
  const key = `${postId || 0}|${q}`;
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < _CACHE_MS) return hit.users;
  const api = _api();
  if (!api?.apiCall) return [];
  let r = null;
  try { r = await api.apiCall('comment_mention_search', { q, post_id: postId || 0, limit: 12 }, 'POST'); } catch { r = null; }
  if (r && r.success === false && /unknown action|invalid action|a[cç][aã]o (desconhecida|inv[aá]lida)/i.test(String(r.message || r.error || ''))) { _unsupported = true; return []; }
  const users = Array.isArray(r?.data?.users) ? r.data.users.filter((u) => u && u.email) : [];
  if (r && r.success !== false) {
    _cache.set(key, { t: Date.now(), users });
    if (_cache.size > 80) _cache.delete(_cache.keys().next().value);
  }
  return users;
}

export function useCommentMentions({ postId, text, setText, enabled = true }) {
  const on = enabled && commentMentionsOn();
  const [sel, setSel] = useState(null);           // {start,end} do TextInput
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [closedAt, setClosedAt] = useState(-1);   // posição do "@" que o usuário dispensou/escolheu
  const hints = useRef(new Map());                // token → email (escolhidos na lista)
  const seq = useRef(0);

  const active = useMemo(() => {
    if (!on || typeof text !== 'string' || text.indexOf('@') < 0) return null;
    const cur = sel && sel.start === sel.end && sel.end <= text.length ? sel.end : text.length;
    const m = ACTIVE_RE.exec(text.slice(0, cur));
    if (!m) return null;
    const at = cur - m[2].length - 1;
    if (at === closedAt) return null;
    return { at, cur, q: m[2].toLowerCase() };
  }, [on, text, sel, closedAt]);

  const query = active ? active.q : null;
  useEffect(() => {
    if (query == null) { setUsers([]); setLoading(false); return undefined; }
    const my = ++seq.current;
    const key = `${postId || 0}|${query}`;
    const hit = _cache.get(key);
    if (hit) setUsers(hit.users); else setLoading(true);
    const id = setTimeout(async () => {
      const list = await searchMentions(postId, query);
      if (my !== seq.current) return;
      setUsers(list);
      setLoading(false);
    }, hit ? 0 : (query ? 140 : 0));
    return () => clearTimeout(id);
  }, [query, postId]);

  // texto voltou a não ter aquele "@" → libera p/ abrir de novo
  useEffect(() => { if (closedAt >= 0 && (typeof text !== 'string' || text[closedAt] !== '@')) setClosedAt(-1); }, [text, closedAt]);

  const onSelectionChange = useCallback((e) => {
    const s = e?.nativeEvent?.selection;
    if (s && typeof s.start === 'number') setSel({ start: s.start, end: s.end });
  }, []);

  const pick = useCallback((u) => {
    if (!active || !u) return;
    const tok = mentionTokenFor(u);
    if (!tok) return;
    hints.current.set(tok, String(u.email || '').toLowerCase());
    const before = text.slice(0, active.at);
    const after = text.slice(active.cur).replace(/^[A-Za-z0-9._\-]*/, '');
    const ins = `@${tok} `;
    const next = before + ins + (after.startsWith(' ') ? after.slice(1) : after);
    setText(next);
    const pos = before.length + ins.length;
    setSel({ start: pos, end: pos });
    setClosedAt(active.at);
    try { require('../../services/haptics').hapticEvent?.('toggle'); } catch {}
  }, [active, text, setText]);

  const dismiss = useCallback(() => { if (active) setClosedAt(active.at); }, [active]);

  const mentionsFor = useCallback((t) => {
    const s = String(t || '');
    const out = [];
    const seen = new Set();
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(s))) {
      const tok = m[2].replace(/[.\-]+$/, '').toLowerCase();
      const em = hints.current.get(tok);
      if (em && !seen.has(tok)) { seen.add(tok); out.push({ u: tok, email: em }); }
    }
    return out;
  }, []);

  const reset = useCallback(() => { hints.current = new Map(); setClosedAt(-1); setUsers([]); setSel(null); }, []);

  return {
    open: query != null && (loading || users.length > 0),
    query, users, loading, pick, dismiss, onSelectionChange, mentionsFor, reset,
  };
}

/** Lista flutuante: coloque dentro de um View com position:'relative' acima do campo. */
export const MentionSuggestList = memo(function MentionSuggestList({ state, isDark, colors, t, style, maxHeight = 232 }) {
  if (!state || !state.open) return null;
  const bg = isDark ? '#1c1c1e' : (colors?.surface || '#fff');
  const line = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)';
  const fg = colors?.text || (isDark ? '#fff' : '#111');
  const sub = colors?.textTertiary || (isDark ? '#8e8e93' : '#6c6c70');
  const relLabel = (r) => {
    if (r === 'author') return t?.('comments.mentionRelAuthor') || 'Autor';
    if (r === 'commenter') return t?.('comments.mentionRelCommenter') || 'Comentou';
    if (r === 'following') return t?.('comments.mentionRelFollowing') || 'Seguindo';
    if (r === 'follower') return t?.('comments.mentionRelFollower') || 'Segue você';
    return '';
  };
  return (
    <View style={[styles.box, { backgroundColor: bg, borderColor: line, maxHeight }, style]}
      accessibilityLabel={t?.('comments.mentionListA11y') || 'Sugestões de pessoas para marcar'}>
      {state.loading && !state.users.length ? (
        <View style={{ paddingVertical: 14, alignItems: 'center' }}><ActivityIndicator size="small" color={sub} /></View>
      ) : (
        <ScrollView keyboardShouldPersistTaps="always" nestedScrollEnabled showsVerticalScrollIndicator={false}>
          {state.users.map((u) => {
            const tok = mentionTokenFor(u);
            const rl = relLabel(u.rel);
            return (
              <Pressable key={u.email} onPress={() => state.pick(u)}
                style={({ pressed }) => [styles.row, { borderBottomColor: line, backgroundColor: pressed ? (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)') : 'transparent' }]}
                accessibilityRole="button" accessibilityLabel={`${u.name || tok} @${tok}`}>
                <AvatarCircle email={u.email} name={u.name || tok} uri={u.avatar_url || undefined} size={34} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={[styles.name, { color: fg }]} numberOfLines={1}>{u.name || tok}</Text>
                  <Text style={[styles.tok, { color: sub }]} numberOfLines={1}>{`@${tok}`}{rl ? ` · ${rl}` : ''}</Text>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>
      )}
    </View>
  );
});

// ── abrir perfil a partir do @ (fecha a folha/modal de cima antes) ──
const _closers = [];
export function useMentionCloser(active, fn) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!active) return undefined;
    const e = { fn: () => ref.current?.() };
    _closers.push(e);
    return () => { const i = _closers.indexOf(e); if (i >= 0) _closers.splice(i, 1); };
  }, [active]);
}
export function openMentionProfile(m) {
  const target = (m && (m.email || m.u)) || '';
  if (!target) return;
  const top = _closers[_closers.length - 1];
  let delay = 0;
  if (top) { try { top.fn(); delay = Platform.OS === 'ios' ? 380 : 160; } catch {} }
  setTimeout(() => {
    try { require('expo-router').router.push(`/u/${encodeURIComponent(target)}`); } catch {}
  }, delay);
}

/** Quebra o texto em partes [{t:'texto'} | {t:'@tok', m:{u,email}}]. */
export function splitMentions(text, mentions) {
  const s = String(text ?? '');
  if (s.indexOf('@') < 0) return null;
  const map = new Map();
  if (Array.isArray(mentions)) for (const x of mentions) if (x && x.u) map.set(String(x.u).toLowerCase(), x);
  const parts = [];
  let last = 0;
  TOKEN_RE.lastIndex = 0;
  let m;
  while ((m = TOKEN_RE.exec(s))) {
    let tok = m[2];
    const trail = (tok.match(/[.\-]+$/) || [''])[0];
    if (trail) tok = tok.slice(0, tok.length - trail.length);
    if (tok.length < 2) continue;
    const start = m.index + m[1].length;
    if (start > last) parts.push({ t: s.slice(last, start) });
    const known = map.get(tok.toLowerCase());
    parts.push({ t: '@' + tok, m: known || { u: tok.toLowerCase() } });
    last = start + 1 + tok.length;
  }
  if (!parts.length) return null;
  if (last < s.length) parts.push({ t: s.slice(last) });
  return parts;
}

/**
 * Texto de comentário com @menções tocáveis. Renderiza <Text> ANINHADO (vai dentro do
 * <Text> do comentário, ao lado do nome do autor). `linkable=false` = só destaque.
 */
export function MentionText({ text, mentions, mentionStyle, linkable = true, onPressMention }) {
  const parts = useMemo(() => (commentMentionsOn() ? splitMentions(text, mentions) : null), [text, mentions]);
  if (!parts) return <Text>{text}</Text>;
  return (
    <Text>
      {parts.map((p, i) => (p.m ? (
        <Text key={i} style={[styles.mention, mentionStyle]} suppressHighlighting={false}
          onPress={linkable ? () => (onPressMention ? onPressMention(p.m) : openMentionProfile(p.m)) : undefined}
          accessibilityRole={linkable ? 'link' : undefined}>
          {p.t}
        </Text>
      ) : <Text key={i}>{p.t}</Text>))}
    </Text>
  );
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute', left: 8, right: 8, bottom: '100%', marginBottom: 6,
    borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', zIndex: 50,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.16, shadowRadius: 12 },
      android: { elevation: 8 },
      web: { boxShadow: '0 6px 20px rgba(0,0,0,0.16)' },
    }),
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 12, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  name: { fontSize: 14, fontWeight: '600' },
  tok: { fontSize: 12.5, marginTop: 1 },
  mention: { fontWeight: '600', color: '#1d6fe8' },
});
