/**
 * LUMORA AI — Backend proxy
 * ---------------------------------------------------------------------------
 * Keeps every provider secret on the server, validates and rate-limits client
 * requests, streams real LLM tokens to the app over Server-Sent Events and
 * fetches live data (web search, news, weather, crypto, currency) from real
 * providers. Nothing here is simulated: if a provider fails, the client is told
 * that live data could not be retrieved.
 *
 * Endpoints
 *   GET  /api/health
 *   GET  /api/models
 *   POST /api/chat            (JSON response)
 *   POST /api/chat/stream     (text/event-stream)
 *   POST /api/tools/search
 *   POST /api/tools/news
 *   POST /api/tools/weather
 *   POST /api/tools/crypto
 *   POST /api/tools/currency
 *
 * Run:  cp .env.example .env  →  fill LLM_API_KEY  →  npm install  →  npm start
 */

import 'dotenv/config';
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

// ─── Configuration ──────────────────────────────────────────────────────────
const NODE_ENV = process.env.NODE_ENV || '';
const REQUIRE_SECURE_CONFIG = !['development', 'test'].includes(NODE_ENV);
const PORT = Number(process.env.PORT) || 8787;
const LISTEN_HOST = NODE_ENV === 'development' ? (process.env.HOST || '').trim() || '127.0.0.1' : undefined;
const isLoopbackHost = (host) => host === '127.0.0.1' || host === '::1';
const TRUST_PROXY_RAW = (process.env.TRUST_PROXY || '').trim();
const CLIENT_TOKENS = (process.env.LUMORA_CLIENT_TOKENS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const LLM = {
  name: process.env.LLM_PROVIDER_NAME || 'Groq',
  baseUrl: (process.env.LLM_BASE_URL || 'https://api.groq.com/openai/v1').replace(/\/+$/, ''),
  apiKey: process.env.LLM_API_KEY || process.env.GROQ_API_KEY || '',
};
LLM.isGroq = /groq\.com/i.test(LLM.baseUrl);

function isSecureProviderUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function parseTrustedProxyRanges(raw) {
  if (!raw || raw === '0') return { value: false, error: false };
  // Render terminates public TLS at its edge and sends X-Forwarded-Proto to
  // the web service over HTTP. Trust only that scheme signal in Render's web
  // runtime; keep Express proxy trust disabled so X-Forwarded-For stays ignored.
  if (raw.toLowerCase() === 'render') {
    const isRenderWebService = process.env.RENDER === 'true' && process.env.RENDER_SERVICE_TYPE === 'web';
    return isRenderWebService
      ? { value: false, renderHttps: true, error: false }
      : { value: false, renderHttps: false, error: true };
  }
  if (/^\d+$/.test(raw)) {
    // Keep hop-count trust for development/test only. In deployed environments
    // numeric trust can accept spoofed forwarding headers on direct connections.
    return REQUIRE_SECURE_CONFIG && Number(raw) > 0
      ? { value: false, error: true }
      : { value: Number(raw), error: false };
  }
  const ranges = raw.split(',').map((part) => part.trim());
  const valid = ranges.length > 0 && ranges.every((range) => {
    const [address, prefix, extra] = range.split('/');
    const family = isIP(address);
    if (!family || extra !== undefined) return false;
    if (prefix === undefined) return true;
    const bits = family === 4 ? 32 : 128;
    return /^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= bits;
  });
  return valid ? { value: ranges, error: false } : { value: false, error: true };
}

const TRUST_PROXY_CONFIG = parseTrustedProxyRanges(TRUST_PROXY_RAW);
const TRUST_PROXY = TRUST_PROXY_CONFIG.value;
const TRUST_RENDER_HTTPS = TRUST_PROXY_CONFIG.renderHttps === true;

const KEYS = {
  tavily: process.env.TAVILY_API_KEY || '',
  coingecko: process.env.COINGECKO_DEMO_API_KEY || '',
};

const NEWS_LOCALE = {
  hl: process.env.NEWS_HL || 'en-US',
  gl: process.env.NEWS_GL || 'US',
  ceid: process.env.NEWS_CEID || 'US:en',
};
const LIMITS = {
  maxMessages: 40,
  maxMessageChars: 8000,
  maxTotalChars: 48000,
  maxTokens: 4096,
  toolTimeoutMs: 9000,
  llmConnectTimeoutMs: 30000,
  llmIdleTimeoutMs: 45000,
  upstreamRetries: 2,
};

/** Public model IDs (used by the app) → provider model IDs. */
const MODEL_CATALOG = [
  {
    id: 'gpt-oss-20b',
    label: 'GPT-OSS 20B',
    category: 'Fast reasoning',
    providerModel: process.env.MODEL_GPT_OSS_20B || 'openai/gpt-oss-20b',
    reasoningEffort: 'low',
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS 120B',
    category: 'Deep reasoning',
    providerModel: process.env.MODEL_GPT_OSS_120B || 'openai/gpt-oss-120b',
    reasoningEffort: 'medium',
  },
  {
    id: 'qwen-3.8-27b',
    label: 'Qwen 3.8 27B',
    category: 'Reasoning & coding',
    providerModel: process.env.MODEL_QWEN_38_27B || 'qwen/qwen3.8-27b',
    reasoningEffort: 'medium',
    reasoningFormat: 'hidden',
    temperature: 1.0,
    topP: 0.95,
  },
];

const hasValidClientTokenConfig = CLIENT_TOKENS.length > 0 && CLIENT_TOKENS.every((token) => Buffer.byteLength(token, 'utf8') >= 32);
const allowUnauthenticatedLocalDev = NODE_ENV === 'development' && isLoopbackHost(LISTEN_HOST);
if (!allowUnauthenticatedLocalDev && !hasValidClientTokenConfig) {
  console.error('[lumora] Non-loopback or non-development startup requires at least one LUMORA_CLIENT_TOKENS entry of 32 bytes or more. Refusing to start.');
  process.exit(1);
}
if (REQUIRE_SECURE_CONFIG && !isSecureProviderUrl(LLM.baseUrl)) {
  console.error('[lumora] LLM_BASE_URL must use HTTPS outside development/test. Refusing to start.');
  process.exit(1);
}
if (TRUST_PROXY_CONFIG.error) {
  console.error('[lumora] TRUST_PROXY must be 0, "render" on a Render web service, or a comma-separated list of proxy IPs/CIDRs; deployed modes do not allow hop counts. Refusing to start.');
  process.exit(1);
}
if (!CLIENT_TOKENS.length) console.warn('[lumora] No LUMORA_CLIENT_TOKENS set — auth disabled for loopback development only.');
if (!LLM.apiKey) console.warn('[lumora] LLM_API_KEY is empty — chat will report the provider as not configured.');

// ─── Errors ─────────────────────────────────────────────────────────────────
class HttpError extends Error {
  constructor(status, code, message, { retryable = false } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const sendError = (res, err) => {
  const status = err instanceof HttpError ? err.status : 500;
  const code = err instanceof HttpError ? err.code : 'internal';
  const message = err instanceof HttpError ? err.message : 'Something went wrong on the Lumora server.';
  if (!(err instanceof HttpError)) console.error('[lumora] unexpected error', err?.name || 'Error');
  res.status(status).json({ error: { code, message } });
};

/** Maps provider status and allowlisted error fields to safe public categories. */
function providerError(status, payload) {
  const providerDetails = payload?.error || {};
  const detailText = [providerDetails.code, providerDetails.type, providerDetails.message]
    .filter((value) => typeof value === 'string')
    .join(' ')
    .toLowerCase();
  const modelIssue = /model.{0,100}(not found|unavailable|unsupported|deprecat|decommission|retir|access|permission|enabled|allowed)|(not found|unavailable|unsupported|deprecat|decommission|retir).{0,100}model/.test(detailText);
  const quotaIssue = /quota|billing|credit|insufficient_quota/.test(detailText);

  if (status === 401)
    return new HttpError(502, 'provider_auth', 'The AI provider rejected the server credentials. The administrator must update the API key.');
  if (status === 403) {
    if (modelIssue) return new HttpError(400, 'model_unavailable', 'This model is not available to the configured provider project.');
    return new HttpError(502, 'provider_access_denied', 'The AI provider denied access to this project or model. Check provider permissions.');
  }
  if (status === 404 || modelIssue)
    return new HttpError(400, 'model_unavailable', 'This model is not available on the configured AI provider.');
  if (status === 429 && quotaIssue)
    return new HttpError(503, 'provider_quota_exceeded', 'The AI provider account has no available quota or billing capacity. Contact the administrator.');
  if (status === 429)
    return new HttpError(429, 'provider_rate_limited', 'The AI provider is rate limiting requests. Please wait a moment and try again.', { retryable: true });
  if (status === 400 || status === 413 || status === 422)
    return new HttpError(400, 'provider_rejected', 'The AI provider could not process this request. Try shortening the conversation.');
  return new HttpError(502, 'provider_unavailable', 'The AI provider is temporarily unavailable. Please try again shortly.', { retryable: true });
}

// ─── Utilities ──────────────────────────────────────────────────────────────
const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        reject(new HttpError(499, 'aborted', 'Request cancelled.'));
      },
      { once: true },
    );
  });

