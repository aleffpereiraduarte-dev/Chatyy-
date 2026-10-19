// app/game/[id].js — [jogos 2026-10-18] Tela do jogo (rota antiga).
// [jogos 2026-10-19 inline] O corpo da partida mudou para components/games/GamePlay.js, que também roda
// na folha POR CIMA da conversa (components/games/GamePlaySheet.js). A conversa não navega mais para cá
// (globalThis.__chatyy_games_inline = false volta a navegar); a rota fica para deep links e apps antigos.
import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import GamePlay from '../../components/games/GamePlay';

export default function GameScreen() {
  const params = useLocalSearchParams();
  return <GamePlay gid={Number(params.id)} cid={params.cid} />;
}
