# Lumora AI

A multi-model AI assistant for **iOS and Android**, built with React Native + Expo and a Node.js/Express backend. The backend keeps provider credentials server-side and protects API routes with a bearer client token and rate limits. That token is extractable from a distributed app and is not per-user authentication.

```
lumora/
├── AUDIT.md             Earlier point-in-time production-readiness audit
├── DISTRIBUTION.md      Private distribution: signed APK, TestFlight, ad hoc IPA
├── CONTRIBUTING.md      Local setup, tests and contribution guidelines
├── SECURITY.md          Private vulnerability reporting policy
├── LICENSE              MIT license for project files
├── .github/             CI workflows and issue forms
├── mobile/              Complete Expo SDK 58 project (React Native 0.88, React 19.3)
│   ├── App.js           Complete application (single file)
│   ├── index.js         Entry point (registerRootComponent)
│   ├── app.json         Static production Expo config
│   ├── app.config.js    Preview-only app identity override
│   ├── eas.json         EAS profiles, including production and Preview APKs
│   ├── package.json     Pinned, SDK-matched dependencies + scripts
│   ├── pnpm-lock.yaml   Lockfile (reproducible installs on EAS)
│   ├── assets/          Official Lumora mark (brand/lumora-mark.svg) + generated icons & splash
│   ├── distribution/    TestFlight beta description, feedback & group config
│   ├── scripts/         Release guard, TestFlight (App Store Connect API) tool, brand asset generator
│   ├── __tests__/       Jest integration tests (+ optional e2e)
│   └── .env.example     Public app config
└── backend/             Secure proxy: LLM streaming + live tools
    ├── server.js
    ├── package.json
    ├── test/            node:test integration suite (mock provider)
    └── .env.example     Server environment-variable template (no values)
```

## What lives where

