// [2026-10-07 native-group-call] Native group-call grid.
//
// Layout (task spec):
//   1–2 participants → full tiles (1 = whole stage, 2 = stacked halves)
//   3–4             → 2×2
//   ≥5              → 2 columns × N rows, PAGINATED at 9 tiles per page
//
// Only the CURRENT page is rendered with VideoViews (other pages are not
// mounted at all — no SurfaceView scrolling glitches on Android). Page change
// = horizontal swipe on the stage or tap on the page dots. Every time the
// visible set changes we report it upward (onVisibleChange) so the hook
// enables only those remote cameras and caps their simulcast layer:
// HIGH for 1–2 tiles, MEDIUM for 2×2, LOW for the paginated thumbnails.
//
// Ordering: pinned → remotes in join order, with the local tile kept on page 1
// (last slot of page 1). The debounced active speaker is promoted onto page 1
// when they'd otherwise be off-screen.
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { View, StyleSheet, PanResponder, Pressable } from 'react-native';
import GroupCallTile from './GroupCallTile';

export const GROUP_PAGE_SIZE = 9;
const GAP = 6;

export function orderGroupTiles(participants, { pinnedEmail, promotedEmail, pageSize = GROUP_PAGE_SIZE } = {}) {
  const list = Array.isArray(participants) ? participants : [];
  const local = list.find((p) => p.isLocal) || null;
  let remotes = list.filter((p) => !p.isLocal).slice().sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
  const pinLc = String(pinnedEmail || '').toLowerCase();
  if (pinLc) {
    const i = remotes.findIndex((p) => p.email === pinLc);
    if (i > 0) { const [p] = remotes.splice(i, 1); remotes.unshift(p); }
  }
  // Slots on page 1 for remotes (local takes the last one).
  const firstPageRemoteSlots = Math.max(1, pageSize - (local ? 1 : 0));
  const promLc = String(promotedEmail || '').toLowerCase();
  if (promLc && remotes.length > firstPageRemoteSlots) {
    const i = remotes.findIndex((p) => p.email === promLc);
    if (i >= firstPageRemoteSlots) {
      const target = firstPageRemoteSlots - 1;
      const tmp = remotes[target];
      remotes[target] = remotes[i];
      remotes[i] = tmp;
    }
  }
  if (!local) return remotes;
  const out = remotes.slice();
  out.splice(Math.min(out.length, firstPageRemoteSlots), 0, local);
  return out;
}

export default function GroupCallGrid({
  participants,
  activeSpeakers,
  promotedEmail,
  pinnedEmail,
  silencedEmails,
  raisedHandEmails,
  mirrorLocal,
  youLabel,
  topInset = 0,
  bottomInset = 0,
  onTileLongPress,
  onVisibleChange,
}) {
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [page, setPage] = useState(0);

  const ordered = useMemo(
    () => orderGroupTiles(participants, { pinnedEmail, promotedEmail }),
    [participants, pinnedEmail, promotedEmail]
  );
  const n = ordered.length;
  const paged = n >= 5;
  const pageCount = paged ? Math.ceil(n / GROUP_PAGE_SIZE) : 1;
  const curPage = Math.min(page, pageCount - 1);
  useEffect(() => { if (page !== curPage) setPage(curPage); }, [page, curPage]);

  const pageTiles = useMemo(
    () => (paged ? ordered.slice(curPage * GROUP_PAGE_SIZE, (curPage + 1) * GROUP_PAGE_SIZE) : ordered),
    [ordered, paged, curPage]
  );

  // Grid geometry.
  const availW = Math.max(0, box.w - GAP * 2);
  const availH = Math.max(0, box.h - topInset - bottomInset - GAP * 2);
  let cols = 1;
  let rows = 1;
  if (n === 2) { cols = 1; rows = 2; }
  else if (n === 3 || n === 4) { cols = 2; rows = 2; }
  else if (paged) { cols = 2; rows = Math.ceil(Math.min(n, GROUP_PAGE_SIZE) / 2); }
  const tileW = Math.floor((availW - GAP * (cols - 1)) / cols);
  const tileH = Math.floor((availH - GAP * (rows - 1)) / rows);

  const quality = n <= 2 ? 'high' : n <= 4 ? 'medium' : 'low';
  const visibleKey = pageTiles.map((p) => p.email).join('|');
  const onVisRef = useRef(onVisibleChange);
  onVisRef.current = onVisibleChange;
  useEffect(() => {
    try { onVisRef.current?.(pageTiles.filter((p) => !p.isLocal).map((p) => p.email), quality); } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleKey, quality]);

  // Horizontal swipe → page change (only when paginated).
  const pageRef = useRef({ cur: curPage, count: pageCount });
  pageRef.current = { cur: curPage, count: pageCount };
  const pan = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) => pageRef.current.count > 1 && Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 1.5,
    onPanResponderRelease: (_e, g) => {
      const { cur, count } = pageRef.current;
      if (g.dx < -50 && cur < count - 1) setPage(cur + 1);
      else if (g.dx > 50 && cur > 0) setPage(cur - 1);
    },
  }), []);

  const onLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((b) => (b.w === width && b.h === height ? b : { w: width, h: height }));
  }, []);

  const speakingSet = useMemo(() => new Set((activeSpeakers || []).map((x) => String(x).toLowerCase())), [activeSpeakers]);
  const pinLc = String(pinnedEmail || '').toLowerCase();
  const hands = raisedHandEmails || {};
  const silenced = silencedEmails || {};

  return (
    <View style={styles.stage} onLayout={onLayout} {...pan.panHandlers}>
      {box.w > 0 && tileW > 0 && tileH > 0 ? (
        <View style={[styles.grid, { paddingTop: topInset + GAP, paddingHorizontal: GAP }]}>
          {pageTiles.map((vm) => (
            <View key={vm.identity} style={{ width: tileW, height: tileH, marginBottom: GAP }}>
              <GroupCallTile
                vm={vm}
                width={tileW}
                height={tileH}
                visible
                speaking={speakingSet.has(vm.email)}
                pinned={!!pinLc && pinLc === vm.email}
                silenced={!!silenced[vm.email]}
                handRaised={!!hands[vm.email] || !!vm.handRaised}
                mirrorLocal={mirrorLocal}
                youLabel={youLabel}
                onLongPress={onTileLongPress}
              />
            </View>
          ))}
        </View>
      ) : null}
      {pageCount > 1 ? (
        <View pointerEvents="box-none" style={[styles.dots, { bottom: bottomInset + 12 }]}>
          {Array.from({ length: pageCount }).map((_, i) => (
            <Pressable
              key={i}
              hitSlop={8}
              onPress={() => setPage(i)}
              accessibilityLabel={`${i + 1}/${pageCount}`}
              style={[styles.dot, i === curPage && styles.dotOn]}
            />
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  stage: { flex: 1, backgroundColor: '#000' },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-evenly',
    alignContent: 'flex-start',
    columnGap: GAP,
  },
  dots: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  dot: { width: 7, height: 7, borderRadius: 3.5, backgroundColor: 'rgba(255,255,255,0.35)' },
  dotOn: { backgroundColor: '#fff' },
});
