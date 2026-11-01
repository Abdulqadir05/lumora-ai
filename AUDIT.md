# Lumora AI — Production-Readiness Audit

**Scope:** `lumora/mobile` (Expo app) and `lumora/backend` (Node proxy).
**Environment:** Linux x86_64 container, Node 22, no JDK, no Android SDK, no macOS/Xcode, no emulators or physical devices.

Every result below comes from a command that was actually run. Nothing here claims Android or iOS **device** testing; see [Untested](#3-untested-requires-devices-or-external-accounts).

---

## 1. Passed

### Project structure and dependencies
| Check | Command / method | Result |
| --- | --- | --- |
| Complete Expo project (`package.json`, `index.js`, `app.json`, `eas.json`, `tsconfig.json`, assets, lockfile) | file review + clean install | Pass |
| Reproducible install | `pnpm install --frozen-lockfile` in a fresh copy | Pass |
| SDK version alignment | `npx expo install --check` | "Dependencies are up to date" |
| Project health | `npx expo-doctor@latest` | **20/20 checks passed** |
| Every import resolves to a declared dependency | `App.js` imports compared with `package.json`; Metro export | Pass (react, react-native, expo-status-bar, expo/fetch, async-storage, expo-clipboard, expo-haptics, expo-linear-gradient, @expo/vector-icons/Ionicons, react-native-safe-area-context, markdown fork) |
| Only RN / Expo components (no DOM or web-only APIs) | code review + native bundling | Pass |
| All 52 Ionicons glyph names exist | checked against the installed glyph map | Pass |
| Node engine | RN 0.88 / Expo 58 require Node ^22.13 | `engines` and the EAS image (22.17.0) are set accordingly |

### Static checks and production bundle
| Check | Command | Result |
| --- | --- | --- |
| JavaScript type check | `tsc -p .` (`checkJs` against RN 0.88 + Expo 58 types) | **0 errors** (90 before fixes) |
| Production bundle | `expo export --platform android --platform ios` | Pass: Hermes bytecode, about 2.1 MB per platform |
| Dev-only defaults stripped | grep the release bundle | `localhost:8787` / `10.0.2.2` absent; `EXPO_PUBLIC_LUMORA_API_URL` inlined |
| No provider secrets in bundle | grep the bundle for key formats and key variable names | None. One false-positive match was an Ionicons glyph name |
| Native project generation (what EAS runs) | `expo prebuild --clean --platform all --no-install` | Pass with no warnings. iOS `UIUserInterfaceStyle=Dark` and `ITSAppUsesNonExemptEncryption=false`; Android `adjustResize`, edge-to-edge, New Architecture and Hermes enabled, `#060B16` splash and background |
| Runtime dependency vulnerabilities | `pnpm audit --prod` | No advisories in shipped code. 4 remaining are in Expo CLI build tooling, which never ships (see §2.3) |
| Backend dependency vulnerabilities | `pnpm audit --prod` | No known vulnerabilities |

### Mobile behavior: Jest integration tests (`pnpm test`: 23 passed, 1 e2e skipped by default)
These run the real `App.js` with `jest-expo` and React Native Testing Library. The network, AsyncStorage, the clipboard and native views are mocked.

| Area | Tests |
| --- | --- |
| Layout | Header, LUMORA STUDIO badge, 3-model selector, 5 starter cards, Reset and Settings buttons; starter card sends its prompt |
| SSE streaming | Progressive token rendering, SSE frame split across chunks, status → meta → tokens → done, tool card (weather), source chips, actions hidden while streaming |
| Cancellation | Stop aborts the `AbortController`, calls `reader.cancel()`, keeps partial text, marks the message "Generation stopped", and does **not** retry |
| Reliability | Duplicate taps produce one request; empty messages are ignored; network failure is retried with backoff and then succeeds; 401 isn't retried and shows a friendly message; server `error` event (429) is mapped and partial text kept; stream closed without `done` is flagged as interrupted; malformed SSE JSON shows a safe error |
| Regenerate | Replaces the last answer and resends history up to the last user message |
| Models | Switching changes the `model` field of the next request; an unavailable model can't be selected (shows the provider's reason); a stored unavailable model auto-switches; an unreachable backend shows the offline banner |
| Markdown | Headings, bold, italic, lists, blockquote, table, inline code, link opens via `Linking`, fenced code with language label, Copy code (exact text) with "Copied" feedback, Copy response, unterminated fence while streaming |
| Citations | `[1]` renders as a pressable citation and opens the matching source URL |
| Persistence | Conversation, index and prefs saved; restored after unmount and remount; nothing written mid-stream; Reset mid-stream saves the partial reply as `stopped`; app backgrounding flushes the in-flight chat; corrupted JSON doesn't crash; delete conversation and clear all remove the storage keys |
| Scrolling | A programmatic scroll never detaches auto-follow; a user drag upward shows "Scroll to bottom"; returning to the bottom hides it |