| Capability | Where | Needs |
| --- | --- | --- |
| UI, streaming display, Markdown, history, preferences | `App.js` (device) | none |
| LLM calls (GPT-OSS 20B, GPT-OSS 120B, Qwen 3.8 27B) | backend | `LLM_API_KEY` or `GROQ_API_KEY` |
| Real token streaming (SSE) | backend → `expo/fetch` | backend running |
| Model availability check | backend `GET /api/models` | `LLM_API_KEY` |
| Weather (Open-Meteo through Lumora's Cloudflare Worker relay) | backend | relay URL is configured in backend code |
| Currency (ExchangeRate-API) | backend | none (keyless) |
| Crypto (CoinGecko) | backend | optional `COINGECKO_DEMO_API_KEY` |
| News (Google News RSS) | backend | none (keyless) |
| Web search (Tavily, Wikipedia fallback for facts) | backend | `TAVILY_API_KEY` |

**The app cannot chat without the backend.** That is deliberate: provider keys never ship in the mobile bundle. If a live tool fails or isn't configured, the app shows a warning card and the model is told not to guess.

---

## 1. Backend setup

Requires Node.js 18.17+.

```bash
cd backend
cp .env.example .env          # then fill in LLM_API_KEY (and TAVILY_API_KEY, optional)
npm ci
npm run dev                   # http://localhost:8787
npm test                      # node:test suite; provider calls are mocked
```

Check it: `curl http://localhost:8787/api/health`

### Provider configuration

Groq is the default provider. `LLM_BASE_URL` can point to another OpenAI-compatible Chat Completions endpoint, but alternate providers and model IDs must be configured and verified separately; only models found in the configured provider's model list are available.

| Provider | `LLM_BASE_URL` | Notes |
| --- | --- | --- |
| Groq (default) | `https://api.groq.com/openai/v1` | Default model IDs are configured in the backend; availability may change |
| Other compatible endpoint | Set `LLM_BASE_URL` and the `MODEL_*` mappings | Requires compatible endpoints and model IDs |

### Production checklist

- Deploy behind HTTPS (Render, Fly.io, Railway, Cloud Run, etc.). With `NODE_ENV=production`, the server rejects plain-HTTP forwarded requests.
- Set `NODE_ENV=production` and `LUMORA_CLIENT_TOKENS` (the server won't start without tokens in production). Generate a token with `openssl rand -hex 32`.
- Configure `TRUST_PROXY` only for the actual hosting topology. Production rejects numeric hop counts. For a Render web service, use `TRUST_PROXY=render`; for other proxies, follow `backend/.env.example` and trust only known proxy IP/CIDR ranges. Do not trust arbitrary forwarding headers or use blanket proxy trust.
- Rate limits (per IP, per minute) default to 120 for all `/api` traffic (applied before auth, so token floods are throttled), 20 for chat and 60 for tools (`API_RATE_PER_MIN`, `CHAT_RATE_PER_MIN`, `TOOL_RATE_PER_MIN`). The built-in limiter store is in-memory and per process; do not treat it as a shared quota system when running multiple instances or offering public multi-user access.
- CORS is closed by default; the native app doesn't need it. Set `CORS_ORIGINS` to exact origins only if a browser client must call the API.
- **Client tokens are not user authentication.** Anything inside an app binary can be extracted. For a public launch, put real per-user auth in front of `/api/*` (Clerk, Supabase Auth, Firebase Auth, Auth0, or App Attest / Play Integrity) and verify the user's JWT in the `auth` middleware.

---

## 2. Mobile app setup

`mobile/` is the Expo SDK 58 project. It requires **Node.js 22.13+** (React Native 0.88 requirement).

```bash
cd mobile
corepack enable               # provides pnpm (the committed lockfile is pnpm)
pnpm install --frozen-lockfile
cp .env.example .env          # then edit
npx expo start
```

`npm install` also works, since `package.json` declares the same `overrides`. Dependencies were added with `npx expo install`, so they match SDK 58. Notes:

- `@ronradtke/react-native-markdown-display` is pinned to **8.1.0**, which is pure JS and runs in Expo Go. Version 9.x adds a native vector-icons dependency.
- `markdown-it` is overridden to **^14.1.1**. The fork's default 13.x has published ReDoS advisories, and 13.x also imports Node's `punycode`, which breaks Metro bundling.
- Icons import from `@expo/vector-icons/Ionicons`, so only one icon font ships.
- `expo-system-ui` applies the dark `userInterfaceStyle` and root background, which prevents a white flash on launch.

Quality gates:

```bash
pnpm typecheck                # TypeScript checkJs over App.js
pnpm test                     # Jest integration suite (jest-expo + RNTL)
pnpm doctor                   # Expo config and dependency diagnostics
pnpm export:check             # production Hermes bundles for android + ios
LUMORA_E2E_URL=http://127.0.0.1:8787 pnpm test:e2e   # real backend → real SSE → App.js
```

### Pointing the app at your backend

| Scenario | `EXPO_PUBLIC_LUMORA_API_URL` |
| --- | --- |
| iOS Simulator | `http://localhost:8787` (default in dev if unset) |
| Android Emulator | `http://10.0.2.2:8787` (default in dev if unset) |
| Physical phone + Expo Go | `http://<your-computer-LAN-IP>:8787` |
| Production builds | `https://…` (required, since release builds reject `http://`) |

You can also change the URL at runtime under **Settings → Lumora Backend**, and use **Test connection** to see which tools are configured. Restart Expo (`npx expo start -c`) after editing `.env`.

---

## 3. API contract

Protected endpoints return errors as `{ "error": { "code": string, "message": string } }`. Send `Authorization: Bearer <client token>` on API data routes; the minimal liveness endpoint `GET /api/health` and allowed CORS preflight requests are exceptions. Production requires `LUMORA_CLIENT_TOKENS`; unauthenticated API access is allowed only for development bound to loopback. A shared token in a mobile binary is not a secure user identity.

### `GET /api/health`

Unauthenticated requests receive only `{ "ok": true }`. An authenticated request also reports provider and tool readiness; this endpoint does not expose credentials.

### `GET /api/models` (authenticated)

```json
{ "provider": "Groq",
  "models": [ { "id": "gpt-oss-20b", "label": "GPT-OSS 20B", "category": "Fast reasoning",
                "provider": "Groq", "available": true, "verified": true, "reason": null } ] }
```

### `POST /api/chat/stream` (Server-Sent Events)

Request:

```json
{ "model": "gpt-oss-20b",
  "messages": [ { "role": "user", "content": "Weather in Tokyo?" } ],
  "tools": "auto",
  "timezone": "Asia/Tokyo" }
```

Validation: 1–40 messages, `user` or `assistant` roles only, at most 8,000 characters per message and 48,000 in total, last message from `user`, `tools` set to `auto` or `off`.

Response stream (`text/event-stream`). The server sends a `: ping` comment every 15 seconds.

```
event: status   data: {"stage":"tools","label":"Checking live weather…"}
event: meta     data: {"requestId":"…","model":{"id":"gpt-oss-20b","label":"GPT-OSS 20B"},
                       "sources":[{"n":1,"title":"…","url":"…","domain":"…"}],
                       "tools":[{"type":"weather","data":{…}}],
                       "toolErrors":[{"type":"search","message":"Web search could not be retrieved: …"}]}
event: status   data: {"stage":"thinking","label":"GPT-OSS 20B is thinking…"}
event: token    data: {"t":"Right now in Tokyo"}        (repeated)
event: done     data: {"requestId":"…","finishReason":"stop","usage":{…}}
event: error    data: {"code":"provider_rate_limited","message":"…","status":429}   (instead of done)
```

If the client disconnects (for example, the user taps **Stop**), the backend aborts the upstream LLM request right away.

### `POST /api/chat`

Same request as the stream endpoint. Response:

```json
{ "id": "…", "model": { "id": "…", "label": "…" }, "content": "markdown…", "finishReason": "stop",
  "usage": {…}, "sources": [...], "tools": [...], "toolErrors": [...] }
```

### Tool endpoints (all `POST`, response `{ "data": … }`)

| Endpoint | Body | Returns |
| --- | --- | --- |
| `/api/tools/search` | `{ "query": "…", "topic": "general" \| "news", "maxResults": 5 }` | `results[] { title, url, domain, snippet, publishedAt }` |
| `/api/tools/news` | `{ "query": "…" }` (empty means top headlines) | `articles[] { title, url, source, publishedAt }` |
| `/api/tools/weather` | `{ "location": "London" }` | `location, current { temperatureC, apparentC, humidity, windKph, description, time }, daily[]` |
| `/api/tools/crypto` | `{ "assets": ["btc", "eth"] }` | `assets[] { symbol, name, priceUsd, change24h, lastUpdatedAt }, unavailable[]` |
| `/api/tools/currency` | `{ "from": "USD", "to": "EUR", "amount": 100 }` | `rate, result, lastUpdated` |

### Error codes

| HTTP | code | Meaning |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_json`, `invalid_model`, `model_unavailable`, `provider_rejected` | Bad input or unsupported model |
| 401 | `unauthorized` | Missing or wrong client token |
| 403 | `https_required` | Plain HTTP in production |
| 404 | `not_found`, `location_not_found`, `no_results` | Unknown endpoint or no data |
| 429 | `rate_limited`, `provider_rate_limited` | Slow down (retryable) |
| 502/503/504 | `provider_auth`, `provider_unavailable`, `provider_not_configured`, `upstream_timeout`, `search_not_configured`, `tool_rate_limited` | Upstream problems |

---

## 4. Reliability behavior (client)

- **Real streaming.** Tokens are appended as SSE `token` events arrive, batched every 50 ms so only the streaming bubble re-renders. There is no fake typewriter effect.
- **Retries.** Network errors, timeouts, 408/429/5xx and `Retry-After` all trigger exponential backoff with jitter (3 attempts), but only before the stream opens. Nothing is retried after the user cancels or once tokens have arrived.
- **Timeouts.** 30 s to connect and 60 s idle between chunks (the backend heartbeat keeps healthy streams alive).
- **Cancellation.** Stop, Reset, switching conversations and unmounting all abort through `AbortController`. A generation counter discards late updates from old streams.
- **No duplicates.** A synchronous in-flight lock blocks double sends from rapid taps.
- **Storage.** Writes are debounced and paused while streaming, then saved once at the end. Unchanged conversations are skipped. Corrupted JSON is sanitized or dropped, and a storage failure shows a toast instead of crashing.
- **Backgrounding.** When the app goes to the background, the active conversation is written right away (mid-stream replies are saved as "stopped"), so an OS kill doesn't lose the exchange.

---

## 5. Private distribution with EAS (APK / TestFlight / ad hoc IPA)

The full step-by-step guide, with credentials, commands and tester instructions, is in **[DISTRIBUTION.md](./DISTRIBUTION.md)**. In brief:

| Goal | Command | EAS profile |
| --- | --- | --- |
| Signed Android release APK (internal distribution, no Play Store) | `pnpm build:android:apk` | `android-apk` |
| Separate internal Preview APK (`ai.lumora.app.preview`) | `pnpm build:android:preview` | `android-preview` |
| iOS TestFlight build, uploaded to App Store Connect | `pnpm release:ios:testflight` | `testflight` |
| TestFlight groups, beta info and public link | `pnpm testflight:setup` → `pnpm testflight:distribute` | — |
| Register iPhone UDIDs | `pnpm devices:register` | — |
| iOS ad hoc IPA for registered devices | `pnpm build:ios:adhoc` | `ios-adhoc` |

The production profiles use the production app identity and production EAS environment. The separate `android-preview` profile uses the Preview EAS environment, resolves to app name **Lumora AI Preview** and package `ai.lumora.app.preview`, and produces an internal APK that can be installed beside production (`ai.lumora.app`). `scripts/check-release-env.mjs` runs as an EAS pre-install hook and checks release configuration and secret-like values. Nothing is submitted to Google Play or for public App Store release. A build only counts as successful once EAS reports `finished`.

---

## 6. Platform notes and limitations

- **Keyboard.** iOS uses animated padding from `keyboardWillShow`. On Android (SDK 58 is always edge-to-edge, and prebuild sets `adjustResize`), the app detects whether the OS already resized the window and only adds keyboard padding if it didn't. This hasn't been verified on a physical device yet; see `AUDIT.md`.
- **Safe areas.** `react-native-safe-area-context` handles insets for the notch, Dynamic Island, home indicator, Android gesture bar and landscape side insets.
- **Streaming runtime.** Streaming needs `expo/fetch`. The global RN `fetch` can't stream response bodies.
- **iOS ATS.** Release builds block `http://`. Use HTTPS for the backend, which the app also enforces in non-dev builds.
- **News links.** These are Google News redirect URLs, which open the publisher page in the browser.
- **Search.** Without `TAVILY_API_KEY`, general web search reports "not configured". Short factual questions fall back to Wikipedia, which is labeled as such.
- **Rate limits.** The free CoinGecko and Open-Meteo tiers are rate-limited. When that happens, the app shows a "could not be retrieved" card instead of stale or invented numbers.

## License

Lumora AI's project files are licensed under the MIT License in [LICENSE](./LICENSE), except where a file or third-party component states otherwise. Dependencies retain their respective upstream licenses; see their package metadata and notices when redistributing builds.

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup and pull request guidance. Report security vulnerabilities privately using the process in [SECURITY.md](./SECURITY.md), not in a public issue.
