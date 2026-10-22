// components/games/RulesSheet.js — [jogos 2026-10-18] "Como jogar" de cada jogo (texto original do Chatyy).
import React from 'react';
import { View, Text, ScrollView, StyleSheet } from 'react-native';
import { GameTypeIcon } from './GameIcons';
import GameSheet from './GameSheet';
import { hTap } from './fx';
import { PressScale } from './motion';
import { gameTitle, tr } from '../../services/games';
import { NOVOS_RULES } from '../../services/gamesNovos'; // [jogos2b]
import { EXTRA_RULES } from '../../services/gamesExtra'; // [jogos3]

export const RULES_FB = {
  damas: [
    'Tabuleiro 8×8; as peças andam só nas casas escuras. As brancas começam.',
    'A pedra anda uma casa na diagonal, sempre para a frente.',
    'Capturar é obrigatório: salte por cima da peça adversária para a casa livre logo depois. A pedra pode capturar para a frente e para trás.',
    'Se houver mais de um jeito de capturar, vale o que leva mais peças (lei da maioria). Numa sequência, toque cada casa de pouso.',
    'Chegou na última linha (e parou lá), a pedra vira dama: anda e captura a qualquer distância na diagonal.',
    'Perde quem fica sem peças ou sem lance. Depois de 20 lances de cada lado só com damas e sem captura, é empate.',
  ],
  velha: [
    'Tabuleiro 3×3. Quem criou a partida joga com X e começa; na revanche quem começa troca.',
    'Faça três marcas iguais em linha, coluna ou diagonal para vencer.',
    'Casas cheias sem ninguém completar uma linha: deu velha (empate).',
  ],
  cartas: [
    'De 2 a 6 jogadores; cada um recebe 7 cartas. O objetivo é ficar sem cartas primeiro.',
    'Na sua vez, jogue uma carta da mesma cor OU do mesmo número/símbolo da carta da mesa.',
    'Pular: o próximo perde a vez. Inverter: muda o sentido (com 2 jogadores funciona como Pular). +2: o próximo compra 2 e perde a vez.',
    'Coringa: vale sobre qualquer carta e você escolhe a nova cor. Coringa +4: o próximo compra 4 e perde a vez; só pode ser jogado quando você não tem carta da cor da mesa.',
    'Sem jogada? Compre uma carta. Se ela servir, você pode jogá-la na hora ou passar a vez.',
    'Em grupo, quem demora mais de 3 minutos compra 1 e passa a vez; três vezes seguidas sai da partida.',
  ],
  quiz: [
    '10 perguntas de conhecimentos gerais; todos respondem ao mesmo tempo.',
    'Cada pergunta tem 20 segundos. Acertar vale 500 pontos e mais até 500 pela rapidez.',
    'A resposta certa aparece quando todos responderam ou o tempo acabou.',
    'Vence quem somar mais pontos no fim.',
  ],
  forca: [
    'Uma palavra secreta com a categoria como dica; os jogadores se revezam.',
    'Acertou uma letra: +10 pontos por vez que ela aparece e você joga de novo. Errou: a vez passa e o boneco ganha uma parte.',
    'Pode chutar a palavra inteira: acertar dá bônus por letra escondida; errar conta como erro.',
    'Quem completar a palavra ganha +30. Seis erros e a forca vence (ninguém ganha).',
    'Em grupo, quem demora mais de 3 minutos perde a vez.',
  ],
};
// [jogos2 2026-10-21] Ligue 4, Batalha Naval, Dominó, Jogo da Memória
Object.assign(RULES_FB, {
  ligue4: [
    'Grade de 7 colunas e 6 linhas. Quem criou joga com as vermelhas e começa.',
    'Na sua vez, toque numa coluna: a ficha cai até a casa livre mais baixa.',
    'Vence quem fizer 4 fichas em linha: na horizontal, na vertical ou na diagonal.',
    'Grade cheia sem 4 em linha é empate. Também dá para propor empate.',
  ],
  naval: [
    'Cada um posiciona 5 barcos num mar 10×10: tamanhos 5, 4, 3, 3 e 2, na horizontal ou na vertical.',
    'Use Aleatório para sortear, toque num barco e em Girar para virar, ou toque numa casa para mover.',
    'Os barcos de cada um ficam escondidos: nem o aplicativo do outro sabe onde estão.',
    'Depois, os tiros se alternam: toque numa casa do mar do outro. Acertando ou não, a vez passa.',
    'Quando todas as casas de um barco são atingidas, ele afunda. Vence quem afundar a frota inteira primeiro.',
  ],
  domino: [
    'Dominó duplo-seis para 2: cada um recebe 7 pedras e 14 ficam no monte.',
    'Começa quem tem a maior bucha (pedra dupla). A primeira pedra pode ser qualquer uma.',
    'Na sua vez, encaixe uma pedra numa das pontas da mesa com o mesmo número.',
    'Sem pedra que encaixe, compre do monte até conseguir; com o monte vazio, passe a vez.',
    'Vence quem bater (ficar sem pedras). Se ninguém conseguir jogar, vence quem tiver menos pontos na mão.',
  ],
  memoria: [
    '16 cartas viradas para baixo formam 8 pares de figuras.',
    'Na sua vez, vire duas cartas. Se forem iguais, o par é seu e você joga de novo.',
    'Se forem diferentes, as duas desviram e a vez passa. Preste atenção nas cartas do outro!',
    'Acabaram as cartas: vence quem formou mais pares. Mesmo número de pares é empate.',
  ],
});