### End-to-end: real backend → real SSE bytes → `App.js`
| Check | Result |
| --- | --- |
| `LUMORA_E2E_URL=… pnpm test:e2e` against the running backend (auth enabled) using the mock provider | Pass. The reply streamed and rendered, and the provider received exactly one request |
| Same test with a wrong client token | Fails as expected; the provider is never called |

### Backend: `npm test` (13/13, real server against a mock OpenAI-compatible provider)
| Area | Result |
| --- | --- |
| Health is public, leaks no key material, sends no `x-powered-by` header | Pass |
| Auth: missing token or wrong token gives 401; valid token gives 200 (timing-safe compare) | Pass |
| CORS: allowlisted origin gets headers; others get none; preflight 204 or 403 | Pass |
| Model availability verified against provider `/models`; unavailable model returns 400 `model_unavailable` | Pass |
| Validation: invalid JSON, empty or system or blank messages, last role not `user`, over 8,000 characters, bad `tools`, unknown model, tool inputs (length, type and NoSQL-style objects), body over 256 KB returns 413, unknown route returns 404 | Pass |
| SSE order status → meta → token → done; timezone reaches the system prompt; Groq-only reasoning params are omitted for other providers | Pass |
| Client disconnect aborts the upstream LLM request | Pass |
| Upstream 401 maps to `provider_auth` with no retry; upstream 500 is retried twice, then reported | Pass |
| Rate limiting returns 429 with standard `RateLimit` headers; the pre-auth limiter throttles invalid-token floods | Pass |
| Production refuses to start without client tokens; rejects plain-HTTP forwarded requests | Pass |

### Live providers (from the backend, earlier in this session)
Open-Meteo weather, ExchangeRate-API rates and Google News RSS returned real data. CoinGecko returned HTTP 429 from this shared IP; that's handled and shown to the user as "could not be retrieved". Tavily search was not configured, and it correctly reported `search_not_configured`.

---

## 2. Failed, then fixed

### 2.1 Critical
| # | Issue | Evidence | Fix |
| --- | --- | --- | --- |
| 1 | **Production bundle failed**: `Unable to resolve module punycode` (markdown-it 13 imports a Node built-in) | `expo export` error | Overrode markdown-it to ^14.1.1, which uses the userland `punycode.js` |
| 2 | **ReDoS advisories in shipped code**: markdown-it 13 (4 advisories) and linkify-it (2 high) parse untrusted model output | `pnpm audit --prod` | Same override; markdown-it 14.3.3 and linkify-it 5.0.2 now have zero runtime advisories |
| 3 | **Data loss on OS kill mid-stream**: saves were paused while streaming, so a backgrounded-then-killed app lost the whole exchange | code review; regression test added | `AppState` listener flushes the active conversation on `background` / `inactive` |
| 4 | **Wrong Node for the SDK**: RN 0.88 / Expo 58 require Node ^22.13 | package `engines` | `engines` updated; EAS `base` profile pins Node 22.17.0 |

