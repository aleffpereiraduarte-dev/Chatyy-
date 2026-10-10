/**
 * liveEngageStore — estado de engajamento da live (curtidas, top fãs, Q&A,
 * presentes) FORA da árvore das telas live-viewer / live-broadcast.
 *
 * Por quê: as telas têm 5-7k linhas; qualquer setState nelas re-renderiza tudo.
 * Aqui o estado vive num store externo (useSyncExternalStore) e só os
 * componentes de engajamento que leem a fatia que mudou re-renderizam.
 *
 * Uso (tela):
 *   const likeEngage = useLiveEngageController({ sessionId, wsRef, me, isHost });
 *   ws.onmessage → likeEngage.onWsMessage(msg)   (observador, não consome)
 *   toque → likeEngage.queueLike({ x, color })   (lote ~450ms pro hub)
 *   live_reaction remoto → likeEngage.heartsFor(msg) corações a desenhar
 *   <LiveEngageLayer engage={likeEngage} ... />  (banners, sheets, Q&A)
 *
 * Hub antigo (sem live_engage.go): ignora count/like/live_engage_state →
 * likesTotal fica null e a UI cai no contador local. Q&A: sonda
 * chat_live_qa_list; se o backend não tem a ação, qaSupported=false e o botão
 * some. Presentes: só com LIVE_GIFTS_ENABLED (DIAMONDS_ENABLED).
 */

import { useEffect, useRef, useSyncExternalStore, useCallback } from 'react';
import * as engApi from './liveEngageApi';
import { LIVE_GIFTS_ENABLED, BIG_GIFT_DIAMONDS, giftMeta } from './liveEngageConfig';

const LIKE_FLUSH_MS = 450;
const LIKE_MAX_PER_MSG = 25;
const MAX_REMOTE_HEARTS_PER_FRAME = 6;
const GIFT_COMBO_WINDOW_MS = 3500;
const MAX_GIFT_BANNERS = 3;
const MAX_BIG_QUEUE = 5;

const INITIAL = {
  likesTotal: null,     // null = hub sem suporte (usa contador local)
  topFans: [],          // top 3 por curtidas (hub)
  fans: [],             // ranking completo (sheet)
  fansLoading: false,
  gifters: [],          // ranking por diamantes (REST, só com presentes ligados)
  qaSupported: null,    // null = sondando
  questions: [],
  highlighted: null,
  qaUnseen: 0,
  giftBanners: [],      // [{ key, email, name, gift, label, diamonds, count, ts }]
  giftBig: null,        // presente grande em exibição
  sheet: null,          // 'fans' | 'qa' | 'gift' | null
};