const clip = (s = '', n = 600) => {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const hostOf = (url = '') => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** Creates an AbortController that follows a parent signal and has its own timer. */
function linkedController(parent, timeoutMs) {
  const ctrl = new AbortController();
  const state = { timedOut: false };
  const relay = () => ctrl.abort();
  if (parent) {
    if (parent.aborted) ctrl.abort();
    else parent.addEventListener('abort', relay, { once: true });
  }
  let timer = null;
  const arm = (ms = timeoutMs) => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.timedOut = true;
      ctrl.abort();
    }, ms);
  };
  if (timeoutMs) arm();
  const dispose = () => {
    clearTimeout(timer);
    parent?.removeEventListener('abort', relay);
  };
  return { ctrl, state, arm, dispose };
}

/** fetch() with timeout, cancellation and JSON/text parsing for tool providers. */
async function fetchData(url, { signal, timeout = LIMITS.toolTimeoutMs, as = 'json', ...init } = {}) {
  const link = linkedController(signal, timeout);
  try {
    const res = await fetch(url, { ...init, signal: link.ctrl.signal });
    if (res.status === 429) throw new HttpError(503, 'tool_rate_limited', 'Provider rate limit reached — try again in a minute');
    if (!res.ok) throw new HttpError(502, 'tool_http', `Provider responded with HTTP ${res.status}`);
    if (as === 'text') return await res.text();
    try {
      return await res.json();
    } catch {
      throw new HttpError(502, 'tool_malformed', 'Provider returned malformed data');
    }
  } catch (e) {
    if (link.state.timedOut) throw new HttpError(504, 'tool_timeout', 'Provider timed out');
    if (signal?.aborted) throw new HttpError(499, 'aborted', 'Request cancelled.');
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, 'tool_network', 'Provider could not be reached');
  } finally {
    link.dispose();
  }
}

// ─── Model availability (verified against the provider) ─────────────────────
const modelCache = { at: 0, ids: null, error: null, failedAt: 0 };
const MODEL_TTL_MS = 10 * 60 * 1000;
const MODEL_FAILURE_TTL_MS = 30 * 1000; // avoid hammering the provider when it is down

async function getProviderModelIds() {
  if (!LLM.apiKey) return { ids: null, error: 'not_configured' };
  if (modelCache.ids && Date.now() - modelCache.at < MODEL_TTL_MS) return { ids: modelCache.ids, error: null };
  if (!modelCache.ids && Date.now() - modelCache.failedAt < MODEL_FAILURE_TTL_MS) return { ids: null, error: 'unverified' };
  try {
    const data = await fetchData(`${LLM.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${LLM.apiKey}` },
      timeout: 8000,
    });
    const ids = new Set((data?.data || []).map((m) => m.id).filter(Boolean));
    // Some providers list models as "models/<id>".
    [...ids].forEach((id) => id.startsWith('models/') && ids.add(id.slice(7)));
    Object.assign(modelCache, { at: Date.now(), ids, error: null });
    return { ids, error: null };
  } catch (e) {
    modelCache.error = e.code || 'unreachable';
    modelCache.failedAt = Date.now();
    return { ids: null, error: 'unverified' };
  }
}

async function listModels() {
  const { ids, error } = await getProviderModelIds();
  return MODEL_CATALOG.map((m) => {
    let available = false;
    let reason = null;
    if (error === 'not_configured') reason = 'Provider API key is not configured on the server.';
    else if (!ids) reason = 'Model availability could not be verified with the provider.';
    else if (ids.has(m.providerModel)) available = true;
    else reason = `${LLM.name} does not offer ${m.providerModel}.`;
    return { id: m.id, label: m.label, category: m.category, provider: LLM.name, available, verified: !!ids, reason };
  });
}

