import { requireNativeView } from 'expo';
import * as React from 'react';
import { ViewProps } from 'react-native';

export interface HtmlViewProps extends ViewProps {
  /** Raw HTML string to render. */
  html: string;
  /** Inject CSS at the top of the document. */
  injectedCss?: string;
  /** Open links in Safari instead of inside the view. */
  openLinksExternally?: boolean;
  /** Called when the view finishes rendering (height in points). */
  onRendered?: (e: { nativeEvent: { contentHeight: number } }) => void;
}

// iOS-only (WKWebView). `requireNativeView` THROWS if the view isn't registered
// (e.g. on Android), and because index.ts re-exports this module statically, an
// unguarded call here crashes the whole JS bundle on import — including the
// voice-message path that merely imports the package for `Audio`. Wrap it so a
// missing native view degrades to null instead of taking down the app.
let NativeView: React.ComponentType<HtmlViewProps> | null = null;
try { NativeView = requireNativeView('ExpoNativeHtmlView'); } catch { NativeView = null; }
export default NativeView as React.ComponentType<HtmlViewProps>;
