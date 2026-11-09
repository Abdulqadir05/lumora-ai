/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LUMORA AI — Premium Multi-Model Generative AI Assistant                ║
 * ║  React Native · Expo SDK 58 · JavaScript · StyleSheet                   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * This app NEVER talks to an LLM provider directly and ships NO secrets.
 * All model calls and live-data tools go through the Lumora backend proxy
 * (see ../backend/server.js), which holds provider keys in environment
 * variables and streams real tokens over Server-Sent Events.
 *
 * Install: this folder is a complete Expo project (package.json + lockfile).
 *   pnpm install --frozen-lockfile        (Node 22.13+)
 *   npx expo start
 * Dependencies (all added via `npx expo install`, SDK-matched): expo,
 * @react-native-async-storage/async-storage, expo-clipboard, expo-haptics,
 * expo-audio, expo-file-system, expo-linear-gradient, expo-status-bar, expo-system-ui, expo-font,
 * expo-splash-screen, react-native-safe-area-context, @expo/vector-icons,
 * @ronradtke/react-native-markdown-display@8.1.0 (markdown-it overridden to ^14).
 *
 * Environment (.env in the Expo project root — these are PUBLIC values):
 *   EXPO_PUBLIC_LUMORA_API_URL=https://your-lumora-backend.example.com
 *   EXPO_PUBLIC_LUMORA_CLIENT_TOKEN=<one of the backend LUMORA_CLIENT_TOKENS>
 *
 * Requires a running backend for chat. Live tools also require network access
 * from the backend to Open-Meteo, CoinGecko, ExchangeRate-API, Google News and
 * (optionally) Tavily.
 */

import React, { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Easing,
  FlatList,
  Image,
  Keyboard,
  KeyboardAvoidingView,
  LayoutAnimation,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Share,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { fetch as expoFetch } from 'expo/fetch';
import { AudioModule, RecordingPresets, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from 'expo-audio';
import { Directory, File, Paths, UploadType } from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { LinearGradient } from 'expo-linear-gradient';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import Markdown, { MarkdownIt } from '@ronradtke/react-native-markdown-display';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const ENV = {
  apiUrl: (process.env.EXPO_PUBLIC_LUMORA_API_URL || '').trim(),
  // Public client token: identifies the app to the backend. It is NOT a provider
  // secret — anything in a mobile bundle can be extracted. Use per-user auth for
  // production (see README).
  clientToken: (process.env.EXPO_PUBLIC_LUMORA_CLIENT_TOKEN || '').trim(),
};

const DEFAULT_API_URL =
  ENV.apiUrl || (__DEV__ ? (Platform.OS === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787') : '');

const LIMITS = {
  maxInput: 6000,
  historyMessages: 24,
  historyChars: 40000,
  keepMessages: 200,
  flushMs: 50,
  highlightMaxChars: 12000,
};

const TIMEOUTS = { connect: 30000, idle: 60000, request: 12000 };
const VOICE_TRANSCRIPTION_TIMEOUT_MS = 120000;
/** @type {{ allowsRecording: boolean, playsInSilentMode: boolean, interruptionMode: 'mixWithOthers' }} */
const DEFAULT_AUDIO_MODE = { allowsRecording: false, playsInSilentMode: false, interruptionMode: 'mixWithOthers' };
/** @type {{ allowsRecording: boolean, playsInSilentMode: boolean, interruptionMode: 'mixWithOthers' }} */
const RECORDING_AUDIO_MODE = { allowsRecording: true, playsInSilentMode: false, interruptionMode: 'mixWithOthers' };
const RETRY = { attempts: 3, baseMs: 700, maxMs: 6000 };

const STORAGE_KEYS = {
  prefs: 'lumora.v1.prefs',
  index: 'lumora.v1.index',
  conv: (id) => `lumora.v1.conv.${id}`,
};

const TOKENS = {
  color: {
    bg: '#090A0E',
    surface: '#12141A',
    surface2: '#191C24',
    glass: 'rgba(20,22,29,0.8)',
    glassStrong: 'rgba(18,20,26,0.98)',
    border: 'rgba(235,237,244,0.08)',
    borderStrong: 'rgba(235,237,244,0.14)',
    blue: '#8D7CFA',
    blueBright: '#B1A4FF',
    blueSoft: 'rgba(141,124,250,0.14)',
    blueDeep: '#6758D9',
    amber: '#D7AD72',
    amberSoft: 'rgba(215,173,114,0.13)',
    white: '#F8F8FA',
    text: '#E7E8EC',
    slate: '#A4A7B0',
    muted: '#777B85',
    green: '#7CC9A9',
    greenSoft: 'rgba(124,201,169,0.13)',
    red: '#ED8587',
    redSoft: 'rgba(237,133,135,0.12)',
    code: '#0B0C11',
  },
  space: { xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32 },
  radius: { sm: 10, md: 14, lg: 18, xl: 24, sheet: 28, pill: 999 },
  type: { micro: 10, caption: 12, body: 15, bodyLine: 24, subtitle: 16, title: 20, display: 28 },
  elevation: {
    card: { shadowColor: '#000000', shadowOpacity: 0.18, shadowRadius: 14, shadowOffset: { width: 0, height: 6 }, elevation: 4 },
    float: { shadowColor: '#000000', shadowOpacity: 0.28, shadowRadius: 18, shadowOffset: { width: 0, height: 8 }, elevation: 8 },
  },
};
const C = TOKENS.color;
const SPACE = TOKENS.space;
const RADIUS = TOKENS.radius;
const TYPE = TOKENS.type;
const ELEVATION = TOKENS.elevation;
const ReducedMotionContext = createContext(false);

/** Official Lumora mark (generated from assets/brand/lumora-mark.svg by scripts/brand-assets.mjs). */
const LUMORA_MARK = require('./assets/brand/lumora-mark-white.png');

const MONO = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' });

/** Must match MODEL_CATALOG ids in the backend. Availability comes from GET /api/models. */
const MODELS = [
  { id: 'gpt-oss-20b', label: 'GPT-OSS 20B', category: 'Fast reasoning', icon: 'flash-outline' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', category: 'Deep reasoning', icon: 'sparkles-outline' },
  { id: 'qwen-3.8-27b', label: 'Qwen 3.8 27B', category: 'Reasoning & coding', icon: 'layers-outline' },
];

const LEGACY_MODEL_ID_MIGRATIONS = { 'llama-3.3-70b': 'qwen-3.8-27b' };

const STARTERS = [
  {
    id: 'learn',
    title: 'Explain a concept',
    subtitle: 'Make a difficult idea feel simple.',
    icon: 'bulb-outline',
    tint: C.blueBright,
    prompt: 'Explain gradient descent using a simple everyday analogy.',
  },
  {
    id: 'code',
    title: 'Write Python',
    subtitle: 'Create a useful snippet with an explanation.',
    icon: 'code-slash-outline',
    tint: '#9F92F8',
    prompt: 'Write a Python function that reads a CSV and summarizes its numeric columns.',
  },
  {
    id: 'summarize',
    title: 'Summarize a topic',
    subtitle: 'Get the main ideas in a few clear points.',
    icon: 'reader-outline',
    tint: '#87C9B6',
    prompt: 'Summarize the key ideas of machine learning in five clear bullet points.',
  },
  {
    id: 'search',
    title: 'Search the web',
    subtitle: 'Find current information with sources.',
    icon: 'globe-outline',
    tint: C.amber,
    prompt: 'Search the web for current information about generative AI and cite reliable sources.',
  },
  {
    id: 'weather',
    title: 'Live weather',
    subtitle: 'Choose a city for live conditions.',
    icon: 'partly-sunny-outline',
    tint: '#77B8DD',
    prompt: 'Can you check the current weather?',
  },
];

const DEFAULT_PREFS = {
  modelId: MODELS[0].id,
  toolsMode: 'auto',
  haptics: true,
  apiBaseUrl: '',
  lastConversationId: null,
};

// ═══════════════════════════════════════════════════════════════════════════
// PURE UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

const uid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;

const safeParse = (raw) => {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
};

const normalizeUrl = (url) => String(url || '').trim().replace(/\/+$/, '');
const isAllowedApiUrl = (url) => /^https:\/\/[^\s]+$/i.test(url) || (__DEV__ && /^http:\/\/[^\s]+$/i.test(url));

const getTimezone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (e) {
    return null;
  }
};

function formatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function formatDateTime(iso) {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  try {
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return d.toISOString();
  }
}

function formatDay(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return dateStr;
  try {
    return d.toLocaleDateString([], { weekday: 'short' });
  } catch (e) {
    return dateStr;
  }
}

function formatRelative(ts) {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return 'Just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatUsd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  const digits = n >= 1000 ? 0 : n >= 1 ? 2 : 6;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: Math.min(digits, 2), maximumFractionDigits: digits })}`;
}

function formatNumber(n, max = 4) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: max });
}

/** Promise-based delay that rejects immediately when the signal aborts. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      reject(new ApiError('aborted'));
      return;
    }
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(new ApiError('aborted'));
    }
    if (signal) signal.addEventListener('abort', onAbort);
  });
}

function backoffDelay(attempt, retryAfterSec) {
  if (retryAfterSec && retryAfterSec > 0) return Math.min(retryAfterSec * 1000, RETRY.maxMs);
  return Math.min(RETRY.baseMs * 2 ** (attempt - 1), RETRY.maxMs) + Math.floor(Math.random() * 250);
}

function findLastIndexById(list, id) {
  for (let i = list.length - 1; i >= 0; i -= 1) if (list[i].id === id) return i;
  return -1;
}

// ─── Errors ──────────────────────────────────────────────────────────────────
class ApiError extends Error {
  constructor(kind, { status = 0, code = '', message = '', retryable = false, retryAfter = 0 } = {}) {
    super(message || kind);
    this.kind = kind; // aborted | network | timeout | http | server | malformed | stream_interrupted
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfter = retryAfter;
  }
}

/** Turns any failure into a short, human sentence. Never shows raw stack traces. */
function friendlyError(err) {
  if (!err) return 'Something went wrong. Tap Regenerate to try again.';
  const { kind, status, code } = err;
  if (kind === 'network') return "Can't reach Lumora. Check your internet connection or the backend URL in Settings.";
  if (kind === 'timeout') return 'The request timed out. Your connection may be slow — tap Regenerate to try again.';
  if (kind === 'stream_interrupted' || code === 'stream_interrupted') return 'The response was interrupted before it finished. The partial answer is kept — tap Regenerate to retry.';
  if (kind === 'malformed') return 'Lumora received an unexpected response from the server. Please try again.';
  switch (code) {
    case 'provider_auth':
      return 'The AI provider rejected the server credentials. The backend administrator needs to update the provider API key.';
    case 'provider_access_denied':
      return 'The AI provider denied access to this project or model. The backend administrator should check provider permissions.';
    case 'provider_quota_exceeded':
      return 'The AI provider account has no available quota or billing capacity. Please try again later.';
    case 'provider_not_configured':
      return 'The AI provider is not configured on the Lumora backend yet.';
    case 'model_unavailable':
      return 'This model is unavailable on the provider account. Choose another available model from the selector.';
    case 'invalid_model':
      return 'This model selection is invalid. Choose a model from the selector.';
    case 'provider_rate_limited':
    case 'rate_limited':
      return 'Too many requests right now. Wait a few seconds and try again.';
    case 'upstream_timeout':
      return 'The AI provider took too long to respond. Please try again.';
    default:
      break;
  }
  if (status === 400) return err.message && err.message !== 'http' ? err.message : 'The request was invalid. Try rephrasing your message.';
  if (status === 401) return "Lumora couldn't verify this app's backend access. Please ask the app administrator to check the connection.";
  if (status === 403) return 'Access to the Lumora backend was denied.';
  if (status === 404) return 'Lumora endpoint not found. Check the backend URL in Settings.';
  if (status === 429) return 'Rate limit reached. Wait a moment, then try again.';
  if (status >= 500) return 'Lumora servers are having trouble right now. Please try again shortly.';
  return err.message && err.message.length < 200 ? err.message : 'Something went wrong. Tap Regenerate to try again.';
}

function voiceTranscriptionError(status, code, timedOut = false) {
  if (timedOut || code === 'tool_timeout' || status === 504) return 'Transcription timed out. Try a shorter recording or try again.';
  if (status === 401 || status === 403) return "Lumora couldn't verify backend access. Check the app connection and try again.";
  if (status === 413 || code === 'payload_too_large') return 'This recording is too large. Record a shorter clip and try again.';
  if (status === 400 || status === 415 || ['invalid_multipart', 'audio_required', 'invalid_audio', 'unsupported_audio'].includes(code)) {
    return 'This recording could not be read. Record a new clip and try again.';
  }
  if (status === 429 || code === 'provider_rate_limited' || code === 'rate_limited') return 'Speech transcription is temporarily rate limited. Wait a little and try again.';
  if (code === 'voice_busy') return 'Speech transcription is busy right now. Try again shortly.';
  if (code === 'provider_not_configured') return 'Speech transcription is not configured on the Lumora backend yet.';
  if (status >= 500 || String(code || '').startsWith('provider_')) return 'Speech transcription is temporarily unavailable. Please try again.';
  return 'Could not transcribe this recording. Check your connection and try again.';
}

function normalizeFetchError(e, userSignal, timedOut, midStream) {
  if (e instanceof ApiError) return e;
  if (userSignal && userSignal.aborted) return new ApiError('aborted');
  if (timedOut) return new ApiError('timeout', { retryable: !midStream });
  if (midStream) return new ApiError('stream_interrupted');
  return new ApiError('network', { retryable: true });
}

async function errorFromResponse(res) {
  let code = '';
  let message = '';
  try {
    const text = await res.text();
    const body = safeParse(text);
    if (body && body.error) {
      code = String(body.error.code || '');
      message = String(body.error.message || '');
    }
  } catch (e) {
    // body unreadable — status is enough
  }
  const retryAfter = parseInt((res.headers && res.headers.get && res.headers.get('retry-after')) || '0', 10) || 0;
  const retryable = [408, 429, 500, 502, 503, 504].includes(res.status) && code !== 'provider_auth';
  return new ApiError('http', { status: res.status, code, message, retryable, retryAfter });
}

// ─── Incremental UTF-8 decoding (TextDecoder with a safe fallback) ────────────
function createUtf8Decoder() {
  if (typeof TextDecoder !== 'undefined') {
    try {
      const td = new TextDecoder('utf-8');
      return { decode: (u8) => td.decode(u8, { stream: true }), flush: () => td.decode() };
    } catch (e) {
      // fall through to manual decoder
    }
  }
  let carry = [];
  const decode = (u8) => {
    const bytes = carry.concat(Array.from(u8 || []));
    let out = '';
    let i = 0;
    while (i < bytes.length) {
      const b = bytes[i];
      const need = b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
      if (i + need > bytes.length) break;
      let cp;
      if (need === 1) cp = b < 0x80 ? b : 0xfffd;
      else if (need === 2) cp = ((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f);
      else if (need === 3) cp = ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f);
      else cp = ((b & 0x07) << 18) | ((bytes[i + 1] & 0x3f) << 12) | ((bytes[i + 2] & 0x3f) << 6) | (bytes[i + 3] & 0x3f);
      out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
      i += need;
    }
    carry = bytes.slice(i);
    return out;
  };
  return { decode, flush: () => (carry.length ? ((carry = []), '\ufffd') : '') };
}

// ─── Server-Sent Events parser ───────────────────────────────────────────────
function createSSEParser(onEvent) {
  let buffer = '';
  let done = false;
  const dispatch = (block) => {
    let event = 'message';
    const data = [];
    block.split(/\r?\n/).forEach((line) => {
      if (!line || line.startsWith(':')) return; // comment / heartbeat
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    });
    if (!data.length) return;
    const parsed = safeParse(data.join('\n'));
    if (parsed === null || typeof parsed !== 'object') throw new ApiError('malformed');
    if (event === 'done') done = true;
    onEvent(event, parsed);
  };
  return {
    push(text) {
      if (!text) return;
      buffer += text;
      let match = buffer.match(/\r?\n\r?\n/);
      while (match) {
        const block = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        dispatch(block);
        match = buffer.match(/\r?\n\r?\n/);
      }
    },
    end() {
      if (buffer.trim()) dispatch(buffer);
      buffer = '';
    },
    isDone: () => done,
  };
}

// ─── Markdown preparation (citations + safe partial rendering) ───────────────
const FENCE_RX = /^\s*(```|~~~)/;

/** Converts only HTML line-break tags outside fenced and inline code. Other HTML stays text. */
function normalizeHtmlBreaks(text) {
  const parts = String(text || '').split(/(\r?\n)/);
  let inFence = false;
  let inlineTicks = 0;

  return parts
    .map((line, index) => {
      if (index % 2 === 1) return line;
      const fence = !inlineTicks && /^\s{0,3}(`{3,}|~{3,})/.test(line);
      if (fence) {
        inFence = !inFence;
        return line;
      }
      if (inFence || /^(?: {4}|\t)/.test(line)) return line;

      const hasLineEnding = index + 1 < parts.length;
      let out = '';
      for (let i = 0; i < line.length;) {
        if (line[i] === '`') {
          let end = i + 1;
          while (line[end] === '`') end += 1;
          const runLength = end - i;
          out += line.slice(i, end);
          if (!inlineTicks) inlineTicks = runLength;
          else if (inlineTicks === runLength) inlineTicks = 0;
          i = end;
          continue;
        }

        if (!inlineTicks) {
          const firstBreak = /^<br\s*\/?>/i.exec(line.slice(i));
          if (firstBreak) {
            let cursor = i;
            let count = 0;
            while (cursor < line.length) {
              while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
              const match = /^<br\s*\/?>/i.exec(line.slice(cursor));
              if (!match) break;
              count += 1;
              cursor += match[0].length;
            }
            while (line[cursor] === ' ' || line[cursor] === '\t') cursor += 1;
            const atLineEnd = cursor === line.length;
            const breaks = Math.min(count, 2) - (atLineEnd && hasLineEnding ? 1 : 0);
            out += '\n'.repeat(Math.max(0, breaks));
            i = cursor;
            continue;
          }
        }

        out += line[i];
        i += 1;
      }
      return out;
    })
    .join('');
}