async function resolveModel(id) {
  const model = MODEL_CATALOG.find((m) => m.id === id);
  if (!model) throw new HttpError(400, 'invalid_model', 'Unknown model. Choose one of the listed models.');
  if (!LLM.apiKey) throw new HttpError(503, 'provider_not_configured', 'The AI provider is not configured on the server yet.');
  const { ids } = await getProviderModelIds();
  // If availability could not be verified we still try; provider errors are mapped safely.
  if (ids && !ids.has(model.providerModel))
    throw new HttpError(400, 'model_unavailable', `${model.label} is not available on ${LLM.name}.`);
  return model;
}

// ─── Request validation ─────────────────────────────────────────────────────
function validateChatBody(body) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'invalid_request', 'Request body must be JSON.');
  const { model, messages, tools = 'auto', timezone } = body;
  if (typeof model !== 'string' || !model) throw new HttpError(400, 'invalid_request', 'A model is required.');
  if (!Array.isArray(messages) || messages.length === 0)
    throw new HttpError(400, 'invalid_request', 'At least one message is required.');
  if (messages.length > LIMITS.maxMessages)
    throw new HttpError(400, 'invalid_request', `Send at most ${LIMITS.maxMessages} messages.`);
  let total = 0;
  const clean = messages.map((m) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string')
      throw new HttpError(400, 'invalid_request', 'Each message needs a role (user|assistant) and text content.');
    const content = m.content.trim();
    if (!content) throw new HttpError(400, 'invalid_request', 'Messages cannot be empty.');
    if (content.length > LIMITS.maxMessageChars)
      throw new HttpError(400, 'invalid_request', `Messages are limited to ${LIMITS.maxMessageChars} characters.`);
    total += content.length;
    return { role: m.role, content };
  });
  if (total > LIMITS.maxTotalChars) throw new HttpError(400, 'invalid_request', 'The conversation is too long. Start a new chat.');
  if (clean[clean.length - 1].role !== 'user')
    throw new HttpError(400, 'invalid_request', 'The last message must come from the user.');
  if (tools !== 'auto' && tools !== 'on' && tools !== 'off') throw new HttpError(400, 'invalid_request', 'tools must be "auto", "on", or "off".');
  let tz = null;
  if (typeof timezone === 'string' && timezone.length < 64) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: timezone });
      tz = timezone;
    } catch {
      tz = null;
    }
  }
  return { modelId: model, messages: clean, toolsMode: tools === 'off' ? 'off' : 'auto', timezone: tz };
}

