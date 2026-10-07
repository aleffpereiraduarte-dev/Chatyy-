import { requireNativeView } from 'expo';
import * as React from 'react';
import { ViewProps } from 'react-native';

export interface PdfViewProps extends ViewProps {
  uri: string;
  /** Page index to show (0-based). Default 0. */
  page?: number;
  /** Show built-in PDFKit thumbnail strip at the bottom (iOS only). */
  showThumbnails?: boolean;
  // [2026-10-07 native-docs-mail] Binaries from 2026-10-07 on (iOS + Android).
  // Feature-detect with nativeViewHas('ExpoNativePdfView', { events: ['onLoad'] }).
  /** Extra HTTP headers for downloading a remote `uri` (e.g. Authorization). */
  headers?: Record<string, string>;
  onLoad?: (e: { nativeEvent: { pageCount: number } }) => void;
  onError?: (e: { nativeEvent: { message: string } }) => void;
  onPageChange?: (e: { nativeEvent: { page: number; pageCount: number } }) => void;
}

// iOS (PDFKit) and, since 2026-10-07, Android (PdfRenderer). `requireNativeView` THROWS if the view isn't registered
// (e.g. on Android), and because index.ts re-exports this module statically,
// an unguarded call here crashes the whole JS bundle on import — including the
// voice-message path that merely imports the package for `Audio`. Wrap it so a
// missing native view degrades to null instead of taking down the app.
let NativeView: React.ComponentType<PdfViewProps> | null = null;
try { NativeView = requireNativeView('ExpoNativePdfView'); } catch { NativeView = null; }
export default NativeView as React.ComponentType<PdfViewProps>;