function prepareMarkdown(text, sourceCount, streaming) {
  let src = normalizeHtmlBreaks(text);
  if (streaming) {
    // Close an unterminated fence so half-streamed code renders as code.
    const fences = src.split('\n').filter((l) => FENCE_RX.test(l)).length;
    if (fences % 2 === 1) src += '\n```';
  }
  let inFence = false;
  return src
    .split('\n')
    .map((line) => {
      if (FENCE_RX.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/)
        .map((seg) => {
          if (seg.length > 1 && seg.startsWith('`') && seg.endsWith('`')) return seg;
          return seg.replace(/(^|[^\]\\!])\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\](?![(:])/g, (m, pre, nums) => {
            const parts = nums.split(',').map((n) => {
              const k = parseInt(n, 10);
              return k >= 1 && k <= sourceCount ? `[\\[${k}\\]](cite:${k})` : `\\[${k}\\]`;
            });
            return pre + parts.join('');
          });
        })
        .join('');
    })
    .join('\n');
}

/** Strips inline [n] citations before resending assistant turns as context. */
const stripCitations = (s) => String(s || '').replace(/\s?\[\d{1,2}(?:\s*,\s*\d{1,2})*\](?!\()/g, '');

function toApiMessages(history) {
  const usable = history.filter(
    (m) =>
      (m.role === 'user' && m.content.trim()) ||
      (m.role === 'assistant' && (m.status === 'done' || m.status === 'stopped') && m.content.trim()),
  );
  const out = [];
  let chars = 0;
  for (let i = usable.length - 1; i >= 0 && out.length < LIMITS.historyMessages; i -= 1) {
    const m = usable[i];
    const content = (m.role === 'assistant' ? stripCitations(m.content) : m.content).trim().slice(0, 7900);
    if (!content) continue;
    if (chars + content.length > LIMITS.historyChars && out.length) break;
    chars += content.length;
    out.unshift({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
}

// ─── Lightweight syntax highlighter ──────────────────────────────────────────
const KEYWORDS = new Set(
  (
    'abstract and as async await break case catch class const continue def default defer del do elif else enum except export extends ' +
    'false final finally fn for from func function go if impl import in instanceof interface is lambda let match mod mut new nil none ' +
    'not null of or package pass private protected pub public raise return self static struct super switch this throw throws true try ' +
    'type typeof undefined use val var void when where while with yield True False None println print'
  ).split(' '),
);
const HL_COLORS = { comment: '#64748B', string: '#FBBF24', number: '#F59E0B', keyword: '#60A5FA', func: '#A5B4FC', type: '#5EEAD4', plain: '#E2E8F0' };
const HASH_COMMENT_LANGS = /^(py|python|sh|bash|shell|zsh|rb|ruby|yaml|yml|toml|r|perl|dockerfile|makefile|make|ps1|powershell)$/i;
const PLAIN_LANGS = /^(|text|txt|plain|plaintext|md|markdown|output|console|log)$/i;

function highlightCode(code, lang) {
  if (code.length > LIMITS.highlightMaxChars || PLAIN_LANGS.test(lang || '')) return [{ t: code, c: 'plain' }];
  const comment = HASH_COMMENT_LANGS.test(lang || '') ? /#[^\n]*/ : /\/\/[^\n]*/;
  const parts = [comment, /\/\*[\s\S]*?\*\//, /"(?:\\.|[^"\\\n])*"/, /'(?:\\.|[^'\\\n])*'/, /`(?:\\.|[^`\\])*`/, /\b\d+(?:\.\d+)?\b/, /[A-Za-z_$][\w$]*/];
  const re = new RegExp(parts.map((r) => `(${r.source})`).join('|'), 'g');
  const out = [];
  const pushSeg = (t, c) => {
    if (!t) return;
    const prev = out[out.length - 1];
    if (prev && prev.c === c) prev.t += t;
    else out.push({ t, c });
  };
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m.index > last) pushSeg(code.slice(last, m.index), 'plain');
    const tok = m[0];
    if (m[1] || m[2]) pushSeg(tok, 'comment');
    else if (m[3] || m[4] || m[5]) pushSeg(tok, 'string');
    else if (m[6]) pushSeg(tok, 'number');
    else if (KEYWORDS.has(tok)) pushSeg(tok, 'keyword');
    else if (code.charAt(re.lastIndex) === '(') pushSeg(tok, 'func');
    else if (/^[A-Z][a-zA-Z0-9]+$/.test(tok)) pushSeg(tok, 'type');
    else pushSeg(tok, 'plain');
    last = re.lastIndex;
  }
  if (last < code.length) pushSeg(code.slice(last), 'plain');
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// API CLIENT
// ═══════════════════════════════════════════════════════════════════════════

function buildHeaders({ stream = false, hasBody = false } = {}) {
  const h = { Accept: stream ? 'text/event-stream' : 'application/json' };
  if (hasBody) h['Content-Type'] = 'application/json';
  if (ENV.clientToken) h.Authorization = `Bearer ${ENV.clientToken}`;
  return h;
}

/**
 * Plain JSON request with timeout (used for health + model discovery).
 * @param {string} url
 * @param {{ method?: string, body?: any, signal?: AbortSignal, timeout?: number }} [options]
 */
async function requestJson(url, { method = 'GET', body, signal, timeout = TIMEOUTS.request } = {}) {
  const ctrl = new AbortController();
  let timedOut = false;
  const relay = () => ctrl.abort();
  if (signal) signal.addEventListener('abort', relay);
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeout);
  try {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: buildHeaders({ hasBody: !!body }),
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
    } catch (e) {
      throw normalizeFetchError(e, signal, timedOut, false);
    }
    if (!res.ok) throw await errorFromResponse(res);
    try {
      return await res.json();
    } catch (e) {
      throw new ApiError('malformed');
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relay);
  }
}

const fetchModels = (baseUrl, signal) => requestJson(`${baseUrl}/api/models`, { signal });
const fetchHealth = (baseUrl, signal) => requestJson(`${baseUrl}/api/health`, { signal });

/**
 * Genuine token streaming over SSE using expo/fetch (ReadableStream support on
 * iOS + Android). Resolves when the server sends `done`; throws ApiError
 * otherwise. Every network resource is released in `finally`.
 */
async function streamChat({ baseUrl, body, signal, onOpen, onEvent }) {
  if (signal.aborted) throw new ApiError('aborted');
  const ctrl = new AbortController();
  const relay = () => ctrl.abort();
  signal.addEventListener('abort', relay);
  let timer = null;
  let timedOut = false;
  const arm = (ms) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, ms);
  };
  let reader = null;
  let midStream = false;
  try {
    arm(TIMEOUTS.connect);
    let res;
    try {
      res = await expoFetch(`${baseUrl}/api/chat/stream`, {
        method: 'POST',
        headers: buildHeaders({ stream: true, hasBody: true }),
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw normalizeFetchError(e, signal, timedOut, false);
    }
    if (!res.ok) throw await errorFromResponse(res);
    if (!res.body || typeof res.body.getReader !== 'function') throw new ApiError('malformed', { message: 'Streaming unsupported' });
    if (onOpen) onOpen();
    midStream = true;
    reader = res.body.getReader();
    const decoder = createUtf8Decoder();
    const parser = createSSEParser(onEvent);
    for (;;) {
      arm(TIMEOUTS.idle);
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw normalizeFetchError(e, signal, timedOut, true);
      }
      if (chunk.done) break;
      parser.push(decoder.decode(chunk.value));
      if (parser.isDone()) break;
    }
    parser.push(decoder.flush());
    parser.end();
    if (!parser.isDone()) throw new ApiError('stream_interrupted');
  } catch (e) {
    throw normalizeFetchError(e, signal, timedOut, midStream);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', relay);
    if (reader) {
      try {
        const p = reader.cancel();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (e) {
        // already released
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCAL PERSISTENCE (AsyncStorage)
// ═══════════════════════════════════════════════════════════════════════════

function sanitizePrefs(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const migratedModelId = LEGACY_MODEL_ID_MIGRATIONS[p.modelId];
  const modelId = MODELS.some((m) => m.id === p.modelId) ? p.modelId : migratedModelId || DEFAULT_PREFS.modelId;
  return {
    modelId,
    toolsMode: p.toolsMode === 'off' ? 'off' : 'auto',
    haptics: p.haptics !== false,
    apiBaseUrl: typeof p.apiBaseUrl === 'string' ? p.apiBaseUrl : '',
    lastConversationId: typeof p.lastConversationId === 'string' ? p.lastConversationId : null,
  };
}

function sanitizeIndex(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => c && typeof c.id === 'string' && typeof c.title === 'string')
    .map((c) => ({
      id: c.id,
      title: c.title.slice(0, 120),
      preview: typeof c.preview === 'string' ? c.preview.slice(0, 160) : '',
      updatedAt: Number(c.updatedAt) || Date.now(),
      modelId: typeof c.modelId === 'string' ? c.modelId : MODELS[0].id,
      count: Number(c.count) || 0,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function sanitizeMessages(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((m) => m && typeof m.id === 'string' && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: Number(m.createdAt) || Date.now(),
      modelId: typeof m.modelId === 'string' ? m.modelId : undefined,
      modelLabel: typeof m.modelLabel === 'string' ? m.modelLabel : undefined,
      status: m.status === 'streaming' ? 'stopped' : ['done', 'stopped', 'error'].includes(m.status) ? m.status : 'done',
      sources: Array.isArray(m.sources) ? m.sources : [],
      tools: Array.isArray(m.tools) ? m.tools : [],
      toolErrors: Array.isArray(m.toolErrors) ? m.toolErrors : [],
      errorText: typeof m.errorText === 'string' ? m.errorText : undefined,
      finishReason: typeof m.finishReason === 'string' ? m.finishReason : undefined,
    }));
}

function serializeMessages(messages) {
  return JSON.stringify(
    messages.slice(-LIMITS.keepMessages).map(({ statusLabel, ...m }) => ({ ...m, status: m.status === 'streaming' ? 'stopped' : m.status })),
  );
}

function summarizeConversation(id, messages, modelId) {
  const firstUser = messages.find((m) => m.role === 'user');
  const last = messages[messages.length - 1];
  const title = firstUser ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, 60) : 'New conversation';
  return {
    id,
    title: title || 'New conversation',
    preview: last ? last.content.replace(/[#*`>_\[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) : '',
    updatedAt: Date.now(),
    modelId,
    count: messages.length,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// HOOKS
// ═══════════════════════════════════════════════════════════════════════════

/** Keyboard tracking that works with iOS (overlay) and Android (resize, pan or edge-to-edge). */
function useKeyboard() {
  const [kb, setKb] = useState({ visible: false, height: 0 });
  useEffect(() => {
    const ios = Platform.OS === 'ios';
    const animate = (e) => {
      if (ios && e && e.duration) {
        LayoutAnimation.configureNext({
          duration: e.duration,
          update: { duration: e.duration, type: LayoutAnimation.Types.keyboard },
        });
      }
    };
    const show = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', (e) => {
      animate(e);
      setKb({ visible: true, height: (e && e.endCoordinates && e.endCoordinates.height) || 0 });
    });
    const hide = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', (e) => {
      animate(e);
      setKb({ visible: false, height: 0 });
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);
  return kb;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    let active = true;
    const update = (value) => active && setReduced(!!value);
    const result = AccessibilityInfo.isReduceMotionEnabled?.();
    if (result && typeof result.then === 'function') result.then(update).catch(() => {});
    const subscription = AccessibilityInfo.addEventListener?.('reduceMotionChanged', update);
    return () => {
      active = false;
      subscription?.remove?.();
    };
  }, []);
  return reduced;
}

function useReducedMotionPreference() {
  return useContext(ReducedMotionContext);
}

function useMountedRef() {
  const ref = useRef(true);
  useEffect(() => {
    ref.current = true;
    return () => {
      ref.current = false;
    };
  }, []);
  return ref;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRIMITIVE UI COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

/** @param {any} props */
function PressableScale({ children, style, onPress, onLongPress, disabled, scaleTo = 0.95, hitSlop, accessibilityLabel, accessibilityHint, accessibilityRole = 'button', accessibilityState, testID }) {
  const scale = useRef(new Animated.Value(1)).current;
  const reducedMotion = useReducedMotionPreference();
  const to = useCallback(
    (v) => {
      if (reducedMotion) {
        scale.setValue(1);
        return;
      }
      Animated.spring(scale, { toValue: v, useNativeDriver: true, speed: 40, bounciness: 6 }).start();
    },
    [reducedMotion, scale],
  );
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={hitSlop}
      onPressIn={() => to(scaleTo)}
      onPressOut={() => to(1)}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, ...accessibilityState }}
    >
      <Animated.View testID={testID} style={[style, { transform: [{ scale }] }, disabled ? styles.disabled : null]}>{children}</Animated.View>
    </Pressable>
  );
}

/** @param {any} props */
function IconButton({ icon, onPress, label, color = C.text, size = 18, style, disabled }) {
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={[styles.iconBtn, style]}
    >
      <Ionicons name={icon} size={size} color={color} />
    </PressableScale>
  );
}

/** Soft radial glow faked with concentric translucent circles (no blur dependency). */
/** @param {any} props */
function GlowOrb({ rgb, size, style, strength = 1 }) {
  const rings = [1, 0.74, 0.5, 0.3];
  return (
    <View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size }, style]}>
      {rings.map((r, i) => (
        <View
          key={r}
          style={{
            position: 'absolute',
            width: size * r,
            height: size * r,
            borderRadius: (size * r) / 2,
            left: (size - size * r) / 2,
            top: (size - size * r) / 2,
            backgroundColor: `rgba(${rgb},${(0.035 + i * 0.022) * strength})`,
          }}
        />
      ))}
    </View>
  );
}

const AmbientGlow = memo(function AmbientGlow() {
  const { width, height } = useWindowDimensions();
  const drift = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    drift.setValue(0);
    if (reducedMotion) return undefined;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(drift, { toValue: 1, duration: 9000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(drift, { toValue: 0, duration: 9000, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [drift, reducedMotion]);
  const big = Math.max(width, 360) * 1.25;
  const ty = drift.interpolate({ inputRange: [0, 1], outputRange: [0, 28] });
  const tx = drift.interpolate({ inputRange: [0, 1], outputRange: [0, -22] });
  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill}>
      <Animated.View style={{ transform: [{ translateY: ty }] }}>
        <GlowOrb rgb="141,124,250" size={big} style={{ top: -big * 0.55, left: -big * 0.4 }} strength={0.8} />
      </Animated.View>
      <Animated.View style={{ transform: [{ translateX: tx }] }}>
        <GlowOrb rgb="124,201,169" size={big * 0.8} style={{ top: height * 0.55, left: width - big * 0.35 }} strength={0.45} />
      </Animated.View>
    </View>
  );
});

/** @param {any} props */
/** Same composition as the app icon: the official mark on a midnight tile. */
function BrandMark({ size = 40 }) {
  return (
    <LinearGradient
      colors={['#242137', '#101116']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[styles.brandTile, { width: size, height: size, borderRadius: size * 0.28 }]}
      accessibilityRole="image"
      accessibilityLabel="Lumora AI"
    >
      <Image source={LUMORA_MARK} style={{ width: size * 0.56, height: size * 0.56 }} resizeMode="contain" />
    </LinearGradient>
  );
}

/** @param {any} props */
function PulseDot({ color, active }) {
  const v = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    if (!active || reducedMotion) {
      v.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(v, { toValue: 1, duration: 1600, easing: Easing.out(Easing.ease), useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [active, reducedMotion, v]);
  return (
    <View style={styles.pulseWrap}>
      {active && !reducedMotion && (
        <Animated.View
          style={[
            styles.pulseRing,
            {
              backgroundColor: color,
              opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] }),
              transform: [{ scale: v.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) }],
            },
          ]}
        />
      )}
      <View style={[styles.pulseCore, { backgroundColor: color }]} />
    </View>
  );
}

/** @param {any} props */
function TypingDots({ color = C.blueBright }) {
  const dots = useRef([0, 1, 2].map(() => new Animated.Value(0))).current;
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    if (reducedMotion) {
      dots.forEach((dot) => dot.setValue(0));
      return undefined;
    }
    const loops = dots.map((d, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(i * 150),
          Animated.timing(d, { toValue: 1, duration: 340, easing: Easing.out(Easing.quad), useNativeDriver: true }),
          Animated.timing(d, { toValue: 0, duration: 340, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.delay((2 - i) * 150),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [dots, reducedMotion]);
  return (
    <View style={styles.dotsRow}>
      {dots.map((d, i) => (
        reducedMotion ? (
          <View key={i} style={[styles.typingDot, { backgroundColor: color, opacity: 0.7 }]} />
        ) : (
          <Animated.View
            key={i}
            style={[
              styles.typingDot,
              {
                backgroundColor: color,
                opacity: d.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
                transform: [{ translateY: d.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) }],
              },
            ]}
          />
        )
      ))}
    </View>
  );
}

function StreamingCaret() {
  const v = useRef(new Animated.Value(1)).current;
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    if (reducedMotion) {
      v.setValue(1);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 0.15, duration: 480, useNativeDriver: true }),
        Animated.timing(v, { toValue: 1, duration: 480, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, v]);
  return reducedMotion ? <View style={styles.caret} /> : <Animated.View style={[styles.caret, { opacity: v }]} />;
}

/** @param {any} props */
function Toast({ toast }) {
  const v = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    if (!toast) return undefined;
    v.setValue(0);
    if (reducedMotion) {
      v.setValue(1);
      const timeout = setTimeout(() => v.setValue(0), 2160);
      return () => clearTimeout(timeout);
    }
    const anim = Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(1900),
      Animated.timing(v, { toValue: 0, duration: 260, useNativeDriver: true }),
    ]);
    anim.start();
    return () => anim.stop();
  }, [reducedMotion, toast, v]);
  if (!toast) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.toast,
        { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }] },
      ]}
    >
      <Ionicons name={toast.icon || 'information-circle-outline'} size={16} color={C.blueBright} />
      <Text style={styles.toastText}>{toast.text}</Text>
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// HEADER + MODEL SELECTOR
// ═══════════════════════════════════════════════════════════════════════════