// ─── Intent detection (decides which live tools to run) ─────────────────────
const RX = {
  weather: /\b(weather|temperature|forecast|humidity|rain(?:ing)?|snow(?:ing)?|sunny|windy)\b/i,
  news: /\b(news|headlines?|breaking|what'?s happening|latest on|updates? on)\b/i,
  recency:
    /\b(latest|today|tonight|yesterday|right now|currently|current|recent(?:ly)?|this (?:week|month|year)|live|score|results?|released?|launch(?:ed)?|trending|stock price|share price)\b|\b20(?:2[5-9]|3\d)\b/i,
  factual: /^(who|what|when|where|which|how (?:much|many|old|tall|far))\b/i,
  explicitSearch:
    /\b(?:search\s+(?:for\b|(?:(?:the|on(?:\s+the)?)\s+)?(?:web|internet|online|google)\b)|browse\s+(?:(?:the|on(?:\s+the)?)\s+)?(?:web|internet|online)\b|look\s+(?:(?:this|that|it)\s+)?up\s+(?:online|on\s+(?:the\s+)?(?:web|internet|google))\b|find\s+(?:information|info|results?|sources?)\s+(?:online|on\s+(?:the\s+)?(?:web|internet|google))\b)/i,
  negatedSearch: /\b(?:don't|dont|do not|never|avoid|without)\b.{0,24}\b(?:search|browse|look\s+up)\b/i,
  creative: /\b(write|rewrite|code|script|function|debug|fix|poem|story|essay|translate|summari[sz]e|email|letter|joke|regex|plan|workout)\b/i,
  chit: /^(hi+|hello|hey+|thanks?|thank you|ok(?:ay)?|cool|bye|good (?:morning|night|evening))[\s!.?]*$/i,
};

const CITY_STOP = new Set(
  "what whats what's is the how hows how's tell me current today todays today's check show get like a of in at for please weather temperature forecast now right next days day search browse online internet google web".split(
    ' ',
  ),
);

function extractCity(text) {
  let city = '';
  const endOfCity = /(?=\s+(?:today|tomorrow|now|tonight|right\s+now|this\s+(?:week|month|year)|and|over|for|weather|temperature|forecast|search|browse|online|internet|google|web|please)\b|[?.!,;]|$)/i;
  const patterns = [
    new RegExp(`\\b(?:weather|temperature|forecast)\\s+(?:in|at|for|of)\\s+([A-Za-z][A-Za-z .'-]{1,60}?)${endOfCity.source}`, 'i'),
    new RegExp(`\\b(?:in|at|for|of)\\s+([A-Za-z][A-Za-z .'-]{1,60}?)${endOfCity.source}`, 'i'),
    /^([A-Za-z .'-]{2,40}?)\s+(?:weather|temperature|forecast)\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      city = match[1];
      break;
    }
  }
  city = city
    .split(/\s+/)
    .filter((w) => w && !CITY_STOP.has(w.toLowerCase()))
    .join(' ')
    .trim();
  return city || null;
}

const FX_CODES = new Set(
  'USD EUR GBP INR JPY AUD CAD CNY AED SGD CHF SAR PKR BDT NZD ZAR KRW THB MYR IDR TRY BRL MXN NPR LKR QAR KWD HKD SEK NOK DKK PLN PHP EGP NGN'.split(
    ' ',
  ),
);
const FX_WORDS = { dollar: 'USD', dollars: 'USD', euro: 'EUR', euros: 'EUR', pound: 'GBP', pounds: 'GBP', yen: 'JPY', rupee: 'INR', rupees: 'INR', dirham: 'AED' };

function detectCurrency(text) {
  const m = text.match(/(\d[\d,]*(?:\.\d+)?)?\s*\b([a-z]{3,7})\b\s*(?:to|in|into|=|->|vs)\s*\b([a-z]{3,7})\b/i);
  if (!m) return null;
  const norm = (w) => FX_WORDS[w.toLowerCase()] || w.toUpperCase();
  const from = norm(m[2]);
  const to = norm(m[3]);
  if (!FX_CODES.has(from) || !FX_CODES.has(to) || from === to) return null;
  const amount = parseFloat((m[1] || '1').replace(/,/g, '')) || 1;
  return { from, to, amount };
}

const COINS = {
  bitcoin: 'bitcoin', btc: 'bitcoin', ethereum: 'ethereum', eth: 'ethereum', solana: 'solana', sol: 'solana',
  dogecoin: 'dogecoin', doge: 'dogecoin', xrp: 'ripple', ripple: 'ripple', bnb: 'binancecoin', cardano: 'cardano',
  ada: 'cardano', litecoin: 'litecoin', ltc: 'litecoin', toncoin: 'the-open-network', ton: 'the-open-network',
  polkadot: 'polkadot', dot: 'polkadot', avalanche: 'avalanche-2', avax: 'avalanche-2', tron: 'tron', trx: 'tron',
};
const COIN_META = {
  bitcoin: ['BTC', 'Bitcoin'], ethereum: ['ETH', 'Ethereum'], solana: ['SOL', 'Solana'], dogecoin: ['DOGE', 'Dogecoin'],
  ripple: ['XRP', 'XRP'], binancecoin: ['BNB', 'BNB'], cardano: ['ADA', 'Cardano'], litecoin: ['LTC', 'Litecoin'],
  'the-open-network': ['TON', 'Toncoin'], polkadot: ['DOT', 'Polkadot'], 'avalanche-2': ['AVAX', 'Avalanche'], tron: ['TRX', 'TRON'],
};

function detectCrypto(text) {
  const t = text.toLowerCase();
  const ids = new Set();
  (t.match(/[a-z]+/g) || []).forEach((w) => COINS[w] && ids.add(COINS[w]));
  const markety = /\b(crypto|price|prices|market|worth|trading|value|rate|snapshot)\b/.test(t);
  if (!ids.size && /\bcrypto(currency|currencies)?\b/.test(t) && markety) ['bitcoin', 'ethereum', 'solana'].forEach((i) => ids.add(i));
  if (!ids.size || !markety) return [];
  return [...ids].slice(0, 6);
}

function planTools(messages, toolsMode) {
  const users = messages.filter((m) => m.role === 'user');
  const last = users[users.length - 1]?.content || '';
  const prev = users[users.length - 2]?.content || '';
  const plan = { weather: null, weatherMissingCity: false, currency: null, crypto: [], news: null, search: null };
  if (toolsMode === 'off' || RX.chit.test(last)) return plan;
  const explicitSearch = RX.explicitSearch.test(last) && !RX.negatedSearch.test(last);

  // Short follow-ups ("and in Paris?") borrow context from the previous question.
  const isShort = last.split(/\s+/).length < 4;
  const query = isShort && prev ? `${clip(prev, 160)} ${last}` : last;

  if (RX.weather.test(query) && !RX.creative.test(last) && !explicitSearch) {
    const city = extractCity(last) || (isShort ? extractCity(prev) : null);
    if (city) plan.weather = city;
    else plan.weatherMissingCity = true;
  }
  plan.currency = detectCurrency(last);
  plan.crypto = detectCrypto(query);
  const instant = plan.weather || plan.weatherMissingCity || plan.currency || plan.crypto.length;
  const isNews = RX.news.test(last);
  if (isNews) plan.news = clip(query, 200);
  const recency = RX.recency.test(last);
  const factual = RX.factual.test(last) && last.split(/\s+/).length <= 12 && !RX.creative.test(last);
  if (explicitSearch || (!instant && (recency || factual || isNews)))
    plan.search = { query: clip(query, 380), topic: isNews ? 'news' : 'general', factual, explicit: explicitSearch };
  return plan;
}

// ─── Live data providers ────────────────────────────────────────────────────
const WMO = {
  0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Depositing rime fog',
  51: 'Light drizzle', 53: 'Drizzle', 55: 'Dense drizzle', 56: 'Freezing drizzle', 57: 'Freezing drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain', 71: 'Light snow',
  73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Rain showers', 81: 'Rain showers', 82: 'Violent rain showers',
  85: 'Snow showers', 86: 'Heavy snow showers', 95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with hail',
};

/** Open-Meteo (keyless) — real current conditions + 3-day forecast. */
async function getWeather(location, signal) {
  const name = typeof location === 'string' ? location.trim() : '';
  if (!name || name.length > 100) throw new HttpError(400, 'invalid_request', 'A location (max 100 characters) is required.');
  const geo = await fetchData(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`,
    { signal },
  );
  const place = geo?.results?.[0];
  if (!place) throw new HttpError(404, 'location_not_found', `Could not find a location named "${clip(name, 60)}".`);
  const w = await fetchData(
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      '&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max' +
      '&timezone=auto&forecast_days=4',
    { signal },
  );
  const c = w?.current;
  const d = w?.daily;
  if (!c || !d?.time) throw new HttpError(502, 'tool_malformed', 'Weather provider returned malformed data');
  return {
    location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    timezone: w.timezone,
    current: {
      time: c.time,
      temperatureC: Math.round(c.temperature_2m),
      apparentC: Math.round(c.apparent_temperature),
      humidity: c.relative_humidity_2m,
      windKph: Math.round(c.wind_speed_10m),
      description: WMO[c.weather_code] || 'Unknown',
    },
    daily: d.time.map((date, i) => ({
      date,
      description: WMO[d.weather_code[i]] || 'Unknown',
      minC: Math.round(d.temperature_2m_min[i]),
      maxC: Math.round(d.temperature_2m_max[i]),
      precipProb: d.precipitation_probability_max?.[i] ?? null,
    })),
    provider: 'Open-Meteo',
    providerUrl: 'https://open-meteo.com',
    retrievedAt: new Date().toISOString(),
  };
}

/** open.er-api.com (keyless) — real exchange rates with publication timestamp. */
async function getCurrency({ from, to, amount = 1 }, signal) {
  const f = String(from || '').toUpperCase();
  const t = String(to || '').toUpperCase();
  const a = Number(amount);
  if (!/^[A-Z]{3}$/.test(f) || !/^[A-Z]{3}$/.test(t)) throw new HttpError(400, 'invalid_request', 'Use 3-letter currency codes, e.g. USD.');
  if (!Number.isFinite(a) || a <= 0 || a > 1e12) throw new HttpError(400, 'invalid_request', 'Amount must be a positive number.');
  const d = await fetchData(`https://open.er-api.com/v6/latest/${f}`, { signal });
  const rate = d?.rates?.[t];
  if (d?.result !== 'success' || typeof rate !== 'number')
    throw new HttpError(404, 'rate_unavailable', `No exchange rate is available for ${f} → ${t}.`);
  return {
    from: f,
    to: t,
    amount: a,
    rate,
    result: Math.round(a * rate * 10000) / 10000,
    lastUpdated: d.time_last_update_utc,
    nextUpdate: d.time_next_update_utc,
    provider: 'ExchangeRate-API',
    providerUrl: 'https://www.exchangerate-api.com',
    retrievedAt: new Date().toISOString(),
  };
}

/** CoinGecko — real spot prices, 24h change and market timestamps. */
async function getCrypto(assets, signal) {
  const ids = [...new Set((assets || []).map((a) => COINS[String(a).toLowerCase()] || String(a).toLowerCase()))]
    .filter((id) => /^[a-z0-9-]{2,40}$/.test(id))
    .slice(0, 10);
  if (!ids.length) throw new HttpError(400, 'invalid_request', 'Provide at least one asset, e.g. ["btc","eth"].');
  const headers = KEYS.coingecko ? { 'x-cg-demo-api-key': KEYS.coingecko } : {};
  const d = await fetchData(
    `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`,
    { signal, headers },
  );
  const list = ids
    .filter((id) => d?.[id] && typeof d[id].usd === 'number')
    .map((id) => ({
      id,
      symbol: COIN_META[id]?.[0] || id.toUpperCase(),
      name: COIN_META[id]?.[1] || id,
      priceUsd: d[id].usd,
      change24h: typeof d[id].usd_24h_change === 'number' ? d[id].usd_24h_change : null,
      lastUpdatedAt: d[id].last_updated_at ? new Date(d[id].last_updated_at * 1000).toISOString() : null,
    }));
  if (!list.length) throw new HttpError(404, 'market_unavailable', 'Market data is unavailable for the requested assets.');
  return {
    assets: list,
    unavailable: ids.filter((id) => !list.some((x) => x.id === id)),
    provider: 'CoinGecko',
    providerUrl: 'https://www.coingecko.com',
    retrievedAt: new Date().toISOString(),
  };
}

function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '');
}

/** Google News RSS (keyless) — real headlines with source and publication date. */
async function getNews(query, signal) {
  if (query != null && typeof query !== 'string') throw new HttpError(400, 'invalid_request', 'query must be a string.');
  const q = String(query || '').trim();
  if (q.length > 300) throw new HttpError(400, 'invalid_request', 'query is limited to 300 characters.');
  const generic = !q || /^(the )?(latest|top|today'?s?|breaking)?\s*(news|headlines)( today)?[?.!]*$/i.test(q);
  const loc = `hl=${NEWS_LOCALE.hl}&gl=${NEWS_LOCALE.gl}&ceid=${encodeURIComponent(NEWS_LOCALE.ceid)}`;
  const url = generic
    ? `https://news.google.com/rss?${loc}`
    : `https://news.google.com/rss/search?q=${encodeURIComponent(`${q} when:3d`)}&${loc}`;
  const xml = await fetchData(url, { signal, as: 'text' });
  const articles = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) && articles.length < 6) {
    const block = m[1];
    const tag = (t) => {
      const x = block.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`));
      return x ? decodeEntities(x[1]).trim() : '';
    };
    let title = tag('title');
    let source = tag('source');
    const cut = title.lastIndexOf(' - ');
    if (cut > 0) {
      if (!source) source = title.slice(cut + 3);
      title = title.slice(0, cut);
    }
    const link = tag('link');
    const pub = tag('pubDate');
    if (title && /^https?:\/\//.test(link))
      articles.push({ title, url: link, source: source || 'Google News', publishedAt: pub ? new Date(pub).toISOString() : null });
  }
  if (!articles.length) throw new HttpError(404, 'no_results', 'No recent news articles were found.');
  return { query: generic ? null : q, articles, provider: 'Google News', providerUrl: 'https://news.google.com', retrievedAt: new Date().toISOString() };
}

/** Tavily web search (needs TAVILY_API_KEY). */
async function getSearch({ query, topic = 'general', maxResults = 5 }, signal) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q || q.length > 500) throw new HttpError(400, 'invalid_request', 'A search query (max 500 characters) is required.');
  if (!KEYS.tavily) throw new HttpError(503, 'search_not_configured', 'Web search is not configured on the server.');
  const d = await fetchData('https://api.tavily.com/search', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEYS.tavily}` },
    body: JSON.stringify({
      query: clip(q, 380),
      topic: topic === 'news' ? 'news' : 'general',
      search_depth: 'basic',
      max_results: Math.min(Math.max(Number(maxResults) || 5, 1), 8),
    }),
  });
  const results = (d?.results || [])
    .filter((r) => r?.url && r?.title)
    .map((r) => ({ title: clip(r.title, 140), url: r.url, domain: hostOf(r.url), snippet: clip(r.content, 500), publishedAt: r.published_date || null }));
  if (!results.length) throw new HttpError(404, 'no_results', 'The web search returned no results.');
  return { query: q, results, provider: 'Tavily', providerUrl: 'https://tavily.com', retrievedAt: new Date().toISOString() };
}

