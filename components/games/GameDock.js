// components/games/GameDock.js — [jogos 2026-10-20 dock] jogo DENTRO da tela da conversa, estilo MSN.
//
// Painel embutido acima do composer (no fluxo do layout: a lista da conversa encolhe e continua rolável,
// o composer e o chat seguem funcionando). Nada de Modal/folha — nunca folha sobre folha no iOS.
//   - modo 'pick': seletor de jogo ("Jogos" do "+") → cria o convite; o CARTÃO na conversa é o lobby
//     (convidado/pronto, aceitar, recusar, cancelar, revanche) e o painel fecha.
//   - modo 'play': partida de Damas/Cartas (ou qualquer jogo escolhido em "Em andamento"), GamePlay docked.
//     Abre sozinho quando uma partida de Damas/Cartas desta conversa em que eu jogo sai de "pendente" para
//     "ativa" (o outro aceitou o convite/revanche) — Velha/Forca/Quiz jogam no próprio cartão.
//   - teclado abriu (responder no chat) → o painel recolhe numa faixa fina (vez/estado) e volta ao fechar.
//   - frases rápidas ("Boa jogada!", "Sua vez!") = mensagens normais da conversa (onSendText).
//
// Uso (tela da conversa, 1× por tela, logo acima do composer):
//   <GameDock conversationId conversationType members currentEmail t colors isDark onSendText />
// Abrir: services/gamesInline.openPickerInChat(cid) / openGameInChat(gid, cid, router, hint).
// Kill (OTA): globalThis.__chatyy_games_dock = false → volta a folha de 19/10 (GamePicker/GamePlaySheet).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Keyboard, Platform, BackHandler, useWindowDimensions } from 'react-native';
import { IconChevronUp, IconX } from '../Icons';
import { GameTypeIcon, IconGamepad } from './GameIcons';
import { gamePalette, hTap, hOk } from './fx';
import GamePicker from './GamePicker';
import GamePlay from './GamePlay';
import { registerGameSheetHost, registerGamePickerHost, gamesDockOn, SHEET_TYPES } from '../../services/gamesInline';
import { getGameView, subscribeGame, onAnyGameView, gameTitle, gameStatusLine, isMyTurn, tr } from '../../services/games';

const lc = (x) => String(x || '').toLowerCase();

function CollapsedBar({ mode, gid, pal, t, me, onExpand, onClose }) {
  const [v, setV] = useState(() => (gid ? getGameView(gid) : null));
  useEffect(() => (gid ? subscribeGame(gid, setV) : undefined), [gid]);
  const mine = isMyTurn(v, me);
  const title = mode === 'pick' ? tr(t, 'games.menu', 'Jogos') : (v ? gameTitle(t, v.type) : tr(t, 'games.menu', 'Jogos'));
  const sub = mode === 'pick' ? tr(t, 'games.dock.pickHint', 'Escolha um jogo') : (v ? gameStatusLine(t, v, me) : '');
  return (
    <View style={[st.bar, { borderTopColor: pal.line, backgroundColor: pal.bg }]}>
      <Pressable onPress={onExpand} style={st.barMain} accessibilityRole="button" accessibilityLabel={`${title}. ${sub}. ${tr(t, 'games.dock.expand', 'Abrir o jogo')}`}>
        <View style={[st.barIcon, { backgroundColor: pal.strong }]}>
          {mode === 'pick' || !v ? <IconGamepad size={15} color={pal.onStrong} /> : <GameTypeIcon type={v.type} size={15} color={pal.onStrong} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 14 }} numberOfLines={1}>{title}</Text>
          {sub ? <Text style={{ color: mine ? pal.ink : pal.sub, fontWeight: mine ? '800' : '600', fontSize: 12 }} numberOfLines={1}>{sub}</Text> : null}
        </View>
        <IconChevronUp size={20} color={pal.ink} />
      </Pressable>
      <Pressable onPress={onClose} hitSlop={10} style={[st.barClose, { backgroundColor: pal.card2 }]} accessibilityRole="button" accessibilityLabel={tr(t, 'common.close', 'Fechar')}>
        <IconX size={14} color={pal.ink} />
      </Pressable>
    </View>
  );
}