const BACKEND_STATUS = {
  online: { color: C.green, label: 'Online' },
  checking: { color: C.amber, label: 'Connecting' },
  offline: { color: C.red, label: 'Offline' },
  unconfigured: { color: C.muted, label: 'Setup required' },
};

const Header = memo(/** @param {any} props */ function Header({ backendState, isGenerating, onHistory, onNewChat, onSettings }) {
  const status = BACKEND_STATUS[backendState] || BACKEND_STATUS.checking;
  return (
    <View style={styles.header}>
      <View style={styles.headerLeft}>
        <BrandMark size={36} />
        <View style={styles.headerTitles}>
          <View style={styles.titleRow}>
            <Text style={styles.brandName}>Lumora</Text>
            <Text style={styles.brandAI}>AI</Text>
          </View>
          <View style={styles.statusRow}>
            <PulseDot color={status.color} active={backendState === 'online' || isGenerating} />
            <Text style={styles.statusText} numberOfLines={1}>
              {isGenerating ? 'Generating response' : status.label}
            </Text>
          </View>
        </View>
      </View>
      <View style={styles.headerRight}>
        <IconButton icon="time-outline" label="Conversation history" onPress={onHistory} />
        <IconButton icon="create-outline" label="New chat" onPress={onNewChat} />
        <IconButton icon="settings-outline" label="Settings" onPress={onSettings} />
      </View>
    </View>
  );
});

const ModelChip = memo(/** @param {any} props */ function ModelChip({ model, active, availability, onSelect }) {
  const unavailable = availability && availability.available === false;
  return (
    <Pressable
      onPress={() => onSelect(model.id)}
      accessibilityRole="button"
      accessibilityLabel={`Select ${model.label}`}
      accessibilityHint={unavailable ? availability.reason || 'This model is unavailable.' : `${model.category}${active ? ', currently selected' : ''}`}
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [styles.modelOption, active && styles.modelOptionActive, unavailable && styles.modelOptionOff, pressed && styles.pressed]}
    >
      <View style={[styles.modelOptionIcon, active && styles.modelOptionIconActive]}>
        <Ionicons name={unavailable ? 'cloud-offline-outline' : model.icon} size={18} color={active ? C.white : C.slate} />
      </View>
      <View style={styles.modelOptionCopy}>
        <View style={styles.modelOptionTitleRow}>
          <Text style={[styles.modelName, active && styles.modelNameActive]}>{model.label}</Text>
          {active && <Text style={styles.selectedTag}>SELECTED</Text>}
        </View>
        <Text style={[styles.modelCat, unavailable && { color: C.red }]}>{unavailable ? 'Unavailable on this provider' : model.category}</Text>
        {unavailable && !!availability.reason && <Text style={styles.modelReason}>{availability.reason}</Text>}
      </View>
      {active && <Ionicons name="checkmark-circle" size={20} color={C.blueBright} />}
    </Pressable>
  );
});