/** Wikipedia (keyless) — factual fallback when web search is not configured. */
async function getWikipedia(query, signal) {
  const clean = String(query)
    .replace(/^(who|what|when|where|which|how)\s+(is|are|was|were|does|do|did)?\s*/i, '')
    .replace(/[?!.]+$/, '');
  const d = await fetchData(
    `https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(clean)}` +
      '&gsrlimit=2&prop=extracts%7Cinfo&exintro=1&explaintext=1&exchars=700&inprop=url&format=json&origin=*',
    { signal, headers: { 'User-Agent': 'LumoraAI/1.0 (backend proxy)' } },
  );
  const pages = Object.values(d?.query?.pages || {}).sort((a, b) => a.index - b.index);
  const results = pages
    .filter((p) => p.extract && p.fullurl)
    .map((p) => ({ title: `${p.title} — Wikipedia`, url: p.fullurl, domain: 'wikipedia.org', snippet: clip(p.extract, 600) }));
  if (!results.length) throw new HttpError(404, 'no_results', 'No encyclopedia entries were found.');
  return { query: clean, results, provider: 'Wikipedia', providerUrl: 'https://wikipedia.org', retrievedAt: new Date().toISOString() };
}

const TOOL_LABEL = { weather: 'Live weather', currency: 'Exchange rates', crypto: 'Crypto market data', news: 'News', search: 'Web search' };