### 2.2 High / medium
| # | Issue | Fix |
| --- | --- | --- |
| 5 | `app.json` root `splash` key is invalid in SDK 58 (expo-doctor schema failure) | Moved to the `expo-splash-screen` config plugin with image and background |
| 6 | `expo-font` (a required peer of `@expo/vector-icons`) was missing, a likely crash outside Expo Go | Installed and added the plugin |
| 7 | `userInterfaceStyle: "dark"` was silently ignored (prebuild produced `Automatic`), risking a white launch flash | Installed `expo-system-ui`; iOS and Android background `#060B16` |
| 8 | Markdown fork v9 (latest) adds a native vector-icons dependency | Pinned the pure-JS 8.1.0 (verified React 19 safe: no `defaultProps`, `MarkdownIt` export, rule signatures match) |
| 9 | Every icon font shipped (about 4 MB of assets) | `import Ionicons from '@expo/vector-icons/Ionicons'`; bundle went from 2.3 MB to about 2.1 MB with only one font |
| 10 | Bottom sheets on Android edge-to-edge: Modal lacked `navigationBarTranslucent`, risking double bottom inset | Added (RN 0.88 supports it alongside `statusBarTranslucent`) |
| 11 | Backend: no rate limit before auth (invalid-token floods weren't throttled) | Global `/api` limiter before auth (`API_RATE_PER_MIN`, default 120) |
| 12 | Backend: a failing provider `/models` call wasn't cached, so every request amplified load on the provider | 30 s failure cache |
| 13 | Backend: CORS behavior was implicit | Explicit allowlist (`CORS_ORIGINS`), closed by default, OPTIONS handled |
| 14 | Backend: tool inputs were unbounded or not type-checked (`location`, `query`) | Type and length validation (100 / 300 / 500 characters) |
| 15 | Backend: no graceful shutdown on SIGTERM (container deploys) | `server.close()` with a 10 s hard stop |
| 16 | Typecheck: 90 checkJs errors (untyped props, `requestJson` options, backend state shape, icon prop) | JSDoc annotations; 0 errors |
| 17 | `.env.example` templates were excluded by the root `.gitignore` (`.env*`) | Added `!**/.env.example` (real `.env` files stay ignored) |
| 18 | Dev tool versions mismatched the SDK (`typescript`, `@types/react`) | `expo install --fix` |
| 19 | Citations had no accessibility label | `accessibilityLabel="Citation n: <title>"` |

### 2.3 Accepted / not fixed
| Item | Reason |
| --- | --- |
| `pnpm audit` reports `zod`, `glob`, `minimatch` and `deepmerge` under `expo > @expo/cli` and `@expo/config` | Build-time CLI and tooling only, never in the app bundle. Versions are pinned by Expo SDK 58 and resolve with Expo patch releases (`npx expo install --fix`) |
| Jest prints `act()` warnings | Test-harness timing (debounced timers and the deliberate concurrent double-tap); not app errors |
| Client token is extractable from the binary | Inherent to mobile apps. Documented; use per-user auth (JWT, App Attest, Play Integrity) for public launch |

---

## 3. Untested (requires devices or external accounts)

| Feature | Why it couldn't run here | How to verify |
| --- | --- | --- |
| **Running on a physical Android phone or emulator** | No Android SDK, JDK or emulator; 4 GB RAM | `pnpm build:apk`, install the APK, or `npx expo start` + Expo Go |
| **Running on an iPhone or iOS Simulator** | Requires macOS / Xcode | `eas build -p ios --profile development` (simulator) or TestFlight |
| **Native compile (Gradle / Xcode)** | Same as above; only `prebuild` generation was verified | First EAS build |
| `expo/fetch` streaming on device (iOS URLSession / Android OkHttp) | Requires a native runtime; Jest mocks the transport (e2e used a Node adapter carrying real server bytes) | Ask a long question on device; tokens should appear progressively and Stop should halt immediately |
| Keyboard: iOS animated padding; Android edge-to-edge `adjustResize` detection | Needs a real IME and window insets | Open the keyboard on both platforms; the composer should sit flush above the keyboard and the sheets' URL field should stay visible |
| Safe areas (notch, Dynamic Island, gesture bar), rotation and tablets | Needs devices | Visual check on a notch iPhone, iPad and an Android gesture-nav phone |
| Native animation driver, haptics, clipboard, share sheet and `Linking` on device | Mocked in Jest | Manual smoke test |
| Scroll physics and momentum detection on real touch | Simulated scroll events only | Scroll up during streaming; the app shouldn't snap back, and "Scroll to bottom" should appear |
| AsyncStorage on device after a real app kill | Jest uses the official in-memory mock | Send a message, kill the app mid-stream, reopen |
| Real LLM provider (Groq / OpenAI / Gemini) | No provider key in this environment; a mock provider was used | Set `LLM_API_KEY`, then `pnpm test:e2e` with `LUMORA_E2E_URL` |
| Tavily search; CoinGecko from a non-rate-limited IP | No key; shared IP rate-limited | Configure keys, then ask a news or crypto question |
| EAS build, credentials and store submission | Needs Expo, Apple and Google accounts | Follow README §5 |
| HTTPS deployment, TLS and real proxy `TRUST_PROXY` behavior | Needs hosting | Deploy, then `curl https://…/api/health` |

---

## 4. Reproduce

```bash
# Mobile
cd lumora/mobile && pnpm install --frozen-lockfile
pnpm typecheck && pnpm test && pnpm doctor && pnpm export:check
npx expo prebuild --clean --no-install && rm -rf android ios

# Backend
cd lumora/backend && npm install && npm test

# End-to-end (backend running on :8787)
cd lumora/mobile && LUMORA_E2E_URL=http://127.0.0.1:8787 LUMORA_E2E_TOKEN=<token> pnpm test:e2e
```

---

## 5. Addendum: private distribution configuration

All results below come from commands that were actually run. **No EAS build has been run**: no Expo, Apple or Google credentials were available, so no APK or IPA exists yet.

**Passed**
| Check | Result |
| --- | --- |
| `eas.json` validated by the official `@expo/eas-json` 27.2.0 reader for every profile and platform | `android-apk` gives an internal APK; `ios-adhoc` gives internal distribution (ad hoc provisioning); `testflight` gives store distribution; `submit.testflight.ios` is valid |
| All profiles share the backend URL, EAS environment, Node and pnpm, and nothing overrides the bundle identifier | Pass (tests and release guard) |
| No Google Play submit profile | Pass |
| Release guard (`eas-build-pre-install`) | Blocks provider secrets, secret-like `EXPO_PUBLIC_*` variables, non-HTTPS backends and identity overrides; the bundle scan of a production export is clean |
| TestFlight tool against a mock App Store Connect | ES256 JWT verified; creates the internal group (all builds) and external group (public link, limit and feedback), beta localization and review detail; idempotent re-runs; adds the build and submits Beta App Review; never calls App Store version or release endpoints |
| Branding from the uploaded SVG | Geometry preserved verbatim; iOS icon is opaque RGB 1024 px; adaptive mark inside the safe circle (270 px vs 313 px); `expo prebuild` generated the Android adaptive, round and monochrome icons, the iOS AppIcon and the splash on both platforms |
| `pnpm test:distribution` 10/10 · `pnpm test` 23/23 · `tsc` 0 errors · `expo-doctor` 20/20 · `expo install --check` up to date (Expo 58.0.22) | Pass |

**Fixed during this pass:** TypeScript asset typing for the PNG mark (`expo-env.d.ts`); updated Expo 58.0.21 to 58.0.22 (a patch released during the session); corrected the documented iOS minimum to 16.4 (from the generated project) instead of an assumed 15.1.

**Untested (requires accounts or devices):** EAS Build for all three profiles; keystore, certificate and provisioning-profile generation; `eas device:create` UDID registration; `eas submit` to App Store Connect; the TestFlight script against the real App Store Connect API (only the mock was used); Beta App Review; installing an APK or IPA on physical devices.
