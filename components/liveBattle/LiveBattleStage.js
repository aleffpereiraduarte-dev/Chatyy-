// [live-pk 2026-10-10] Tela dividida da Batalha PK (estilo TikTok LIVE Match).
//
//   ┌──────── barra do topo da live ────────┐
//   │  [ meu host ]  │  [ adversário ]       │  ← 2 retratos 3:4 lado a lado
//   │       VS   cronômetro 4:59            │
//   ├█████████ branco ███│▒▒▒ cinza ▒▒▒▒▒▒▒─┤  ← placar (curtidas)
//   │  MVP fulano            MVP beltrano   │
//   └───────────────────────────────────────┘
// No fim: carimbo VITÓRIA / DERROTA / EMPATE em cada lado + faixa central com
// o resultado e os MVPs por 20s (comemoração/castigo). Fundo preto; o chat da
// live continua por cima da parte de baixo.
//
// Esquerda = host da live que ESTA tela assiste (ou o próprio host); direita =
// host adversário via useOpponentRoom (2ª conexão LiveKit oculta).
import React, { memo, useEffect, useRef } from 'react';
import { View, Text, Pressable, Animated, Easing, StyleSheet, useWindowDimensions, Platform } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconAward, IconX } from '../Icons';
import BattleVideo, { BattleWebAudio } from './BattleVideo';
import BattleScoreBar, { BattleClock } from './BattleScoreBar';
import useOpponentRoom from './useOpponentRoom';
import { PHASE, orient, outcomeFor } from './battleLogic';
import {
  useBattleSelector, selPhase, selBattle, selMySide, selOffset, selOpponent, selOpponentBlocked,
} from './battleStore';

const OPPONENT_GONE_MS = 20000;

function Stamp({ outcome, t }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    Animated.spring(v, { toValue: 1, friction: 5, tension: 90, useNativeDriver: true }).start();
  }, [outcome, v]);
  const label = outcome === 'win' ? t('liveBattle.win') : outcome === 'lose' ? t('liveBattle.lose') : t('liveBattle.draw');
  const scale = v.interpolate({ inputRange: [0, 1], outputRange: [2.2, 1] });
  return (
    <View pointerEvents="none" style={styles.stampWrap}>
      <Animated.View style={[styles.stamp, outcome === 'win' ? styles.stampWin : styles.stampOther, { opacity: v, transform: [{ scale }, { rotate: '-8deg' }] }]}>
        <Text style={[styles.stampText, outcome === 'win' ? styles.stampTextWin : null]} numberOfLines={1}>{label}</Text>
      </Animated.View>
    </View>
  );
}

function Side({ side, video, placeholderText, outcome, ended, t, mirror, zOrder }) {
  const name = side.host.name || (side.host.email ? side.host.email.split('@')[0] : '');
  const hasVideo = typeof video?.renderVideo === 'function' || !!video?.track;
  return (
    <View style={styles.tile}>
      <View collapsable={false} style={StyleSheet.absoluteFill}>
        {hasVideo ? <BattleVideo track={video.track} renderVideo={video.renderVideo} mirror={mirror} zOrder={zOrder} keyHint={side.side} /> : (
          <View style={styles.center}>
            <AvatarCircle email={side.host.email} name={name} size={64} />
            {placeholderText ? <Text style={styles.placeholder} numberOfLines={2}>{placeholderText}</Text> : null}
          </View>
        )}
      </View>
      {ended ? <View pointerEvents="none" style={styles.dim} /> : null}
      <View pointerEvents="none" style={styles.namePill}>
        <Text style={styles.nameText} numberOfLines={1}>{name}</Text>
      </View>
      {ended ? <Stamp outcome={outcome} t={t} /> : null}
    </View>
  );
}

function MvpChip({ fan, t, align }) {
  if (!fan) return <View style={{ flex: 1 }} />;
  return (
    <View style={[styles.mvp, align === 'right' ? { justifyContent: 'flex-end' } : null]}>
      <IconAward size={13} color="#fff" />
      <Text style={styles.mvpLabel}>{t('liveBattle.mvp')}</Text>
      <Text style={styles.mvpName} numberOfLines={1}>{fan.name || fan.email.split('@')[0]}</Text>
    </View>
  );
}

