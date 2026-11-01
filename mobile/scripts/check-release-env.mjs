#!/usr/bin/env node
/**
 * Release guard. Runs automatically on EAS (package.json "eas-build-pre-install")
 * and locally via `pnpm verify:release`. Fails the build when:
 *   - a provider secret (LLM / Groq / OpenAI / Gemini / Tavily key) is present in
 *     the build environment or in any EXPO_PUBLIC_* variable (those are bundled);
 *   - an unexpected secret-looking EXPO_PUBLIC_* variable exists;
 *   - a distributable build has no real HTTPS backend URL or a strong shared token;
 *   - the iOS bundle identifier / Android package are missing, placeholders, or inconsistent;
 *   - (with --dist <dir>) an exported JS bundle contains key-shaped strings.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Only these public variables may be embedded. The shared client token can be extracted from a built APK. */
export const ALLOWED_PUBLIC = new Set(['EXPO_PUBLIC_LUMORA_API_URL', 'EXPO_PUBLIC_LUMORA_CLIENT_TOKEN']);

/** Server-only variable names that must never reach a mobile build. */
export const FORBIDDEN_NAMES = [
  'LLM_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY', 'APP_OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY',
  'GOOGLE_API_KEY', 'TAVILY_API_KEY', 'COINGECKO_DEMO_API_KEY', 'LUMORA_CLIENT_TOKENS',
];

/** Value shapes of well-known provider secrets. */
export const SECRET_PATTERNS = [
  ['Groq key', /gsk_[A-Za-z0-9]{20,}/],
  ['OpenAI key', /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ['Anthropic key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Tavily key', /tvly-[A-Za-z0-9_-]{16,}/],
  ['Private key block', /-----BEGIN (?:EC |RSA )?PRIVATE KEY-----/],
];

const DISTRIBUTABLE = new Set(['android-apk', 'ios-adhoc', 'testflight']);
const PLACEHOLDER_URL_RX = /your[-_. ]?domain|example\.(com|net|org)|yourcompany|placeholder|replace[-_. ]?me|localhost/i;
const PLACEHOLDER_ID_RX = /yourcompany|your[-_. ]?company|example|placeholder|replace/i;

function validPublicHttpsUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.search && !url.hash &&
      !PLACEHOLDER_URL_RX.test(url.hostname) && !/\.(?:localhost|local|test|invalid)$/i.test(url.hostname) &&
      !['::1', '[::1]', '0.0.0.0'].includes(url.hostname) && !/^127(?:\.\d{1,3}){3}$/.test(url.hostname);
  } catch {
    return false;
  }
}

/**
 * @returns {{ errors: string[], warnings: string[] }}
 * Server-only names are fatal on EAS builders (strict) and warnings locally,
 * because Metro only inlines EXPO_PUBLIC_* values into the bundle.
 */
export function checkEnv(env, { profile, strict = false } = {}) {
  const errors = [];
  const warnings = [];
  for (const name of FORBIDDEN_NAMES) {
    if (!env[name]) continue;
    const msg = `${name} is set in the build environment. Provider secrets belong to the backend only.`;
    (strict ? errors : warnings).push(msg);
  }
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('EXPO_PUBLIC_')) continue;
    if (!ALLOWED_PUBLIC.has(name) && /KEY|SECRET|PASSWORD|PRIVATE|TOKEN/i.test(name))
      errors.push(`${name} looks like a secret and would be embedded in the app bundle.`);
    for (const [label, rx] of SECRET_PATTERNS) {
      if (rx.test(String(value))) errors.push(`${name} contains a ${label}; it would be shipped inside the app.`);
    }
  }
  const url = env.EXPO_PUBLIC_LUMORA_API_URL || '';
  if (profile && DISTRIBUTABLE.has(profile)) {
    if (!url) errors.push('EXPO_PUBLIC_LUMORA_API_URL is not set for a distributable build.');
    else if (!validPublicHttpsUrl(url)) errors.push(`EXPO_PUBLIC_LUMORA_API_URL must be a real HTTPS backend URL for "${profile}"; placeholders and URLs with credentials/query strings are not allowed.`);
    const clientToken = String(env.EXPO_PUBLIC_LUMORA_CLIENT_TOKEN || '').trim();
    if (!clientToken) errors.push('EXPO_PUBLIC_LUMORA_CLIENT_TOKEN is required for a distributable build.');
    else if (Buffer.byteLength(clientToken, 'utf8') < 32) errors.push('EXPO_PUBLIC_LUMORA_CLIENT_TOKEN must be at least 32 bytes.');
  }
  return { errors, warnings };
}

