import { Directory, File, Paths } from 'expo-file-system';

const IMAGE_CACHE_PATTERN = /^lumora-image-\d+(?:-[a-z0-9]+)?\.(?:png|jpg)$/i;

function isLumoraCacheUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return false;

  try {
    const fileUrl = new URL(uri);
    const cacheUrl = new URL(Paths.cache.uri);
    if (
      fileUrl.protocol !== 'file:' ||
      cacheUrl.protocol !== 'file:' ||
      fileUrl.hostname !== cacheUrl.hostname ||
      fileUrl.username ||
      fileUrl.password ||
      fileUrl.search ||
      fileUrl.hash
    ) return false;

    // Inspect the original URI path as URL parsing normalizes literal dot
    // segments. Decode once to catch encoded traversal and malformed escapes.
    const pathStart = uri.indexOf('/', 'file://'.length);
    if (pathStart < 0) return false;
    const rawPath = uri.slice(pathStart);
    if (rawPath.includes('\\')) return false;
    const path = decodeURIComponent(rawPath);
    if (path.includes('\\') || path.includes('\0')) return false;
    if (path.split('/').some((segment) => segment === '.' || segment === '..')) return false;

    const cachePath = decodeURIComponent(cacheUrl.pathname).replace(/\/+$/, '');
    const lastSlash = path.lastIndexOf('/');
    if (lastSlash < 0 || path.slice(0, lastSlash) !== cachePath) return false;
    return IMAGE_CACHE_PATTERN.test(path.slice(lastSlash + 1));
  } catch {
    return false;
  }
}

export function cleanupImageStudioCache() {
  try {
    const cacheDirectory = new Directory(Paths.cache);
    if (!cacheDirectory.exists) return;
    for (const entry of cacheDirectory.list()) {
      if (entry instanceof File && IMAGE_CACHE_PATTERN.test(entry.name)) {
        try { if (entry.exists) entry.delete(); } catch {}
      }
    }
  } catch {
    // Best-effort cleanup restricted to Lumora-generated temporary filenames.
  }
}

export async function writeImageToCache(bytes, contentType) {
  const extension = contentType === 'image/png' ? 'png' : 'jpg';
  const file = new File(Paths.cache, `lumora-image-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
  try {
    await file.write(bytes);
    return { uri: file.uri, extension };
  } catch (error) {
    deleteImageFromCache(file.uri);
    throw error;
  }
}

export function deleteImageFromCache(uri) {
  if (!isLumoraCacheUri(uri)) return;
  try {
    const file = new File(uri);
    // Recheck the native File URI in case its constructor canonicalizes it.
    if (isLumoraCacheUri(file.uri) && file.exists && IMAGE_CACHE_PATTERN.test(file.name)) file.delete();
  } catch {
    // Cache cleanup is best-effort and restricted to Lumora files directly inside Paths.cache.
  }
}