function ResultBanner({ outcome, battle, mySide, t, onClose, canClose }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    v.setValue(0);
    Animated.timing(v, { toValue: 1, duration: 520, easing: Easing.out(Easing.back(1.6)), useNativeDriver: true }).start();
  }, [battle.id, v]);
  const title = outcome === 'win' ? t('liveBattle.resultWin') : outcome === 'lose' ? t('liveBattle.resultLose') : t('liveBattle.resultDraw');
  const reason = battle.reason === 'opponent_left' ? t('liveBattle.reasonLeft') : (battle.reason === 'host_ended' ? t('liveBattle.reasonEnded') : '');
  const myScore = mySide === 'b' ? battle.scoreB : battle.scoreA;
  const theirScore = mySide === 'b' ? battle.scoreA : battle.scoreB;
  const ty = v.interpolate({ inputRange: [0, 1], outputRange: [24, 0] });
  return (
    <Animated.View style={[styles.banner, { opacity: v, transform: [{ translateY: ty }, { scale: v.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }]}>
      <View style={{ flex: 1 }}>
        <Text style={styles.bannerTitle} numberOfLines={1}>{title}</Text>
        <Text style={styles.bannerScore} numberOfLines={1}>{`${myScore} x ${theirScore}`}{reason ? `  ·  ${reason}` : ''}</Text>
      </View>
      {canClose ? (
        <Pressable onPress={onClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('liveBattle.close')} style={styles.bannerClose}>
          <IconX size={18} color="#fff" />
        </Pressable>
      ) : null}
    </Animated.View>
  );
}

/**
 * props:
 *  battle     controlador (useLiveBattleController)
 *  left       { renderVideo?() | track?, mirror? }  — vídeo do MEU host
 *  topInset   safe-area top
 *  t          i18n
 *  isHost     host vigia a queda do adversário (encerra após 20s)
 *  muted      (web) silencia o áudio do adversário junto com o player
 */
function LiveBattleStage({ battle, left, topInset = 0, t, isHost = false, muted = false }) {
  const { width: W, height: winH } = useWindowDimensions();
  const phase = useBattleSelector(battle, selPhase);
  const b = useBattleSelector(battle, selBattle);
  const mySide = useBattleSelector(battle, selMySide);
  const offset = useBattleSelector(battle, selOffset);
  const opponent = useBattleSelector(battle, selOpponent);
  const blocked = useBattleSelector(battle, selOpponentBlocked);
  const active = phase === PHASE.ACTIVE;
  const opp = useOpponentRoom(opponent, { enabled: !!b && (active || phase === PHASE.ENDED) });

  // Host: adversário sumiu da sala dele por 20s com a batalha rolando → encerra.
  const oppRef = useRef(opp);
  oppRef.current = opp;
  useEffect(() => {
    if (!isHost || !active) return undefined;
    const id = setInterval(() => {
      const o = oppRef.current;
      if (o && o.connected && !o.present && o.since && Date.now() - o.since > OPPONENT_GONE_MS) {
        battle.endBattle('opponent_left');
      }
    }, 2000);
    return () => clearInterval(id);
  }, [isHost, active, battle]);

  if (!b || (phase !== PHASE.ACTIVE && phase !== PHASE.ENDED)) return null;
  const o = orient(b, mySide);
  const ended = phase === PHASE.ENDED;
  const outcome = outcomeFor(b.winner, mySide);
  const oppOutcome = outcome === 'win' ? 'lose' : outcome === 'lose' ? 'win' : 'draw';
  const top = Math.round(topInset + 64);
  const tileW = Math.floor((W - 2) / 2);
  const tileH = Math.min(Math.round(tileW * 4 / 3), Math.max(180, winH - top - Math.round(winH * 0.36)));
  const oppPlaceholder = blocked ? t('liveBattle.opponentHidden')
    : (opp.connected && !opp.present ? t('liveBattle.opponentReconnecting') : (!opp.connected ? t('liveBattle.connecting') : ''));
  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={[styles.area, { top, height: tileH }]}>
        <Side side={o.left} video={left} outcome={outcome} ended={ended} t={t} mirror={!!left?.mirror} zOrder={0} />
        <View style={{ width: 2 }} />
        <Side
          side={o.right}
          video={opp.videoTrack ? { track: opp.videoTrack } : null}
          placeholderText={oppPlaceholder}
          outcome={oppOutcome}
          ended={ended}
          t={t}
          zOrder={1}
        />
        <View pointerEvents="none" style={styles.vsWrap}>
          {ended ? (
            <View style={styles.finalChip}><Text style={styles.finalText}>{t('liveBattle.final')}</Text></View>
          ) : (
            <BattleClock endsAt={b.endsAt} offset={offset} label={t('liveBattle.vs')} />
          )}
        </View>
      </View>
      <View style={[styles.below, { top: top + tileH }]} pointerEvents="box-none">
        <BattleScoreBar
          left={o.left.score}
          right={o.right.score}
          a11yLabel={t('liveBattle.scoreA11y', { left: o.left.score, right: o.right.score })}
        />
        <View style={styles.mvpRow} pointerEvents="none">
          <MvpChip fan={o.left.mvp} t={t} align="left" />
          <MvpChip fan={o.right.mvp} t={t} align="right" />
        </View>
        {ended ? (
          <ResultBanner
            outcome={outcome}
            battle={b}
            mySide={mySide}
            t={t}
            canClose
            onClose={() => battle.dismissResult()}
          />
        ) : null}
      </View>
      {Platform.OS === 'web' && opp.audioTrack ? <BattleWebAudio track={opp.audioTrack} muted={muted} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  area: { position: 'absolute', left: 0, right: 0, flexDirection: 'row' },
  tile: { flex: 1, backgroundColor: '#111', overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111', paddingHorizontal: 10 },
  placeholder: { color: 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: '600', marginTop: 10, textAlign: 'center' },
  dim: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.35)' },
  namePill: {
    position: 'absolute', left: 6, bottom: 6, maxWidth: '88%',
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: 'rgba(0,0,0,0.55)',
  },
  nameText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  vsWrap: { position: 'absolute', top: 8, left: 0, right: 0, alignItems: 'center' },
  finalChip: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 999, backgroundColor: '#fff' },
  finalText: { color: '#000', fontSize: 12, fontWeight: '800', letterSpacing: 0.6 },
  below: { position: 'absolute', left: 0, right: 0 },
  mvpRow: { flexDirection: 'row', paddingHorizontal: 8, paddingTop: 6, gap: 8 },
  mvp: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 20 },
  mvpLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '800', letterSpacing: 0.6 },
  mvpName: { color: '#fff', fontSize: 12, fontWeight: '700', flexShrink: 1 },
  stampWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  stamp: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6, borderWidth: 2 },
  stampWin: { backgroundColor: '#fff', borderColor: '#fff' },
  stampOther: { backgroundColor: 'rgba(0,0,0,0.55)', borderColor: 'rgba(255,255,255,0.8)' },
  stampText: { color: '#fff', fontSize: 20, fontWeight: '900', letterSpacing: 1.2 },
  stampTextWin: { color: '#000' },
  banner: {
    marginTop: 10, marginHorizontal: 12, flexDirection: 'row', alignItems: 'center',
    paddingLeft: 14, paddingVertical: 6, borderRadius: 14,
    backgroundColor: 'rgba(20,20,20,0.92)', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.25)',
  },
  bannerTitle: { color: '#fff', fontSize: 17, fontWeight: '800' },
  bannerScore: { color: 'rgba(255,255,255,0.75)', fontSize: 12, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  bannerClose: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});

export default memo(LiveBattleStage);
