#!/usr/bin/env node
/**
 * TestFlight distribution helper (App Store Connect API, no extra dependencies).
 *
 *   node scripts/testflight.mjs setup                 # beta info + internal & external groups + public link
 *   node scripts/testflight.mjs distribute [--build N] [--what-to-test "…"]
 *                                                     # add a processed build to the external group and
 *                                                     # submit it for Beta App Review (TestFlight only)
 *   node scripts/testflight.mjs status                # groups, public link, latest build state
 *
 * Credentials (App Store Connect → Users and Access → Integrations → App Store Connect API,
 * role "App Manager"). Never commit the .p8 file.
 *   ASC_KEY_ID=ABC123DEFG  ASC_ISSUER_ID=xxxxxxxx-xxxx-…  ASC_KEY_PATH=./AuthKey_ABC123DEFG.p8
 *
 * This script never creates an App Store version or submits for public App Store release.
 */
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.ASC_API_BASE || 'https://api.appstoreconnect.apple.com').replace(/\/+$/, '') + '/v1';

// ─── Config ─────────────────────────────────────────────────────────────────
export function loadConfig(root = ROOT) {
  const cfg = JSON.parse(readFileSync(path.join(root, 'distribution', 'testflight.config.json'), 'utf8'));
  const app = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8'));
  cfg.bundleId = app.expo.ios.bundleIdentifier; // single source of truth
  return cfg;
}

/** Refuses to talk to Apple while placeholders are still present. */
export function validateConfig(cfg) {
  const problems = [];
  const walk = (v, key) => {
    if (typeof v === 'string' && /REPLACE|your-domain\.com|yourcompany/i.test(v)) problems.push(`${key} still contains a placeholder ("${v.slice(0, 40)}")`);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (k !== '$comment') walk(x, key ? `${key}.${k}` : k);
  };
  walk(cfg, '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(cfg.feedbackEmail || '')) problems.push('feedbackEmail must be a valid email');
  if ((cfg.betaAppDescription || '').length > 4000) problems.push('betaAppDescription exceeds 4000 characters');
  if ((cfg.whatToTest || '').length > 4000) problems.push('whatToTest exceeds 4000 characters');
  const limit = cfg.groups?.external?.publicLinkLimit;
  if (limit != null && (limit < 1 || limit > 10000)) problems.push('groups.external.publicLinkLimit must be 1–10000');
  return problems;
}

// ─── Auth: ES256 JWT for App Store Connect ──────────────────────────────────
const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

export function createToken({ keyId, issuerId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  const header = { alg: 'ES256', kid: keyId, typ: 'JWT' };
  const payload = { iss: issuerId, iat: now, exp: now + 15 * 60, aud: 'appstoreconnect-v1' };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${b64url(sig)}`;
}

// ─── Minimal JSON:API client ────────────────────────────────────────────────
export function createClient({ token, fetchImpl = fetch, base = API }) {
  async function call(method, urlPath, body) {
    const res = await fetchImpl(`${base}${urlPath}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const detail = json?.errors?.map((e) => `${e.code}: ${e.detail || e.title}`).join('; ') || text;
      const err = new Error(`App Store Connect ${method} ${urlPath} → ${res.status} ${detail}`);
      err.status = res.status;
      err.codes = json?.errors?.map((e) => e.code) || [];
      throw err;
    }
    return json;
  }
  return {
    get: (p) => call('GET', p),
    post: (p, b) => call('POST', p, b),
    patch: (p, b) => call('PATCH', p, b),
  };
}

const rel = (type, id) => ({ data: { type, id } });

export async function findApp(api, bundleId) {
  const res = await api.get(`/apps?filter[bundleId]=${encodeURIComponent(bundleId)}&limit=1`);
  const app = res.data?.[0];
  if (!app)
    throw new Error(`No App Store Connect app with bundle ID ${bundleId}. Run "eas submit -p ios --profile testflight" once (it creates the app), or create it in App Store Connect.`);
  return app;
}