function createController() {
  let state = { ...INITIAL };
  const listeners = new Set();
  const opts = { sessionId: '', wsRef: null, me: { email: '', name: '' }, isHost: false };
  let likePend = 0;
  let likeX = null;
  let likeColor = null;
  let likeTimer = null;
  let selfEchoPending = 0;
  const bigQueue = [];
  let probedFor = '';

  const emit = () => { listeners.forEach((l) => { try { l(); } catch {} }); };
  const set = (patch) => {
    const next = typeof patch === 'function' ? patch(state) : patch;
    if (!next) return;
    let changed = false;
    for (const k in next) { if (state[k] !== next[k]) { changed = true; break; } }
    if (!changed) return;
    state = { ...state, ...next };
    emit();
  };
  const meEmail = () => String(opts.me?.email || '').toLowerCase();

  const wsSend = (obj) => {
    const ws = opts.wsRef?.current;
    try {
      if (ws && ws.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
    } catch {}
    return false;
  };

  const flushLikes = () => {
    likeTimer = null;
    if (!likePend || !opts.sessionId) { likePend = 0; return; }
    const n = Math.min(likePend, LIKE_MAX_PER_MSG);
    likePend -= n;
    const payload = { type: 'live_reaction', session_id: opts.sessionId, emoji: '❤️', like: true, count: n };
    if (typeof likeX === 'number') payload.x = likeX;
    if (likeColor) payload.color = likeColor;
    if (wsSend(payload)) selfEchoPending += n;
    if (likePend > 0) likeTimer = setTimeout(flushLikes, LIKE_FLUSH_MS);
  };

  const playNextBig = () => {
    const next = bigQueue.shift() || null;
    set({ giftBig: next });
  };

  const pushGift = (msg) => {
    const giftType = String(msg.gift_type || msg.gift || msg.gift_sku || '').toLowerCase();
    const meta = giftMeta(giftType);
    const diamonds = Number(msg.diamonds || msg.amount || meta.diamonds || 1);
    const email = String(msg.sender_email || '').toLowerCase();
    const name = msg.sender_name || (email.split('@')[0] || '?');
    const key = email + '|' + meta.icon;
    const now = Date.now();
    set((s) => {
      const banners = s.giftBanners.slice();
      const idx = banners.findIndex(b => b.key === key && now - b.ts < GIFT_COMBO_WINDOW_MS);
      if (idx >= 0) {
        banners[idx] = { ...banners[idx], count: banners[idx].count + 1, ts: now };
      } else {
        banners.push({ key, id: key + '|' + now, email, name, icon: meta.icon, label: meta.label, diamonds, count: 1, ts: now });
        while (banners.length > MAX_GIFT_BANNERS) banners.shift();
      }
      return { giftBanners: banners };
    });
    if (diamonds >= BIG_GIFT_DIAMONDS) {
      const ev = { id: 'big_' + now + '_' + Math.random().toString(36).slice(2, 6), email, name, icon: meta.icon, label: meta.label, diamonds };
      if (!state.giftBig) set({ giftBig: ev });
      else if (bigQueue.length < MAX_BIG_QUEUE) bigQueue.push(ev);
    }
  };

  const qaRefresh = async () => {
    const sid = opts.sessionId;
    if (!sid) return;
    try {
      const r = await engApi.qaList(sid);
      if (sid !== opts.sessionId) return;
      if (r && r.success) {
        const d = r.data || {};
        set({ qaSupported: true, questions: Array.isArray(d.questions) ? d.questions : [], highlighted: d.highlighted || null });
      } else if (state.qaSupported == null) {
        set({ qaSupported: false });
      }
    } catch {
      if (state.qaSupported == null) set({ qaSupported: false });
    }
  };

  const api = {
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    getState() { return state; },
    setOpts(o) {
      const prevSid = opts.sessionId;
      Object.assign(opts, o);
      if (opts.sessionId && opts.sessionId !== prevSid) {
        // Chamado durante o render da tela: reseta SEM emitir (setState em
        // filho durante render do pai gera warning); os filhos leem
        // getState() no próprio render.
        state = { ...INITIAL };
        bigQueue.length = 0;
      }
    },
    probe() {
      if (!opts.sessionId || probedFor === opts.sessionId) return;
      probedFor = opts.sessionId;
      qaRefresh();
    },
    dispose() {
      if (likeTimer) { clearTimeout(likeTimer); likeTimer = null; }
      if (likePend) flushLikes();
      listeners.clear();
    },

    // ── Curtidas ────────────────────────────────────────────────────────
    queueLike({ x, color } = {}) {
      likePend += 1;
      if (typeof x === 'number' && isFinite(x)) likeX = Math.max(0, Math.min(1, x));
      if (typeof color === 'string') likeColor = color;
      if (state.likesTotal != null) set({ likesTotal: state.likesTotal + 1 });
      if (!likeTimer) likeTimer = setTimeout(flushLikes, LIKE_FLUSH_MS);
    },
    // Quantos corações desenhar para um live_reaction recebido.
    heartsFor(msg) {
      if (!msg) return 0;
      if (msg.like && typeof msg.count === 'number') {
        let mine = 0;
        const me = meEmail();
        if (Array.isArray(msg.reactors) && me) {
          for (const r of msg.reactors) {
            if (String(r?.email || '').toLowerCase() === me) mine += Number(r.n) || 0;
          }
        }
        if (mine) selfEchoPending = Math.max(0, selfEchoPending - mine);
        return Math.max(0, Math.min(MAX_REMOTE_HEARTS_PER_FRAME, msg.count - mine));
      }
      return 1;
    },

    // ── WS (observador) ─────────────────────────────────────────────────
    onWsMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      switch (msg.type) {
        case 'live_joined':
        case 'live_started':
          setTimeout(() => wsSend({ type: 'live_engage_state', session_id: opts.sessionId }), 400);
          break;
        case 'live_reaction':
        case 'live_engage_state':
          if (typeof msg.likes_total === 'number') {
            set({ likesTotal: Math.max(state.likesTotal || 0, msg.likes_total) });
          }
          if (Array.isArray(msg.top_fans)) set({ topFans: msg.top_fans.slice(0, 3) });
          break;
        case 'live_top_fans':
          if (typeof msg.likes_total === 'number') set({ likesTotal: Math.max(state.likesTotal || 0, msg.likes_total) });
          if (Array.isArray(msg.fans)) set({ fans: msg.fans, fansLoading: false, topFans: msg.fans.slice(0, 3) });
          break;
        case 'live_qa_new': {
          const q = msg.question;
          if (!q || !q.id) break;
          set((s) => {
            if (s.questions.some(x => x.id === q.id)) return null;
            return {
              qaSupported: true,
              questions: [...s.questions, q].slice(-200),
              qaUnseen: opts.isHost && s.sheet !== 'qa' ? s.qaUnseen + 1 : s.qaUnseen,
            };
          });
          break;
        }
        case 'live_qa_update': {
          const id = Number(msg.id);
          if (!id) break;
          set((s) => {
            if (msg.status === 'dismissed') {
              return {
                questions: s.questions.filter(x => x.id !== id),
                highlighted: s.highlighted && s.highlighted.id === id ? null : s.highlighted,
              };
            }
            return {
              questions: s.questions.map(x => (x.id === id
                ? { ...x, upvotes: typeof msg.upvotes === 'number' ? msg.upvotes : x.upvotes, status: msg.status || x.status }
                : x)),
            };
          });
          break;
        }
        case 'live_qa_highlight': {
          const q = msg.question || null;
          set((s) => ({
            highlighted: q,
            questions: s.questions.map(x => {
              if (q && x.id === q.id) return { ...x, status: 'highlighted' };
              if (x.status === 'highlighted') return { ...x, status: 'answered' };
              return x;
            }),
          }));
          break;
        }
        case 'live_gift':
          if (LIVE_GIFTS_ENABLED) pushGift(msg);
          break;
        default:
          break;
      }
    },

    // ── Top fãs ─────────────────────────────────────────────────────────
    requestTopFans() {
      if (!opts.sessionId) return;
      set({ fansLoading: true });
      if (!wsSend({ type: 'live_top_fans', session_id: opts.sessionId })) set({ fansLoading: false });
      // Hub antigo nunca responde → solta o spinner.
      setTimeout(() => { if (state.fansLoading) set({ fansLoading: false }); }, 2500);
      if (LIVE_GIFTS_ENABLED) {
        engApi.topGifters(opts.sessionId).then((r) => {
          const list = r?.data?.gifters || r?.gifters;
          if (Array.isArray(list)) set({ gifters: list });
        }).catch(() => {});
      }
    },

    // ── Sheets ──────────────────────────────────────────────────────────
    openSheet(name) {
      set({ sheet: name, ...(name === 'qa' ? { qaUnseen: 0 } : null) });
      if (name === 'fans') api.requestTopFans();
      if (name === 'qa') qaRefresh();
    },
    closeSheet() { set({ sheet: null }); },

    // ── Presentes ───────────────────────────────────────────────────────
    dismissGiftBanner(id) {
      set((s) => ({ giftBanners: s.giftBanners.filter(b => b.id !== id) }));
    },
    bigGiftDone() { playNextBig(); },
    sendGift(sku) { return engApi.giftSend(opts.sessionId, sku); },

    // ── Q&A ─────────────────────────────────────────────────────────────
    qaRefresh,
    async qaAsk(text) {
      const r = await engApi.qaAsk(opts.sessionId, text);
      const q = r?.data?.question;
      if (r?.success && q && q.id) {
        set((s) => (s.questions.some(x => x.id === q.id) ? null : { questions: [...s.questions, q] }));
      }
      return r;
    },
    async qaUpvote(id) {
      set((s) => ({ questions: s.questions.map(x => (x.id === id && !x.voted ? { ...x, voted: true, upvotes: (x.upvotes || 0) + 1 } : x)) }));
      try { return await engApi.qaUpvote(opts.sessionId, id); } catch { return null; }
    },
    async qaHighlight(id) {
      const r = await engApi.qaHighlight(opts.sessionId, id || 0);
      if (r?.success) api.onWsMessage({ type: 'live_qa_highlight', question: r.data?.question || null });
      return r;
    },
    async qaDismiss(id) {
      const r = await engApi.qaDismiss(opts.sessionId, id);
      if (r?.success) api.onWsMessage({ type: 'live_qa_update', id, status: 'dismissed' });
      return r;
    },
    getOpts() { return opts; },
  };
  return api;
}

