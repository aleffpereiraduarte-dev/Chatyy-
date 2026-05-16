export type UploadRequest = {
  assetId: string;
  presignedUrl: string;
  mimeType: string;
  maxWidth?: number;
  maxHeight?: number;
};

export type ProgressEvent = {
  assetId: string;
  progress: number;
  bytesSent: number;
  totalBytes: number;
};

export type CompleteEvent = {
  assetId: string;
  success: boolean;
  httpStatus?: number;
  error?: string;
};

export type BatchCompleteEvent = {
  remaining: number;
};

export type ErrorEvent = {
  assetId?: string;
  code?: string;
  message?: string;
};

// Android-side MediaStore row shape returned by scanMediaStore().
// Field names match what services/photoBackup.js + services/backupEngine.js
// consume from expo-media-library so the existing queue logic doesn't have
// to special-case the platform.
export type MediaStoreRow = {
  id: string;
  uri: string;             // content:// URI — feed straight back into hashFile/uploadToR2
  size: number;
  mimeType: string;
  dateAdded: number;       // ms since epoch
  dateModified: number;    // ms since epoch
  width: number;
  height: number;
  filename: string;
  mediaType: 'photo' | 'video';
};

export type ExpoBackgroundUploadModuleEvents = {
  onProgress: (params: ProgressEvent) => void;
  onComplete: (params: CompleteEvent) => void;
  onBatchComplete: (params: BatchCompleteEvent) => void;
  onError: (params: ErrorEvent) => void;
};
