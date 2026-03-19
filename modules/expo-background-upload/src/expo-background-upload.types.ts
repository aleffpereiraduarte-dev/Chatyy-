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

export type ExpoBackgroundUploadModuleEvents = {
  onProgress: (params: ProgressEvent) => void;
  onComplete: (params: CompleteEvent) => void;
  onBatchComplete: (params: BatchCompleteEvent) => void;
};
