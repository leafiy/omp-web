export const TEXT_PREVIEW_MAX_BYTES = 256 * 1024;
export const DOCX_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

export type DocumentPreviewKind = "pdf" | "docx";

export const IMAGE_EXT_TO_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  apng: "image/apng",
  jfif: "image/jpeg",
  jpe: "image/jpeg",
  pjpeg: "image/jpeg",
  tif: "image/tiff",
  tiff: "image/tiff",
  heic: "image/heic",
  heif: "image/heif",
  jxl: "image/jxl",
};

export const AUDIO_EXT_TO_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  weba: "audio/webm",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  caf: "audio/x-caf",
  m4b: "audio/mp4",
};

const VIDEO_EXT_TO_MIME: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mpg: "video/mpeg",
  mpeg: "video/mpeg",
  "3gp": "video/3gpp",
  "3g2": "video/3gpp2",
};

export const DOCUMENT_EXT_TO_MIME: Record<DocumentPreviewKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

function getBaseName(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").pop() ?? "";
}

export function getFileExt(filePath: string): string {
  return getBaseName(filePath).toLowerCase().split(".").pop() ?? "";
}

function lookupMime(types: Record<string, string>, filePath: string): string | null {
  const ext = getFileExt(filePath);
  return Object.prototype.hasOwnProperty.call(types, ext) ? types[ext] : null;
}

export function getImageMime(filePath: string): string | null {
  return lookupMime(IMAGE_EXT_TO_MIME, filePath);
}

export function getAudioMime(filePath: string): string | null {
  return lookupMime(AUDIO_EXT_TO_MIME, filePath);
}

export function getVideoMime(filePath: string): string | null {
  return lookupMime(VIDEO_EXT_TO_MIME, filePath);
}

export function getMediaMime(filePath: string): string | null {
  return getImageMime(filePath) ?? getAudioMime(filePath) ?? getVideoMime(filePath);
}

export function getDocumentMime(filePath: string): string | null {
  return lookupMime(DOCUMENT_EXT_TO_MIME, filePath);
}

export function documentPreviewKind(filePath: string): DocumentPreviewKind | null {
  const ext = getFileExt(filePath);
  if (ext === "pdf" || ext === "docx") return ext;
  return null;
}

export function isImagePath(filePath: string): boolean {
  return getImageMime(filePath) !== null;
}

export function isAudioPath(filePath: string): boolean {
  return getAudioMime(filePath) !== null;
}

export function isDocumentPreviewPath(filePath: string): boolean {
  return documentPreviewKind(filePath) !== null;
}