async function ensureBetaLocalization(api, appId, cfg) {
  const attrs = {
    description: cfg.betaAppDescription,
    feedbackEmail: cfg.feedbackEmail,
    marketingUrl: cfg.marketingUrl || null,
    privacyPolicyUrl: cfg.privacyPolicyUrl || null,
  };
  const list = await api.get(`/apps/${appId}/betaAppLocalizations`);
  const existing = list.data?.find((l) => l.attributes.locale === cfg.locale);
  if (existing) {
    await api.patch(`/betaAppLocalizations/${existing.id}`, { data: { type: 'betaAppLocalizations', id: existing.id, attributes: attrs } });
    return 'updated';
  }
  await api.post('/betaAppLocalizations', {
    data: { type: 'betaAppLocalizations', attributes: { locale: cfg.locale, ...attrs }, relationships: { app: rel('apps', appId) } },
  });
  return 'created';
}

async function updateBetaReviewDetail(api, appId, cfg) {
  const detail = await api.get(`/apps/${appId}/betaAppReviewDetail`);
  const id = detail.data.id;
  await api.patch(`/betaAppReviewDetails/${id}`, { data: { type: 'betaAppReviewDetails', id, attributes: cfg.betaReview } });
}

async function ensureGroup(api, appId, spec, internal) {
  const list = await api.get(`/apps/${appId}/betaGroups?limit=200`);
  const found = list.data?.find((g) => g.attributes.name === spec.name);
  const attrs = internal
    ? { feedbackEnabled: !!spec.feedbackEnabled }
    : {
        feedbackEnabled: !!spec.feedbackEnabled,
        publicLinkEnabled: !!spec.publicLinkEnabled,
        publicLinkLimitEnabled: !!spec.publicLinkLimitEnabled,
        ...(spec.publicLinkLimitEnabled ? { publicLinkLimit: spec.publicLinkLimit } : {}),
      };
  if (found) {
    if (found.attributes.isInternalGroup !== internal)
      throw new Error(`Group "${spec.name}" exists but is ${found.attributes.isInternalGroup ? 'internal' : 'external'}; rename it in the config.`);
    const res = await api.patch(`/betaGroups/${found.id}`, { data: { type: 'betaGroups', id: found.id, attributes: attrs } });
    return { group: res?.data || found, action: 'updated' };
  }
  const res = await api.post('/betaGroups', {
    data: {
      type: 'betaGroups',
      // Internal groups get every new build automatically; external builds go through Beta App Review.
      attributes: { name: spec.name, isInternalGroup: internal, ...(internal ? { hasAccessToAllBuilds: true } : {}), ...attrs },
      relationships: { app: rel('apps', appId) },
    },
  });
  return { group: res.data, action: 'created' };
}

export async function setup(api, cfg, log = console.log) {
  const app = await findApp(api, cfg.bundleId);
  log(`App: ${app.attributes.name} (${app.id}) · ${cfg.bundleId}`);
  log(`✓ Beta app information ${await ensureBetaLocalization(api, app.id, cfg)} (${cfg.locale})`);
  await updateBetaReviewDetail(api, app.id, cfg);
  log('✓ Beta App Review contact & notes updated');
  const internal = await ensureGroup(api, app.id, cfg.groups.internal, true);
  log(`✓ Internal group "${cfg.groups.internal.name}" ${internal.action} (all builds, up to 100 team members)`);
  const external = await ensureGroup(api, app.id, cfg.groups.external, false);
  log(`✓ External group "${cfg.groups.external.name}" ${external.action} (public link ${external.group.attributes.publicLinkEnabled ? 'enabled' : 'disabled'})`);
  const link = external.group.attributes.publicLink;
  log(link ? `Public TestFlight link: ${link}` : 'Public link will appear once Apple generates it (check `status` after the first build is approved).');
  return { app, internal: internal.group, external: external.group, publicLink: link || null };
}

async function findBuild(api, appId, buildNumber) {
  const filter = buildNumber ? `&filter[version]=${encodeURIComponent(buildNumber)}` : '';
  const res = await api.get(`/builds?filter[app]=${appId}&filter[processingState]=VALID${filter}&sort=-uploadedDate&limit=1`);
  const build = res.data?.[0];
  if (!build)
    throw new Error(buildNumber ? `No processed build ${buildNumber} found.` : 'No processed (VALID) build found yet. Wait for App Store Connect processing to finish.');
  return build;
}

