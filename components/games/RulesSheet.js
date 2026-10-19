// components/games/RulesSheet.js — [jogos 2026-10-18] "Como jogar" de cada jogo (texto original do Chatyy).
import React from 'react';
import { View, Text, Pressable, Modal, ScrollView, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GameTypeIcon } from './GameIcons';
import { gameTitle, tr } from '../../services/games';

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

export function rulesFor(t, type) {
  const fb = RULES_FB[type] || [];
  return fb.map((line, i) => tr(t, `games.rules.${type}.${i + 1}`, line));
}

export default function RulesSheet({ visible, onClose, type, t, pal }) {
  const ins = useSafeAreaInsets();
  if (!visible || !type) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={st.backdrop} onPress={onClose} accessibilityLabel={tr(t, 'common.close', 'Fechar')} />
      <View style={[st.sheet, { backgroundColor: pal.bg, paddingBottom: Math.max(ins.bottom, 16) }]}>
        <View style={st.grab} />
        <View style={st.head}>
          <GameTypeIcon type={type} size={22} color={pal.ink} />
          <Text style={[st.title, { color: pal.ink }]}>{tr(t, 'games.rules.title', 'Como jogar {game}', { game: gameTitle(t, type) })}</Text>
        </View>
        <ScrollView style={{ maxHeight: 460 }} contentContainerStyle={{ paddingHorizontal: 18, paddingBottom: 8 }}>
          {rulesFor(t, type).map((line, i) => (
            <View key={i} style={st.row}>
              <View style={[st.num, { backgroundColor: pal.strong }]}><Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 12 }}>{i + 1}</Text></View>
              <Text style={[st.tx, { color: pal.ink }]}>{line}</Text>
            </View>
          ))}
        </ScrollView>
        <Pressable onPress={onClose} style={[st.ok, { backgroundColor: pal.strong }]} accessibilityRole="button">
          <Text style={{ color: pal.onStrong, fontWeight: '800', fontSize: 15 }}>{tr(t, 'games.rules.ok', 'Entendi')}</Text>
        </Pressable>
      </View>
    </Modal>
  );
}

const st = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.42)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingTop: 8 },
  grab: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, backgroundColor: 'rgba(127,127,127,0.4)', marginBottom: 8 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 18, marginBottom: 10 },
  title: { fontSize: 18, fontWeight: '800', flex: 1 },
  row: { flexDirection: 'row', gap: 12, marginBottom: 12 },
  num: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  tx: { flex: 1, fontSize: 15, lineHeight: 21 },
  ok: { marginHorizontal: 16, marginTop: 6, borderRadius: 14, paddingVertical: 13, alignItems: 'center' },
});
