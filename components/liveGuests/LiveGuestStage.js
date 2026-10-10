// [multi-guest 2026-10-10] Palco estilo TikTok Multi-guest: host + até 4
// convidados em grade. Layouts (n = host + convidados):
//   2 → lado a lado (meia tela cada)
//   3 → host à esquerda (coluna inteira) + 2 empilhados à direita
//   4 → 2×2
//   5 → host grande (2/3 da altura, metade esquerda) + 2 à direita + 2 embaixo
// A grade ocupa a faixa central (abaixo da barra do topo), fundo preto; os
// comentários continuam sobre a parte de baixo — mesmo arranjo do TikTok.
// P&B: borda branca no tile de quem está falando; nomes em pílula escura.
import React, { memo, useEffect, useRef } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconMicOff } from '../Icons';
import { getLiveKitVideoView } from '../../hooks/useLiveKitRoom';

const GAP = 2;

function WebTrackVideo({ track, mirror }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track) return undefined;
    try {
      if (typeof track.attach === 'function') track.attach(el);
      else if (track.mediaStreamTrack) el.srcObject = new MediaStream([track.mediaStreamTrack]);
      el.muted = true; // áudio vai por elementos <audio> próprios
      const pr = el.play?.();
      if (pr && pr.catch) pr.catch(() => {});
    } catch {}
    return () => {
      try { if (typeof track.detach === 'function') track.detach(el); else el.srcObject = null; } catch {}
    };
  }, [track]);
  return React.createElement('video', {
    ref,
    autoPlay: true,
    playsInline: true,
    muted: true,
    style: {
      position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
      objectFit: 'cover', backgroundColor: '#000',
      transform: mirror ? 'scaleX(-1)' : 'none',
    },
  });
}

// Web: <audio> por convidado (livekit-client não toca áudio remoto sozinho
// no navegador). Nativo: o WebRTC já toca as faixas assinadas.
function WebTrackAudio({ track }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !track || typeof track.attach !== 'function') return undefined;
    try { track.attach(el); const pr = el.play?.(); if (pr && pr.catch) pr.catch(() => {}); } catch {}
    return () => { try { track.detach(el); } catch {} };
  }, [track]);
  return React.createElement('audio', { ref, autoPlay: true, style: { display: 'none' } });
}

function TileVideo({ tile }) {
  const track = tile.videoTrack;
  if (!track) return null;
  if (Platform.OS === 'web') return <WebTrackVideo track={track} mirror={!!tile.mirror} />;
  const VV = getLiveKitVideoView();
  if (!VV) return null;
  return (
    <VV
      key={`${tile.key}:${track.sid || 'local'}`}
      videoTrack={track}
      style={StyleSheet.absoluteFill}
      objectFit="cover"
      mirror={!!tile.mirror}
      zOrder={tile.isSelf ? 1 : 0}
    />
  );
}

const StageTile = memo(function StageTile({ tile, frame, onPress, hostLabel, youLabel }) {
  const minSide = Math.min(frame.width, frame.height);
  const avatar = Math.max(40, Math.min(96, Math.round(minSide * 0.36)));
  const hasCustom = typeof tile.renderVideo === 'function';
  const showVideo = !tile.camOff && (hasCustom || !!tile.videoTrack);
  const label = tile.isSelf && !tile.isHost ? youLabel : tile.name;
  return (
    <Pressable
      onPress={onPress ? () => onPress(tile) : undefined}
      disabled={!onPress}
      style={[styles.tile, { left: frame.left, top: frame.top, width: frame.width, height: frame.height }]}
      accessibilityRole={onPress ? 'button' : undefined}
      accessibilityLabel={label}
    >
      <View collapsable={false} style={StyleSheet.absoluteFill}>
        {showVideo ? (hasCustom ? tile.renderVideo() : <TileVideo tile={tile} />) : (
          <View style={styles.center}>
            <AvatarCircle email={tile.email} name={tile.name} size={avatar} />
          </View>
        )}
      </View>
      <View pointerEvents="none" style={styles.namePill}>
        {tile.micMuted ? <IconMicOff size={12} color="#fff" /> : null}
        {tile.isHost ? (
          <View style={styles.hostBadge}><Text style={styles.hostBadgeText}>{hostLabel}</Text></View>
        ) : null}
        <Text style={styles.nameText} numberOfLines={1}>{label}</Text>
      </View>
      {tile.speaking && !tile.micMuted ? <View pointerEvents="none" style={styles.speakingRing} /> : null}
    </Pressable>
  );
});

