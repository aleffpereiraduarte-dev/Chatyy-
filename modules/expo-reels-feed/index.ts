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

// [2026-10-15 native-feed] Aba FEED (posts) em NATIVO — view `ChatyyPostFeed`
// no MESMO pacote para reaproveitar o pool de players/cache de vídeo/imagem dos
// Reels. Wrapper: components/feed/NativePostFeed.js. Kill switch:
// globalThis.__chatyy_native_feed = false.
export const POST_FEED_VIEW_NAME = 'ChatyyPostFeed';
let _postFeedChecked = false;
let _postFeedView: any = null;
export function getNativePostFeedView(): any {
  if (_postFeedChecked) return _postFeedView;
  _postFeedChecked = true;
  try {
    const m = requireOptionalNativeModule<NativeMod>(POST_FEED_VIEW_NAME);
    if (!m || !(Number(m.apiVersion()) >= 1)) return null;
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const core = require('expo-modules-core');
    const req = core.requireNativeViewManager || core.requireNativeView;
    if (typeof req === 'function') _postFeedView = req(POST_FEED_VIEW_NAME);
  } catch {
    _postFeedView = null;
  }
  return _postFeedView;
}
