import { requireNativeView } from 'expo';
import * as React from 'react';
import { ViewProps } from 'react-native';

export interface PdfViewProps extends ViewProps {
  uri: string;
  /** Page index to show (0-based). Default 0. */
  page?: number;
  /** Show built-in PDFKit thumbnail strip at the bottom. */
  showThumbnails?: boolean;
}

// iOS-only (PDFKit). `requireNativeView` THROWS if the view isn't registered
// (e.g. on Android), and because index.ts re-exports this module statically,
// an unguarded call here crashes the whole JS bundle on import — including the
// voice-message path that merely imports the package for `Audio`. Wrap it so a
// missing native view degrades to null instead of taking down the app.
let NativeView: React.ComponentType<PdfViewProps> | null = null;
try { NativeView = requireNativeView('ExpoNativePdfView'); } catch { NativeView = null; }
export default NativeView as React.ComponentType<PdfViewProps>;