/** Hook da tela: controlador estável por montagem. */
export function useLiveEngageController({ sessionId, wsRef, me, isHost }) {
  const ref = useRef(null);
  if (!ref.current) ref.current = createController();
  const ctl = ref.current;
  ctl.setOpts({ sessionId: sessionId ? String(sessionId) : '', wsRef, me: me || {}, isHost: !!isHost });
  useEffect(() => { if (sessionId) ctl.probe(); }, [sessionId, ctl]);
  useEffect(() => () => ctl.dispose(), [ctl]);
  return ctl;
}

/** Componentes: lê uma fatia do store (re-render só quando ela muda). */
export function useEngageSelector(engage, selector) {
  const sub = useCallback((l) => (engage ? engage.subscribe(l) : () => {}), [engage]);
  const get = useCallback(() => (engage ? selector(engage.getState()) : selector(INITIAL)), [engage, selector]);
  return useSyncExternalStore(sub, get, get);
}

export const selLikesTotal = (s) => s.likesTotal;
export const selTopFans = (s) => s.topFans;
export const selSheet = (s) => s.sheet;
export const selQaSupported = (s) => s.qaSupported;
export const selQaUnseen = (s) => s.qaUnseen;
export const selHighlighted = (s) => s.highlighted;
export const selQuestions = (s) => s.questions;
export const selFans = (s) => s.fans;
export const selFansLoading = (s) => s.fansLoading;
export const selGifters = (s) => s.gifters;
export const selGiftBanners = (s) => s.giftBanners;
export const selGiftBig = (s) => s.giftBig;
