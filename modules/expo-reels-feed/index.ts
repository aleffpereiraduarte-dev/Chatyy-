// modules/expo-reels-feed — [2026-10-15 native-reels]
//
// Feed vertical de Reels NATIVO (view `ChatyyReelsFeed`), nível TikTok:
//   iOS: UICollectionView paginada + pool de 3 AVPlayer (anterior/atual/
//        próximo) com pré-buffer + download em disco dos 2 seguintes.
//   Android: RecyclerView + PagerSnapHelper + pool de 3 ExoPlayer (Media3)
//        + SimpleCache com pré-gravação dos 2 seguintes.
// O wrapper React (diff incremental, eventos, fallback, kill switch) mora em
// components/reels/NativeReelsFeed.js. Binário sem o módulo → isAvailable()
// false e o ReelsViewer usa a FlatList JS de sempre.
//
// Props:  labels, muted, paused, rate, captionsEnabled, insets {top,bottom},
//         imageHeaders, refreshEnabled, refreshing
// Métodos (ref): applyItems({op:'reset'|'append'|'update'|'remove', items, ids, startIndex}),
//         play(), pause(), scrollTo(index, animated)
// Eventos (nativeEvent): onReady, onNativeError {message}, onIndexChange {index,id},
//         onLike {id,liked,likes,source}, onSave {id,saved}, onComment/onGift/onShare/
//         onMore/onAuthorPress/onFollow/onMusicPress/onCreditPress {id,index},
//         onNeedMore {index,count}, onViewProgress {id,watchedMs,completed,loops,durationMs},
//         onMuteChange {muted}, onRefresh, onPlaybackError {id}
import { requireOptionalNativeModule } from 'expo-modules-core';

type NativeMod = { apiVersion(): number };

let _mod: NativeMod | null | undefined;

export function isAvailable(): boolean {
  if (_mod === undefined) {
    try { _mod = requireOptionalNativeModule<NativeMod>('ChatyyReelsFeed'); } catch { _mod = null; }
  }
  try { return !!_mod && _mod.apiVersion() >= 1; } catch { return false; }
}