/** Runs planned tools in parallel and returns normalized cards, numbered sources and errors. */
async function runTools(plan, signal, onStatus) {
  const jobs = [];
  const errors = [];
  if (plan.weatherMissingCity) errors.push({ type: 'weather', message: 'No location was given, so live weather was not fetched.' });
  if (plan.weather) jobs.push(['weather', () => getWeather(plan.weather, signal)]);
  if (plan.currency) jobs.push(['currency', () => getCurrency(plan.currency, signal)]);
  if (plan.crypto.length) jobs.push(['crypto', () => getCrypto(plan.crypto, signal)]);
  if (plan.news) jobs.push(['news', () => getNews(plan.news, signal)]);
  if (plan.search) {
    jobs.push([
      'search',
      async () => {
        try {
          return await getSearch(plan.search, signal);
        } catch (e) {
          if (e.code === 'aborted' || plan.search.explicit || !plan.search.factual) throw e;
          return getWikipedia(plan.search.query, signal);
        }
      },
    ]);
  }
  if (!jobs.length) return { tools: [], sources: [], toolErrors: errors, attempted: errors.length > 0 };

  onStatus?.(
    plan.weather ? 'Checking live weather…'
      : plan.currency ? 'Fetching exchange rates…'
        : plan.crypto.length ? 'Fetching live market prices…'
          : plan.news ? 'Scanning the latest headlines…'
            : 'Searching the web…',
  );

  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  if (signal?.aborted) throw new HttpError(499, 'aborted', 'Request cancelled.');

  const tools = [];
  const sources = [];
  const addSource = (title, url, domain) => {
    if (!url || sources.some((s) => s.url === url) || sources.length >= 8) return null;
    const n = sources.length + 1;
    sources.push({ n, title, url, domain: domain || hostOf(url) });
    return n;
  };

  settled.forEach((r, i) => {
    const type = jobs[i][0];
    if (r.status === 'rejected') {
      const e = r.reason;
      const safe = e instanceof HttpError && (e.status < 500 || e.code === 'search_not_configured') ? e.message : 'the provider could not be reached';
      errors.push({ type, message: `${TOOL_LABEL[type]} could not be retrieved: ${safe}` });
      return;
    }
    const data = r.value;
    if (type === 'news') data.articles.forEach((a) => (a.n = addSource(a.title, a.url, a.source)));
    else if (type === 'search') data.results.forEach((x) => (x.n = addSource(x.title, x.url, x.domain)));
    else data.n = addSource(`${TOOL_LABEL[type]} — ${data.provider}`, data.providerUrl, hostOf(data.providerUrl));
    tools.push({ type, data });
  });
  return { tools, sources, toolErrors: errors, attempted: true };
}

function toolContext(live) {
  const blocks = [];
  for (const { type, data } of live.tools) {
    if (type === 'weather') {
      const c = data.current;
      const days = data.daily.map((d) => `${d.date}: ${d.description}, ${d.minC}–${d.maxC}°C, precip ${d.precipProb ?? '?'}%`).join('; ');
      blocks.push(
        `[${data.n}] WEATHER (${data.provider}, local time ${c.time}, ${data.location}): ${c.temperatureC}°C (feels ${c.apparentC}°C), ${c.description}, humidity ${c.humidity}%, wind ${c.windKph} km/h. Forecast: ${days}`,
      );
    } else if (type === 'currency') {
      blocks.push(
        `[${data.n}] EXCHANGE RATE (${data.provider}, last updated ${data.lastUpdated}): 1 ${data.from} = ${data.rate} ${data.to}; ${data.amount} ${data.from} = ${data.result} ${data.to}`,
      );
    } else if (type === 'crypto') {
      const rows = data.assets
        .map((a) => `${a.symbol} $${a.priceUsd}${a.change24h == null ? '' : ` (24h ${a.change24h.toFixed(2)}%)`} as of ${a.lastUpdatedAt || 'unknown'}`)
        .join('; ');
      blocks.push(`[${data.n}] CRYPTO (${data.provider}): ${rows}${data.unavailable.length ? `. Unavailable: ${data.unavailable.join(', ')}` : ''}`);
    } else if (type === 'news') {
      data.articles.forEach((a) => a.n && blocks.push(`[${a.n}] NEWS: ${a.title} — ${a.source}${a.publishedAt ? ` (${a.publishedAt})` : ''}`));
    } else if (type === 'search') {
      data.results.forEach((r) => r.n && blocks.push(`[${r.n}] ${r.title} — ${r.domain}\n${r.snippet}`));
    }
  }
  return blocks.join('\n\n');
}

