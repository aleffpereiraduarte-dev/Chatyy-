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

const NativeView: React.ComponentType<PdfViewProps> = requireNativeView('ExpoNativePdfView');
export default NativeView;
