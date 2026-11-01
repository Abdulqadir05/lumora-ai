/**
 * Tests for the private-distribution tooling (no network, no Apple/Expo accounts).
 * Run: pnpm test:distribution
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createToken, createClient, setup, distribute, validateConfig, loadConfig } from './testflight.mjs';
import { checkEnv, checkAppIds, SECRET_PATTERNS } from './check-release-env.mjs';
import { extractMark, composeSvg, SPECS } from './brand-assets.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const easJson = JSON.parse(readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
const appJson = JSON.parse(readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const testflightConfig = JSON.parse(readFileSync(path.join(ROOT, 'distribution/testflight.config.json'), 'utf8'));

const resolveProfile = (name) => {
  const chain = [];
  let p = easJson.build[name];
  while (p) {
    chain.unshift(p);
    p = p.extends ? easJson.build[p.extends] : null;
  }
  const out = { env: {} };
  for (const c of chain) {
    const { env, extends: _e, ...rest } = c;
    Object.assign(out, rest);
    Object.assign(out.env, env || {});
    for (const plat of ['android', 'ios']) if (c[plat]) out[plat] = { ...(out[plat] || {}), ...c[plat] };
  }
  return out;
};

// ─── eas.json / app.json invariants ─────────────────────────────────────────
test('TestFlight description lists the current selectable models', () => {
  assert.match(testflightConfig.betaAppDescription, /GPT-OSS 20B, GPT-OSS 120B and Qwen 3\.8 27B/);
  assert.doesNotMatch(testflightConfig.betaAppDescription, /Llama 3\.3 70B/);
});

test('Android: signed release APK via EAS internal distribution; no Play submission configured', () => {
  const p = resolveProfile('android-apk');
  assert.equal(p.distribution, 'internal');
  assert.equal(p.android.buildType, 'apk');
  assert.equal(p.android.gradleCommand, undefined); // default :app:assembleRelease (release-signed)
  assert.equal(p.credentialsSource ?? 'remote', 'remote'); // EAS-managed keystore
  for (const s of Object.values(easJson.submit || {})) assert.equal(s.android, undefined, 'no Google Play submit profile');
});

test('iOS: TestFlight store profile and separate ad hoc profile', () => {
  const tf = resolveProfile('testflight');
  assert.equal(tf.distribution, 'store');
  assert.equal(tf.ios.simulator, undefined);
  assert.equal(tf.autoIncrement, true);
  const adhoc = resolveProfile('ios-adhoc');
  assert.equal(adhoc.distribution, 'internal'); // EAS internal iOS distribution = ad hoc provisioning
  assert.equal(adhoc.ios.enterpriseProvisioning, undefined);
  assert.equal(adhoc.ios.simulator, undefined);
  assert.ok(easJson.submit.testflight?.ios, 'TestFlight submit profile exists');
});

test('Android APK uses the confirmed application ID while iOS profiles remain blocked pending an iOS ID', () => {
  assert.equal(appJson.expo.android.package, 'ai.lumora.app');
  assert.deepEqual(checkAppIds(appJson, easJson, { profile: 'android-apk' }), []);
  for (const profile of ['ios-adhoc', 'testflight'])
    assert.ok(checkAppIds(appJson, easJson, { profile }).some((error) => /placeholder iOS bundle identifier/i.test(error)), profile);

  const incorrectAndroidId = structuredClone(appJson);
  incorrectAndroidId.expo.android.package = 'ai.lumora.other';
  assert.ok(checkAppIds(incorrectAndroidId, easJson, { profile: 'android-apk' }).some((error) => /Android package .* differs from the canonical/i.test(error)));
  const placeholderAndroidId = structuredClone(appJson);
  placeholderAndroidId.expo.android.package = 'com.yourcompany.lumora';
  assert.ok(checkAppIds(placeholderAndroidId, easJson, { profile: 'android-apk' }).some((error) => /placeholder Android package/i.test(error)));

  const distributable = ['android-apk', 'ios-adhoc', 'testflight'];
  const urls = new Set(distributable.map((n) => resolveProfile(n).env.EXPO_PUBLIC_LUMORA_API_URL));
  assert.equal(urls.size, 1, 'one backend URL for every distributable profile');
  assert.match([...urls][0], /^https:\/\//);
  for (const name of distributable) {
    const { errors } = checkEnv({ ...resolveProfile(name).env, EXPO_PUBLIC_LUMORA_CLIENT_TOKEN: 'x'.repeat(64) }, { profile: name, strict: true });
    assert.ok(errors.some((error) => /real HTTPS backend URL/i.test(error)), `${name} must reject the placeholder host`);
  }
  const envs = new Set(distributable.map((n) => resolveProfile(n).environment));
  assert.deepEqual([...envs], ['production'], 'all profiles read the same EAS environment (client token)');
  for (const n of distributable) {
    for (const key of Object.keys(resolveProfile(n).env)) assert.match(key, /^EXPO_PUBLIC_LUMORA_(API_URL|CLIENT_TOKEN)$/);
  }
});

test('release guard runs automatically on EAS before install', () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts['eas-build-pre-install'], /check-release-env\.mjs/);
});

// ─── Release guard ──────────────────────────────────────────────────────────
test('release guard blocks provider secrets and insecure backends', () => {
  const ok = checkEnv({ EXPO_PUBLIC_LUMORA_API_URL: 'https://api.lumora.dev', EXPO_PUBLIC_LUMORA_CLIENT_TOKEN: 'x'.repeat(64) }, { profile: 'testflight', strict: true });
  assert.deepEqual(ok, { errors: [], warnings: [] });
  const fake = (s) => s.split('').reverse().join(''); // keep literal key shapes out of the source
  const cases = [
    [{ EXPO_PUBLIC_LUMORA_API_URL: 'https://a.b', LLM_API_KEY: 'x' }, /LLM_API_KEY/],
    [{ EXPO_PUBLIC_LUMORA_API_URL: 'https://a.b', EXPO_PUBLIC_GROQ_KEY: 'x' }, /EXPO_PUBLIC_GROQ_KEY looks like a secret/],
    [{ EXPO_PUBLIC_LUMORA_API_URL: 'https://a.b', EXPO_PUBLIC_LUMORA_CLIENT_TOKEN: fake('ABCDEFGHIJKLMNOPQRSTUVWXYZ_ksg') }, /Groq key/],
    [{ EXPO_PUBLIC_LUMORA_API_URL: 'http://a.b', EXPO_PUBLIC_LUMORA_CLIENT_TOKEN: 'x'.repeat(64) }, /must be a real HTTPS backend URL/],
    [{ EXPO_PUBLIC_LUMORA_API_URL: 'https://api.your-domain.com', EXPO_PUBLIC_LUMORA_CLIENT_TOKEN: 'x'.repeat(64) }, /must be a real HTTPS backend URL/],
    [{ EXPO_PUBLIC_LUMORA_API_URL: 'https://api.lumora.dev' }, /CLIENT_TOKEN is required/],
    [{ EXPO_PUBLIC_LUMORA_API_URL: 'https://api.lumora.dev', EXPO_PUBLIC_LUMORA_CLIENT_TOKEN: 'short' }, /CLIENT_TOKEN must be at least 32 bytes/],
    [{}, /not set/],
  ];
  for (const [env, rx] of cases) {
    const { errors } = checkEnv(env, { profile: 'android-apk', strict: true });
    assert.ok(errors.some((e) => rx.test(e)), `${JSON.stringify(Object.keys(env))} → ${errors.join(' | ')}`);
  }
  // Locally (non-strict) server-only names warn instead of failing.
  const local = checkEnv({ EXPO_PUBLIC_LUMORA_API_URL: 'https://api.lumora.dev', EXPO_PUBLIC_LUMORA_CLIENT_TOKEN: 'x'.repeat(64), OPENAI_API_KEY: 'x' }, { profile: 'testflight' });
  assert.equal(local.errors.length, 0);
  assert.equal(local.warnings.length, 1);
  assert.ok(SECRET_PATTERNS.length >= 5);
});

test('release guard rejects per-profile bundle identifier overrides', () => {
  const bad = structuredClone(easJson);
  bad.build['ios-adhoc'].ios.bundleIdentifier = 'com.other.app';
  assert.ok(checkAppIds(appJson, bad).some((e) => /ios-adhoc/.test(e)));
});

test('release guard rejects Android package overrides and placeholder app identifiers', () => {
  const bad = structuredClone(easJson);
  bad.build['android-apk'].android.package = 'com.other.app';
  assert.ok(checkAppIds(appJson, bad, { profile: 'android-apk' }).some((error) => /overrides the app identity/i.test(error)));
  assert.ok(checkAppIds(appJson, easJson, { profile: 'testflight' }).some((error) => /placeholder iOS bundle identifier/i.test(error)));
});

// ─── Branding ───────────────────────────────────────────────────────────────
test('icons are generated from the uploaded mark without altering its geometry', () => {
  const svg = readFileSync(path.join(ROOT, 'assets/brand/lumora-mark.svg'), 'utf8');
  const shapes = extractMark(svg);
  assert.deepEqual(shapes.length, 2);
  const composed = composeSvg(shapes, { size: 1024, fraction: 0.5, color: '#FFFFFF', background: '#060B16' });
  assert.ok(composed.includes('d="M22 24V74H44L54 64"'));
  assert.ok(composed.includes('cx="76" cy="42" r="12"'));
  for (const s of SPECS) assert.ok(existsSync(path.join(ROOT, 'assets', s.file)), s.file);
  const e = appJson.expo;
  assert.equal(e.icon, './assets/icon.png');
  assert.equal(e.ios.icon, './assets/icon.png');
  assert.equal(e.android.adaptiveIcon.foregroundImage, './assets/adaptive-icon.png');
  assert.equal(e.android.adaptiveIcon.backgroundColor, '#060B16');
  const splash = e.plugins.find((p) => Array.isArray(p) && p[0] === 'expo-splash-screen')[1];
  assert.equal(splash.image, './assets/splash-icon.png');
  assert.equal(splash.backgroundColor, '#060B16');
  // iOS icon must be opaque RGB (PNG colour type 2, no tRNS chunk).
  const icon = readFileSync(path.join(ROOT, 'assets/icon.png'));
  assert.equal(icon[25], 2);
  assert.equal(icon.includes(Buffer.from('tRNS')), false);
});

// ─── TestFlight script against a mock App Store Connect ─────────────────────
test('JWT is a valid ES256 App Store Connect token', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const token = createToken({ keyId: 'ABC123DEFG', issuerId: '11111111-2222-3333-4444-555555555555', privateKey, now: 1000 });
  const [h, p, s] = token.split('.');
  const dec = (x) => JSON.parse(Buffer.from(x, 'base64url').toString());
  assert.deepEqual(dec(h), { alg: 'ES256', kid: 'ABC123DEFG', typ: 'JWT' });
  assert.deepEqual(dec(p), { iss: '11111111-2222-3333-4444-555555555555', iat: 1000, exp: 1900, aud: 'appstoreconnect-v1' });
  const ok = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
  assert.equal(ok, true);
});

function mockAsc() {
  const state = { calls: [], groups: [], localizations: [], buildLocs: [], groupBuilds: [], reviews: 0 };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://x');
      const route = `${req.method} ${url.pathname}`;
      state.calls.push({ route, body, auth: req.headers.authorization });
      const send = (code, json) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(json ? JSON.stringify(json) : '');
      };
      if (route === 'GET /v1/apps') return send(200, { data: [{ id: 'APP1', type: 'apps', attributes: { name: 'Lumora AI', bundleId: url.searchParams.get('filter[bundleId]') } }] });
      if (route === 'GET /v1/apps/APP1/betaAppLocalizations') return send(200, { data: state.localizations });
      if (route === 'POST /v1/betaAppLocalizations') {
        const l = { id: 'LOC1', type: 'betaAppLocalizations', attributes: body.data.attributes };
        state.localizations.push(l);
        return send(201, { data: l });
      }
      if (route === 'PATCH /v1/betaAppLocalizations/LOC1') return send(200, { data: state.localizations[0] });
      if (route === 'GET /v1/apps/APP1/betaAppReviewDetail') return send(200, { data: { id: 'RD1', type: 'betaAppReviewDetails', attributes: {} } });
      if (route === 'PATCH /v1/betaAppReviewDetails/RD1') return send(200, { data: { id: 'RD1' } });
      if (route === 'GET /v1/apps/APP1/betaGroups') return send(200, { data: state.groups });
      if (route === 'POST /v1/betaGroups') {
        const a = body.data.attributes;
        const g = { id: `G${state.groups.length + 1}`, type: 'betaGroups', attributes: { ...a, publicLink: a.publicLinkEnabled ? 'https://testflight.apple.com/join/AbCdEf12' : null } };
        state.groups.push(g);
        return send(201, { data: g });
      }
      if (route.startsWith('PATCH /v1/betaGroups/')) {
        const g = state.groups.find((x) => x.id === url.pathname.split('/').pop());
        Object.assign(g.attributes, body.data.attributes);
        return send(200, { data: g });
      }
      if (route === 'GET /v1/builds') return send(200, { data: [{ id: 'B42', type: 'builds', attributes: { version: '42', uploadedDate: '2026-10-31T10:00:00Z', processingState: 'VALID' } }] });
      if (route === 'GET /v1/builds/B42/betaBuildLocalizations') return send(200, { data: state.buildLocs });
      if (route === 'POST /v1/betaBuildLocalizations') {
        state.buildLocs.push({ id: 'BL1', attributes: body.data.attributes });
        return send(201, { data: state.buildLocs[0] });
      }
      if (route === 'PATCH /v1/betaBuildLocalizations/BL1') {
        Object.assign(state.buildLocs[0].attributes, body.data.attributes);
        return send(200, { data: state.buildLocs[0] });
      }
      if (route.endsWith('/relationships/builds')) {
        state.groupBuilds.push({ group: url.pathname.split('/')[3], builds: body.data });
        return send(204);
      }
      if (route === 'POST /v1/betaAppReviewSubmissions') {
        state.reviews += 1;
        if (state.reviews > 1) return send(409, { errors: [{ code: 'ENTITY_ERROR.STATE', detail: 'already submitted' }] });
        return send(201, { data: { id: 'R1' } });
      }
      return send(404, { errors: [{ code: 'NOT_FOUND', detail: route }] });
    });
  });
  return { server, state };
}

test('setup + distribute create the right TestFlight resources and never touch App Store release', async () => {
  const { server, state } = mockAsc();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/v1`;
  try {
    const cfg = { ...loadConfig(), bundleId: 'com.example.lumora' };
    const api = createClient({ token: 'TEST', base });
    const logs = [];
    const log = (m) => logs.push(m);

    const r1 = await setup(api, cfg, log);
    assert.equal(r1.publicLink, 'https://testflight.apple.com/join/AbCdEf12');
    const internal = state.groups.find((g) => g.attributes.name === cfg.groups.internal.name).attributes;
    assert.equal(internal.isInternalGroup, true);
    assert.equal(internal.hasAccessToAllBuilds, true);
    const external = state.groups.find((g) => g.attributes.name === cfg.groups.external.name).attributes;
    assert.equal(external.isInternalGroup, false);
    assert.equal(external.publicLinkEnabled, true);
    assert.equal(external.publicLinkLimit, 500);
    assert.equal(external.feedbackEnabled, true);
    const loc = state.calls.find((c) => c.route === 'POST /v1/betaAppLocalizations').body.data;
    assert.equal(loc.attributes.description, cfg.betaAppDescription);
    assert.equal(loc.attributes.feedbackEmail, cfg.feedbackEmail);
    assert.equal(loc.relationships.app.data.id, 'APP1');
    const review = state.calls.find((c) => c.route === 'PATCH /v1/betaAppReviewDetails/RD1').body.data.attributes;
    assert.equal(review.demoAccountRequired, false);
    assert.ok(state.calls.every((c) => c.auth === 'Bearer TEST'));

    // Idempotent: a second setup updates instead of duplicating.
    await setup(api, cfg, log);
    assert.equal(state.groups.length, 2);
    assert.ok(state.calls.some((c) => c.route === 'PATCH /v1/betaAppLocalizations/LOC1'));

    await distribute(api, cfg, {}, log);
    assert.equal(state.buildLocs[0].attributes.whatsNew, cfg.whatToTest);
    assert.deepEqual(state.groupBuilds[0], { group: 'G2', builds: [{ type: 'builds', id: 'B42' }] });
    assert.equal(state.reviews, 1);
    // Re-running distribute tolerates "already submitted".
    await distribute(api, cfg, { whatToTest: 'Second pass' }, log);
    assert.equal(state.buildLocs.length, 1);
    assert.equal(state.buildLocs[0].attributes.whatsNew, 'Second pass');

    // Never creates App Store versions or App Store review submissions (public release).
    assert.ok(!state.calls.some((c) => /appStoreVersion|appStoreVersionSubmissions|reviewSubmissions(?!.*beta)/i.test(c.route) && !/betaAppReviewSubmissions/.test(c.route)));
  } finally {
    server.close();
  }
});

test('placeholders in the TestFlight config are rejected before contacting Apple', () => {
  const problems = validateConfig(loadConfig());
  assert.ok(problems.some((p) => /feedbackEmail/.test(p)));
  assert.ok(problems.some((p) => /bundleId/.test(p)));
  const good = {
    ...loadConfig(),
    bundleId: 'com.acme.lumora',
    feedbackEmail: 'beta@acme.io',
    marketingUrl: 'https://acme.io',
    privacyPolicyUrl: 'https://acme.io/privacy',
    whatToTest: 'Try streaming.',
    betaReview: { contactFirstName: 'Ada', contactLastName: 'L', contactPhone: '+1 555 0100', contactEmail: 'ada@acme.io', demoAccountRequired: false, notes: 'No login.' },
  };
  assert.deepEqual(validateConfig(good), []);
});
