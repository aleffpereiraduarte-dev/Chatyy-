// [reels-v1 2026-10-13] Opt-in FUTURO: "Personalizar com meus interesses das conversas".
//
// ESTADO: DESLIGADO. Nada aqui é chamado em produção. A flag abaixo + o servidor
// (REELS_CHAT_TOPICS_ENABLED=on, coluna reels_user_prefs.personalize_from_chats) precisam
// estar ligados E o usuário precisa aceitar o consentimento explícito (i18n
// reels.interests.chatTopicsConsent) para qualquer coisa acontecer.
//
// Desenho (LGPD — dado de comunicação é sensível):
//   1. Extração SÓ no aparelho, sobre mensagens que o próprio app já decifrou/tem em cache
//      local (E2EE continua intacto: nada sai do aparelho além do resultado agregado).
//   2. Saída = no máximo 5 IDs de categoria do catálogo fechado (humor, pets, …) com peso 0–1.
//      Nunca texto, palavras, contatos, horários ou IDs de conversa.
//   3. Envio ≤ 1×/dia via reels_interests_set { chat_topics: { pets: 0.6, … } }; o servidor
//      aplica como sinal FRACO (máx. +1 por categoria, decai em 14 dias) e ignora se o opt-in
//      estiver desligado.
//   4. Desligar = para na hora + reels_interests_reset apaga o perfil. Conversas secretas,
//      grupos marcados como privados, menores de idade (contas Kids) e e-mails ficam FORA.
//   5. Sem uso para anúncios; sem compartilhamento com terceiros.
export const REELS_CHAT_TOPICS_CLIENT_ENABLED = false;

const KEYWORDS = {
  humor: ['kkk', 'meme', 'piada', 'engraçado', 'hahaha'],
  pets: ['cachorro', 'gato', 'pet', 'filhote', 'ração', 'veterinário'],
  sports: ['jogo', 'gol', 'futebol', 'treino de', 'campeonato', 'basquete'],
  music: ['música', 'show', 'banda', 'playlist', 'cantor', 'violão'],
  food: ['receita', 'jantar', 'almoço', 'restaurante', 'bolo', 'churrasco'],
  travel: ['viagem', 'praia', 'passagem', 'hotel', 'aeroporto', 'férias'],
  tech: ['celular', 'computador', 'app', 'notebook', 'programar', 'iphone'],
  beauty: ['maquiagem', 'cabelo', 'unha', 'skincare', 'salão'],
  games: ['jogar', 'game', 'console', 'partida', 'ranked', 'steam'],
  nature: ['trilha', 'cachoeira', 'natureza', 'acampar', 'montanha'],
  fitness: ['academia', 'treino', 'corrida', 'yoga', 'dieta'],
  art: ['desenho', 'pintura', 'arte', 'tatuagem', 'artesanato'],
};

// Puro e local: recebe textos já em memória, devolve só pesos por categoria (top 5).
export function extractTopicsOnDevice(texts) {
  if (!REELS_CHAT_TOPICS_CLIENT_ENABLED || !Array.isArray(texts) || texts.length === 0) return {};
  const counts = {};
  for (const raw of texts.slice(-500)) {
    const s = String(raw || '').toLowerCase();
    if (!s) continue;
    for (const [cat, words] of Object.entries(KEYWORDS)) {
      if (words.some((w) => s.includes(w))) counts[cat] = (counts[cat] || 0) + 1;
    }
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const max = top.length ? top[0][1] : 1;
  const out = {};
  for (const [cat, n] of top) out[cat] = Math.round((n / max) * 100) / 100;
  return out;
}
