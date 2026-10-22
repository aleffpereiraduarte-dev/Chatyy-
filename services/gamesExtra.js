// services/gamesExtra.js — [jogos3 2026-10-22] registro de Xadrez (xadrez) e "Quem me conhece mais?" (conhece).
// Servidor: api/games_engine_xadrez.php / games_engine_conhece.php (gm_ext_register, LIVE). Aqui só textos de
// catálogo, status do cartão, erros e regras — services/games.js / RulesSheet.js mesclam isto
// (sem import circular: `tr`/`nameOf` vêm por parâmetro).

export const EXTRA_TYPES = ['xadrez', 'conhece'];
export const EXTRA_TITLES = { xadrez: 'Xadrez', conhece: 'Quem me conhece mais?' };
export const EXTRA_SUBS = { xadrez: 'Regras completas, xeque-mate', conhece: 'Adivinhe as respostas do outro, 2 a 8' };
/** Jogos com placar por pontos (ranking/pódio mostram "pts"). */
export const EXTRA_POINTS = { conhece: 1 };
export const EXTRA_ERRORS = {
  not_your_piece: 'Essa peça não é sua', illegal_move: 'Esse lance não vale', illegal_check: 'Seu rei está em xeque: proteja o rei',
  choose_promo: 'Escolha a peça da promoção',
};
export const EXTRA_RULES = {
  xadrez: [
    'Quem criou joga com as brancas e começa; na revanche as cores trocam.',
    'Toque numa peça sua para ver as casas possíveis e toque no destino. Só lances válidos são aceitos.',
    'Vale tudo do xadrez: roque, en passant e promoção (você escolhe dama, torre, bispo ou cavalo).',
    'Xeque-mate vence. Sem lances e sem xeque é afogamento: empate.',
    'Também é empate: tripla repetição, 50 lances sem captura nem lance de peão, ou material insuficiente. Dá para propor empate.',
  ],
  conhece: [
    'A cada rodada uma pessoa é a vez de ser o alvo; as perguntas são sobre ela.',
    'O alvo marca a resposta verdadeira. Os outros tentam adivinhar o que o alvo marcou, todos ao mesmo tempo e em segredo.',
    'Na revelação, quem acertou ganha 10 pontos. Cada pergunta tem 60 segundos.',
    'Funciona em dupla ou em grupo de até 8. Vence quem somar mais: quem conhece melhor os outros.',
  ],
};

/** Linha de status do cartão/cabeçalho para partida EM ANDAMENTO (null = usa a regra comum). */
export function extraStatusLine(t, g, meEmail, tr, nameOf) {
  if (!g || g.status !== 'active' || !EXTRA_TITLES[g.type]) return null;
  const I = g.info || {};
  if (g.type === 'conhece' && I.i && I.count) {
    if (I.ph === 'rev') return tr(t, 'games.conhece.statusRev', 'Pergunta {i} de {n} · revelando', { i: I.i, n: I.count });
    return tr(t, 'games.conhece.status', 'Pergunta {i} de {n}', { i: I.i, n: I.count });
  }
  if (g.type === 'xadrez' && I.check && g.turn) {
    const me = String(meEmail || '').toLowerCase();
    if (String(g.turn).toLowerCase() === me) return tr(t, 'games.xadrez.statusCheckYou', 'Xeque! Sua vez');
    return tr(t, 'games.xadrez.statusCheck', 'Xeque · vez de {name}', { name: nameOf(g, g.turn, meEmail, t) });
  }
  return null;
}
