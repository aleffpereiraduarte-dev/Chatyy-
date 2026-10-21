// services/gamesNovos.js — [jogos2b 2026-10-21] registro dos jogos novos SIMULTÂNEOS (sem vez):
// Termo em dupla (termo), Pedra, papel e tesoura (ppt), Stop/Adedonha (stop), Desenha e Adivinha (desenho).
// Servidor: api/games_engine_<tipo>.php (gm_ext_register). Aqui só textos de catálogo, status do cartão,
// erros e regras — services/games.js / RulesSheet.js mesclam isto (sem import circular: `tr` vem por parâmetro).

export const NOVOS_TYPES = ['termo', 'ppt', 'stop', 'desenho'];
export const NOVOS_TITLES = { termo: 'Termo em dupla', ppt: 'Pedra, papel e tesoura', stop: 'Stop', desenho: 'Desenha e Adivinha' };
export const NOVOS_SUBS = {
  termo: 'Adivinhe a palavra antes do outro', ppt: 'Melhor de 3, jogada secreta',
  stop: 'Letra sorteada, preencha e STOP', desenho: 'Um desenha, o outro adivinha',
};
/** Jogos novos com placar por pontos (ranking/pódio mostram "pts"). */
export const NOVOS_POINTS = { ppt: 1, stop: 1, desenho: 1 };
export const NOVOS_ERRORS = {
  not_in_list: 'Essa palavra não está na lista', word_length: 'A palavra tem 5 letras', already_done: 'Você já terminou',
  stale_round: 'A rodada já mudou', already_picked: 'Você já escolheu nesta rodada',
  answers_locked: 'O tempo acabou: respostas fechadas', already_stopped: 'Alguém já pediu STOP', fill_all_first: 'Preencha todas as categorias para pedir STOP',
  not_review: 'A revisão ainda não começou', nothing_to_contest: 'Não há resposta para contestar',
  not_drawer: 'Agora é a vez do outro desenhar', drawer_cant_guess: 'Quem desenha não chuta', bad_strokes: 'Traço inválido',
  drawing_full: 'O quadro está cheio: limpe ou desfaça', too_many_guesses: 'Chutes demais nesta rodada', not_accepting: 'Espere a próxima rodada',
  bad_word: 'Digite uma palavra',
};
export const NOVOS_RULES = {
  termo: [
    'Os dois tentam descobrir a MESMA palavra secreta de 5 letras, cada um no seu ritmo.',
    'Cada um tem 6 tentativas. Verde: letra no lugar certo. Amarelo: a letra existe em outro lugar. Cinza: não tem.',
    'Acentos não contam: digite sem acento. Só vale palavra da lista do português.',
    'Vence quem acertar em menos tentativas; empate em tentativas vai para quem acertou primeiro. As tentativas do outro só aparecem no fim.',
  ],
  ppt: [
    'Melhor de 3: quem fizer 2 pontos primeiro vence.',
    'Cada um escolhe pedra, papel ou tesoura em segredo; as duas jogadas aparecem juntas quando os dois escolheram.',
    'Pedra quebra tesoura, tesoura corta papel, papel embrulha pedra. Jogadas iguais: a rodada se repete.',
  ],
  stop: [
    'Uma letra é sorteada. Preencha Nome, Cidade/País, Fruta, Animal, Cor e Objeto começando com ela.',
    'Quem preencher tudo pode pedir STOP: o outro ainda tem 10 segundos para terminar. Sem STOP, a rodada acaba em 3 minutos.',
    'Na revisão as respostas aparecem; você pode contestar uma resposta do outro que não valha.',
    'Pontos por categoria: 10 resposta única, 5 resposta igual à do outro, 0 vazia, com letra errada ou contestada.',
  ],
  desenho: [
    '4 rodadas, alternando quem desenha. Quem desenha vê a palavra; o outro vê só a categoria e o tamanho.',
    'Desenhe com o dedo (sem escrever a palavra!). Dá para trocar a cor, desfazer, limpar ou pular a palavra.',
    'Quem adivinha digita os chutes; acento e maiúsculas não importam. Cada rodada tem 60 segundos.',
    'Acertou: quem adivinhou ganha 50 pontos e quem desenhou 25, mais bônus pela rapidez. Vence quem somar mais.',
  ],
};

const _lc = (s) => String(s || '').toLowerCase();
/** Linha de status do cartão/cabeçalho para partida EM ANDAMENTO (null = usa a regra comum). */
export function novosStatusLine(t, g, meEmail, tr, nameOf) {
  if (!g || g.status !== 'active' || !NOVOS_TITLES[g.type]) return null;
  const I = g.info || {};
  const seats = Array.isArray(g.seats) ? g.seats : [];
  const mi = seats.findIndex((e) => _lc(e) === _lc(meEmail));
  const oi = mi === 0 ? 1 : 0;
  const other = seats[mi >= 0 ? oi : 1];
  const on = (e) => (e ? nameOf(g, e, meEmail, t) : '');
  if (g.type === 'termo' && Array.isArray(I.att)) {
    if (mi < 0) return tr(t, 'games.termo.statusSpect', '{a}: {x}/6 · {b}: {y}/6', { a: on(seats[0]), x: I.att[0], b: on(seats[1]), y: I.att[1] });
    if (I.done && I.done[mi]) return tr(t, 'games.termo.statusDone', 'Você terminou · {name} {n}/6', { name: on(other), n: I.att[oi] });
    return tr(t, 'games.termo.status', 'Você {x}/6 · {name} {y}/6', { x: I.att[mi], name: on(other), y: I.att[oi] });
  }
  if (g.type === 'ppt' && Array.isArray(I.sc)) {
    const a = mi >= 0 ? I.sc[mi] : I.sc[0]; const b = mi >= 0 ? I.sc[oi] : I.sc[1];
    if (mi >= 0 && I.picked && I.picked[mi] && !I.picked[oi]) return tr(t, 'games.ppt.statusWait', 'Rodada {r} · {a} x {b} · aguardando {name}', { r: I.r, a, b, name: on(other) });
    if (mi >= 0 && I.picked && !I.picked[mi]) return tr(t, 'games.ppt.statusPick', 'Rodada {r} · {a} x {b} · sua escolha', { r: I.r, a, b });
    return tr(t, 'games.ppt.status', 'Rodada {r} · {a} x {b}', { r: I.r, a, b });
  }
  if (g.type === 'stop' && I.letter) {
    if (I.ph === 'review') return tr(t, 'games.stop.statusReview', 'Letra {l} · revisando respostas', { l: I.letter });
    if (I.ph === 'grace') return tr(t, 'games.stop.statusGrace', 'Letra {l} · STOP! últimos segundos', { l: I.letter });
    return tr(t, 'games.stop.status', 'Letra {l} · preenchendo', { l: I.letter });
  }
  if (g.type === 'desenho' && I.r) {
    const drawer = seats[I.drawer];
    if (drawer && _lc(drawer) === _lc(meEmail)) return tr(t, 'games.desenho.statusYou', 'Rodada {r} de {n} · você desenha', { r: I.r, n: I.rounds || 3 });
    return tr(t, 'games.desenho.status', 'Rodada {r} de {n} · {name} desenha', { r: I.r, n: I.rounds || 3, name: on(drawer) });
  }
  return null;
}