function buildSystemPrompt(live, timezone, model) {
  let now = new Date().toUTCString();
  try {
    now = new Date().toLocaleString('en-US', {
      timeZone: timezone || 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    });
  } catch {
    /* keep UTC */
  }
  const parts = [
    'You are Lumora AI, the conversational assistant in the Lumora AI application.',
    `IDENTITY: Abdul Qadir created Lumora AI as an AI application project. He is an undergraduate student in Applied AI and Data Science at IIT Jodhpur, India. The backend uses Node.js and Express, and the mobile app uses React Native and Expo. Lumora supports conversational AI, code generation, model selection, and live weather integration. The configured AI inference provider is ${LLM.name}; the actual model generating this response is ${model.providerModel}. Keep these identities distinct: Abdul is the creator, Lumora AI is the application, ${LLM.name} is the provider, and ${model.providerModel} is the model. Never claim Lumora was developed by OpenAI or that it is ChatGPT/GPT-4. Do not invent Abdul's employment, awards, affiliations, or achievements, or overstate the project's maturity.`,
    'IDENTITY ANSWERS: Answer questions such as "Who built you?", "Who created Lumora?", "Tell me about your creator", "Who are you?", and "What is Lumora AI?" accurately and consistently. For creator questions, identify Abdul Qadir as the creator and describe his studies; keep "Who built you?" responses professional and approximately 70–110 words. Describe Lumora as Abdul’s AI application project, mentioning its stack and capabilities when useful. For "Who are you?", use a shorter answer focused on Lumora itself.',
    `Current date/time for the user: ${now}.`,
    'RESPONSE STYLE: Answer simple questions directly and concisely. Give explanations enough detail to be useful without repeating points. Structure complex technical answers with clear headings or short lists. On mobile, prefer sections or lists to wide tables; use tables when a compact comparison genuinely improves clarity. Give detailed step-by-step guidance when requested. Never omit accuracy caveats or important safety information for brevity. Use readable Markdown and fenced code blocks where useful; do not emit raw HTML.',
    'Never invent real-time facts (prices, weather, scores, news, rates). If you do not have live data for something time-sensitive, say so plainly.',
  ];
  const ctx = toolContext(live);
  if (ctx) {
    parts.push(
      `LIVE DATA (retrieved by the server moments ago from real providers):\n${ctx}`,
      'Use this live data for anything time-sensitive and cite it inline as [n] right after the claim. Only cite numbers that appear above. Mention data timestamps when relevant.',
    );
  }
  if (live.toolErrors.length) {
    parts.push(
      `LIVE DATA FAILURES:\n${live.toolErrors.map((e) => `- ${e.message}`).join('\n')}\nTell the user clearly which live data could not be retrieved. Do not guess those values. If a location is missing, ask for it.`,
    );
  }
  if (live.tools.some((tool) => tool.type === 'weather') || live.toolErrors.some((error) => error.type === 'weather')) {
    parts.push(
      'WEATHER RESPONSE RULES: The server weather result is authoritative. If LIVE DATA contains a [n] WEATHER record, the lookup succeeded for the printed location. State that location, summarize only the returned values, and cite its [n]. Never say that no location was given or that weather was not fetched when a WEATHER record is present. If LIVE DATA FAILURES contains a weather error, say the live lookup failed and do not provide current conditions or cite a successful weather source. If no location was given, ask the user which city to check. Never infer a location from unrelated search instructions or silently substitute a default city.',
    );
  }
  return parts.join('\n\n');
}

function providerBody(model, messages, live, timezone, stream) {
  const body = {
    model: model.providerModel,
    messages: [{ role: 'system', content: buildSystemPrompt(live, timezone, model) }, ...messages],
    temperature: model.temperature ?? 0.6,
    max_tokens: LIMITS.maxTokens,
    stream,
  };
  if (model.topP !== undefined) body.top_p = model.topP;
  if (LLM.isGroq && model.reasoningEffort) {
    body.reasoning_effort = model.reasoningEffort;
    if (model.reasoningFormat) body.reasoning_format = model.reasoningFormat;
    else body.include_reasoning = false;
  }
  return body;
}