async function setWhatToTest(api, buildId, locale, text) {
  const list = await api.get(`/builds/${buildId}/betaBuildLocalizations`);
  const existing = list.data?.find((l) => l.attributes.locale === locale);
  if (existing) {
    await api.patch(`/betaBuildLocalizations/${existing.id}`, { data: { type: 'betaBuildLocalizations', id: existing.id, attributes: { whatsNew: text } } });
  } else {
    await api.post('/betaBuildLocalizations', {
      data: { type: 'betaBuildLocalizations', attributes: { locale, whatsNew: text }, relationships: { build: rel('builds', buildId) } },
    });
  }
}

export async function distribute(api, cfg, { buildNumber, whatToTest } = {}, log = console.log) {
  const app = await findApp(api, cfg.bundleId);
  const build = await findBuild(api, app.id, buildNumber);
  log(`Build ${build.attributes.version} (${build.id}) uploaded ${build.attributes.uploadedDate}`);
  await setWhatToTest(api, build.id, cfg.locale, whatToTest || cfg.whatToTest);
  log('✓ "What to Test" set');
  const groups = await api.get(`/apps/${app.id}/betaGroups?limit=200`);
  const external = groups.data?.find((g) => g.attributes.name === cfg.groups.external.name);
  if (!external) throw new Error(`External group "${cfg.groups.external.name}" not found. Run "setup" first.`);
  await api.post(`/betaGroups/${external.id}/relationships/builds`, { data: [{ type: 'builds', id: build.id }] });
  log(`✓ Build added to external group "${external.attributes.name}"`);
  try {
    await api.post('/betaAppReviewSubmissions', { data: { type: 'betaAppReviewSubmissions', relationships: { build: rel('builds', build.id) } } });
    log('✓ Submitted for Beta App Review (TestFlight external testing only, not App Store release)');
  } catch (e) {
    if (e.status === 409 || e.status === 422) log(`• Beta App Review submission not needed or already exists (${e.message.split('→')[1]?.trim()})`);
    else throw e;
  }
  if (external.attributes.publicLink) log(`Public TestFlight link: ${external.attributes.publicLink}`);
  return { build, external };
}

export async function status(api, cfg, log = console.log) {
  const app = await findApp(api, cfg.bundleId);
  const groups = await api.get(`/apps/${app.id}/betaGroups?limit=200`);
  for (const g of groups.data || []) {
    const a = g.attributes;
    log(`${a.isInternalGroup ? 'Internal' : 'External'} · ${a.name}${a.publicLinkEnabled ? ` · public link: ${a.publicLink || '(pending)'}` : ''}`);
  }
  const builds = await api.get(`/builds?filter[app]=${app.id}&sort=-uploadedDate&limit=3&include=buildBetaDetail`);
  for (const b of builds.data || []) {
    const detail = builds.included?.find((i) => i.type === 'buildBetaDetails' && i.id === b.relationships?.buildBetaDetail?.data?.id);
    log(`Build ${b.attributes.version}: processing ${b.attributes.processingState}${detail ? `, internal ${detail.attributes.internalBuildState}, external ${detail.attributes.externalBuildState}` : ''}`);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => {
    const i = rest.indexOf(`--${n}`);
    return i > -1 ? rest[i + 1] : undefined;
  };
  const run = async () => {
    if (!['setup', 'distribute', 'status'].includes(cmd)) {
      console.log('Usage: node scripts/testflight.mjs <setup|distribute|status> [--build N] [--what-to-test "…"]');
      process.exit(cmd ? 1 : 0);
    }
    const cfg = loadConfig();
    const problems = validateConfig(cfg);
    if (problems.length) throw new Error(`Fix distribution/testflight.config.json first:\n  - ${problems.join('\n  - ')}`);
    const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_KEY_PATH } = process.env;
    if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_KEY_PATH) throw new Error('Set ASC_KEY_ID, ASC_ISSUER_ID and ASC_KEY_PATH (App Store Connect API key, App Manager role).');
    const token = createToken({ keyId: ASC_KEY_ID, issuerId: ASC_ISSUER_ID, privateKey: readFileSync(ASC_KEY_PATH, 'utf8') });
    const api = createClient({ token });
    if (cmd === 'setup') await setup(api, cfg);
    if (cmd === 'distribute') await distribute(api, cfg, { buildNumber: flag('build'), whatToTest: flag('what-to-test') });
    if (cmd === 'status') await status(api, cfg);
  };
  run().catch((e) => {
    console.error(`✖ ${e.message}`);
    process.exit(1);
  });
}