const ModelSelector = memo(/** @param {any} props */ function ModelSelector({ activeId, availability, onSelect }) {
  const [open, setOpen] = useState(false);
  const activeModel = MODELS.find((model) => model.id === activeId) || MODELS[0];
  const activeUnavailable = availability?.[activeModel.id]?.available === false;
  return (
    <>
      <PressableScale
        onPress={() => setOpen(true)}
        accessibilityLabel="Choose model"
        accessibilityHint={`Current model: ${activeModel.label}`}
        accessibilityState={{ expanded: open }}
        style={styles.modelSelectorWrap}
        scaleTo={0.99}
      >
        <View style={styles.modelSelectorButton}>
          <View style={styles.modelSelectorGlyph}>
            <Ionicons name={activeUnavailable ? 'cloud-offline-outline' : 'sparkles-outline'} size={16} color={activeUnavailable ? C.red : C.blueBright} />
          </View>
          <View style={styles.modelSelectorCopy}>
            <Text style={styles.modelSelectorEyebrow}>MODEL</Text>
            <Text style={styles.modelSelectorName} numberOfLines={1}>{activeModel.label}</Text>
          </View>
          <Text style={[styles.modelSelectorStatus, activeUnavailable && styles.modelUnavailable]} numberOfLines={1}>
            {activeUnavailable ? 'Unavailable' : activeModel.category}
          </Text>
          <Ionicons name="chevron-down" size={16} color={C.slate} />
        </View>
      </PressableScale>
      <Sheet visible={open} title="Choose a model" onClose={() => setOpen(false)}>
        <Text style={styles.modelSheetHint}>Your choice is saved on this device and used for the next reply.</Text>
        <ScrollView style={styles.modelOptions} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          {MODELS.map((model) => (
            <ModelChip
              key={model.id}
              model={model}
              active={model.id === activeId}
              availability={availability?.[model.id]}
              onSelect={(id) => {
                onSelect(id);
                setOpen(false);
              }}
            />
          ))}
        </ScrollView>
      </Sheet>
    </>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// WELCOME + STARTERS
// ═══════════════════════════════════════════════════════════════════════════

const StarterCard = memo(/** @param {any} props */ function StarterCard({ starter, width, onPress, disabled }) {
  return (
    <PressableScale onPress={() => onPress(starter.prompt)} disabled={disabled} accessibilityLabel={starter.title} scaleTo={0.97}>
      <View style={[styles.starterCard, { width }]}>
        <View style={[styles.starterIcon, { backgroundColor: `${starter.tint}20`, borderColor: `${starter.tint}50` }]}>
          <Ionicons name={starter.icon} size={18} color={starter.tint} />
        </View>
        <Text style={styles.starterTitle} numberOfLines={1}>
          {starter.title}
        </Text>
        <Text style={styles.starterSub} numberOfLines={2}>
          {starter.subtitle}
        </Text>
        <View style={styles.starterGo}><Ionicons name="arrow-up-right-box" size={15} color={C.blueBright} /></View>
      </View>
    </PressableScale>
  );
});

const WelcomeScreen = memo(/** @param {any} props */ function WelcomeScreen({ onStarter, backendState, onOpenSettings, disabled }) {
  const { width } = useWindowDimensions();
  const cardWidth = Math.min(230, Math.max(190, width * 0.72));
  return (
    <View style={styles.welcome}>
      <View style={styles.welcomeHero}>
        <View style={styles.welcomeOrbStage}>
          <GlowOrb rgb="141,124,250" size={180} style={{ top: -14, left: -14 }} strength={1.1} />
          <View style={[styles.orbOrbit, styles.orbOrbitOuter]} />
          <View style={[styles.orbOrbit, styles.orbOrbitInner]} />
          <LinearGradient colors={['#39334F', '#191821']} start={{ x: 0.1, y: 0 }} end={{ x: 0.9, y: 1 }} style={styles.welcomeOrbCore}>
            <BrandMark size={48} />
          </LinearGradient>
          <View style={styles.orbSparkle}><Ionicons name="sparkles" size={14} color={C.white} /></View>
        </View>
        <Text style={styles.welcomeEyebrow}>YOUR AI THINKING SPACE</Text>
        <Text style={styles.welcomeTitle}>What can we figure out?</Text>
        <Text style={styles.welcomeSub}>Ask a question, shape an idea, or bring in live information.</Text>
      </View>
      {(backendState === 'offline' || backendState === 'unconfigured') && (
        <PressableScale onPress={onOpenSettings} style={styles.setupBanner} accessibilityLabel="Open settings">
          <Ionicons name="server-outline" size={18} color={C.amber} />
          <View style={{ flex: 1 }}>
            <Text style={styles.setupTitle}>{backendState === 'offline' ? 'Backend unreachable' : 'Connect your backend'}</Text>
            <Text style={styles.setupText}>Lumora is having trouble connecting. Open Settings to retry or review connection details.</Text>
          </View>
          <Ionicons name="chevron-forward" size={16} color={C.slate} />
        </PressableScale>
      )}
      <View style={styles.starterHeading}>
        <Text style={styles.sectionLabel}>START WITH A PROMPT</Text>
        <Text style={styles.starterCount}>QUICK IDEAS</Text>
      </View>
      <ScrollView
        horizontal
        nestedScrollEnabled
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.starterRail}
        testID="starter-prompts-rail"
      >
        {STARTERS.map((s) => <StarterCard key={s.id} starter={s} width={cardWidth} onPress={onStarter} disabled={disabled} />)}
      </ScrollView>
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// MARKDOWN + CODE
// ═══════════════════════════════════════════════════════════════════════════

const markdownIt = MarkdownIt({ html: false, linkify: true, typographer: true, breaks: true });

const CodeBlock = memo(/** @param {any} props */ function CodeBlock({ code, lang, onCopy }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const segments = useMemo(() => highlightCode(code, lang), [code, lang]);
  const handleCopy = useCallback(async () => {
    const ok = await onCopy(code, true);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1600);
  }, [code, onCopy]);
  return (
    <View style={styles.codeBlock}>
      <View style={styles.codeHeader}>
        <View style={styles.codeLangRow}>
          <View style={styles.codeLangDot} />
          <Text style={styles.codeLang}>{(lang || 'code').toUpperCase()}</Text>
        </View>
        <Pressable onPress={handleCopy} hitSlop={8} style={styles.codeCopyBtn} accessibilityLabel="Copy code">
          <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={13} color={copied ? C.green : C.slate} />
          <Text style={[styles.codeCopyText, copied && { color: C.green }]}>{copied ? 'Copied' : 'Copy'}</Text>
        </Pressable>
      </View>
      <ScrollView horizontal showsHorizontalScrollIndicator bounces={false} contentContainerStyle={styles.codeScroll}>
        <Text selectable style={styles.codeText}>
          {segments.map((s, i) => (
            <Text key={i} style={{ color: HL_COLORS[s.c] }}>
              {s.t}
            </Text>
          ))}
        </Text>
      </ScrollView>
    </View>
  );
});

/** Falls back to plain text if the Markdown renderer ever throws on partial input. */
class MarkdownBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidUpdate(prev) {
    if (prev.text !== this.props.text && this.state.failed) this.setState({ failed: false });
  }

  render() {
    if (this.state.failed) return <Text style={styles.mdFallback}>{this.props.text}</Text>;
    return this.props.children;
  }
}

function markdownNodeText(node) {
  if (!node) return '';
  if (node.children && node.children.length) return node.children.map(markdownNodeText).join('');
  return String(node.content || '');
}

/** @param {React.ReactNode} element */
function renderedElementChildren(element) {
  if (!React.isValidElement(element)) return [];
  const props = /** @type {{ children?: React.ReactNode }} */ (element.props);
  return React.Children.toArray(props.children);
}

const MarkdownMessage = memo(/** @param {any} props */ function MarkdownMessage({ text, sources, streaming, onOpenUrl, onCopy }) {
  const count = sources ? sources.length : 0;
  const prepared = useMemo(() => prepareMarkdown(text, count, streaming), [text, count, streaming]);
  const rules = useMemo(
    () => ({
      fence: (node) => (
        <CodeBlock
          key={node.key}
          code={String(node.content || '').replace(/\n$/, '')}
          lang={String(node.sourceInfo || '').trim().split(/\s+/)[0]}
          onCopy={onCopy}
        />
      ),
      code_block: (node) => <CodeBlock key={node.key} code={String(node.content || '').replace(/\n$/, '')} lang="" onCopy={onCopy} />,
      link: (node, children, parent, mdStyles) => {
        const href = (node.attributes && node.attributes.href) || '';
        if (href.startsWith('cite:')) {
          const n = parseInt(href.slice(5), 10);
          const src = (sources || []).find((s) => s.n === n);
          return (
            <Text
              key={node.key}
              style={styles.cite}
              onPress={() => src && onOpenUrl(src.url)}
              accessibilityRole="link"
              accessibilityLabel={`Citation ${n}${src ? `: ${src.title}` : ''}`}
            >
              {` ${n} `}
            </Text>
          );
        }
        return (
          <Text key={node.key} style={mdStyles.link} onPress={() => onOpenUrl(href)} accessibilityRole="link">
            {children}
          </Text>
        );
      },
      table: (node, children, parent, mdStyles) => {
        const tableNodes = node.children || [];
        const headerNode = tableNodes.find((child) => child.type === 'thead');
        const bodyNode = tableNodes.find((child) => child.type === 'tbody');
        const headerRow = headerNode?.children?.find((child) => child.type === 'tr');
        const headers = headerRow?.children?.filter((child) => child.type === 'th') || [];
        const rows = bodyNode?.children?.filter((child) => child.type === 'tr') || [];
        const renderedTableChildren = React.Children.toArray(children);
        const headerIndex = tableNodes.findIndex((child) => child.type === 'thead');
        const renderedHeaderRows = renderedElementChildren(renderedTableChildren[headerIndex]);
        const renderedHeaderCells = renderedElementChildren(renderedHeaderRows[0]);
        const bodyIndex = tableNodes.findIndex((child) => child.type === 'tbody');
        const renderedBodyRows = renderedElementChildren(renderedTableChildren[bodyIndex]);

        // Three or more fixed-width columns are easier to scan as labeled records on a phone.
        // Every header and cell remains visible, including rich Markdown inside each cell.
        if (headers.length > 2 && rows.length && renderedBodyRows.length === rows.length) {
          return (
            <View key={node.key} style={styles.mobileTable}>
              {rows.map((row, rowIndex) => {
                const cells = row.children?.filter((child) => child.type === 'td') || [];
                const renderedCells = renderedElementChildren(renderedBodyRows[rowIndex]);
                return (
                  <View key={`${node.key}-record-${rowIndex}`} testID={`responsive-table-record-${rowIndex}`} style={styles.tableRecord}>
                    {cells.map((cell, cellIndex) => {
                      const label = markdownNodeText(headers[cellIndex]) || `Column ${cellIndex + 1}`;
                      const headerContent = renderedElementChildren(renderedHeaderCells[cellIndex]);
                      const valueChildren = renderedElementChildren(renderedCells[cellIndex]);
                      return (
                        <View key={`${node.key}-field-${rowIndex}-${cellIndex}`} style={styles.tableField}>
                          <View style={styles.tableFieldLabel} accessibilityLabel={label}>
                            {headerContent.length ? headerContent : <Text style={styles.tableLabel}>{label}</Text>}
                          </View>
                          <View style={styles.tableValue}>{valueChildren.length ? valueChildren : markdownNodeText(cell)}</View>
                        </View>
                      );
                    })}
                  </View>
                );
              })}
            </View>
          );
        }

        return (
          <ScrollView
            key={node.key}
            horizontal
            nestedScrollEnabled
            showsHorizontalScrollIndicator
            style={styles.tableScroll}
            contentContainerStyle={styles.tableContent}
          >
            <View style={mdStyles._VIEW_SAFE_table}>{children}</View>
          </ScrollView>
        );
      },
    }),
    [sources, onOpenUrl, onCopy],
  );
  const onLinkPress = useCallback(
    (url) => {
      onOpenUrl(url);
      return false;
    },
    [onOpenUrl],
  );
  return (
    <MarkdownBoundary text={text}>
      <View style={styles.markdownContent}>
        <Markdown markdownit={markdownIt} rules={rules} style={markdownStyles} onLinkPress={onLinkPress} mergeStyle>
          {prepared}
        </Markdown>
      </View>
    </MarkdownBoundary>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// LIVE TOOL CARDS
// ═══════════════════════════════════════════════════════════════════════════

/** @param {any} props */
function ToolCardShell({ icon, title, provider, timestamp, n, children, onOpenSource }) {
  return (
    <View style={styles.toolCard}>
      <View style={styles.toolHead}>
        <View style={styles.toolIcon}>
          <Ionicons name={icon} size={14} color={C.blueBright} />
        </View>
        <Text style={styles.toolTitle} numberOfLines={1}>
          {title}
        </Text>
        <View style={styles.liveTag}>
          <View style={styles.liveDot} />
          <Text style={styles.liveText}>LIVE</Text>
        </View>
      </View>
      {children}
      <Pressable
        onPress={onOpenSource}
        disabled={!onOpenSource}
        accessibilityRole="link"
        accessibilityLabel={provider ? `Open ${provider} source` : 'Source unavailable'}
        style={styles.toolFoot}
      >
        <Text style={styles.toolFootText} numberOfLines={1}>
          {n ? `[${n}] ` : ''}
          {provider}
          {timestamp ? ` · ${timestamp}` : ''}
        </Text>
      </Pressable>
    </View>
  );
}

/** @param {any} props */
function WeatherCard({ data, onOpenUrl }) {
  const c = data.current || {};
  return (
    <ToolCardShell
      icon="partly-sunny-outline"
      title={data.location}
      provider={data.provider}
      timestamp={c.time ? `local ${c.time.replace('T', ' ')}` : formatDateTime(data.retrievedAt)}
      n={data.n}
      onOpenSource={data.providerUrl ? () => onOpenUrl(data.providerUrl) : null}
    >
      <View style={styles.weatherMain}>
        <Text style={styles.weatherTemp}>{`${c.temperatureC}°`}</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.weatherDesc}>{c.description}</Text>
          <Text style={styles.weatherFeels}>{`Feels like ${c.apparentC}°C`}</Text>
        </View>
      </View>
      <View style={styles.weatherStats}>
        <View style={styles.statPill}>
          <Ionicons name="water-outline" size={13} color={C.blueBright} />
          <Text style={styles.statText}>{`${c.humidity}% humidity`}</Text>
        </View>
        <View style={styles.statPill}>
          <Ionicons name="speedometer-outline" size={13} color={C.amber} />
          <Text style={styles.statText}>{`${c.windKph} km/h wind`}</Text>
        </View>
      </View>
      {Array.isArray(data.daily) && data.daily.length > 0 && (
        <View style={styles.forecastRow}>
          {data.daily.slice(0, 4).map((d) => (
            <View key={d.date} style={styles.forecastDay}>
              <Text style={styles.forecastName}>{formatDay(d.date)}</Text>
              <Text style={styles.forecastTemp}>{`${d.maxC}°`}</Text>
              <Text style={styles.forecastMin}>{`${d.minC}°`}</Text>
              <Text style={styles.forecastDesc} numberOfLines={1}>
                {d.precipProb == null ? d.description : `${d.precipProb}% rain`}
              </Text>
            </View>
          ))}
        </View>
      )}
    </ToolCardShell>
  );
}

/** @param {any} props */
function CryptoCard({ data, onOpenUrl }) {
  return (
    <ToolCardShell
      icon="trending-up-outline"
      title="Crypto market"
      provider={data.provider}
      timestamp={`retrieved ${formatDateTime(data.retrievedAt)}`}
      n={data.n}
      onOpenSource={data.providerUrl ? () => onOpenUrl(data.providerUrl) : null}
    >
      {(data.assets || []).map((a) => {
        const up = typeof a.change24h === 'number' && a.change24h >= 0;
        return (
          <View key={a.id} style={styles.assetRow}>
            <View style={styles.assetSym}>
              <Text style={styles.assetSymText}>{a.symbol.slice(0, 4)}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.assetName}>{a.name}</Text>
              <Text style={styles.assetTime}>{a.lastUpdatedAt ? `as of ${formatDateTime(a.lastUpdatedAt)}` : 'timestamp unavailable'}</Text>
            </View>
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={styles.assetPrice}>{formatUsd(a.priceUsd)}</Text>
              {typeof a.change24h === 'number' ? (
                <Text style={[styles.assetChange, { color: up ? C.green : C.red }]}>{`${up ? '+' : ''}${a.change24h.toFixed(2)}% 24h`}</Text>
              ) : (
                <Text style={styles.assetTime}>24h n/a</Text>
              )}
            </View>
          </View>
        );
      })}
      {Array.isArray(data.unavailable) && data.unavailable.length > 0 && (
        <Text style={styles.unavailableText}>{`Market data unavailable: ${data.unavailable.join(', ')}`}</Text>
      )}
    </ToolCardShell>
  );
}

/** @param {any} props */
function CurrencyCard({ data, onOpenUrl }) {
  return (
    <ToolCardShell
      icon="swap-horizontal-outline"
      title={`${data.from} → ${data.to}`}
      provider={data.provider}
      timestamp={`rate updated ${formatDateTime(data.lastUpdated)}`}
      n={data.n}
      onOpenSource={data.providerUrl ? () => onOpenUrl(data.providerUrl) : null}
    >
      <View style={styles.fxRow}>
        <View style={styles.fxSide}>
          <Text style={styles.fxAmount}>{formatNumber(data.amount, 2)}</Text>
          <Text style={styles.fxCode}>{data.from}</Text>
        </View>
        <Ionicons name="arrow-forward" size={18} color={C.amber} />
        <View style={[styles.fxSide, { alignItems: 'flex-end' }]}>
          <Text style={[styles.fxAmount, { color: C.white }]}>{formatNumber(data.result, 2)}</Text>
          <Text style={styles.fxCode}>{data.to}</Text>
        </View>
      </View>
      <Text style={styles.fxRate}>{`1 ${data.from} = ${formatNumber(data.rate, 6)} ${data.to}`}</Text>
    </ToolCardShell>
  );
}

/** @param {any} props */
function NewsCard({ data, onOpenUrl }) {
  return (
    <ToolCardShell icon="newspaper-outline" title={data.query ? `News · ${data.query}` : 'Top headlines'} provider={data.provider} timestamp={`retrieved ${formatDateTime(data.retrievedAt)}`}>
      {(data.articles || []).slice(0, 5).map((a) => (
        <Pressable
          key={a.url}
          onPress={() => onOpenUrl(a.url)}
          accessibilityRole="link"
          accessibilityLabel={`Open source: ${a.title}${a.source ? `, ${a.source}` : ''}`}
          style={({ pressed }) => [styles.newsRow, pressed && styles.pressed]}
        >
          <Text style={styles.newsNum}>{a.n || '•'}</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.newsTitle} numberOfLines={2}>
              {a.title}
            </Text>
            <Text style={styles.newsMeta} numberOfLines={1}>
              {a.source}
              {a.publishedAt ? ` · ${formatDateTime(a.publishedAt)}` : ''}
            </Text>
          </View>
          <Ionicons name="open-outline" size={14} color={C.muted} />
        </Pressable>
      ))}
    </ToolCardShell>
  );
}

const ToolResults = memo(/** @param {any} props */ function ToolResults({ tools, toolErrors, onOpenUrl }) {
  if (!(tools && tools.length) && !(toolErrors && toolErrors.length)) return null;
  return (
    <View style={styles.toolStack}>
      {(tools || []).map((tool, i) => {
        const key = `${tool.type}-${i}`;
        if (!tool || !tool.data) return null;
        if (tool.type === 'weather') return <WeatherCard key={key} data={tool.data} onOpenUrl={onOpenUrl} />;
        if (tool.type === 'crypto') return <CryptoCard key={key} data={tool.data} onOpenUrl={onOpenUrl} />;
        if (tool.type === 'currency') return <CurrencyCard key={key} data={tool.data} onOpenUrl={onOpenUrl} />;
        if (tool.type === 'news') return <NewsCard key={key} data={tool.data} onOpenUrl={onOpenUrl} />;
        return null; // web search results are shown as numbered sources
      })}
      {(toolErrors || []).map((e, i) => (
        <View key={`err-${i}`} style={styles.toolError}>
          <Ionicons name="warning-outline" size={14} color={C.amber} />
          <Text style={styles.toolErrorText}>{e.message}</Text>
        </View>
      ))}
    </View>
  );
});

const SourceChips = memo(/** @param {any} props */ function SourceChips({ sources, onOpenUrl }) {
  if (!sources || !sources.length) return null;
  return (
    <View style={styles.sourcesWrap}>
      <Text style={styles.sourcesLabel}>SOURCES</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sourcesRow}>
        {sources.map((s) => (
          <PressableScale key={`${s.n}-${s.url}`} onPress={() => onOpenUrl(s.url)} accessibilityLabel={`Open source ${s.n}: ${s.title}`} scaleTo={0.97}>
            <View style={styles.sourceChip}>
              <View style={styles.sourceNum}>
                <Text style={styles.sourceNumText}>{s.n}</Text>
              </View>
              <View style={{ maxWidth: 180 }}>
                <Text style={styles.sourceTitle} numberOfLines={1}>
                  {s.title}
                </Text>
                <Text style={styles.sourceDomain} numberOfLines={1}>
                  {s.domain}
                </Text>
              </View>
            </View>
          </PressableScale>
        ))}
      </ScrollView>
    </View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// MESSAGE BUBBLE
// ═══════════════════════════════════════════════════════════════════════════

/** @param {any} props */
function ActionChip({ icon, label, onPress, accent }) {
  return (
    <PressableScale onPress={onPress} accessibilityLabel={label} style={[styles.actionChip, accent && styles.actionChipAccent]} scaleTo={0.94}>
      <Ionicons name={icon} size={13} color={accent ? C.amber : C.slate} />
      <Text style={[styles.actionText, accent && { color: C.amber }]}>{label}</Text>
    </PressableScale>
  );
}

const MessageBubble = memo(/** @param {any} props */ function MessageBubble({ item, canRegenerate, maxWidth, onCopy, onShare, onRegenerate, onOpenUrl }) {
  const isUser = item.role === 'user';
  const enter = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    if (reducedMotion) {
      enter.setValue(1);
      return undefined;
    }
    Animated.timing(enter, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [enter, reducedMotion]);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef(null);
  useEffect(() => () => clearTimeout(copyTimer.current), []);

  const streaming = item.status === 'streaming';
  const waiting = streaming && !item.content;
  const handleCopy = useCallback(async () => {
    const ok = await onCopy(item.content);
    if (!ok) return;
    setCopied(true);
    clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(false), 1600);
  }, [item.content, onCopy]);

  const animStyle = {
    opacity: enter,
    transform: [{ translateY: enter.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }],
  };

  if (isUser) {
    return (
      <Animated.View style={[styles.msgRow, styles.msgRowUser, animStyle]}>
        <Pressable onLongPress={() => onCopy(item.content)} delayLongPress={350} style={{ maxWidth }}>
          <LinearGradient colors={['#39334F', '#282633']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.userBubble}>
            <Text selectable style={styles.userText}>
              {item.content}
            </Text>
          </LinearGradient>
        </Pressable>
        <Text style={styles.userTime}>{formatTime(item.createdAt)}</Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.msgRow, animStyle]}>
      <View style={styles.aiMeta}>
        <View style={styles.aiAvatar}>
          <LinearGradient colors={['#13213D', '#060B16']} style={styles.aiAvatarInner}>
            <Image source={LUMORA_MARK} style={styles.aiAvatarMark} resizeMode="contain" />
          </LinearGradient>
        </View>
        {!!item.modelLabel && (
          <View style={styles.modelTag}>
            <Text style={styles.modelTagText}>{item.modelLabel}</Text>
          </View>
        )}
        <Text style={styles.aiTime}>{formatTime(item.createdAt)}</Text>
      </View>

      <View style={[styles.aiBubble, { maxWidth }, item.status === 'error' && !item.content && styles.aiBubbleError]}>
        <ToolResults tools={item.tools} toolErrors={item.toolErrors} onOpenUrl={onOpenUrl} />
        {waiting ? (
          <View style={styles.waitingRow}>
            <TypingDots />
            <Text style={styles.waitingText} numberOfLines={1}>
              {item.statusLabel || 'Thinking…'}
            </Text>
          </View>
        ) : null}
        {!!item.content && (
          <MarkdownMessage text={item.content} sources={item.sources} streaming={streaming} onOpenUrl={onOpenUrl} onCopy={onCopy} />
        )}
        {streaming && !!item.content && <StreamingCaret />}
        {item.status === 'stopped' && (
          <View style={styles.noticeRow}>
            <Ionicons name="stop-circle-outline" size={14} color={C.slate} />
            <Text style={styles.noticeText}>Generation stopped</Text>
          </View>
        )}
        {item.finishReason === 'length' && (
          <View style={styles.noticeRow}>
            <Ionicons name="cut-outline" size={14} color={C.amber} />
            <Text style={styles.noticeText}>Response reached the token limit.</Text>
          </View>
        )}
        {item.status === 'error' && (
          <View style={styles.errorRow}>
            <Ionicons name="alert-circle-outline" size={15} color={C.red} />
            <Text style={styles.errorText}>{item.errorText || 'Something went wrong.'}</Text>
          </View>
        )}
      </View>

      {!streaming && <SourceChips sources={item.sources} onOpenUrl={onOpenUrl} />}

      {!streaming && (
        <View style={styles.actionsRow}>
          {!!item.content && <ActionChip icon={copied ? 'checkmark' : 'copy-outline'} label={copied ? 'Copied' : 'Copy'} onPress={handleCopy} />}
          {!!item.content && <ActionChip icon="share-outline" label="Share" onPress={() => onShare(item.content)} />}
          {canRegenerate && (
            <ActionChip icon="refresh" label={item.status === 'error' ? 'Retry' : 'Regenerate'} onPress={onRegenerate} accent={item.status === 'error'} />
          )}
        </View>
      )}
    </Animated.View>
  );
});

// ═══════════════════════════════════════════════════════════════════════════
// COMPOSER + FLOATING BUTTON
// ═══════════════════════════════════════════════════════════════════════════

function formatRecordingDuration(durationMillis) {
  const totalSeconds = Math.max(0, Math.floor((Number(durationMillis) || 0) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

const Composer = memo(/** @param {any} props */ function Composer({ value, onChangeText, onSend, onStop, onRecordingError, apiBaseUrl, isGenerating, toolsMode, onToggleTools, bottomPad, disabled }) {
  const recorder = useAudioRecorder({ ...RecordingPresets.HIGH_QUALITY, directory: 'cache' });
  const recorderState = useAudioRecorderState(recorder, 250);
  const [capture, setCapture] = useState({ phase: 'idle', uri: null, durationMs: 0, progress: null, transcribed: false });
  const captureRef = useRef(capture);
  const inputValueRef = useRef(value);
  const mountedRef = useRef(true);
  const actionRef = useRef(false);
  const uploadAbortRef = useRef(null);
  const uploadTaskRef = useRef(null);
  const uploadPromiseRef = useRef(null);
  const uploadCopyRef = useRef(null);
  const cancelUploadRef = useRef(false);
  captureRef.current = capture;
  inputValueRef.current = value;

  const updateCapture = useCallback((next) => {
    if (mountedRef.current) setCapture(next);
  }, []);
  const removeCachedFile = useCallback((uri) => {
    if (!uri) return true;
    try {
      const file = new File(uri);
      if (file.exists) file.delete();
      return true;
    } catch {
      return false;
    }
  }, []);
  const cleanupUploadCopy = useCallback(() => {
    const copy = uploadCopyRef.current;
    uploadCopyRef.current = null;
    if (!copy) return;
    try {
      if (copy.directory?.exists) copy.directory.delete();
      else if (copy.file?.exists) copy.file.delete();
    } catch {}
  }, []);

  const startRecording = useCallback(async () => {
    if (actionRef.current || disabled || isGenerating || captureRef.current.phase !== 'idle') return;
    actionRef.current = true;
    updateCapture({ phase: 'requesting', uri: null, durationMs: 0, progress: null, transcribed: false });
    try {
      // Ask for microphone access only in response to this explicit user tap.
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!permission?.granted) {
        updateCapture({ phase: 'idle', uri: null, durationMs: 0, progress: null, transcribed: false });
        onRecordingError?.('Microphone permission was denied. Allow microphone access to record.');
        return;
      }
      await setAudioModeAsync(RECORDING_AUDIO_MODE);
      await recorder.prepareToRecordAsync();
      await recorder.record();
      updateCapture({ phase: 'recording', uri: null, durationMs: 0, progress: null, transcribed: false });
    } catch {
      try { await recorder.stop(); } catch {}
      try { await setAudioModeAsync(DEFAULT_AUDIO_MODE); } catch {}
      updateCapture({ phase: 'idle', uri: null, durationMs: 0, progress: null, transcribed: false });
      onRecordingError?.('Could not start microphone recording. Please try again.');
    } finally {
      actionRef.current = false;
    }
  }, [disabled, isGenerating, onRecordingError, recorder, updateCapture]);

  const stopRecording = useCallback(async () => {
    if (actionRef.current || captureRef.current.phase !== 'recording') return;
    actionRef.current = true;
    let recorderStopped = false;
    try {
      await recorder.stop();
      recorderStopped = true;
      const uri = recorder.uri;
      if (!uri) throw new Error('missing_recording');
      try { await setAudioModeAsync(DEFAULT_AUDIO_MODE); } catch {}
      updateCapture({ phase: 'saved', uri, durationMs: recorderState.durationMillis, progress: null, transcribed: false });
    } catch {
      if (recorderStopped) {
        try { await setAudioModeAsync(DEFAULT_AUDIO_MODE); } catch {}
        updateCapture({ phase: 'idle', uri: null, durationMs: 0, progress: null, transcribed: false });
        onRecordingError?.('The recording could not be saved to the app cache.');
      } else {
        onRecordingError?.('Could not stop the microphone recording. Try stopping it again.');
      }
    } finally {
      actionRef.current = false;
    }
  }, [onRecordingError, recorder, recorderState.durationMillis, updateCapture]);

  const transcribeRecording = useCallback(() => {
    if (captureRef.current.phase !== 'saved' || uploadPromiseRef.current) return;
    const uri = captureRef.current.uri;
    const durationMs = captureRef.current.durationMs;
    if (!uri) {
      onRecordingError?.('The saved recording is unavailable. Record a new clip and try again.');
      return;
    }
    if (!apiBaseUrl) {
      onRecordingError?.('Configure the Lumora backend connection before transcribing audio.');
      return;
    }
    if (!ENV.clientToken) {
      onRecordingError?.("Lumora backend access isn't configured for this app. Please check the app connection.");
      return;
    }

    const controller = new AbortController();
    uploadAbortRef.current = controller;
    cancelUploadRef.current = false;
    updateCapture({ phase: 'transcribing', uri, durationMs, progress: null, transcribed: false });

    const operation = (async () => {
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, VOICE_TRANSCRIPTION_TIMEOUT_MS);
      try {
        const directory = new Directory(Paths.cache, `lumora-voice-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        directory.create({ intermediates: true });
        const file = new File(directory, 'recording.m4a');
        uploadCopyRef.current = { directory, file };
        await new File(uri).copy(file);
        if (controller.signal.aborted) {
          if (timedOut) throw Object.assign(new Error('timeout'), { kind: 'timeout' });
          return;
        }

        const task = file.createUploadTask(`${apiBaseUrl}/api/voice/transcribe`, {
          httpMethod: 'POST',
          uploadType: UploadType.MULTIPART,
          fieldName: 'audio',
          mimeType: 'audio/mp4',
          headers: buildHeaders(),
          signal: controller.signal,
          onProgress: ({ bytesSent, totalBytes }) => {
            const progress = totalBytes > 0 ? Math.min(100, Math.floor((bytesSent / totalBytes) * 100)) : null;
            if (mountedRef.current) setCapture((current) => current.phase === 'transcribing' ? { ...current, progress } : current);
          },
        });
        uploadTaskRef.current = task;
        const response = await task.uploadAsync();
        if (controller.signal.aborted || cancelUploadRef.current) return;

        let result;
        try { result = JSON.parse(response.body); } catch {
          if (response.status >= 200 && response.status < 300) throw Object.assign(new Error('malformed'), { kind: 'malformed' });
        }
        if (response.status < 200 || response.status >= 300) {
          throw Object.assign(new Error('http'), { status: response.status, code: String(result?.error?.code || '') });
        }
        if (!result || typeof result.text !== 'string') throw Object.assign(new Error('malformed'), { kind: 'malformed' });
        const transcription = result.text.trim();
        if (!transcription) throw Object.assign(new Error('empty_transcription'), { kind: 'empty' });

        const currentDraft = inputValueRef.current;
        const nextDraft = currentDraft.trim() ? `${currentDraft.trimEnd()}\n\n${transcription}` : transcription;
        if (nextDraft.length > LIMITS.maxInput) throw Object.assign(new Error('composer_limit'), { kind: 'composer_limit' });
        inputValueRef.current = nextDraft;
        onChangeText(nextDraft);

        const recordingDeleted = removeCachedFile(uri);
        updateCapture(recordingDeleted
          ? { phase: 'idle', uri: null, durationMs: 0, progress: null, transcribed: false }
          : { phase: 'saved', uri, durationMs, progress: null, transcribed: true });
        if (!recordingDeleted) onRecordingError?.('Transcription added, but the temporary audio could not be deleted. Tap Cancel recording to discard it.');
      } catch (error) {
        if (controller.signal.aborted && !timedOut && !cancelUploadRef.current) return;
        if (cancelUploadRef.current) return;
        updateCapture({ phase: 'saved', uri, durationMs, progress: null, transcribed: false });
        const message = error?.kind === 'empty'
          ? 'No speech was detected. Try recording again in a quieter place.'
          : error?.kind === 'malformed'
            ? 'Lumora received an unexpected transcription response. Your recording is saved; try again.'
            : error?.kind === 'composer_limit'
              ? 'The transcription is too long to add to the current draft. Shorten the draft and retry.'
              : error?.status
                ? voiceTranscriptionError(error.status, error.code || '', timedOut)
                : timedOut
                  ? voiceTranscriptionError(0, '', true)
                  : 'Could not upload the recording. Check your connection and try again.';
        onRecordingError?.(message);
      } finally {
        clearTimeout(timeout);
        try { uploadTaskRef.current?.release?.(); } catch {}
        uploadTaskRef.current = null;
        uploadAbortRef.current = null;
        uploadPromiseRef.current = null;
        cleanupUploadCopy();
      }
    })();
    uploadPromiseRef.current = operation;
    return operation;
  }, [apiBaseUrl, cleanupUploadCopy, onChangeText, onRecordingError, removeCachedFile, updateCapture]);

  const cancelRecording = useCallback(async () => {
    const current = captureRef.current;
    if (current.phase === 'transcribing') {
      cancelUploadRef.current = true;
      uploadAbortRef.current?.abort();
      try { await uploadTaskRef.current?.cancelAsync?.(); } catch {}
      try { await uploadPromiseRef.current; } catch {}
      if (!removeCachedFile(current.uri)) {
        onRecordingError?.('Could not discard the recording. It remains in the temporary app cache.');
        updateCapture({ ...current, phase: 'saved', progress: null });
        return;
      }
      updateCapture({ phase: 'idle', uri: null, durationMs: 0, progress: null, transcribed: false });
      return;
    }
    if (actionRef.current || !['recording', 'saved'].includes(current.phase)) return;
    actionRef.current = true;
    try {
      let uri = current.uri;
      if (current.phase === 'recording') {
        await recorder.stop();
        uri = recorder.uri || uri;
      }
      try { await setAudioModeAsync(DEFAULT_AUDIO_MODE); } catch {}
      if (uri && !removeCachedFile(uri)) {
        onRecordingError?.('Could not discard the recording. It remains in the temporary app cache.');
        updateCapture({ ...current, phase: 'saved', uri });
        return;
      }
      updateCapture({ phase: 'idle', uri: null, durationMs: 0, progress: null, transcribed: false });
    } catch {
      onRecordingError?.('Could not cancel the microphone recording. Try stopping it again.');
    } finally {
      actionRef.current = false;
    }
  }, [onRecordingError, recorder, removeCachedFile, updateCapture]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      uploadAbortRef.current?.abort();
      try { uploadTaskRef.current?.cancelAsync?.(); } catch {}
      try { recorder.stop(); } catch {}
      void setAudioModeAsync(DEFAULT_AUDIO_MODE).catch(() => {});
      cleanupUploadCopy();
    };
  }, [cleanupUploadCopy, recorder]);

  const canSend = !!value.trim() && !disabled && !['recording', 'requesting', 'transcribing'].includes(capture.phase);
  const near = value.length > LIMITS.maxInput * 0.8;
  const durationMs = capture.phase === 'recording' ? recorderState.durationMillis : capture.durationMs;
  const voiceStatus = capture.phase === 'recording'
    ? `Recording · ${formatRecordingDuration(durationMs)} · audio stays on this device`
    : capture.phase === 'saved'
      ? capture.transcribed
        ? `Transcription added · audio remains temporarily · ${formatRecordingDuration(durationMs)}`
        : `Recording saved temporarily · ${formatRecordingDuration(durationMs)} · ready to transcribe`
      : capture.phase === 'requesting'
        ? 'Requesting microphone access…'
        : capture.phase === 'transcribing'
          ? capture.progress == null || capture.progress < 100
            ? `Uploading audio${capture.progress == null ? '…' : ` · ${capture.progress}%`}`
            : 'Transcribing audio…'
          : null;

  return (
    <View style={[styles.composerWrap, { paddingBottom: bottomPad }]}>
      <View style={styles.composer}>
        <Pressable
          onPress={onToggleTools}
          style={[styles.toolsToggle, toolsMode === 'auto' && styles.toolsToggleOn]}
          accessibilityLabel={`Live tools ${toolsMode === 'auto' ? 'on' : 'off'}`}
          accessibilityRole="button"
          accessibilityState={{ selected: toolsMode === 'auto' }}
          accessibilityHint="Toggle live web, weather, and other connected tools."
          hitSlop={6}
        >
          <Ionicons name={toolsMode === 'auto' ? 'globe' : 'globe-outline'} size={17} color={toolsMode === 'auto' ? C.white : C.muted} />
          <Text style={[styles.toolsToggleText, toolsMode === 'auto' && styles.toolsToggleTextOn]}>Live</Text>
        </Pressable>
        <TextInput
          style={styles.input}
          value={value}
          onChangeText={(text) => { inputValueRef.current = text; onChangeText(text); }}
          placeholder="Ask Lumora anything…"
          placeholderTextColor={C.muted}
          multiline
          maxLength={LIMITS.maxInput}
          textAlignVertical="center"
          selectionColor={C.blue}
          accessibilityLabel="Message input"
        />
        {['recording', 'saved', 'transcribing'].includes(capture.phase) ? (
          <PressableScale
            onPress={cancelRecording}
            accessibilityLabel={capture.phase === 'transcribing' ? 'Cancel transcription' : 'Cancel recording'}
            accessibilityHint={capture.phase === 'transcribing' ? 'Aborts transcription and discards the local recording.' : 'Stops and discards the local recording.'}
            testID="cancel-recording-button"
            style={styles.recordingCancelBtn}
          >
            <Ionicons name="close" size={20} color={C.red} />
          </PressableScale>
        ) : (
          <PressableScale
            onPress={startRecording}
            disabled={disabled || isGenerating || capture.phase === 'requesting'}
            accessibilityLabel={capture.phase === 'requesting' ? 'Requesting microphone access' : 'Start recording'}
            accessibilityHint="Records audio locally. It is uploaded only if you tap Transcribe."
            testID="start-recording-button"
            style={styles.recordingStartBtn}
          >
            {capture.phase === 'requesting' ? <ActivityIndicator size="small" color={C.blueBright} /> : <Ionicons name="mic-outline" size={19} color={C.text} />}
          </PressableScale>
        )}
        {isGenerating ? (
          <PressableScale onPress={onStop} accessibilityLabel="Stop generating" testID="stop-touch-target" style={styles.stopBtn}>
            <View style={styles.stopSquare} />
          </PressableScale>
        ) : capture.phase === 'recording' ? (
          <PressableScale onPress={stopRecording} accessibilityLabel="Stop recording" accessibilityHint="Finishes and keeps the recording temporarily in the app cache." testID="stop-recording-button" style={styles.recordingStopBtn}>
            <Ionicons name="stop" size={19} color={C.white} />
          </PressableScale>
        ) : capture.phase === 'saved' ? (
          <PressableScale onPress={() => { if (!capture.transcribed) void transcribeRecording(); }} disabled={disabled || !!capture.transcribed} accessibilityLabel={capture.transcribed ? 'Transcription added' : 'Transcribe recording'} accessibilityHint="Uploads this saved recording securely to Lumora. It will not send a chat message." testID="transcribe-recording-button" style={[styles.transcribeBtn, capture.transcribed && styles.transcribedBtn]}>
            <Ionicons name={capture.transcribed ? 'checkmark' : 'text-outline'} size={19} color={C.white} />
          </PressableScale>
        ) : capture.phase === 'transcribing' ? (
          <View accessibilityRole="progressbar" accessibilityLabel="Transcribing audio" accessibilityState={{ busy: true }} testID="transcribing-indicator" style={styles.transcribingBtn}>
            <ActivityIndicator size="small" color={C.blueBright} />
          </View>
        ) : (
          <PressableScale onPress={onSend} disabled={!canSend} accessibilityLabel="Send message">
            <LinearGradient testID="send-touch-target" colors={canSend ? ['#6758D9', '#5142B8'] : ['#262832', '#262832']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.sendBtn}>
              <Ionicons name="arrow-up" size={19} color={canSend ? C.white : C.muted} />
            </LinearGradient>
          </PressableScale>
        )}
      </View>
      <View style={styles.composerMeta}>
        <Text style={styles.composerHint}>
          {toolsMode === 'auto' ? 'Live tools on · answers cite real sources' : 'Live tools off · model knowledge only'}
        </Text>
        {near && <Text style={styles.counter}>{`${value.length}/${LIMITS.maxInput}`}</Text>}
      </View>
      {!!voiceStatus && <Text accessibilityLiveRegion="polite" style={styles.voiceStatus}>{voiceStatus}</Text>}
    </View>
  );
});

/** @param {any} props */
function ScrollToBottomButton({ visible, onPress }) {
  const v = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotionPreference();
  useEffect(() => {
    if (reducedMotion) {
      v.setValue(visible ? 1 : 0);
      return undefined;
    }
    Animated.timing(v, { toValue: visible ? 1 : 0, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [reducedMotion, visible, v]);
  return (
    <Animated.View
      testID="scroll-bottom"
      pointerEvents={visible ? 'auto' : 'none'}
      style={[
        styles.jumpWrap,
        { opacity: v, transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] },
      ]}
    >
      <PressableScale onPress={onPress} accessibilityLabel="Scroll to bottom" style={styles.jumpBtn}>
        <Ionicons name="arrow-down" size={14} color={C.white} />
        <Text style={styles.jumpText}>Scroll to bottom</Text>
      </PressableScale>
    </Animated.View>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SHEETS (SETTINGS + HISTORY)
// ═══════════════════════════════════════════════════════════════════════════

/** @param {any} props */
function Sheet({ visible, title, onClose, children, footer }) {
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotionPreference();
  return (
    <Modal visible={visible} transparent animationType={reducedMotion ? 'none' : 'slide'} onRequestClose={onClose} statusBarTranslucent navigationBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.sheetOverlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityLabel="Close" />
        <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          <View style={styles.sheetGrab} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <IconButton icon="close" label="Close" onPress={onClose} />
          </View>
          {children}
          {footer}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

/** @param {any} props */
function SettingsSheet({ visible, prefs, effectiveUrl, backend, onSave, onClose, onClearAll, onRetryConnection }) {
  const [url, setUrl] = useState(effectiveUrl);
  const [toolsMode, setToolsMode] = useState(prefs.toolsMode);
  const [haptics, setHaptics] = useState(prefs.haptics);
  const [connectionDetailsOpen, setConnectionDetailsOpen] = useState(false);
  const [test, setTest] = useState(null);
  const testCtrl = useRef(null);

  useEffect(() => {
    if (visible) {
      setUrl(effectiveUrl);
      setToolsMode(prefs.toolsMode);
      setHaptics(prefs.haptics);
      setConnectionDetailsOpen(false);
      setTest(null);
    }
    return () => testCtrl.current && testCtrl.current.abort();
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps

  const runTest = async () => {
    const target = normalizeUrl(url);
    if (!isAllowedApiUrl(target)) {
      setTest({ ok: false, text: __DEV__ ? 'Enter a valid http(s) URL.' : 'Production builds require an https:// URL.' });
      return;
    }
    if (testCtrl.current) testCtrl.current.abort();
    const ctrl = new AbortController();
    testCtrl.current = ctrl;
    setTest({ busy: true });
    try {
      const h = await fetchHealth(target, ctrl.signal);
      if (!h || h.ok !== true) throw new ApiError('malformed');
      const tools = h.tools || {};
      setTest({
        ok: true,
        text: h.provider && h.provider.configured ? 'Connection is ready.' : 'Connected, but the AI service is not ready yet.',
        tools: [
          ['Web search', !!tools.search],
          ['News', !!tools.news],
          ['Weather', !!tools.weather],
          ['Crypto', !!tools.crypto],
          ['Currency', !!tools.currency],
        ],
      });
    } catch (e) {
      if (e.kind !== 'aborted') setTest({ ok: false, text: friendlyError(e) });
    }
  };

  const save = () => {
    const target = normalizeUrl(url);
    if (target && !isAllowedApiUrl(target)) {
      setTest({ ok: false, text: __DEV__ ? 'Enter a valid http(s) URL.' : 'Production builds require an https:// URL.' });
      return;
    }
    onSave({ apiBaseUrl: target === normalizeUrl(DEFAULT_API_URL) ? '' : target, toolsMode, haptics });
  };

  const status = BACKEND_STATUS[backend.state] || BACKEND_STATUS.checking;

  return (
    <Sheet
      visible={visible}
      title="Settings"
      onClose={onClose}
      footer={
        <PressableScale onPress={save} accessibilityLabel="Save settings">
          <LinearGradient colors={['#B1A4FF', '#6758D9']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.primaryBtn}>
            <Text style={styles.primaryText}>Save changes</Text>
          </LinearGradient>
        </PressableScale>
      }
    >
      <ScrollView style={styles.sheetScroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <Text style={styles.fieldLabel}>CONNECTION</Text>
        <View style={styles.glassCard}>
          <View style={styles.backendRow}>
            <PulseDot color={status.color} active={backend.state === 'online'} />
            <Text style={styles.backendText}>
              {status.label}
            </Text>
            <Pressable onPress={onRetryConnection} hitSlop={8} accessibilityRole="button" accessibilityLabel="Retry connection">
              <Text style={styles.linkSmall}>Retry</Text>
            </Pressable>
          </View>
          <Pressable
            onPress={() => setConnectionDetailsOpen((open) => !open)}
            style={styles.connectionDetailsToggle}
            accessibilityRole="button"
            accessibilityLabel={connectionDetailsOpen ? 'Hide connection details' : 'Show connection details'}
            accessibilityState={{ expanded: connectionDetailsOpen }}
          >
            <Text style={styles.linkSmall}>{connectionDetailsOpen ? 'Hide connection details' : 'Connection details'}</Text>
            <Ionicons name={connectionDetailsOpen ? 'chevron-up' : 'chevron-down'} size={16} color={C.blueBright} />
          </Pressable>
          {connectionDetailsOpen && (
            <>
              <Text style={styles.fieldLabel}>SERVER ADDRESS</Text>
              <TextInput
                style={styles.field}
                value={url}
                onChangeText={setUrl}
                placeholder="Enter server address"
                placeholderTextColor={C.muted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                selectionColor={C.blue}
                accessibilityLabel="Server address"
              />
              <View style={styles.inlineRow}>
                <PressableScale onPress={runTest} style={styles.smallBtn} accessibilityLabel="Check connection">
                  {test && test.busy ? <ActivityIndicator size="small" color={C.blueBright} /> : <Text style={styles.smallBtnText}>Check connection</Text>}
                </PressableScale>
                <Text style={styles.hint} numberOfLines={2}>
                  {ENV.apiUrl ? 'Using the app-configured server address.' : __DEV__ ? 'Using the local development server.' : 'No server address is configured.'}
                </Text>
              </View>
              {!!(test && test.text) && <Text style={[styles.testText, { color: test.ok ? C.green : C.red }]}>{test.text}</Text>}
              {!!(test && test.tools) && (
                <View style={styles.toolStatusGrid}>
                  {test.tools.map(([name, ok]) => (
                    <View key={name} style={styles.toolStatus}>
                      <Ionicons name={ok ? 'checkmark-circle' : 'remove-circle-outline'} size={13} color={ok ? C.green : C.muted} />
                      <Text style={styles.toolStatusText}>{`${name}: ${ok ? 'Ready' : 'Unavailable'}`}</Text>
                    </View>
                  ))}
                </View>
              )}
            </>
          )}
        </View>

        <Text style={styles.fieldLabel}>LIVE INTELLIGENCE</Text>
        <View style={styles.segment}>
          {[
            ['auto', 'Auto', 'globe-outline'],
            ['off', 'Off', 'ban-outline'],
          ].map(([id, label, icon]) => {
            const on = toolsMode === id;
            return (
              <Pressable
                key={id}
                onPress={() => setToolsMode(id)}
                accessibilityRole="button"
                accessibilityLabel={`Live intelligence ${label}`}
                accessibilityState={{ selected: on }}
                style={[styles.segBtn, on && styles.segBtnOn]}
              >
                <Ionicons name={/** @type {any} */ (icon)} size={14} color={on ? C.white : C.slate} />
                <Text style={[styles.segText, on && styles.segTextOn]}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>
          {toolsMode === 'auto'
            ? 'Lumora fetches live weather, news, crypto, exchange rates and web results when your question needs them.'
            : 'Answers come from model knowledge only. Nothing is presented as real-time.'}
        </Text>

        <Text style={styles.fieldLabel}>PREFERENCES</Text>
        <View style={[styles.glassCard, styles.switchRow]}>
          <View style={{ flex: 1 }}>
            <Text style={styles.switchTitle}>Haptic feedback</Text>
            <Text style={styles.hint}>Subtle taps on send and model switch</Text>
          </View>
          <Switch
            value={haptics}
            onValueChange={setHaptics}
            accessibilityLabel="Haptic feedback"
            accessibilityHint="Enable or disable haptic feedback for supported actions."
            trackColor={{ false: '#1E293B', true: C.blue }}
            thumbColor={C.white}
          />
        </View>

        <Text style={styles.fieldLabel}>DATA</Text>
        <PressableScale onPress={onClearAll} style={styles.dangerBtn} accessibilityLabel="Clear all chat history">
          <Ionicons name="trash-outline" size={16} color={C.red} />
          <Text style={styles.dangerText}>Clear all chat history</Text>
        </PressableScale>

        <View style={styles.securityNote}>
          <Ionicons name="shield-checkmark-outline" size={16} color={C.blueBright} />
          <Text style={styles.securityText}>
            Provider API keys live only on the Lumora backend. This app stores conversations and preferences on this device only.
          </Text>
        </View>
      </ScrollView>
    </Sheet>
  );
}

/** @param {any} props */
function HistorySheet({ visible, conversations, activeId, onClose, onOpen, onDelete, onNew, onClearAll }) {
  const modelLabel = (id) => {
    const current = MODELS.find((m) => m.id === id);
    if (current) return current.label;
    // Keep the original model name for conversations created before its removal.
    if (id === 'llama-3.3-70b') return 'Llama 3.3 70B (retired)';
    return id;
  };
  return (
    <Sheet visible={visible} title="Conversations" onClose={onClose}>
      <View style={styles.historyActions}>
        <PressableScale onPress={onNew} style={styles.historyNew} accessibilityLabel="New conversation">
          <Ionicons name="add" size={16} color={C.white} />
          <Text style={styles.historyNewText}>New chat</Text>
        </PressableScale>
        {conversations.length > 0 && (
          <Pressable onPress={onClearAll} hitSlop={8} accessibilityRole="button" accessibilityLabel="Clear all conversations">
            <Text style={[styles.linkSmall, { color: C.red }]}>Clear all</Text>
          </Pressable>
        )}
      </View>
      <FlatList
        style={styles.sheetScroll}
        data={conversations}
        keyExtractor={(c) => c.id}
        ListEmptyComponent={
          <View style={styles.historyEmpty}>
            <Ionicons name="chatbubbles-outline" size={28} color={C.muted} />
            <Text style={styles.hint}>No saved conversations yet.</Text>
          </View>
        }
        renderItem={({ item }) => (
          <View style={[styles.historyRow, item.id === activeId && styles.historyRowActive]}>
            <Pressable
              onPress={() => onOpen(item.id)}
              accessibilityRole="button"
              accessibilityLabel={`Open conversation: ${item.title}`}
              style={({ pressed }) => [styles.historyOpen, pressed && styles.pressed]}
            >
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={styles.historyTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={styles.historyPreview} numberOfLines={1}>
                  {item.preview || 'No messages'}
                </Text>
                <Text style={styles.historyMeta}>{`${formatRelative(item.updatedAt)} · ${modelLabel(item.modelId)} · ${item.count} msgs`}</Text>
              </View>
            </Pressable>
            <IconButton icon="trash-outline" label={`Delete conversation: ${item.title}`} color={C.red} size={16} onPress={() => onDelete(item.id)} />
          </View>
        )}
      />
    </Sheet>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════

function LumoraApp() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const kb = useKeyboard();
  const mountedRef = useMountedRef();

  const [hydrated, setHydrated] = useState(false);
  const [prefs, setPrefs] = useState(DEFAULT_PREFS);
  const [conversations, setConversations] = useState([]);
  const [activeId, setActiveId] = useState(() => uid());
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [backend, setBackend] = useState({ state: 'checking', models: {}, provider: null, error: null });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const [toast, setToast] = useState(null);
  const [layoutHeight, setLayoutHeight] = useState(0);

  const listRef = useRef(null);
  const abortRef = useRef(null);
  const genRef = useRef(0);
  const inFlightRef = useRef(false);
  const streamingRef = useRef(false);
  const followRef = useRef(true);
  const userScrollUntil = useRef(0);
  const baseHeightRef = useRef(0);
  const backendReq = useRef(0);
  const accessibilityAnnouncement = useRef({ generating: false, lastStatus: '' });
  const savedSnapshot = useRef({});
  const messagesRef = useRef(messages);
  const prefsRef = useRef(prefs);
  const activeIdRef = useRef(activeId);
  messagesRef.current = messages;
  prefsRef.current = prefs;
  activeIdRef.current = activeId;

  const lastMessage = messages.length ? messages[messages.length - 1] : null;
  const lastAssistantMessage = lastMessage?.role === 'assistant' ? lastMessage : null;
  const hasAssistantContent = !!lastAssistantMessage?.content;

  useEffect(() => {
    const previous = accessibilityAnnouncement.current;
    if (isGenerating) {
      const status = lastAssistantMessage?.statusLabel || (hasAssistantContent ? 'Generating response' : 'Starting response');
      if (status !== previous.lastStatus) AccessibilityInfo.announceForAccessibility?.(status);
      previous.generating = true;
      previous.lastStatus = status;
      return;
    }

    if (previous.generating) {
      const status = lastAssistantMessage?.status === 'error'
        ? `Error: ${lastAssistantMessage.errorText || 'Something went wrong.'}`
        : lastAssistantMessage?.status === 'stopped'
          ? 'Generation stopped'
          : 'Response complete';
      AccessibilityInfo.announceForAccessibility?.(status);
      previous.generating = false;
      previous.lastStatus = '';
    }
  }, [isGenerating, lastAssistantMessage?.statusLabel, hasAssistantContent, lastAssistantMessage?.status, lastAssistantMessage?.errorText]);

  const apiBaseUrl = normalizeUrl(prefs.apiBaseUrl || DEFAULT_API_URL);
  const bubbleMaxWidth = Math.min(width - 32, 720);

  // ── Feedback helpers ──────────────────────────────────────────────────────
  const showToast = useCallback((text, icon) => setToast({ id: Date.now(), text, icon }), []);
  const haptic = useCallback((kind = 'light') => {
    if (!prefsRef.current.haptics) return;
    const p = kind === 'select' ? Haptics.selectionAsync() : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (p && p.catch) p.catch(() => {});
  }, []);

  // ── Hydration ─────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let nextPrefs = DEFAULT_PREFS;
      let index = [];
      let msgs = [];
      let active = null;
      let storageOk = true;
      let migratedLegacyModel = false;
      try {
        const pairs = await AsyncStorage.multiGet([STORAGE_KEYS.prefs, STORAGE_KEYS.index]);
        const map = Object.fromEntries(pairs);
        const storedPrefs = safeParse(map[STORAGE_KEYS.prefs]);
        migratedLegacyModel = !!(storedPrefs && LEGACY_MODEL_ID_MIGRATIONS[storedPrefs.modelId]);
        nextPrefs = sanitizePrefs(storedPrefs);
        index = sanitizeIndex(safeParse(map[STORAGE_KEYS.index]));
        const lastId = nextPrefs.lastConversationId;
        if (lastId && index.some((c) => c.id === lastId)) {
          const raw = await AsyncStorage.getItem(STORAGE_KEYS.conv(lastId));
          msgs = sanitizeMessages(safeParse(raw));
          active = lastId;
          savedSnapshot.current[lastId] = serializeMessages(msgs);
        }
      } catch (e) {
        storageOk = false;
      }
      if (cancelled) return;
      setPrefs(nextPrefs);
      setConversations(index);
      if (active) setActiveId(active);
      setMessages(msgs);
      setHydrated(true);
      if (migratedLegacyModel) showToast('Llama 3.3 70B was replaced in Lumora; Qwen 3.8 27B is selected.', 'swap-horizontal-outline');
      else if (!storageOk) showToast('Local storage unavailable — history will not be saved', 'warning-outline');
    })();
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  // ── Persistence (debounced, skipped while streaming) ─────────────────────
  const persistConversation = useCallback(async (id, msgs) => {
    if (!id || !msgs.length) return;
    const serialized = serializeMessages(msgs);
    if (savedSnapshot.current[id] === serialized) return;
    savedSnapshot.current[id] = serialized;
    const summary = summarizeConversation(id, msgs, prefsRef.current.modelId);
    setConversations((prev) => [summary, ...prev.filter((c) => c.id !== id)]);
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.conv(id), serialized);
    } catch (e) {
      delete savedSnapshot.current[id];
    }
  }, []);

  useEffect(() => {
    if (!hydrated || isGenerating) return undefined;
    const id = activeId;
    const snapshot = messages;
    const t = setTimeout(() => persistConversation(id, snapshot), 400);
    return () => clearTimeout(t);
  }, [messages, activeId, hydrated, isGenerating, persistConversation]);

  const indexJson = useMemo(() => JSON.stringify(conversations), [conversations]);
  useEffect(() => {
    if (!hydrated) return undefined;
    const t = setTimeout(() => AsyncStorage.setItem(STORAGE_KEYS.index, indexJson).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [indexJson, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    const lastConversationId = messages.length ? activeId : prefs.lastConversationId;
    if (lastConversationId !== prefs.lastConversationId) setPrefs((p) => ({ ...p, lastConversationId }));
  }, [activeId, messages.length, hydrated, prefs.lastConversationId]);

  useEffect(() => {
    if (!hydrated) return;
    AsyncStorage.setItem(STORAGE_KEYS.prefs, JSON.stringify(prefs)).catch(() => {});
  }, [prefs, hydrated]);

  // Saves are paused while streaming; flush when the OS may suspend or kill the app.
  useEffect(() => {
    if (!hydrated) return undefined;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') persistConversation(activeIdRef.current, messagesRef.current);
    });
    return () => sub.remove();
  }, [hydrated, persistConversation]);

  // ── Backend discovery: which models really exist on the provider ─────────
  const refreshBackend = useCallback(async (url) => {
    const req = ++backendReq.current;
    if (!url) {
      setBackend({ state: 'unconfigured', models: {}, provider: null, error: null });
      return;
    }
    setBackend((b) => ({ ...b, state: 'checking' }));
    try {
      const data = await fetchModels(url);
      if (req !== backendReq.current) return;
      const map = {};
      (Array.isArray(data && data.models) ? data.models : []).forEach((m) => {
        if (m && typeof m.id === 'string') map[m.id] = { available: m.available === true, reason: m.reason || null };
      });
      setBackend({ state: 'online', models: map, provider: data.provider || null, error: null });
    } catch (e) {
      if (req !== backendReq.current) return;
      setBackend({ state: 'offline', models: {}, provider: null, error: friendlyError(e) });
    }
  }, []);

  useEffect(() => {
    if (hydrated) refreshBackend(apiBaseUrl);
  }, [hydrated, apiBaseUrl, refreshBackend]);

  // ── Scrolling ─────────────────────────────────────────────────────────────
  const scrollToEnd = useCallback((animated) => {
    if (listRef.current) listRef.current.scrollToEnd({ animated });
  }, []);

  const followBottom = useCallback(() => {
    followRef.current = true;
    setShowJump(false);
    requestAnimationFrame(() => scrollToEnd(true));
  }, [scrollToEnd]);

  const onScroll = useCallback((e) => {
    const { contentOffset, layoutMeasurement, contentSize } = e.nativeEvent;
    const dist = contentSize.height - layoutMeasurement.height - contentOffset.y;
    if (dist < 48) {
      if (!followRef.current) {
        followRef.current = true;
        setShowJump(false);
      }
    } else if (Date.now() < userScrollUntil.current && dist > 120 && followRef.current) {
      // Only a user gesture can detach auto-follow; programmatic scrolls never do.
      followRef.current = false;
      setShowJump(true);
    }
  }, []);

  const onBeginDrag = useCallback(() => {
    userScrollUntil.current = Number.MAX_SAFE_INTEGER;
  }, []);
  const onEndDrag = useCallback(() => {
    userScrollUntil.current = Date.now() + 700;
  }, []);
  const onMomentumEnd = useCallback(() => {
    userScrollUntil.current = Date.now() + 100;
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (followRef.current) scrollToEnd(!streamingRef.current);
  }, [scrollToEnd]);

  useEffect(() => {
    if (kb.visible && followRef.current) {
      const t = setTimeout(() => scrollToEnd(true), 80);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [kb.visible, scrollToEnd]);

  // ── Generation engine ─────────────────────────────────────────────────────
  const cancelActiveGeneration = useCallback(() => {
    genRef.current += 1; // invalidates every pending update from the old stream
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = null;
    inFlightRef.current = false;
    streamingRef.current = false;
    setIsGenerating(false);
  }, []);

  useEffect(
    () => () => {
      genRef.current += 1;
      if (abortRef.current) abortRef.current.abort();
    },
    [],
  );

  const runGeneration = useCallback(
    async (history) => {
      if (inFlightRef.current) return;
      const apiMessages = toApiMessages(history);
      if (!apiMessages.length) return;
      inFlightRef.current = true;

      const model = MODELS.find((m) => m.id === prefsRef.current.modelId) || MODELS[0];
      const genId = ++genRef.current;
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      streamingRef.current = true;
      setIsGenerating(true);

      const assistantId = uid();
      const isCurrent = () => genRef.current === genId && mountedRef.current;
      setMessages((prev) => [
        ...prev,
        {
          id: assistantId,
          role: 'assistant',
          content: '',
          createdAt: Date.now(),
          modelId: model.id,
          modelLabel: model.label,
          status: 'streaming',
          statusLabel: 'Connecting to Lumora…',
          sources: [],
          tools: [],
          toolErrors: [],
        },
      ]);

      const patch = (fn) => {
        if (!isCurrent()) return;
        setMessages((prev) => {
          const idx = findLastIndexById(prev, assistantId);
          if (idx < 0) return prev;
          const next = prev.slice();
          next[idx] = fn(prev[idx]);
          return next;
        });
      };

      let pending = '';
      let flushTimer = null;
      let gotToken = false;
      let doneInfo = null;
      const flush = () => {
        flushTimer = null;
        if (!pending) return;
        const add = pending;
        pending = '';
        patch((m) => ({ ...m, content: m.content + add, statusLabel: undefined }));
      };

      const onEvent = (name, data) => {
        if (!isCurrent()) return;
        switch (name) {
          case 'status':
            if (typeof data.label === 'string') patch((m) => (m.content ? m : { ...m, statusLabel: data.label }));
            break;
          case 'meta':
            patch((m) => ({
              ...m,
              sources: Array.isArray(data.sources) ? data.sources : [],
              tools: Array.isArray(data.tools) ? data.tools : [],
              toolErrors: Array.isArray(data.toolErrors) ? data.toolErrors : [],
              modelLabel: (data.model && data.model.label) || m.modelLabel,
            }));
            break;
          case 'token':
            if (typeof data.t === 'string' && data.t) {
              pending += data.t;
              gotToken = true;
              if (!flushTimer) flushTimer = setTimeout(flush, LIMITS.flushMs);
            }
            break;
          case 'done':
            doneInfo = data;
            break;
          case 'error':
            throw new ApiError('server', { status: Number(data.status) || 0, code: String(data.code || ''), message: String(data.message || '') });
          default:
            break;
        }
      };

      const body = { model: model.id, messages: apiMessages, tools: prefsRef.current.toolsMode, timezone: getTimezone() };
      let finalStatus = 'done';
      let errorText;
      try {
        let attempt = 0;
        for (;;) {
          let opened = false;
          try {
            await streamChat({
              baseUrl: apiBaseUrl,
              body,
              signal: ctrl.signal,
              onOpen: () => {
                opened = true;
              },
              onEvent,
            });
            break;
          } catch (err) {
            if (ctrl.signal.aborted || err.kind === 'aborted') throw err;
            attempt += 1;
            // Retry only transient failures that happened before the stream opened.
            if (!opened && err.retryable && attempt < RETRY.attempts) {
              patch((m) => ({ ...m, statusLabel: `Reconnecting… (attempt ${attempt + 1} of ${RETRY.attempts})` }));
              await sleep(backoffDelay(attempt, err.retryAfter), ctrl.signal);
              continue;
            }
            throw err;
          }
        }
        clearTimeout(flushTimer);
        flush();
        if (!gotToken) {
          finalStatus = 'error';
          errorText = 'No response was generated. Tap Retry to try again.';
        }
      } catch (err) {
        clearTimeout(flushTimer);
        flush();
        if (ctrl.signal.aborted || (err && err.kind === 'aborted')) {
          finalStatus = 'stopped';
        } else {
          finalStatus = 'error';
          errorText = friendlyError(err);
        }
      } finally {
        if (genRef.current === genId) {
          patch((m) => ({
            ...m,
            status: finalStatus,
            statusLabel: undefined,
            errorText,
            finishReason: doneInfo && typeof doneInfo.finishReason === 'string' ? doneInfo.finishReason : undefined,
          }));
          abortRef.current = null;
          inFlightRef.current = false;
          streamingRef.current = false;
          if (mountedRef.current) setIsGenerating(false);
        }
      }
    },
    [apiBaseUrl, mountedRef],
  );

  const sendText = useCallback(
    (raw) => {
      const text = String(raw || '').trim();
      if (!text) {
        showToast('Type a message first', 'create-outline');
        return;
      }
      if (inFlightRef.current) {
        showToast('Lumora is still responding — stop it or wait', 'hourglass-outline');
        return;
      }
      if (!apiBaseUrl) {
        setSettingsOpen(true);
        showToast('Configure the Lumora backend URL first', 'server-outline');
        return;
      }
      const avail = backend.models[prefsRef.current.modelId];
      if (avail && avail.available === false) {
        showToast('This model is not available on the configured provider', 'cloud-offline-outline');
        return;
      }
      const userMsg = { id: uid(), role: 'user', content: text.slice(0, LIMITS.maxInput), createdAt: Date.now(), status: 'done' };
      const history = [...messagesRef.current, userMsg];
      setMessages(history);
      setInput('');
      followRef.current = true;
      setShowJump(false);
      haptic('light');
      runGeneration(history);
    },
    [apiBaseUrl, backend.models, haptic, runGeneration, showToast],
  );

  const onSendPress = useCallback(() => sendText(input), [sendText, input]);

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      haptic('light');
    }
  }, [haptic]);

  const regenerate = useCallback(() => {
    if (inFlightRef.current) return;
    const cur = messagesRef.current;
    let lastUser = -1;
    for (let i = cur.length - 1; i >= 0; i -= 1) {
      if (cur[i].role === 'user') {
        lastUser = i;
        break;
      }
    }
    if (lastUser < 0) return;
    const history = cur.slice(0, lastUser + 1);
    setMessages(history);
    followRef.current = true;
    setShowJump(false);
    haptic('light');
    runGeneration(history);
  }, [haptic, runGeneration]);

  // ── Conversations ─────────────────────────────────────────────────────────
  const startNewConversation = useCallback(
    (announce = true) => {
      cancelActiveGeneration();
      persistConversation(activeId, messagesRef.current);
      setActiveId(uid());
      setMessages([]);
      setInput('');
      followRef.current = true;
      setShowJump(false);
      if (announce) showToast('New conversation started', 'sparkles-outline');
    },
    [activeId, cancelActiveGeneration, persistConversation, showToast],
  );

  const resetChat = useCallback(() => {
    if (!messagesRef.current.length) {
      showToast('This chat is already empty', 'sparkles-outline');
      return;
    }
    startNewConversation(true);
  }, [showToast, startNewConversation]);

  const openConversation = useCallback(
    async (id) => {
      setHistoryOpen(false);
      if (id === activeId) return;
      cancelActiveGeneration();
      persistConversation(activeId, messagesRef.current);
      let msgs = [];
      try {
        msgs = sanitizeMessages(safeParse(await AsyncStorage.getItem(STORAGE_KEYS.conv(id))));
      } catch (e) {
        showToast('Could not load that conversation', 'warning-outline');
        return;
      }
      if (!mountedRef.current) return;
      savedSnapshot.current[id] = serializeMessages(msgs);
      setActiveId(id);
      setMessages(msgs);
      followRef.current = true;
      setShowJump(false);
      requestAnimationFrame(() => scrollToEnd(false));
    },
    [activeId, cancelActiveGeneration, mountedRef, persistConversation, scrollToEnd, showToast],
  );

  const deleteConversation = useCallback(
    (id) => {
      Alert.alert('Delete conversation?', 'This removes it from this device permanently.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            delete savedSnapshot.current[id];
            setConversations((prev) => prev.filter((c) => c.id !== id));
            AsyncStorage.removeItem(STORAGE_KEYS.conv(id)).catch(() => {});
            if (id === activeId) {
              cancelActiveGeneration();
              setActiveId(uid());
              setMessages([]);
            }
            showToast('Conversation deleted', 'trash-outline');
          },
        },
      ]);
    },
    [activeId, cancelActiveGeneration, showToast],
  );

  const clearAllHistory = useCallback(() => {
    Alert.alert('Clear all history?', 'Every conversation stored on this device will be deleted.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear all',
        style: 'destructive',
        onPress: async () => {
          cancelActiveGeneration();
          try {
            const keys = await AsyncStorage.getAllKeys();
            const ours = keys.filter((k) => k.startsWith('lumora.v1.conv.') || k === STORAGE_KEYS.index);
            if (ours.length) await AsyncStorage.multiRemove(ours);
          } catch (e) {
            showToast('Storage error — some history may remain', 'warning-outline');
          }
          savedSnapshot.current = {};
          setConversations([]);
          setActiveId(uid());
          setMessages([]);
          setPrefs((p) => ({ ...p, lastConversationId: null }));
          setHistoryOpen(false);
          setSettingsOpen(false);
          showToast('All history cleared', 'trash-outline');
        },
      },
    ]);
  }, [cancelActiveGeneration, showToast]);

  // ── Models + settings ─────────────────────────────────────────────────────
  const selectModel = useCallback(
    (id) => {
      const model = MODELS.find((m) => m.id === id);
      if (!model) return;
      const avail = backend.models[id];
      if (avail && avail.available === false) {
        showToast(avail.reason || `${model.label} is not available on this provider`, 'cloud-offline-outline');
        return;
      }
      if (id === prefsRef.current.modelId) return;
      haptic('select');
      setPrefs((p) => ({ ...p, modelId: id }));
      showToast(inFlightRef.current ? `${model.label} will be used for the next reply` : `Switched to ${model.label}`, model.icon);
    },
    [backend.models, haptic, showToast],
  );

  const toggleTools = useCallback(() => {
    const next = prefsRef.current.toolsMode === 'auto' ? 'off' : 'auto';
    setPrefs((p) => ({ ...p, toolsMode: next }));
    haptic('select');
    showToast(next === 'auto' ? 'Live tools enabled' : 'Live tools disabled', next === 'auto' ? 'globe' : 'globe-outline');
  }, [haptic, showToast]);

  const saveSettings = useCallback(
    (next) => {
      setPrefs((p) => ({ ...p, ...next }));
      setSettingsOpen(false);
      showToast('Settings saved', 'checkmark-circle-outline');
    },
    [showToast],
  );

  // ── Clipboard / share / links ─────────────────────────────────────────────
  const copyText = useCallback(
    async (text, silent) => {
      try {
        await Clipboard.setStringAsync(String(text || ''));
        haptic('light');
        if (!silent) showToast('Copied to clipboard', 'copy-outline');
        return true;
      } catch (e) {
        showToast('Could not copy', 'warning-outline');
        return false;
      }
    },
    [haptic, showToast],
  );

  const shareText = useCallback(async (text) => {
    try {
      await Share.share({ message: String(text || '') });
    } catch (e) {
      // user dismissed
    }
  }, []);

  const openUrl = useCallback(
    async (url) => {
      if (!/^https?:\/\//i.test(String(url || ''))) {
        showToast('This link cannot be opened', 'link-outline');
        return;
      }
      try {
        await Linking.openURL(url);
      } catch (e) {
        showToast('Could not open the link', 'link-outline');
      }
    },
    [showToast],
  );

  // ── Keyboard / safe-area math ─────────────────────────────────────────────
  const onRootLayout = useCallback(
    (e) => {
      const h = e.nativeEvent.layout.height;
      if (!kb.visible) baseHeightRef.current = h;
      setLayoutHeight(h);
    },
    [kb.visible],
  );
  const resizedBy = kb.visible ? Math.max(0, baseHeightRef.current - layoutHeight) : 0;
  // If the OS already resized the window (Android adjustResize) no extra padding is needed.
  const keyboardPad = kb.visible ? (resizedBy > 40 ? 0 : kb.height) : 0;
  const composerBottom = kb.visible ? keyboardPad + 8 : Math.max(insets.bottom, 10);

  // ── List rendering ────────────────────────────────────────────────────────
  const lastId = messages.length ? messages[messages.length - 1].id : null;
  const renderItem = useCallback(
    ({ item }) => (
      <MessageBubble
        item={item}
        canRegenerate={item.id === lastId && item.role === 'assistant' && !isGenerating}
        maxWidth={bubbleMaxWidth}
        onCopy={copyText}
        onShare={shareText}
        onRegenerate={regenerate}
        onOpenUrl={openUrl}
      />
    ),
    [lastId, isGenerating, bubbleMaxWidth, copyText, shareText, regenerate, openUrl],
  );
  const keyExtractor = useCallback((m) => m.id, []);

  const empty = useMemo(
    () => (
      <WelcomeScreen
        onStarter={sendText}
        backendState={backend.state}
        onOpenSettings={() => setSettingsOpen(true)}
        disabled={isGenerating}
      />
    ),
    [sendText, backend.state, isGenerating],
  );

  if (!hydrated) {
    return (
      <View style={[styles.root, styles.center]}>
        <StatusBar style="light" />
        <AmbientGlow />
        <BrandMark size={56} />
        <ActivityIndicator color={C.blueBright} style={{ marginTop: 20 }} />
      </View>
    );
  }

  return (
    <View style={styles.root} onLayout={onRootLayout}>
      <StatusBar style="light" />
      <AmbientGlow />

      <View style={{ paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }}>
        <Header
          backendState={backend.state}
          isGenerating={isGenerating}
          onHistory={() => setHistoryOpen(true)}
          onNewChat={resetChat}
          onSettings={() => setSettingsOpen(true)}
        />
        <ModelSelector activeId={prefs.modelId} availability={backend.models} onSelect={selectModel} />
      </View>

      <View style={[styles.chatArea, { paddingLeft: insets.left, paddingRight: insets.right }]}>
        <FlatList
          ref={listRef}
          testID="chat-list"
          data={messages}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={[styles.listContent, !messages.length && styles.listEmpty]}
          ListEmptyComponent={empty}
          onScroll={onScroll}
          onScrollBeginDrag={onBeginDrag}
          onScrollEndDrag={onEndDrag}
          onMomentumScrollEnd={onMomentumEnd}
          scrollEventThrottle={32}
          onContentSizeChange={onContentSizeChange}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
          showsVerticalScrollIndicator={false}
          initialNumToRender={12}
          maxToRenderPerBatch={8}
          windowSize={11}
          removeClippedSubviews={false}
        />
        <ScrollToBottomButton visible={showJump && messages.length > 0} onPress={followBottom} />
      </View>

      <View style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
        <Composer
          value={input}
          onChangeText={setInput}
          apiBaseUrl={apiBaseUrl}
          onRecordingError={(message) => showToast(message, 'mic-off-outline')}
          onSend={onSendPress}
          onStop={stopGeneration}
          isGenerating={isGenerating}
          toolsMode={prefs.toolsMode}
          onToggleTools={toggleTools}
          bottomPad={composerBottom}
          disabled={false}
        />
      </View>

      <View pointerEvents="none" style={[styles.toastLayer, { top: insets.top + 64 }]}>
        <Toast toast={toast} />
      </View>

      <SettingsSheet
        visible={settingsOpen}
        prefs={prefs}
        effectiveUrl={apiBaseUrl}
        backend={backend}
        onSave={saveSettings}
        onClose={() => setSettingsOpen(false)}
        onClearAll={clearAllHistory}
        onRetryConnection={() => refreshBackend(apiBaseUrl)}
      />
      <HistorySheet
        visible={historyOpen}
        conversations={conversations}
        activeId={activeId}
        onClose={() => setHistoryOpen(false)}
        onOpen={openConversation}
        onDelete={deleteConversation}
        onNew={() => {
          setHistoryOpen(false);
          startNewConversation(true);
        }}
        onClearAll={clearAllHistory}
      />
    </View>
  );
}

export default function App() {
  const reducedMotion = useReducedMotion();
  return (
    <SafeAreaProvider>
      <ReducedMotionContext.Provider value={reducedMotion}>
        <LumoraApp />
      </ReducedMotionContext.Provider>
    </SafeAreaProvider>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════════════════════════════

const markdownStyles = {
  body: { color: C.text, fontSize: TYPE.body, lineHeight: TYPE.bodyLine, flexShrink: 1, minWidth: 0 },
  paragraph: { marginTop: 0, marginBottom: SPACE.sm, flexShrink: 1 },
  heading1: { color: C.white, fontSize: 22, fontWeight: '800', marginTop: SPACE.sm, marginBottom: SPACE.sm, letterSpacing: -0.3, flexShrink: 1 },
  heading2: { color: C.white, fontSize: 18, fontWeight: '700', marginTop: SPACE.sm, marginBottom: SPACE.xs, letterSpacing: -0.2, flexShrink: 1 },
  heading3: { color: C.white, fontSize: TYPE.subtitle, fontWeight: '700', marginTop: SPACE.xs, marginBottom: 5, flexShrink: 1 },
  heading4: { color: C.text, fontSize: TYPE.body, fontWeight: '700', marginBottom: 4 },
  strong: { color: C.white, fontWeight: '700' },
  em: { fontStyle: 'italic', color: C.text },
  s: { textDecorationLine: 'line-through' },
  link: { color: C.blueBright, textDecorationLine: 'underline' },
  blockquote: {
    backgroundColor: C.blueSoft,
    borderLeftWidth: 3,
    borderLeftColor: C.blue,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 6,
    marginVertical: 6,
    borderRadius: RADIUS.sm,
  },
  bullet_list: { marginBottom: 10, paddingLeft: 4 },
  ordered_list: { marginBottom: 10, paddingLeft: 4 },
  list_item: { marginBottom: 5 },
  bullet_list_icon: { color: C.amber, fontSize: 16, lineHeight: 23, marginLeft: 2, marginRight: 8 },
  ordered_list_icon: { color: C.amber, fontWeight: '700', lineHeight: 23, marginRight: 8 },
  code_inline: {
    fontFamily: MONO,
    fontSize: 13,
    color: C.amber,
    backgroundColor: C.amberSoft,
    borderRadius: RADIUS.sm,
    paddingHorizontal: 5,
    borderWidth: 0,
  },
  hr: { backgroundColor: C.border, height: 1, marginVertical: 12 },
  table: { borderWidth: 1, borderColor: C.borderStrong, borderRadius: RADIUS.sm, marginVertical: SPACE.xs, overflow: 'hidden' },
  thead: { backgroundColor: C.blueSoft },
  tr: { borderBottomWidth: 1, borderColor: C.border, flexDirection: 'row' },
  th: { width: 140, flex: 0, padding: 9, color: C.white, fontWeight: '700' },
  td: { width: 140, flex: 0, padding: 9, color: C.text, flexShrink: 0 },
};

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  center: { alignItems: 'center', justifyContent: 'center' },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.7 },

  // Header
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: SPACE.md, paddingTop: SPACE.xs, paddingBottom: SPACE.sm },
  headerLeft: { flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 },
  headerTitles: { marginLeft: SPACE.sm, flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center' },
  brandName: { color: C.white, fontSize: 20, fontWeight: '700', letterSpacing: -0.45 },
  brandAI: { color: C.blueBright, fontSize: 12, fontWeight: '800', letterSpacing: 1.2, marginLeft: 6, marginTop: 2 },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 3 },
  statusText: { color: C.slate, fontSize: TYPE.caption, marginLeft: 7, flexShrink: 1 },
  headerRight: { flexDirection: 'row', gap: SPACE.xs, marginLeft: SPACE.xs },
  iconBtn: {
    width: 42,
    height: 42,
    borderRadius: RADIUS.sm,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  brandTile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(177,164,255,0.32)',
    shadowColor: C.blue,
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  pulseWrap: { width: 8, height: 8, alignItems: 'center', justifyContent: 'center' },
  pulseRing: { position: 'absolute', width: 8, height: 8, borderRadius: 4 },
  pulseCore: { width: 7, height: 7, borderRadius: 4 },

  // Model selector
  modelSelectorWrap: { marginHorizontal: SPACE.md, marginBottom: SPACE.sm },
  modelSelectorButton: { minHeight: 58, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, paddingHorizontal: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  modelSelectorGlyph: { width: 34, height: 34, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.blueSoft },
  modelSelectorCopy: { flex: 1, minWidth: 0 },
  modelSelectorEyebrow: { color: C.muted, fontSize: 12, fontWeight: '800', letterSpacing: 1.3 },
  modelSelectorName: { color: C.white, fontSize: 14, fontWeight: '700', marginTop: 1 },
  modelSelectorStatus: { color: C.slate, fontSize: 12, maxWidth: 95 },
  modelUnavailable: { color: C.red },
  modelSheetHint: { color: C.slate, fontSize: TYPE.caption, lineHeight: 18, marginBottom: SPACE.sm },
  modelOptions: { flexGrow: 0, flexShrink: 1, marginBottom: SPACE.sm },
  modelOption: { minHeight: 66, flexDirection: 'row', alignItems: 'center', gap: SPACE.sm, padding: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, marginBottom: SPACE.xs },
  modelOptionActive: { backgroundColor: C.blueSoft, borderColor: 'rgba(177,164,255,0.38)' },
  modelOptionOff: { borderColor: 'rgba(237,133,135,0.24)' },
  modelOptionIcon: { width: 38, height: 38, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface2 },
  modelOptionIconActive: { backgroundColor: C.blueDeep },
  modelOptionCopy: { flex: 1, minWidth: 0 },
  modelOptionTitleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, flexWrap: 'wrap' },
  selectedTag: { color: C.blueBright, fontSize: 12, fontWeight: '800', letterSpacing: 0.8 },
  modelName: { color: C.text, fontSize: 14, fontWeight: '700' },
  modelNameActive: { color: C.white },
  modelCat: { color: C.muted, fontSize: TYPE.caption, marginTop: 3, fontWeight: '600' },
  modelReason: { color: C.red, fontSize: 12, lineHeight: 17, marginTop: 3 },

  // Chat list
  chatArea: { flex: 1, borderTopWidth: 1, borderTopColor: C.border },
  listContent: { paddingHorizontal: SPACE.md, paddingTop: SPACE.md, paddingBottom: SPACE.md },
  listEmpty: { flexGrow: 1 },

  // Welcome
  welcome: { flex: 1, justifyContent: 'flex-start', paddingHorizontal: 2, paddingTop: SPACE.sm, paddingBottom: SPACE.sm },
  welcomeHero: { alignItems: 'center', paddingHorizontal: SPACE.sm, marginBottom: SPACE.xl },
  welcomeOrbStage: { width: 152, height: 152, alignItems: 'center', justifyContent: 'center', marginBottom: SPACE.sm },
  orbOrbit: { position: 'absolute', borderRadius: RADIUS.pill, borderWidth: 1 },
  orbOrbitOuter: { width: 138, height: 138, borderColor: 'rgba(177,164,255,0.13)', transform: [{ rotate: '28deg' }] },
  orbOrbitInner: { width: 112, height: 112, borderColor: 'rgba(124,201,169,0.14)', transform: [{ rotate: '-34deg' }] },
  welcomeOrbCore: { width: 78, height: 78, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.pill, borderWidth: 1, borderColor: 'rgba(177,164,255,0.28)', ...ELEVATION.card },
  orbSparkle: { position: 'absolute', right: 16, top: 23, width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: RADIUS.pill, backgroundColor: C.blueDeep, borderWidth: 1, borderColor: 'rgba(177,164,255,0.4)' },
  welcomeEyebrow: { color: C.blueBright, fontSize: 12, fontWeight: '800', letterSpacing: 2.1, marginTop: 2 },
  welcomeTitle: { color: C.white, fontSize: TYPE.display, fontWeight: '700', textAlign: 'center', marginTop: SPACE.xs, letterSpacing: -0.75, lineHeight: 34 },
  welcomeAccent: { color: C.blueBright },
  welcomeSub: { color: C.slate, fontSize: 14, textAlign: 'center', marginTop: SPACE.xs, lineHeight: 21, maxWidth: 320 },
  setupBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: SPACE.sm,
    borderRadius: RADIUS.md,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.borderStrong,
    marginBottom: SPACE.md,
  },
  setupTitle: { color: C.white, fontWeight: '700', fontSize: 14 },
  setupText: { color: C.slate, fontSize: 12, marginTop: 3, lineHeight: 17 },
  starterHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: SPACE.xs },
  sectionLabel: { color: C.text, fontSize: 12, fontWeight: '700', letterSpacing: 0.8 },
  starterCount: { color: C.muted, fontSize: 12, fontWeight: '700', letterSpacing: 1.2 },
  starterRail: { flexDirection: 'row', gap: SPACE.xs, paddingRight: SPACE.md },
  starterCard: { padding: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, minHeight: 118, ...ELEVATION.card },
  starterIcon: { width: 32, height: 32, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center', borderWidth: 1, marginBottom: SPACE.xs },
  starterTitle: { color: C.white, fontSize: 13, fontWeight: '700' },
  starterSub: { color: C.slate, fontSize: 12, marginTop: 4, lineHeight: 17 },
  starterGo: { alignSelf: 'flex-end', marginTop: SPACE.xs, width: 26, height: 26, borderRadius: RADIUS.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: C.blueSoft },

  // Messages
  msgRow: { marginBottom: SPACE.xl },
  msgRowUser: { alignItems: 'flex-end' },
  userBubble: { paddingHorizontal: SPACE.md, paddingVertical: SPACE.sm, borderRadius: RADIUS.lg, borderBottomRightRadius: RADIUS.sm, borderWidth: 1, borderColor: 'rgba(177,164,255,0.2)' },
  userText: { color: C.white, fontSize: TYPE.body, lineHeight: 23 },
  userTime: { color: C.muted, fontSize: 12, marginTop: 5, marginRight: 4 },
  aiMeta: { flexDirection: 'row', alignItems: 'center', marginBottom: SPACE.xs },
  aiAvatar: { width: 28, height: 28, borderRadius: RADIUS.sm, overflow: 'hidden', marginRight: SPACE.xs, borderWidth: 1, borderColor: 'rgba(177,164,255,0.28)' },
  aiAvatarInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  aiAvatarMark: { width: 16, height: 16 },
  modelTag: { marginLeft: SPACE.xs, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 7, backgroundColor: C.blueSoft },
  modelTagText: { color: C.blueBright, fontSize: 12, fontWeight: '700' },
  aiTime: { color: C.muted, fontSize: 12, marginLeft: SPACE.xs },
  aiBubble: {
    alignSelf: 'stretch',
    minWidth: 0,
    flexShrink: 1,
    paddingHorizontal: 0,
    paddingTop: 2,
    paddingBottom: 0,
    borderRadius: RADIUS.sm,
    backgroundColor: 'transparent',
  },
  aiBubbleError: { paddingHorizontal: SPACE.sm, paddingTop: SPACE.sm, paddingBottom: 4, borderWidth: 1, borderColor: 'rgba(237,133,135,0.3)', backgroundColor: C.redSoft },
  waitingRow: { flexDirection: 'row', alignItems: 'center', paddingBottom: 9 },
  waitingText: { color: C.slate, fontSize: 13, marginLeft: 10, flexShrink: 1 },
  dotsRow: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 14 },
  typingDot: { width: 6, height: 6, borderRadius: 3 },
  caret: { width: 8, height: 15, borderRadius: 2, backgroundColor: C.blueBright, marginBottom: 9, marginTop: -4 },
  mdFallback: { color: C.text, fontSize: 15.5, lineHeight: 23, marginBottom: 10 },
  markdownContent: { width: '100%', maxWidth: '100%', minWidth: 0, flexShrink: 1 },
  cite: { color: C.blueBright, backgroundColor: C.blueSoft, fontSize: 12, fontWeight: '800' },
  tableScroll: { width: '100%', maxWidth: '100%', alignSelf: 'stretch', flexGrow: 0, flexShrink: 1, marginVertical: 8 },
  tableContent: { alignItems: 'flex-start' },
  mobileTable: { width: '100%', maxWidth: '100%', gap: 8, marginVertical: 8 },
  tableRecord: { width: '100%', minWidth: 0, padding: SPACE.sm, gap: SPACE.xs, borderRadius: RADIUS.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  tableField: { width: '100%', minWidth: 0 },
  tableFieldLabel: { width: '100%', minWidth: 0, marginBottom: 3 },
  tableLabel: { color: C.blueBright, fontSize: 12, fontWeight: '800', letterSpacing: 0.3, marginBottom: 3 },
  tableValue: { width: '100%', minWidth: 0, flexShrink: 1 },
  noticeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingBottom: 9 },
  noticeText: { color: C.slate, fontSize: 12.5, fontStyle: 'italic' },
  errorRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, paddingBottom: 10 },
  errorText: { color: '#FECACA', fontSize: 13.5, lineHeight: 19, flex: 1 },
  actionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  actionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    minHeight: 34,
    paddingHorizontal: SPACE.sm,
    paddingVertical: 7,
    borderRadius: RADIUS.sm,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
  },
  actionChipAccent: { borderColor: 'rgba(215,173,114,0.35)', backgroundColor: C.amberSoft },
  actionText: { color: C.slate, fontSize: 12, fontWeight: '600' },

  // Code
  codeBlock: { backgroundColor: C.code, borderRadius: RADIUS.md, borderWidth: 1, borderColor: C.borderStrong, marginVertical: SPACE.xs, overflow: 'hidden' },
  codeHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE.sm,
    paddingVertical: SPACE.xs,
    backgroundColor: C.surface2,
    borderBottomWidth: 1,
    borderBottomColor: C.border,
  },
  codeLangRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  codeLangDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.amber },
  codeLang: { color: C.slate, fontSize: 12, fontWeight: '800', letterSpacing: 1.1 },
  codeCopyBtn: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, backgroundColor: 'rgba(148,163,184,0.1)' },
  codeCopyText: { color: C.slate, fontSize: 12, fontWeight: '700' },
  codeScroll: { padding: 12 },
  codeText: { fontFamily: MONO, fontSize: 13, lineHeight: 20, color: C.text },

  // Tools
  toolStack: { gap: 8, marginBottom: 10 },
  toolCard: { borderRadius: RADIUS.md, padding: SPACE.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  toolHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 10 },
  toolIcon: { width: 24, height: 24, borderRadius: 7, backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center', marginRight: 8 },
  toolTitle: { color: C.white, fontSize: 13.5, fontWeight: '700', flex: 1 },
  liveTag: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, backgroundColor: C.greenSoft },
  liveDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: C.green },
  liveText: { color: C.green, fontSize: 12, fontWeight: '800', letterSpacing: 1 },
  toolFoot: { marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: C.border },
  toolFootText: { color: C.muted, fontSize: 12 },
  toolError: { flexDirection: 'row', gap: SPACE.xs, alignItems: 'flex-start', padding: SPACE.sm, borderRadius: RADIUS.sm, backgroundColor: C.amberSoft, borderWidth: 1, borderColor: 'rgba(215,173,114,0.26)' },
  toolErrorText: { color: '#FCD9A8', fontSize: 12.5, lineHeight: 17, flex: 1 },
  weatherMain: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  weatherTemp: { color: C.white, fontSize: 42, fontWeight: '200', letterSpacing: -1 },
  weatherDesc: { color: C.white, fontSize: 15, fontWeight: '600' },
  weatherFeels: { color: C.slate, fontSize: 12.5, marginTop: 2 },
  weatherStats: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  statPill: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: SPACE.xs, paddingVertical: 4, borderRadius: RADIUS.sm, backgroundColor: 'rgba(255,255,255,0.04)' },
  statText: { color: C.text, fontSize: 12 },
  forecastRow: { flexDirection: 'row', gap: 6, marginTop: 10 },
  forecastDay: { flex: 1, alignItems: 'center', paddingVertical: SPACE.xs, borderRadius: RADIUS.sm, backgroundColor: 'rgba(255,255,255,0.035)' },
  forecastName: { color: C.slate, fontSize: 12, fontWeight: '700' },
  forecastTemp: { color: C.white, fontSize: 15, fontWeight: '700', marginTop: 3 },
  forecastMin: { color: C.muted, fontSize: 12 },
  forecastDesc: { color: C.slate, fontSize: 12, marginTop: 2, paddingHorizontal: 2 },
  assetRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 7, gap: 10 },
  assetSym: { width: 38, height: 38, borderRadius: 12, backgroundColor: C.amberSoft, alignItems: 'center', justifyContent: 'center' },
  assetSymText: { color: C.amber, fontSize: 12, fontWeight: '800' },
  assetName: { color: C.white, fontSize: 14, fontWeight: '600' },
  assetTime: { color: C.muted, fontSize: 12, marginTop: 1 },
  assetPrice: { color: C.white, fontSize: 14.5, fontWeight: '700' },
  assetChange: { fontSize: 12, fontWeight: '700', marginTop: 1 },
  unavailableText: { color: C.amber, fontSize: 12, marginTop: 4 },
  fxRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  fxSide: { flex: 1 },
  fxAmount: { color: C.text, fontSize: 22, fontWeight: '700' },
  fxCode: { color: C.slate, fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  fxRate: { color: C.slate, fontSize: 12, marginTop: 8 },
  newsRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingVertical: SPACE.xs, borderTopWidth: 1, borderTopColor: C.border },
  newsNum: { color: C.blueBright, fontSize: 12, fontWeight: '800', width: 16, textAlign: 'center' },
  newsTitle: { color: C.text, fontSize: 13.5, lineHeight: 18, fontWeight: '600' },
  newsMeta: { color: C.muted, fontSize: 12, marginTop: 3 },
  sourcesWrap: { marginTop: 10 },
  sourcesLabel: { color: C.muted, fontSize: 12, fontWeight: '800', letterSpacing: 1.4, marginBottom: 6, marginLeft: 2 },
  sourcesRow: { gap: 6, paddingRight: 16 },
  sourceChip: { minHeight: 42, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, paddingVertical: 7, paddingLeft: 7, paddingRight: SPACE.sm, borderRadius: RADIUS.sm, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  sourceNum: { width: 20, height: 20, borderRadius: 6, backgroundColor: C.blueSoft, alignItems: 'center', justifyContent: 'center' },
  sourceNumText: { color: C.blueBright, fontSize: 12, fontWeight: '800' },
  sourceTitle: { color: C.text, fontSize: 12, fontWeight: '600' },
  sourceDomain: { color: C.muted, fontSize: 12 },

  // Composer
  composerWrap: { paddingHorizontal: SPACE.sm, paddingTop: SPACE.xs, backgroundColor: C.bg, borderTopWidth: 1, borderTopColor: C.border },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 6,
    borderRadius: RADIUS.xl,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.borderStrong,
    ...ELEVATION.card,
  },
  toolsToggle: { minWidth: 58, height: 40, flexDirection: 'row', gap: 5, paddingHorizontal: 9, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center' },
  toolsToggleOn: { backgroundColor: C.blueDeep },
  toolsToggleText: { color: C.muted, fontSize: 12, fontWeight: '700' },
  toolsToggleTextOn: { color: C.white },
  input: {
    flex: 1,
    color: C.white,
    fontSize: TYPE.body,
    maxHeight: 136,
    minHeight: 40,
    paddingHorizontal: SPACE.xs,
    paddingTop: Platform.OS === 'ios' ? 10 : 8,
    paddingBottom: Platform.OS === 'ios' ? 10 : 8,
  },
  sendBtn: { width: 48, height: 48, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center' },
  stopBtn: { width: 48, height: 48, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.amberSoft, borderWidth: 1, borderColor: 'rgba(215,173,114,0.38)' },
  stopSquare: { width: 12, height: 12, borderRadius: 3, backgroundColor: C.amber },
  recordingStartBtn: { width: 42, height: 42, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface2, borderWidth: 1, borderColor: C.border },
  recordingCancelBtn: { width: 40, height: 42, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.redSoft, borderWidth: 1, borderColor: 'rgba(239,100,100,0.35)' },
  recordingStopBtn: { width: 48, height: 48, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.red, borderWidth: 1, borderColor: 'rgba(239,100,100,0.5)' },
  transcribeBtn: { width: 48, height: 48, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.blueDeep, borderWidth: 1, borderColor: 'rgba(177,164,255,0.45)' },
  transcribedBtn: { backgroundColor: C.greenSoft },
  transcribingBtn: { width: 48, height: 48, borderRadius: RADIUS.lg, alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface2 },
  composerMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: SPACE.xs, paddingTop: 6 },
  composerHint: { color: C.muted, fontSize: 12 },
  voiceStatus: { color: C.slate, fontSize: 12, paddingHorizontal: SPACE.xs, paddingTop: 4 },
  counter: { color: C.amber, fontSize: 12, fontWeight: '700' },
  jumpWrap: { position: 'absolute', bottom: 12, alignSelf: 'center' },
  jumpBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: C.blueDeep,
    borderWidth: 1,
    borderColor: 'rgba(177,164,255,0.45)',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  jumpText: { color: C.white, fontSize: 12.5, fontWeight: '700' },

  // Toast
  toastLayer: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: C.glassStrong,
    borderWidth: 1,
    borderColor: C.borderStrong,
    maxWidth: '90%',
    shadowColor: '#000',
    shadowOpacity: 0.4,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  toastText: { color: C.white, fontSize: 13, fontWeight: '600', flexShrink: 1 },

  // Sheets
  sheetOverlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(3,4,7,0.74)' },
  sheet: {
    maxHeight: '90%',
    backgroundColor: C.surface2,
    borderTopLeftRadius: RADIUS.sheet,
    borderTopRightRadius: RADIUS.sheet,
    borderWidth: 1,
    borderColor: C.borderStrong,
    paddingHorizontal: SPACE.md,
    paddingTop: SPACE.sm,
  },
  sheetGrab: { alignSelf: 'center', width: 38, height: 4, borderRadius: RADIUS.pill, backgroundColor: 'rgba(235,237,244,0.2)', marginBottom: SPACE.sm },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: SPACE.xs },
  sheetTitle: { color: C.white, fontSize: TYPE.title, fontWeight: '700', letterSpacing: -0.35 },
  sheetScroll: { flexGrow: 0, flexShrink: 1, maxHeight: '100%', marginBottom: SPACE.sm },
  fieldLabel: { color: C.slate, fontSize: 12, fontWeight: '800', letterSpacing: 1.3, marginTop: SPACE.md, marginBottom: SPACE.xs },
  glassCard: { padding: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  backendRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginBottom: SPACE.sm },
  backendText: { color: C.text, fontSize: 13, fontWeight: '600', flex: 1 },
  field: {
    color: C.white,
    fontSize: 14,
    minHeight: 48,
    paddingHorizontal: SPACE.sm,
    paddingVertical: Platform.OS === 'ios' ? SPACE.sm : SPACE.xs,
    borderRadius: RADIUS.sm,
    backgroundColor: C.bg,
    borderWidth: 1,
    borderColor: C.borderStrong,
  },
  inlineRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, marginTop: SPACE.xs },
  connectionDetailsToggle: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: SPACE.xs },
  smallBtn: { minHeight: 44, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.sm, backgroundColor: C.blueSoft, borderWidth: 1, borderColor: 'rgba(177,164,255,0.28)', minWidth: 120, alignItems: 'center', justifyContent: 'center' },
  smallBtnText: { color: C.blueBright, fontSize: 12, fontWeight: '700' },
  hint: { color: C.muted, fontSize: 12, lineHeight: 17, flexShrink: 1, marginTop: 4 },
  testText: { fontSize: 12.5, marginTop: 10, fontWeight: '600' },
  toolStatusGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  toolStatus: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  toolStatusText: { color: C.slate, fontSize: 12 },
  linkSmall: { color: C.blueBright, fontSize: 12.5, fontWeight: '700' },
  segment: { flexDirection: 'row', padding: 4, borderRadius: RADIUS.md, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  segBtn: { minHeight: 42, flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: SPACE.xs, borderRadius: RADIUS.sm },
  segBtnOn: { backgroundColor: C.blueDeep },
  segText: { color: C.slate, fontSize: 13, fontWeight: '700' },
  segTextOn: { color: C.white },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  switchTitle: { color: C.white, fontSize: 14, fontWeight: '600' },
  dangerBtn: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: SPACE.xs, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: C.redSoft, borderWidth: 1, borderColor: 'rgba(237,133,135,0.24)' },
  dangerText: { color: C.red, fontSize: 14, fontWeight: '700' },
  securityNote: { flexDirection: 'row', gap: SPACE.xs, marginTop: SPACE.md, padding: SPACE.sm, borderRadius: RADIUS.md, backgroundColor: C.blueSoft },
  securityText: { color: C.slate, fontSize: 12, lineHeight: 17, flex: 1 },
  primaryBtn: { minHeight: 50, paddingVertical: SPACE.sm, borderRadius: RADIUS.md, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: C.white, fontSize: 15, fontWeight: '800', letterSpacing: 0.3 },
  historyActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: SPACE.xs },
  historyNew: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: SPACE.sm, paddingVertical: SPACE.xs, borderRadius: RADIUS.sm, backgroundColor: C.blueDeep },
  historyNewText: { color: C.white, fontSize: 13, fontWeight: '700' },
  historyEmpty: { alignItems: 'center', gap: SPACE.xs, paddingVertical: 40 },
  historyRow: { minHeight: 82, flexDirection: 'row', alignItems: 'center', gap: SPACE.xs, padding: SPACE.sm, borderRadius: RADIUS.md, marginBottom: SPACE.xs, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  historyOpen: { flex: 1, minWidth: 0 },
  historyRowActive: { borderColor: 'rgba(177,164,255,0.36)', backgroundColor: C.blueSoft },
  historyTitle: { color: C.white, fontSize: 14, fontWeight: '700' },
  historyPreview: { color: C.slate, fontSize: 12, marginTop: 3 },
  historyMeta: { color: C.muted, fontSize: 12, marginTop: 5 },
});