/** Opens a provider request with exponential-backoff retries (only before any output). */
async function openProvider(body, signal) {
  let lastErr;
  for (let attempt = 0; attempt <= LIMITS.upstreamRetries; attempt++) {
    const link = linkedController(signal, LIMITS.llmConnectTimeoutMs);
    try {
      const res = await fetch(`${LLM.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${LLM.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: link.ctrl.signal,
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw providerError(res.status, payload);
      }
      return { res, link };
    } catch (e) {
      link.dispose();
      if (signal?.aborted) throw new HttpError(499, 'aborted', 'Request cancelled.');
      lastErr = link.state.timedOut
        ? new HttpError(504, 'upstream_timeout', 'The AI provider took too long to respond.', { retryable: true })
        : e instanceof HttpError
          ? e
          : new HttpError(502, 'provider_unreachable', 'The AI provider could not be reached.', { retryable: true });
      if (!lastErr.retryable || attempt === LIMITS.upstreamRetries) throw lastErr;
      await sleep(Math.min(4000, 500 * 2 ** attempt) + Math.random() * 250, signal);
    }
  }
  throw lastErr;
}

// ─── Express app ────────────────────────────────────────────────────────────
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.use(helmet());

// CORS: the native app does not need CORS. Browsers are denied by default; set
// CORS_ORIGINS (comma-separated, exact origins) only if a web client must call the API.
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && CORS_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Max-Age', '600');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(origin && CORS_ORIGINS.has(origin) ? 204 : 403);
  next();
});

// HTTPS is taken from the socket or from a configured trusted proxy only.
app.use((req, res, next) => {
  if (REQUIRE_SECURE_CONFIG) {
    const forwardedProto = (req.get('x-forwarded-proto') || '').trim().toLowerCase();
    const forwardedProtoInvalid = !req.socket.encrypted && forwardedProto && forwardedProto !== 'https';
    const secureViaRender = TRUST_RENDER_HTTPS && forwardedProto === 'https';
    if ((!req.secure && !secureViaRender) || forwardedProtoInvalid)
      return sendError(res, new HttpError(403, 'https_required', 'HTTPS is required.'));
  }
  next();
});

function hasValidClientToken(req) {
  if (!CLIENT_TOKENS.length) return allowUnauthenticatedLocalDev;
  const header = req.get('authorization') || '';
  const token = /^Bearer ([^\s,]+)$/i.exec(header)?.[1] || '';
  const given = Buffer.from(token);
  return CLIENT_TOKENS.some((t) => {
    const expected = Buffer.from(t);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
  });
}

function auth(req, res, next) {
  if (!hasValidClientToken(req)) return sendError(res, new HttpError(401, 'unauthorized', 'Missing or invalid client token.'));
  next();
}

const limiter = (max) =>
  rateLimit({
    windowMs: 60 * 1000,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (req, res) => sendError(res, new HttpError(429, 'rate_limited', 'Too many requests. Please slow down for a moment.')),
  });
// Applies to every /api request, before authentication, so invalid-token floods are throttled too.
const apiLimiter = limiter(Number(process.env.API_RATE_PER_MIN) || 120);
app.use('/api', apiLimiter);
// API access defaults to authenticated. The only public exception is the
// minimal GET liveness response; readiness details remain token-protected.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' && req.path === '/health') return next();
  return auth(req, res, next);
});
// Parse bodies only after the pre-auth limiter and authentication middleware.
app.use(express.json({ limit: '256kb' }));
const chatLimiter = limiter(Number(process.env.CHAT_RATE_PER_MIN) || 20);
const toolLimiter = limiter(Number(process.env.TOOL_RATE_PER_MIN) || 60);

const asyncRoute = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => sendError(res, e));

// The unauthenticated response is a liveness signal only. The app's authenticated
// settings check also gets provider/tool readiness without disclosing it publicly.
app.get('/api/health', (req, res) => {
  const health = { ok: true };
  if (hasValidClientToken(req)) {
    health.provider = { name: LLM.name, configured: !!LLM.apiKey };
    health.tools = { search: !!KEYS.tavily, news: true, weather: true, crypto: true, currency: true, wikipedia: true };
  }
  res.json(health);
});

app.get('/api/models', asyncRoute(async (req, res) => {
  res.json({ provider: LLM.name, models: await listModels() });
}));

app.post('/api/chat', chatLimiter, asyncRoute(async (req, res) => {
  const input = validateChatBody(req.body);
  const model = await resolveModel(input.modelId);
  const ctrl = new AbortController();
  res.on('close', () => !res.writableEnded && ctrl.abort());
  const live = await runTools(planTools(input.messages, input.toolsMode), ctrl.signal);
  const { res: upstream, link } = await openProvider(providerBody(model, input.messages, live, input.timezone, false), ctrl.signal);
  let data;
  try {
    data = await upstream.json();
  } catch {
    throw new HttpError(502, 'provider_malformed', 'The AI provider returned an unexpected response.');
  } finally {
    link.dispose();
  }
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || !content.trim())
    throw new HttpError(502, 'provider_empty', 'The AI provider returned an empty response.');
  res.json({
    id: data.id || crypto.randomUUID(),
    model: { id: model.id, label: model.label },
    content,
    finishReason: choice.finish_reason || 'stop',
    usage: data.usage || null,
    sources: live.sources,
    tools: live.tools,
    toolErrors: live.toolErrors,
  });
}));

app.post('/api/chat/stream', chatLimiter, async (req, res) => {
  let input;
  let model;
  try {
    input = validateChatBody(req.body);
    model = await resolveModel(input.modelId);
  } catch (e) {
    return sendError(res, e);
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const ctrl = new AbortController();
  const requestId = crypto.randomUUID();
  const send = (event, data) => {
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const heartbeat = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) ctrl.abort(); // client disconnected or pressed Stop
  });

  let link = null;
  let reader = null;
  try {
    send('status', { stage: 'tools', label: 'Understanding your request…' });
    const live = await runTools(planTools(input.messages, input.toolsMode), ctrl.signal, (label) =>
      send('status', { stage: 'tools', label }),
    );
    send('meta', {
      requestId,
      model: { id: model.id, label: model.label, provider: LLM.name },
      sources: live.sources,
      tools: live.tools,
      toolErrors: live.toolErrors,
    });
    send('status', { stage: 'thinking', label: `${model.label} is thinking…` });

    const opened = await openProvider(providerBody(model, input.messages, live, input.timezone, true), ctrl.signal);
    link = opened.link;
    reader = opened.res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = null;
    let usage = null;
    let sawDone = false;

    while (!sawDone) {
      link.arm(LIMITS.llmIdleTimeoutMs);
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          sawDone = true;
          break;
        }
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch {
          continue; // ignore keep-alive or partial vendor lines
        }
        if (chunk.error) throw new HttpError(502, 'provider_stream_error', 'The AI provider reported an error mid-response.');
        const choice = chunk.choices?.[0];
        const token = choice?.delta?.content;
        if (typeof token === 'string' && token) send('token', { t: token });
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage || chunk.x_groq?.usage) usage = chunk.usage || chunk.x_groq.usage;
      }
    }
    if (!sawDone && !finishReason) throw new HttpError(502, 'stream_interrupted', 'The AI provider stream ended unexpectedly.');
    send('done', { requestId, finishReason: finishReason || 'stop', usage });
  } catch (e) {
    if (ctrl.signal.aborted) {
      // Client went away — nothing to send.
    } else {
      let err = e;
      if (link?.state.timedOut) err = new HttpError(504, 'upstream_timeout', 'The AI provider stopped responding.');
      else if (!(e instanceof HttpError)) {
        console.error('[lumora] stream error', e?.name || 'Error');
        err = new HttpError(502, 'stream_interrupted', 'The response stream was interrupted.');
      }
      send('error', { code: err.code, message: err.message, status: err.status });
    }
  } finally {
    clearInterval(heartbeat);
    link?.dispose();
    reader?.cancel().catch(() => {});
    if (!res.writableEnded) res.end();
  }
});

// ─── Direct tool endpoints ──────────────────────────────────────────────────
const toolRoute = (fn) =>
  asyncRoute(async (req, res) => {
    const ctrl = new AbortController();
    res.on('close', () => !res.writableEnded && ctrl.abort());
    res.json({ data: await fn(req.body || {}, ctrl.signal) });
  });

app.post('/api/tools/search', toolLimiter, toolRoute((b, s) => getSearch({ query: b.query, topic: b.topic, maxResults: b.maxResults }, s)));
app.post('/api/tools/news', toolLimiter, toolRoute((b, s) => getNews(b.query, s)));
app.post('/api/tools/weather', toolLimiter, toolRoute((b, s) => getWeather(b.location, s)));
app.post('/api/tools/crypto', toolLimiter, toolRoute((b, s) => getCrypto(Array.isArray(b.assets) ? b.assets : [], s)));
app.post('/api/tools/currency', toolLimiter, toolRoute((b, s) => getCurrency({ from: b.from, to: b.to, amount: b.amount ?? 1 }, s)));

app.use((req, res) => sendError(res, new HttpError(404, 'not_found', 'Endpoint not found.')));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') return sendError(res, new HttpError(400, 'invalid_json', 'Request body is not valid JSON.'));
  if (err?.type === 'entity.too.large') return sendError(res, new HttpError(413, 'payload_too_large', 'Request body is too large.'));
  sendError(res, err);
});

const onListening = () => {
  const endpoint = LISTEN_HOST ? `${LISTEN_HOST}:${PORT}` : `:${PORT}`;
  console.log(`[lumora] backend listening on ${endpoint} (provider: ${LLM.name})`);
};
const server = LISTEN_HOST ? app.listen(PORT, LISTEN_HOST, onListening) : app.listen(PORT, onListening);

// Graceful shutdown for container platforms (SIGTERM on deploy/scale-down).
const shutdown = (signal) => {
  console.log(`[lumora] ${signal} received, closing server`);
  server.close(() => process.exit(0));
  server.closeIdleConnections?.();
  setTimeout(() => process.exit(0), 10000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
