import {
  IMAGE_MAX_BYTES,
  imageGenerationErrorMessage,
  isValidGeneratedImage,
  requestGeneratedImage,
} from '../imageStudioApi';
import { cleanupImageStudioCache, deleteImageFromCache, writeImageToCache } from '../imageStudioCache';

const mockFetch = jest.fn();
const mockWrite = jest.fn();
const mockDelete = jest.fn();
const mockList = jest.fn(() => []);

jest.mock('expo/fetch', () => ({ fetch: (...args) => mockFetch(...args) }));
jest.mock('expo-file-system', () => {
  class MockDirectory {
    constructor(parent) {
      this.uri = parent.uri;
      this.exists = true;
    }
    list() { return mockList(); }
  }
  class MockFile {
    constructor(parent, name) {
      this.uri = name ? `${parent.uri}/${name}` : parent;
      this.name = this.uri.split('/').at(-1);
      this.exists = true;
    }
    write(bytes) { return mockWrite(this.uri, bytes); }
    delete() { return mockDelete(this.uri); }
  }
  return { Directory: MockDirectory, File: MockFile, Paths: { cache: { uri: 'file:///cache' } } };
});

function pngBytes() {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  return bytes;
}

function response({ status = 200, type = 'image/png', chunks = [pngBytes()], length } = {}) {
  let index = 0;
  const reader = {
    read: jest.fn(async () => index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }),
    cancel: jest.fn(async () => {}),
    releaseLock: jest.fn(),
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'content-type' ? type : name.toLowerCase() === 'content-length' ? length : null },
    body: { getReader: () => reader, cancel: jest.fn(async () => {}) },
    __reader: reader,
  };
}

describe('Image Studio API and cache modules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockReturnValue([]);
    mockWrite.mockResolvedValue(undefined);
  });

  it('sends the authenticated prompt and ratio to Lumora and returns bounded binary bytes', async () => {
    const upstream = response();
    mockFetch.mockResolvedValueOnce(upstream);
    const signal = new AbortController().signal;
    const buildHeaders = jest.fn(() => ({ Authorization: 'Bearer test-only', 'Content-Type': 'application/json' }));

    const result = await requestGeneratedImage('https://preview.example', 'A cyan glass garden', '16:9', signal, buildHeaders);

    expect(mockFetch).toHaveBeenCalledWith('https://preview.example/api/images/generate', expect.objectContaining({
      method: 'POST',
      headers: { Authorization: 'Bearer test-only', 'Content-Type': 'application/json', Accept: 'image/png, image/jpeg' },
      body: JSON.stringify({ prompt: 'A cyan glass garden', aspectRatio: '16:9' }),
      signal,
    }));
    expect(result).toEqual({ bytes: expect.any(Uint8Array), contentType: 'image/png' });
    expect(Array.from(result.bytes)).toEqual(Array.from(pngBytes()));
    expect(upstream.__reader.releaseLock).toHaveBeenCalled();
  });

  it('maps recognized backend budget and rate-limit codes without surfacing provider text', async () => {
    for (const [code, expected] of [
      ['image_generation_disabled', /disabled until Preview billing controls are verified/],
      ['image_provider_budget_exhausted', /run out of available credits or budget/],
      ['image_provider_rate_limited', /temporarily rate limited/],
    ]) {
      const body = new TextEncoder().encode(JSON.stringify({ error: { code, message: 'provider private details' } }));
      mockFetch.mockResolvedValueOnce(response({ status: 503, type: 'application/json', chunks: [body] }));
      await expect(requestGeneratedImage('https://preview.example', 'Prompt', '1:1', new AbortController().signal, () => ({})))
        .rejects.toMatchObject({ status: 503, code });
      expect(imageGenerationErrorMessage({ status: 503, code })).toMatch(expected);
      expect(imageGenerationErrorMessage({ status: 503, code })).not.toContain('provider private details');
    }
  });

  it('rejects unsupported image types and oversized streams', async () => {
    const unsupported = response({ type: 'text/html' });
    mockFetch.mockResolvedValueOnce(unsupported);
    await expect(requestGeneratedImage('https://preview.example', 'Prompt', '1:1', new AbortController().signal, () => ({})))
      .rejects.toMatchObject({ kind: 'invalid_image' });

    const tooLarge = response({ length: undefined, chunks: [new Uint8Array(IMAGE_MAX_BYTES + 1)] });
    mockFetch.mockResolvedValueOnce(tooLarge);
    await expect(requestGeneratedImage('https://preview.example', 'Prompt', '1:1', new AbortController().signal, () => ({})))
      .rejects.toMatchObject({ kind: 'too_large' });
    expect(tooLarge.__reader.cancel).toHaveBeenCalled();
  });

  it('validates mobile-recognized image signatures before cache writes', () => {
    expect(isValidGeneratedImage(pngBytes(), 'image/png')).toBe(true);
    expect(isValidGeneratedImage(new Uint8Array([1, 2, 3]), 'image/png')).toBe(false);
    expect(imageGenerationErrorMessage({ status: 402 })).toMatch(/credits or budget/);
    expect(imageGenerationErrorMessage({ status: 429 })).toMatch(/temporarily rate limited/);
  });

  it('writes temporary PNGs and deletes partial files after a cache write fails', async () => {
    const cached = await writeImageToCache(pngBytes(), 'image/png');
    expect(cached.uri).toMatch(/^file:\/\/\/cache\/lumora-image-.+\.png$/);

    mockWrite.mockRejectedValueOnce(new Error('private filesystem detail'));
    await expect(writeImageToCache(pngBytes(), 'image/png')).rejects.toThrow('private filesystem detail');
    expect(mockDelete).toHaveBeenCalledWith(expect.stringMatching(/^file:\/\/\/cache\/lumora-image-.+\.png$/));
  });

  it('cleans only Lumora image cache files and ignores unrelated paths', () => {
    const { File } = jest.requireMock('expo-file-system');
    const lumoraFile = new File('file:///cache/lumora-image-1700000000000-old.jpg');
    const unrelatedFile = new File('file:///cache/user-download.jpg');
    mockList.mockReturnValue([lumoraFile, unrelatedFile]);

    cleanupImageStudioCache();
    deleteImageFromCache(unrelatedFile.uri);

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(lumoraFile.uri);
  });

  it('deletes a matching Lumora file directly inside the app cache directory', () => {
    const { File } = jest.requireMock('expo-file-system');
    const cachedFile = new File('file:///cache/lumora-image-1700000000000-a1b2.png');

    deleteImageFromCache(cachedFile.uri);

    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDelete).toHaveBeenCalledWith(cachedFile.uri);
  });

  it('does not delete a matching Lumora filename outside the app cache directory', () => {
    deleteImageFromCache('file:///other/lumora-image-1700000000000-a1b2.png');

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('rejects literal and encoded path traversal attempts', () => {
    deleteImageFromCache('file:///cache/../cache/lumora-image-1700000000000-a1b2.png');
    deleteImageFromCache('file:///cache/%2e%2e/cache/lumora-image-1700000000000-a1b2.png');

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('ignores malformed or unsupported file URIs', () => {
    deleteImageFromCache('file:///cache/%E0%A4%A/lumora-image-1700000000000-a1b2.png');
    deleteImageFromCache('content://cache/lumora-image-1700000000000-a1b2.png');
    deleteImageFromCache('not a uri');

    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('does not delete unrelated filenames inside the app cache directory', () => {
    deleteImageFromCache('file:///cache/user-download.jpg');

    expect(mockDelete).not.toHaveBeenCalled();
  });
});