export default function GameDock({ conversationId, conversationType, members, currentEmail, t, colors, isDark, onSendText }) {
  const pal = useMemo(() => gamePalette(colors || {}, !!isDark), [colors, isDark]);
  const { width: winW, height: winH } = useWindowDimensions();
  const [mode, setMode] = useState(null); // null | 'pick' | 'play'
  const [gid, setGid] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const kbCollapsed = useRef(false);
  const cidRef = useRef(conversationId);
  cidRef.current = conversationId;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const me = lc(currentEmail);

  const dropKeyboard = () => { try { if (Keyboard.isVisible && Keyboard.isVisible()) Keyboard.dismiss(); } catch {} };
  const openPlay = useCallback((id) => {
    if (!id) return;
    setGid(Number(id)); setMode('play'); setCollapsed(false); kbCollapsed.current = false;
  }, []);
  const close = useCallback(() => { setMode(null); setGid(0); setCollapsed(false); kbCollapsed.current = false; }, []);

  // hosts: "abrir jogo" e "abrir seletor" vindos do cartão / do "+"
  useEffect(() => {
    if (!gamesDockOn()) return undefined;
    const host = (id, cid) => {
      if (cid && cidRef.current && String(cid) !== String(cidRef.current)) return false; // jogo de outra conversa → rota
      dropKeyboard();
      openPlay(id);
      return true;
    };
    host.dock = true;
    const offA = registerGameSheetHost(host);
    const offB = registerGamePickerHost((cid) => {
      if (cid && cidRef.current && String(cid) !== String(cidRef.current)) return false;
      dropKeyboard();
      setMode('pick'); setGid(0); setCollapsed(false); kbCollapsed.current = false;
      return true;
    });
    return () => { offA(); offB(); };
  }, [openPlay]);

  // Damas/Cartas começou (o outro aceitou) → abre o tabuleiro no painel, sem tocar em nada
  const lastSt = useRef(new Map());
  useEffect(() => {
    if (!gamesDockOn()) return undefined;
    return onAnyGameView((v) => {
      try {
        if (!v || !v.g || String(v.conversation_id) !== String(cidRef.current)) return;
        const id = Number(v.g);
        const prev = lastSt.current.get(id);
        lastSt.current.set(id, v.status);
        if (v.status !== 'active' || prev === 'active' || prev === 'finished') return;
        // 1ª visão já ativa (o WS do "pendente" não chegou aqui): só se acabou de começar — nenhum lance ainda
        // (cada gravação sobe a versão: criar 1 + aceites) e atualizada há pouco. Partida velha não abre sozinha.
        if (prev === undefined) {
          const seats = Array.isArray(v.seats) ? v.seats.length : 2;
          if (!(Number(v.v) <= seats + 1 && v.ts && Math.abs(Number(v.now || Date.now()) - Number(v.ts)) < 30000)) return;
        }
        if (!SHEET_TYPES[v.type] || v.me === null || v.me === undefined) return;
        if (modeRef.current === 'play' || modeRef.current === 'pick') return;
        hOk();
        openPlay(id);
      } catch {}
    });
  }, [openPlay]);

  // teclado (responder na conversa) → recolhe; desceu → volta
  useEffect(() => {
    if (!mode) return undefined;
    const showEv = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEv = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const a = Keyboard.addListener(showEv, () => { setCollapsed((c) => { if (!c) kbCollapsed.current = true; return true; }); });
    const b = Keyboard.addListener(hideEv, () => { if (kbCollapsed.current) { kbCollapsed.current = false; setCollapsed(false); } });
    return () => { try { a.remove(); } catch {} try { b.remove(); } catch {} };
  }, [mode]);

  // Android: voltar fecha/recolhe o painel antes de sair da conversa
  useEffect(() => {
    if (!mode || Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!collapsed) { setCollapsed(true); return true; }
      close();
      return true;
    });
    return () => { try { sub.remove(); } catch {} };
  }, [mode, collapsed, close]);

  // trocou de conversa (mesma tela) → fecha
  useEffect(() => { close(); lastSt.current = new Map(); }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mode || !conversationId) return null;
  if (collapsed) {
    return (
      <CollapsedBar mode={mode} gid={gid} pal={pal} t={t} me={me}
        onExpand={() => { hTap(); kbCollapsed.current = false; try { Keyboard.dismiss(); } catch {} setCollapsed(false); }}
        onClose={() => { hTap(); close(); }} />
    );
  }

  const dockH = mode === 'play'
    ? Math.round(Math.max(300, Math.min(winH * 0.58, winW + 150)))
    : Math.round(Math.max(280, Math.min(winH * 0.5, 460)));

  return (
    <View style={[st.dock, { height: dockH, backgroundColor: pal.bg, borderTopColor: pal.line }]}>
      {mode === 'pick' ? (
        <GamePicker panel visible onClose={close} conversationId={conversationId} conversationType={conversationType}
          members={members} currentEmail={currentEmail} t={t} colors={colors} isDark={isDark}
          onCreated={() => {}}
          onOpenGame={(gv) => { if (gv && gv.g) openPlay(gv.g); }} />
      ) : (
        <GamePlay key={gid} gid={gid} cid={conversationId} docked dockH={dockH}
          onClose={close} onOpenGame={(id) => openPlay(id)}
          onCollapse={() => { kbCollapsed.current = false; setCollapsed(true); }}
          onSendText={onSendText} />
      )}
    </View>
  );
}

const st = StyleSheet.create({
  dock: {
    width: '100%', overflow: 'hidden', borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 16, borderTopRightRadius: 16,
    ...(Platform.OS === 'web' ? { maxWidth: 960, alignSelf: 'center' } : null),
  },
  bar: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingLeft: 12, paddingRight: 10, paddingVertical: 6, gap: 8 },
  barMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 },
  barIcon: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  barClose: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
