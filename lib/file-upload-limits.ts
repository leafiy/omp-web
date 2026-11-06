/** Shared by the upload endpoint and browser-side validation. */
export const MAX_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_UPLOAD_TOTAL_BYTES = 100 * 1024 * 1024;
// Multipart boundaries and headers are not file bytes, but must be bounded too.
export const MAX_UPLOAD_REQUEST_BYTES = MAX_UPLOAD_TOTAL_BYTES + 1024 * 1024;