/** Frames (px) por quantidade de tiles dentro da área W×H. */
export function stageFrames(n, W, H) {
  const half = (W - GAP) / 2;
  if (n <= 1) return [{ left: 0, top: 0, width: W, height: H }];
  if (n === 2) {
    return [
      { left: 0, top: 0, width: half, height: H },
      { left: half + GAP, top: 0, width: half, height: H },
    ];
  }
  const hHalf = (H - GAP) / 2;
  if (n === 3) {
    return [
      { left: 0, top: 0, width: half, height: H },
      { left: half + GAP, top: 0, width: half, height: hHalf },
      { left: half + GAP, top: hHalf + GAP, width: half, height: hHalf },
    ];
  }
  if (n === 4) {
    return [
      { left: 0, top: 0, width: half, height: hHalf },
      { left: half + GAP, top: 0, width: half, height: hHalf },
      { left: 0, top: hHalf + GAP, width: half, height: hHalf },
      { left: half + GAP, top: hHalf + GAP, width: half, height: hHalf },
    ];
  }
  const row = (H - 2 * GAP) / 3;
  return [
    { left: 0, top: 0, width: half, height: row * 2 + GAP },
    { left: half + GAP, top: 0, width: half, height: row },
    { left: half + GAP, top: row + GAP, width: half, height: row },
    { left: 0, top: (row + GAP) * 2, width: half, height: row },
    { left: half + GAP, top: (row + GAP) * 2, width: half, height: row },
  ];
}

/**
 * tiles: [{ key, email, name, isHost, isSelf, videoTrack?, renderVideo?(),
 *           mirror?, micMuted, camOff, speaking }]  (host primeiro; máx 5)
 */
function LiveGuestStage({ tiles, topInset = 0, onTilePress, hostLabel = 'Host', youLabel = 'Você', playWebAudio = false }) {
  const { width: winW, height: winH } = useWindowDimensions();
  const list = (tiles || []).slice(0, 5);
  const n = list.length;
  // Faixa central: começa abaixo da barra do topo; 2 tiles = retratos lado a
  // lado (proporção ~ 9:16 cada → altura ≈ largura × 0.89); 3-5 = mais alta.
  const top = Math.round(topInset + 64);
  const maxH = Math.max(200, winH - top - Math.round(winH * 0.30));
  const wantH = n === 2 ? Math.round(winW * 0.89) : Math.round(winW * 1.12);
  const H = Math.min(maxH, wantH);
  const frames = stageFrames(n, winW, H);
  return (
    <View style={styles.root} pointerEvents="box-none">
      <View style={[styles.area, { top, height: H }]} pointerEvents="box-none">
        {list.map((tile, i) => (
          <StageTile
            key={tile.key}
            tile={tile}
            frame={frames[i]}
            onPress={onTilePress}
            hostLabel={hostLabel}
            youLabel={youLabel}
          />
        ))}
      </View>
      {playWebAudio && Platform.OS === 'web'
        ? list.filter((tl) => !tl.isSelf && tl.audioTrack).map((tl) => <WebTrackAudio key={'a:' + tl.key} track={tl.audioTrack} />)
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, backgroundColor: '#000' },
  area: { position: 'absolute', left: 0, right: 0 },
  tile: { position: 'absolute', backgroundColor: '#111', overflow: 'hidden' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#111' },
  namePill: {
    position: 'absolute', left: 6, bottom: 6, maxWidth: '88%',
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 7, paddingVertical: 3, borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  nameText: { color: '#fff', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  hostBadge: { backgroundColor: '#fff', borderRadius: 4, paddingHorizontal: 4, paddingVertical: 1 },
  hostBadgeText: { color: '#000', fontSize: 9, fontWeight: '800', letterSpacing: 0.3 },
  speakingRing: { ...StyleSheet.absoluteFillObject, borderWidth: 2, borderColor: '#fff' },
});

export default memo(LiveGuestStage);
