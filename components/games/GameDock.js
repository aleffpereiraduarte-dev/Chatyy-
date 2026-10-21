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
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming, runOnJS } from 'react-native-reanimated';
import { grafite } from '../../constants/theme';
import { useRM } from './motion';
import { IconChevronUp, IconX } from '../Icons';
import { GameTypeIcon, IconGamepad } from './GameIcons';
import { gamePalette, hTap, hOk } from './fx';
import GamePicker from './GamePicker';
import GamePlay from './GamePlay';
import { registerGameSheetHost, registerGamePickerHost, gamesDockOn, SHEET_TYPES, setDockedGame } from '../../services/gamesInline';
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

// [2026-10-20 dock-kb] nunca o painel inteiro + teclado juntos: teclado aberto (ou composer com foco) = faixa fina
// logo acima do composer (que sobe grudado no teclado). Sinais: Keyboard will/did + foco do composer
// (composerFocused) + estado na hora de abrir (o painel abre sozinho quando o outro aceita — com o teclado já
// aberto não chega evento de "show": era o print de 20/10, Cartas por baixo do teclado e composer escondido).
function _kbUp() { try { return !!(Keyboard.isVisible && Keyboard.isVisible()); } catch { return false; } }

// [jogos 2026-10-21 painel] o painel vira FOLHA (mockup jogos2): alça, raio 30 em cima, sobe com mola ao abrir e
// arrastar p/ baixo pela faixa de cima (alça + cabeçalho) fecha (seletor) ou recolhe na faixa fina (partida).
// Tudo na UI thread (RNGH + Reanimated); Reduzir Movimento = sem mola (aparece pronto). O resto do painel
// (rolagem, tabuleiro, cartas) nem vê o gesto: só toques que começam nos primeiros `zone` pt.
const DRAG_DIST = 90;
const GRAB_H = 19; // alça: 8 + 5 + 6
const DRAG_VEL = 900;
function DockSheet({ height, bg, line, isDark, rm, zone, openKey, onDragClose, children, label }) {
  const y = useSharedValue(rm ? 0 : 46);
  const op = useSharedValue(rm ? 1 : 0.4);
  const closeRef = useRef(onDragClose);
  useEffect(() => { closeRef.current = onDragClose; }, [onDragClose]);
  useEffect(() => {
    if (rm) { y.value = 0; op.value = 1; return; }
    y.value = 46; op.value = 0.4;
    y.value = withSpring(0, { damping: 18, stiffness: 210, mass: 0.9 });
    op.value = withTiming(1, { duration: 220 });
  }, [openKey, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const fire = useCallback(() => { try { closeRef.current && closeRef.current(); } catch {} }, []);
  const pan = useMemo(() => Gesture.Pan()
    .activeOffsetY(10)
    .failOffsetY(-10)
    .failOffsetX([-18, 18])
    .onTouchesDown((e, mgr) => {
      'worklet';
      const t0 = e.allTouches && e.allTouches[0];
      if (!t0 || t0.y > zone) mgr.fail();
    })
    .onUpdate((e) => { 'worklet'; y.value = Math.max(0, e.translationY); })
    .onEnd((e) => {
      'worklet';
      if (y.value > DRAG_DIST || e.velocityY > DRAG_VEL) {
        y.value = withTiming(height, { duration: rm ? 1 : 170 }, (fin) => { 'worklet'; if (fin) runOnJS(fire)(); });
      } else y.value = withSpring(0, { damping: 22, stiffness: 300 });
    }), [zone, height, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const ast = useAnimatedStyle(() => ({ transform: [{ translateY: y.value }], opacity: op.value }));
  return (
    <GestureDetector gesture={pan}>
      <Animated.View style={[st.dock, st.sheet, { height, backgroundColor: bg }, isDark ? null : st.sheetShadow, ast]}>
        <View style={st.grabZone} accessible accessibilityRole="adjustable" accessibilityLabel={label}
          accessibilityActions={[{ name: 'decrement' }, { name: 'escape' }]}
          onAccessibilityAction={(e) => { const n = e.nativeEvent.actionName; if (n === 'decrement' || n === 'escape') fire(); }}
          onAccessibilityEscape={fire}>
          <View style={[st.grab, { backgroundColor: line }]} />
        </View>
        {children}
      </Animated.View>
    </GestureDetector>
  );
}

export default function GameDock({ conversationId, conversationType, members, currentEmail, t, colors, isDark, onSendText, composerFocused = false, onBlurComposer }) {
  const pal = useMemo(() => gamePalette(colors || {}, !!isDark), [colors, isDark]);
  const rm = useRM();
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

  const focusRef = useRef(composerFocused);
  focusRef.current = composerFocused;
  const blurRef = useRef(onBlurComposer);
  blurRef.current = onBlurComposer;
  const expandTm = useRef(null);
  // teclado no ar → abre RECOLHIDO e só expande quando ele descer (hide/blur)
  const startState = () => { const up = _kbUp() || !!focusRef.current; kbCollapsed.current = up; setCollapsed(up); };
  const dropKeyboard = () => {
    if (!(_kbUp() || focusRef.current)) return;
    try { blurRef.current && blurRef.current(); } catch {}
    try { Keyboard.dismiss(); } catch {}
  };
  const openPlay = useCallback((id) => {
    if (!id) return;
    setGid(Number(id)); setMode('play'); startState();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const close = useCallback(() => { setMode(null); setGid(0); setCollapsed(false); kbCollapsed.current = false; }, []);

  // hosts: "abrir jogo" e "abrir seletor" vindos do cartão / do "+"
  useEffect(() => {
    if (!gamesDockOn()) return undefined;
    const host = (id, cid) => {
      if (cid && cidRef.current && String(cid) !== String(cidRef.current)) return false; // jogo de outra conversa → rota
      openPlay(id);
      dropKeyboard();
      return true;
    };
    host.dock = true;
    const offA = registerGameSheetHost(host);
    const offB = registerGamePickerHost((cid) => {
      if (cid && cidRef.current && String(cid) !== String(cidRef.current)) return false;
      setMode('pick'); setGid(0); startState();
      dropKeyboard();
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
    const up = () => { if (expandTm.current) { clearTimeout(expandTm.current); expandTm.current = null; } setCollapsed((c) => { if (!c) kbCollapsed.current = true; return true; }); };
    // composer ainda com foco (painel de emoji no lugar do teclado) → segue recolhido até o blur
    const down = () => { if (kbCollapsed.current && !focusRef.current) { kbCollapsed.current = false; setCollapsed(false); } };
    const subs = [Keyboard.addListener(showEv, up), Keyboard.addListener(hideEv, down)];
    if (Platform.OS === 'ios') { subs.push(Keyboard.addListener('keyboardDidShow', up)); subs.push(Keyboard.addListener('keyboardDidHide', down)); }
    // rede de segurança: abriu/expandiu com o teclado já no ar (sem evento novo)
    if (_kbUp()) up();
    return () => { subs.forEach((x) => { try { x.remove(); } catch {} }); };
  }, [mode]);
  // foco do composer (sinal do próprio campo, vale mesmo se o evento de teclado não chegar)
  const prevFocus = useRef(composerFocused);
  useEffect(() => {
    const was = prevFocus.current;
    prevFocus.current = composerFocused;
    if (!mode || was === composerFocused) return;
    if (composerFocused) { setCollapsed((c) => { if (!c) kbCollapsed.current = true; return true; }); return; }
    if (kbCollapsed.current && !_kbUp()) { kbCollapsed.current = false; setCollapsed(false); }
  }, [composerFocused, mode]);
  useEffect(() => () => { if (expandTm.current) clearTimeout(expandTm.current); }, []);
  // tocar na faixa: com teclado → desce o teclado e o jogo abre quando ele sair (nunca os dois juntos)
  const expand = () => {
    hTap();
    if (_kbUp() || focusRef.current) {
      kbCollapsed.current = true;
      try { blurRef.current && blurRef.current(); } catch {}
      try { Keyboard.dismiss(); } catch {}
      if (expandTm.current) clearTimeout(expandTm.current);
      expandTm.current = setTimeout(() => { expandTm.current = null; if (!_kbUp() && kbCollapsed.current) { kbCollapsed.current = false; setCollapsed(false); } }, 650);
      return;
    }
    kbCollapsed.current = false;
    setCollapsed(false);
  };

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

  // [2026-10-20 dock-imersivo] partida no painel expandido → o cartão dela na conversa vira 1 linha
  useEffect(() => { setDockedGame(mode === 'play' && !collapsed ? gid : 0); }, [mode, gid, collapsed]);
  useEffect(() => () => setDockedGame(0), []);

  // trocou de conversa (mesma tela) → fecha
  useEffect(() => { close(); lastSt.current = new Map(); }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!mode || !conversationId) return null;
  if (collapsed) {
    return (
      <CollapsedBar mode={mode} gid={gid} pal={pal} t={t} me={me}
        onExpand={expand}
        onClose={() => { hTap(); close(); }} />
    );
  }

  // modo jogo: o painel toma a área da conversa até o composer (sobra uma tira da conversa em cima)
  const dockH = mode === 'play'
    ? Math.round(Math.max(300, Math.min(winH * 0.64, winH - 300)))
    : Math.round(Math.max(300, Math.min(winH * 0.6, 540)));

  const G = grafite(!!isDark);
  return (
    <DockSheet height={dockH} bg={mode === 'pick' ? G.bg : pal.bg} line={isDark ? 'rgba(255,255,255,0.22)' : 'rgba(127,127,127,0.35)'} isDark={!!isDark} rm={rm}
      zone={mode === 'pick' ? 64 : 62} openKey={mode}
      label={mode === 'pick' ? tr(t, 'games.panel.dragClose', 'Arraste para baixo para fechar') : tr(t, 'games.panel.dragCollapse', 'Arraste para baixo para recolher')}
      onDragClose={mode === 'pick' ? close : () => { kbCollapsed.current = false; setCollapsed(true); }}>
      {mode === 'pick' ? (
        <GamePicker panel visible onClose={close} conversationId={conversationId} conversationType={conversationType}
          members={members} currentEmail={currentEmail} t={t} colors={colors} isDark={isDark}
          onCreated={() => {}}
          onOpenGame={(gv) => { if (gv && gv.g) openPlay(gv.g); }} />
      ) : (
        <GamePlay key={gid} gid={gid} cid={conversationId} docked dockH={dockH - GRAB_H}
          onClose={close} onOpenGame={(id) => openPlay(id)}
          onCollapse={() => { kbCollapsed.current = false; setCollapsed(true); }}
          onSendText={onSendText} />
      )}
    </DockSheet>
  );
}

const st = StyleSheet.create({
  dock: {
    width: '100%', overflow: 'hidden', borderTopWidth: StyleSheet.hairlineWidth,
    // integrado: sem cantos/cartão — só o filete de cima separa da conversa
    ...(Platform.OS === 'web' ? { maxWidth: 960, alignSelf: 'center' } : null),
  },
  sheet: {
    borderTopWidth: 0, borderTopLeftRadius: 30, borderTopRightRadius: 30,
    ...(Platform.OS === 'web' ? { boxShadow: '0px -10px 30px rgba(0,0,0,0.12)' } : null),
  },
  sheetShadow: Platform.OS === 'web' ? {} : { boxShadow: '0px -10px 30px rgba(0,0,0,0.12)' },
  grabZone: { alignItems: 'center', paddingTop: 8, paddingBottom: 6 },
  grab: { width: 38, height: 5, borderRadius: 3 },
  bar: { flexDirection: 'row', alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, paddingLeft: 12, paddingRight: 10, paddingVertical: 6, gap: 8 },
  barMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 2 },
  barIcon: { width: 30, height: 30, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  barClose: { width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
});
