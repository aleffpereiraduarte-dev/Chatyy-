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

const NativeView: React.ComponentType<HtmlViewProps> = requireNativeView('ExpoNativeHtmlView');
export default NativeView;
