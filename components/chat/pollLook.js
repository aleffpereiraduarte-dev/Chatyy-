// components/chat/pollLook.js — [2026-10-16 poll-wa]
// Visual da ENQUETE estilo WhatsApp, compartilhado pelo render JS
// (app/chat-conversation.js case 'poll') e pela lista NATIVA
// (components/chat/nativeRowCards.js buildPoll): a enquete ocupa a bolha toda
// (sem cartão branco aninhado), título em negrito, opções com check redondo,
// contagem por opção e barra fina; rodapé "Ver votos" separado por hairline.
// Cores derivam da TINTA da bolha (P&B): própria preta → texto/barras brancas;
// recebida clara → texto/barras pretas.
import { toArgb } from './argb';

// Mesmo teto do servidor (api/chat.php chat_create_poll: 10 opções, 200 chars,
// pergunta 300 chars).
export const POLL_MAX_OPTIONS = 10;
export const POLL_MAX_OPTION_LEN = 200;
export const POLL_MAX_QUESTION_LEN = 300;

/** Cor CSS com alfa a partir da tinta (qualquer formato aceito por toArgb). */
export function inkAlpha(ink, a) {
  const n = toArgb(ink, 0xff111111);
  return `rgba(${(n >>> 16) & 255},${(n >>> 8) & 255},${n & 255},${a})`;
}

/** Cor do ✓ dentro do círculo preenchido com a tinta (contraste). */
export function onInk(ink) {
  const n = toArgb(ink, 0xff111111);
  const r = (n >>> 16) & 255; const g = (n >>> 8) & 255; const b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.55 ? '#000000' : '#FFFFFF';
}

/** Normaliza o objeto da enquete (servidor manda votes=[n…] ou vote_counts). */
export function normPoll(m) {
  if (!m) return null;
  let poll = m.poll;
  if (poll && !Array.isArray(poll.vote_counts) && Array.isArray(poll.votes)) {
    poll = { ...poll, vote_counts: poll.votes, total_votes: typeof poll.total_votes === 'number' ? poll.total_votes : poll.votes.reduce((a, v) => a + (v || 0), 0) };
  }
  if (!poll && typeof m.content === 'string') {
    try {
      const p = JSON.parse(m.content.trim());
      if (p && p.question && Array.isArray(p.options)) {
        poll = {
          ...p, id: m.id,
          vote_counts: Array.isArray(p.votes) ? p.votes : [],
          total_votes: Array.isArray(p.votes) ? p.votes.reduce((a, b) => a + (b || 0), 0) : 0,
          my_votes: Array.isArray(p.my_votes) ? p.my_votes : [],
        };
      }
    } catch {}
  }
  return poll || null;
}

function _tr(tr, k, fb) {
  try { const v = typeof tr === 'function' ? tr(k) : ''; return v && v !== k ? v : fb; } catch { return fb; }
}

export function votesLabel(n, tr, zeroAsCount = false) {
  const v = Number(n) || 0;
  if (v === 0 && !zeroAsCount) return _tr(tr, 'chat.pollNoVotes', 'Nenhum voto ainda');
  if (v === 1) return _tr(tr, 'chat.pollOneVote', '1 voto');
  return String(_tr(tr, 'chat.pollVotes', '{n} votos')).replace('{n}', String(v));
}

/** Rótulos fixos da bolha. */
export function pollTexts(poll, tr) {
  return {
    sub: poll && poll.multiple_choice
      ? _tr(tr, 'chat.pollSelectMany', 'Selecione uma ou mais')
      : _tr(tr, 'chat.pollSelectOne', 'Selecione uma opção'),
    viewVotes: _tr(tr, 'chat.pollViewVotes', 'Ver votos'),
    quiz: _tr(tr, 'chat.quiz', 'Quiz'),
    explanation: _tr(tr, 'chat.quizExplanation', 'Explicação'),
  };
}

/** Números da enquete (contagens/percentuais/meus votos). */
export function pollStats(poll) {
  const opts = Array.isArray(poll && poll.options) ? poll.options : [];
  const counts = Array.isArray(poll && poll.vote_counts) ? poll.vote_counts : [];
  let total = Number(poll && poll.total_votes);
  if (!Number.isFinite(total) || total < 0) total = counts.reduce((a, b) => a + (Number(b) || 0), 0);
  const mine = Array.isArray(poll && poll.my_votes) ? poll.my_votes : [];
  const rows = opts.map((o, i) => {
    const c = Number(counts[i]) || 0;
    return { text: String(o == null ? '' : o), count: c, frac: total > 0 ? Math.max(0, Math.min(1, c / total)) : 0, mine: mine.includes(i) };
  });
  const isQuiz = !!(poll && poll.is_quiz);
  const correct = poll && Number.isInteger(poll.correct_option) ? poll.correct_option : -1;
  return { rows, total, hasVoted: mine.length > 0, isQuiz, correct };
}

/** "Ver votos": resumo por opção (o servidor não expõe quem votou). */
export function showPollVotes(poll, tr, alertFn) {
  if (!poll || typeof alertFn !== 'function') return;
  const S = pollStats(poll);
  const you = _tr(tr, 'chat.youVoted', 'Você votou');
  const lines = S.rows.map((r) => `${r.text} — ${votesLabel(r.count, tr, true)}${r.mine ? ` (${you})` : ''}`);
  lines.push('', votesLabel(S.total, tr));
  try { alertFn(String(poll.question || _tr(tr, 'chat.poll', 'Enquete')), lines.join('\n')); } catch {}
}
