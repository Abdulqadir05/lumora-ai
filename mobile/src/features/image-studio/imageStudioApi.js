import { fetch as expoFetch } from 'expo/fetch';

export const IMAGE_MAX_BYTES = 12 * 1024 * 1024;
export const IMAGE_MAX_PROMPT_CHARS = 2000;
export const IMAGE_GENERATION_TIMEOUT_MS = 120000;
export const IMAGE_ERROR_BODY_MAX_BYTES = 4096;
export const IMAGE_ERROR_CODES = new Set([
  'image_busy',
  'image_generation_disabled',
  'image_not_configured',
  'image_provider_budget_exhausted',
  'image_provider_rate_limited',
  'rate_limited',
]);
export const IMAGE_PREVIEW_ASPECT_RATIOS = Object.freeze({ '1:1': 1, '16:9': 16 / 9, '9:16': 9 / 16, '4:3': 4 / 3 });

export function isValidGeneratedImage(bytes, contentType) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 8) return false;
  if (contentType === 'image/png') {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    return bytes.length >= 33 && signature.every((byte, index) => bytes[index] === byte);
  }
  return contentType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
}

export async function requestGeneratedImage(baseUrl, prompt, aspectRatio, signal, buildHeaders) {
  const response = await expoFetch(`${baseUrl}/api/images/generate`, {
    method: 'POST',
    headers: { ...buildHeaders({ hasBody: true }), Accept: 'image/png, image/jpeg' },
    body: JSON.stringify({ prompt, aspectRatio }),
    signal,
  });
  if (!response.ok) {
    const code = await readImageErrorCode(response);
    throw Object.assign(new Error('image_http_error'), { kind: 'http', status: response.status, code });
  }
  const contentType = (response.headers?.get?.('content-type') || '').split(';', 1)[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg'].includes(contentType)) {
    try { await response.body?.cancel?.(); } catch {}
    throw Object.assign(new Error('image_invalid_response'), { kind: 'invalid_image' });
  }
  const contentLength = Number(response.headers?.get?.('content-length'));
  const reader = response.body?.getReader?.();
  if (!reader) throw Object.assign(new Error('image_stream_unsupported'), { kind: 'invalid_image' });
  if (Number.isFinite(contentLength) && contentLength > IMAGE_MAX_BYTES) {
    try { await reader.cancel(); } catch {}
    throw Object.assign(new Error('image_too_large'), { kind: 'too_large' });
  }

  let bytes = new Uint8Array(Number.isFinite(contentLength) && contentLength > 0 ? Math.min(contentLength, IMAGE_MAX_BYTES) : 64 * 1024);
  let totalBytes = 0;
  const cancelOnAbort = () => { try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  signal.addEventListener('abort', cancelOnAbort, { once: true });
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      if (signal.aborted) throw Object.assign(new Error('image_aborted'), { kind: 'aborted' });
      const value = /** @type {unknown} */ (part.value);
      const chunk = value instanceof Uint8Array
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : null;
      if (!chunk) throw Object.assign(new Error('image_invalid_response'), { kind: 'invalid_image' });
      if (totalBytes + chunk.byteLength > IMAGE_MAX_BYTES) {
        try { await reader.cancel(); } catch {}
        throw Object.assign(new Error('image_too_large'), { kind: 'too_large' });
      }
      const required = totalBytes + chunk.byteLength;
      if (required > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(IMAGE_MAX_BYTES, Math.max(required, bytes.byteLength * 2)));
        expanded.set(bytes.subarray(0, totalBytes));
        bytes = expanded;
      }
      bytes.set(chunk, totalBytes);
      totalBytes += chunk.byteLength;
    }
  } catch (error) {
    if (signal.aborted) throw Object.assign(new Error('image_aborted'), { kind: 'aborted' });
    if (error?.kind) throw error;
    throw Object.assign(new Error('image_stream_failed'), { kind: 'network' });
  } finally {
    signal.removeEventListener('abort', cancelOnAbort);
    try { reader.releaseLock?.(); } catch {}
  }
  if (signal.aborted) throw Object.assign(new Error('image_aborted'), { kind: 'aborted' });
  const imageBytes = bytes.subarray(0, totalBytes);
  if (!isValidGeneratedImage(imageBytes, contentType)) throw Object.assign(new Error('image_invalid_response'), { kind: 'invalid_image' });
  return { bytes: imageBytes, contentType };
}

async function readImageErrorCode(response) {
  const contentType = (response.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    try { await response.body?.cancel?.(); } catch {}
    return null;
  }
  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > IMAGE_ERROR_BODY_MAX_BYTES) {
    try { await response.body?.cancel?.(); } catch {}
    return null;
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    try { await response.body?.cancel?.(); } catch {}
    return null;
  }
  let bytes = new Uint8Array(Number.isFinite(declaredLength) && declaredLength > 0 ? Math.min(declaredLength, IMAGE_ERROR_BODY_MAX_BYTES) : 512);
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array
        ? value
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : null;
      if (!chunk || total + chunk.byteLength > IMAGE_ERROR_BODY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      const required = total + chunk.byteLength;
      if (required > bytes.byteLength) {
        const expanded = new Uint8Array(Math.min(IMAGE_ERROR_BODY_MAX_BYTES, Math.max(required, bytes.byteLength * 2)));
        expanded.set(bytes.subarray(0, total));
        bytes = expanded;
      }
      bytes.set(chunk, total);
      total = required;
    }
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes.subarray(0, total)));
      const code = parsed?.error?.code;
      return typeof code === 'string' && IMAGE_ERROR_CODES.has(code) ? code : null;
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    try { reader.releaseLock?.(); } catch {}
  }
}

export function imageGenerationErrorMessage(error) {
  if (error?.kind === 'timeout' || error?.status === 504) return 'Image generation took too long. Try again with a shorter prompt.';
  if (error?.kind === 'too_large' || error?.status === 413) return 'This image is too large to save in the app cache. Try again.';
  if (error?.kind === 'invalid_image') return 'The image service returned an invalid image. Try generating it again.';
  if (error?.code === 'image_generation_disabled') return 'Image generation is disabled until Preview billing controls are verified.';
  if (error?.status === 401 || error?.status === 403) return "Lumora couldn't verify backend access. Check the app connection and try again.";
  if (error?.status === 402 || error?.code === 'image_provider_budget_exhausted') return 'The image provider has run out of available credits or budget. Try again later.';
  if (error?.status === 429 || error?.code === 'image_provider_rate_limited' || error?.code === 'rate_limited') return 'Image generation is temporarily rate limited. Wait a little and try again.';
  if (error?.code === 'image_busy') return 'Image generation is busy. Please try again shortly.';
  if (error?.status >= 500) return 'Image generation is temporarily unavailable. Please try again.';
  return 'Could not generate this image. Check your connection and try again.';
}