export const CANONICAL_IDS = { ios: 'com.yourcompany.lumora', android: 'ai.lumora.app' };

export function checkAppIds(appJson, easJson, { profile } = {}) {
  const errors = [];
  const e = appJson.expo || {};
  const platforms = profile === 'android-apk'
    ? ['android']
    : ['ios-adhoc', 'testflight'].includes(profile)
      ? ['ios']
      : ['ios', 'android'];

  if (platforms.includes('ios')) {
    if (!e.ios?.bundleIdentifier) errors.push('app.json is missing expo.ios.bundleIdentifier.');
    else if (PLACEHOLDER_ID_RX.test(e.ios.bundleIdentifier)) errors.push('app.json still uses a placeholder iOS bundle identifier.');
    if (e.ios?.bundleIdentifier !== CANONICAL_IDS.ios)
      errors.push(`iOS bundle identifier "${e.ios?.bundleIdentifier}" differs from the canonical "${CANONICAL_IDS.ios}" (update CANONICAL_IDS deliberately if you rename the app).`);
  }
  if (platforms.includes('android')) {
    if (!e.android?.package) errors.push('app.json is missing expo.android.package.');
    else if (PLACEHOLDER_ID_RX.test(e.android.package)) errors.push('app.json still uses a placeholder Android package.');
    if (e.android?.package !== CANONICAL_IDS.android)
      errors.push(`Android package "${e.android?.package}" differs from the canonical "${CANONICAL_IDS.android}" (update CANONICAL_IDS deliberately if you rename the app).`);
  }
  for (const [name, profile] of Object.entries(easJson.build || {})) {
    if (profile.ios?.bundleIdentifier || profile.android?.package || profile.env?.APP_VARIANT)
      errors.push(`eas.json profile "${name}" overrides the app identity; all profiles must share the identifiers in app.json.`);
  }
  for (const [name, profile] of Object.entries(easJson.submit || {})) {
    if (profile.ios?.bundleIdentifier && profile.ios.bundleIdentifier !== e.ios?.bundleIdentifier)
      errors.push(`eas.json submit profile "${name}" uses a different bundleIdentifier.`);
  }
  return errors;
}

export function scanBundles(dir) {
  const hits = [];
  const walk = (d) => {
    for (const f of readdirSync(d)) {
      const p = path.join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(hbc|js|bundle)$/.test(f)) {
        const text = readFileSync(p, 'latin1');
        for (const [label, rx] of SECRET_PATTERNS) if (rx.test(text)) hits.push(`${path.relative(dir, p)}: ${label}`);
        for (const name of FORBIDDEN_NAMES) if (text.includes(name)) hits.push(`${path.relative(dir, p)}: ${name}`);
      }
    }
  };
  walk(dir);
  return hits;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = process.env.EAS_BUILD_PROFILE || process.argv.find((a) => a.startsWith('--profile='))?.slice(10);
  const appJson = JSON.parse(readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const easJson = JSON.parse(readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  // Locally (no EAS), evaluate the env that the profile would inject.
  const env = { ...process.env };
  if (!process.env.EAS_BUILD && profile && easJson.build[profile]) {
    let p = easJson.build[profile];
    const chain = [p];
    while (p.extends) chain.unshift((p = easJson.build[p.extends]));
    for (const c of chain) Object.assign(env, c.env || {});
  }
  const envResult = checkEnv(env, { profile, strict: !!process.env.EAS_BUILD });
  envResult.warnings.forEach((w) => console.warn(`⚠ ${w} (fatal on EAS)`));
  const errors = [...envResult.errors, ...checkAppIds(appJson, easJson, { profile })];
  const distIdx = process.argv.indexOf('--dist');
  if (distIdx > -1) {
    const dir = path.resolve(process.argv[distIdx + 1] || 'dist');
    if (!existsSync(dir)) errors.push(`--dist directory not found: ${dir}`);
    else errors.push(...scanBundles(dir).map((h) => `Secret-like content in bundle: ${h}`));
  }
  if (errors.length) {
    console.error(`\n✖ Lumora release guard failed${profile ? ` (profile: ${profile})` : ''}:`);
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }
  console.log(`✓ Lumora release guard passed${profile ? ` (profile: ${profile})` : ''}: no provider secrets, consistent app identity${profile ? ', https backend' : ''}.`);
}
