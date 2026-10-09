// [2026-10-09 expo-image] FastImage — thin drop-in for react-native's <Image>
// backed by expo-image (SDK 55, in every binary): memory+disk cache shared with
// the rest of the app (bubbles, viewer, grids), background decode, and
// `recyclingKey` so a recycled list cell never flashes the previous image.
//
// Same props as RN Image (`resizeMode` maps to `contentFit`); defaults to
// cachePolicy="memory-disk". No wrapper View, no placeholder tint — layout is
// identical to the <Image> it replaces. Falls back to RN Image if expo-image
// isn't available.
//
// Caveat when swapping: expo-image's onLoad/onError events are NOT RN's
// (`e.source.width` instead of `e.nativeEvent.source.width`). Only swap sites
// whose handlers don't read the event.
import React from 'react';
import { Image as RNImage } from 'react-native';

let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image || null; } catch {}

const FIT = { cover: 'cover', contain: 'contain', stretch: 'fill', center: 'scale-down', repeat: 'cover' };

const FastImage = React.forwardRef(function FastImage(
  { resizeMode, contentFit, cachePolicy = 'memory-disk', recyclingKey, ...rest },
  ref,
) {
  if (_ExpoImage) {
    return (
      <_ExpoImage
        ref={ref}
        {...rest}
        contentFit={contentFit || FIT[resizeMode] || 'cover'}
        cachePolicy={cachePolicy}
        recyclingKey={recyclingKey != null ? String(recyclingKey) : undefined}
      />
    );
  }
  return <RNImage ref={ref} resizeMode={resizeMode} {...rest} />;
});

export default FastImage;