Object.assign(RULES_FB, NOVOS_RULES); // [jogos2b 2026-10-21] termo/ppt/stop/desenho
Object.assign(RULES_FB, EXTRA_RULES); // [jogos3 2026-10-22] xadrez/conhece

export function rulesFor(t, type) {
  const fb = RULES_FB[type] || [];
  return fb.map((line, i) => tr(t, `games.rules.${type}.${i + 1}`, line));
}

/** Corpo das regras (usado na folha própria e como passo do seletor de jogos). */
export function RulesBody({ type, t, pal, maxH = 460 }) {
  return (
    <>
      <View style={st.head}>
        <GameTypeIcon type={type} size={22} color={pal.ink} />
        <Text style={[st.title, { color: pal.ink }]}>{tr(t, 'games.rules.title', 'Como jogar {game}', { game: gameTitle(t, type) })}</Text>
      </View>
      <ScrollView style={{ maxHeight: maxH }} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 8 }}>
        {rulesFor(t, type).map((line, i) => (
          <View key={i} style={st.row}>
            <View style={[st.num, { backgroundColor: pal.strong }]}><Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 12 }}>{i + 1}</Text></View>
            <Text style={[st.tx, { color: pal.ink }]}>{line}</Text>
          </View>
        ))}
      </ScrollView>
    </>
  );
}

// [jogos 2026-10-19] folha NATIVA (GameSheet: detents + grabber do sistema; web = folha deslizante)
export default function RulesSheet({ visible, onClose, type, t, pal }) {
  if (!visible || !type) return null;
  const close = () => { hTap(); onClose && onClose(); };
  return (
    <GameSheet visible onClose={onClose} bg={pal.bg}>
      <RulesBody type={type} t={t} pal={pal} />
      <PressScale onPress={close} style={[st.ok, { backgroundColor: pal.strong }]} accessibilityRole="button">
        <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{tr(t, 'games.rules.ok', 'Entendi')}</Text>
      </PressScale>
    </GameSheet>
  );
}

const st = StyleSheet.create({
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 10 },
  title: { fontSize: 18, fontWeight: '800', flex: 1 },
  row: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  num: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  tx: { flex: 1, fontSize: 15, lineHeight: 21 },
  ok: { marginHorizontal: 16, marginTop: 6, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
});
