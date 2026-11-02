/**
 * Backend integration tests. Starts the real server against a mock
 * OpenAI-compatible provider. No external network is required.
 * Run: npm test
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const WEATHER_MOCK = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'test-fixtures', 'mock-open-meteo.cjs');
const TOKEN = '0123456789abcdef0123456789abcdef';
const TAVILY_TEST_KEY = 'offline-tavily-test-key';

function mockCompletion(body, last) {
  const system = body.messages.find((message) => message.role === 'system')?.content || '';
  if (/conflicting current product prices/i.test(system)) return 'I found conflicting current prices. Which source listing should I use before converting?';
  if (/Ask the user for a clearer listing that names the model beside its price/i.test(system)) return 'I found a price, but the source does not tie it clearly to the requested iPhone model. Please share a listing that names the model beside its price.';
  if (/CLARIFICATION REQUIRED:.*target currency/i.test(system)) return 'Which target currency should I use?';
  if (/CLARIFICATION REQUIRED:.*amount and source currency/i.test(system)) return 'What amount and source currency should I convert?';
  const verifiedCalculation = system.match(/Verified calculation: ([^\n]+?)\. Use citations \[(\d+)\] for the quote and \[(\d+)\] for the rate/);
  if (verifiedCalculation) {
    const productQuote = system.match(/\[\d+\] VERIFIED PRODUCT PRICE \([^)]+\): ([^=]+) = (.+?) \(parsed as ([^)]+)\)\. URL:/);
    const original = productQuote ? `The source lists ${productQuote[2]} for ${productQuote[1]} (parsed as ${productQuote[3]}). ` : '';
    return `${original}The verified conversion is ${verifiedCalculation[1]} [${verifiedCalculation[2]}], using the indicative midpoint rate [${verifiedCalculation[3]}].`;
  }
  const weatherLine = system.split('\n').find((line) => /^\[\d+\] WEATHER \(/.test(line));
  if (weatherLine) {
    const number = weatherLine.match(/^\[(\d+)\]/)?.[1] || '1';
    const location = weatherLine.match(/retrieved at [^,]+, (.*?)(?:, requested period [^)]*)?\):/)?.[1] || 'unknown location';
    const values = weatherLine.split('): ')[1] || '';
    const temperature = values.match(/^(-?\d+)°C/)?.[1] || 'unknown';
    const description = values.match(/^\S+°C \(feels [^)]+\), ([^,]+),/)?.[1] || 'current conditions';
    return `Current weather in ${location} is ${temperature}°C, ${description.toLowerCase()} [${number}].`;
  }
  if (/^- No location was given, so live weather was not fetched\./m.test(system)) return 'Which city would you like the current weather for?';
  if (/Live weather could not be retrieved/i.test(system)) return "I couldn't retrieve live weather, so I don't have current conditions.";
  return 'Hello world';
}

// ─── Mock provider ──────────────────────────────────────────────────────────
const provider = { calls: [], aborted: 0, port: 0, fxCalls: 0 };
const mock = http.createServer((req, res) => {
  if (req.url === '/__test__/fx-hit' && req.method === 'POST') {
    provider.fxCalls += 1;
    res.writeHead(204).end();
    return;
  }
  if (req.url.endsWith('/models')) {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data: [{ id: 'openai/gpt-oss-20b' }, { id: 'qwen/qwen3.8-27b' }] }));
    return;
  }
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const body = JSON.parse(raw);
    const last = body.messages.at(-1).content;
    const completion = mockCompletion(body, last);
    provider.calls.push({ body, last });
    if (last.includes('UPSTREAM401')) return res.writeHead(401, { 'content-type': 'application/json' }).end('{}');
    if (last.includes('UPSTREAMMODEL400'))
      return res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'model_decommissioned', message: 'Model was decommissioned; provider credential detail must stay private.' } }));
    if (last.includes('UPSTREAMQUOTA'))
      return res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'insufficient_quota', message: 'Provider quota and billing capacity exhausted.' } }));
    if (last.includes('UPSTREAM403'))
      return res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'permission_denied', message: 'Project permission denied.' } }));
    if (last.includes('UPSTREAM429'))
      return res.writeHead(429, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { code: 'rate_limit_exceeded', message: 'Rate limit reached.' } }));
    if (last.includes('UPSTREAM500')) return res.writeHead(500).end('{}');
    if (!body.stream && !last.includes('FORCE_STREAM_IN_NONSTREAM')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'mock-completion', choices: [{ message: { content: completion }, finish_reason: 'stop' }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const tokens = last.includes('SLOW') ? Array.from({ length: 200 }, (_, i) => `t${i} `) : [completion];
    let i = 0;
    let finished = false;
    res.on('close', () => {
      if (!finished) provider.aborted += 1;
    });
    const timer = setInterval(
      () => {
        if (i < tokens.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: tokens[i++] } }] })}\n\n`);
        } else {
          clearInterval(timer);
          finished = true;
          res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
          res.end();
        }
      },
      last.includes('SLOW') ? 40 : 5,
    );
    res.on('close', () => clearInterval(timer));
  });
});

const children = [];
function startServer(env) {
  return new Promise((resolve, reject) => {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['--require', WEATHER_MOCK, SERVER], {
      env: { PATH: process.env.PATH, PORT: String(port), NODE_ENV: 'test', DOTENV_CONFIG_PATH: '/dev/null', TRUST_PROXY: '', LLM_BASE_URL: `http://127.0.0.1:${provider.port}/v1`, LLM_API_KEY: 'sk-secret-test-value', TAVILY_API_KEY: '', LUMORA_TEST_FX_OBSERVER_URL: `http://127.0.0.1:${provider.port}/__test__/fx-hit`, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    const onData = (d) => {
      out += d;
      if (out.includes('listening')) resolve({ url: `http://127.0.0.1:${port}`, child, output: out });
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (code) => reject(Object.assign(new Error(`server exited ${code}: ${out}`), { code })));
  });
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const chatBody = (content, extra = {}) => JSON.stringify({ model: 'gpt-oss-20b', messages: [{ role: 'user', content }], ...extra });
const chatConversationBody = (messages, extra = {}) => JSON.stringify({ model: 'gpt-oss-20b', messages, ...extra });

function parseSSE(text) {
  return text
    .split('\n\n')
    .filter((b) => b.startsWith('event:'))
    .map((b) => {
      const [e, d] = b.split('\n');
      return { event: e.slice(7), data: JSON.parse(d.slice(6)) };
    });
}

async function requestGoldResponse(url, messages, streaming) {
  const response = await fetch(`${url}/api/chat${streaming ? '/stream' : ''}`, {
    method: 'POST', headers: auth, body: chatConversationBody(messages),
  });
  assert.equal(response.status, 200);
  if (!streaming) {
    const result = await response.json();
    return { content: result.content, meta: result };
  }
  const events = parseSSE(await response.text());
  return {
    content: events.filter((event) => event.event === 'token').map((event) => event.data.t).join(''),
    meta: events.find((event) => event.event === 'meta')?.data,
  };
}

let api;
before(async () => {
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  provider.port = mock.address().port;
  // This stale value reproduces the reported failure; requests without a city must not use it.
  api = (await startServer({
    LUMORA_CLIENT_TOKENS: TOKEN,
    CORS_ORIGINS: 'https://admin.example.com',
    API_RATE_PER_MIN: '1000',
    CHAT_RATE_PER_MIN: '1000',
    DEFAULT_WEATHER_CITY: 'search on Google',
  })).url;
});
after(() => {
  children.forEach((c) => c.kill());
  mock.close();
});

test('public health is liveness-only; authenticated settings can read readiness without secrets', async () => {
  const publicResponse = await fetch(`${api}/api/health`);
  assert.equal(publicResponse.status, 200);
  assert.deepEqual(await publicResponse.json(), { ok: true });
  assert.equal(publicResponse.headers.get('x-powered-by'), null);

  const privateResponse = await fetch(`${api}/api/health`, { headers: auth });
  const details = await privateResponse.json();
  assert.equal(privateResponse.status, 200);
  assert.equal(details.provider.configured, true);
  assert.equal(details.tools.search, false);
  assert.ok(!JSON.stringify(details).includes('sk-secret'), 'no key material');
});

test('authentication: missing / wrong / valid token', async () => {
  assert.equal((await fetch(`${api}/api/models`)).status, 401);
  assert.equal((await fetch(`${api}/api/models`, { headers: { Authorization: 'Bearer nope' } })).status, 401);
  const ok = await fetch(`${api}/api/models`, { headers: auth });
  assert.equal(ok.status, 200);
});

test('protected chat and tool routes reject missing, invalid, and malformed bearer headers', async () => {
  const routes = [
    { method: 'GET', url: `${api}/api/models` },
    { method: 'POST', url: `${api}/api/chat`, body: '{}' },
    { method: 'POST', url: `${api}/api/chat/stream`, body: '{}' },
    { method: 'POST', url: `${api}/api/tools/search`, body: '{}' },
    { method: 'POST', url: `${api}/api/tools/news`, body: '{}' },
    { method: 'POST', url: `${api}/api/tools/weather`, body: '{}' },
    { method: 'POST', url: `${api}/api/tools/crypto`, body: '{}' },
    { method: 'POST', url: `${api}/api/tools/currency`, body: '{}' },
  ];
  const malformed = ['Basic token', 'Bearer', 'Bearer  ' + TOKEN, `Bearer ${TOKEN} extra`];
  for (const route of routes) {
    for (const authorization of [undefined, 'Bearer invalid', ...malformed]) {
      const headers = { 'Content-Type': 'application/json' };
      if (authorization !== undefined) headers.Authorization = authorization;
      const r = await fetch(route.url, { method: route.method, headers, ...(route.body ? { body: route.body } : {}) });
      assert.equal(r.status, 401, `${route.url} should reject ${authorization || 'missing authorization'}`);
    }
  }
  const malformedUnauthenticatedBody = await fetch(`${api}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(malformedUnauthenticatedBody.status, 401, 'authentication runs before JSON parsing');
  assert.equal((await fetch(`${api}/api/nope`)).status, 401, 'unknown API routes are protected by default');
  assert.equal((await fetch(`${api}/api/nope`, { headers: auth })).status, 404);

  const chat = await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('hello') });
  assert.equal(chat.status, 200);
  await chat.text();
  const tool = await fetch(`${api}/api/tools/search`, { method: 'POST', headers: auth, body: JSON.stringify({ query: 'test' }) });
  assert.equal(tool.status, 503); // authenticated; Tavily is intentionally unset in this test server
  assert.equal((await tool.json()).error.code, 'search_not_configured');
});

test('CORS: allowlisted origin only', async () => {
  const allowed = await fetch(`${api}/api/health`, { headers: { Origin: 'https://admin.example.com' } });
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://admin.example.com');
  const denied = await fetch(`${api}/api/health`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  const preflightOk = await fetch(`${api}/api/chat/stream`, { method: 'OPTIONS', headers: { Origin: 'https://admin.example.com' } });
  assert.equal(preflightOk.status, 204);
  const preflightBad = await fetch(`${api}/api/chat/stream`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(preflightBad.status, 403);
});

test('model availability is verified against the provider', async () => {
  const j = await (await fetch(`${api}/api/models`, { headers: auth })).json();
  const by = Object.fromEntries(j.models.map((m) => [m.id, m]));
  assert.equal(by['gpt-oss-20b'].available, true);
  assert.equal(by['qwen-3.8-27b'].available, true);
  assert.equal(by['qwen-3.8-27b'].label, 'Qwen 3.8 27B');
  assert.equal(by['gpt-oss-120b'].available, false);
  assert.match(by['gpt-oss-120b'].reason, /does not offer/);
  const r = await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('hello', { model: 'gpt-oss-120b' }) });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error.code, 'model_unavailable');
});

test('a listed model can complete a successful request through the existing model route', async () => {
  const r = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'qwen-3.8-27b', messages: [{ role: 'user', content: 'hello' }], tools: 'off' }),
  });
  assert.equal(r.status, 200);
  const events = parseSSE(await r.text());
  assert.equal(events.at(-1).event, 'done');
  assert.equal(events.filter((event) => event.event === 'token').map((event) => event.data.t).join(''), 'Hello world');
  assert.equal(provider.calls.at(-1).body.model, 'qwen/qwen3.8-27b');
});

test('Qwen uses the non-streaming chat completion route with the mapped model ID', async () => {
  const r = await fetch(`${api}/api/chat`, { method: 'POST', headers: auth, body: chatBody('hello', { model: 'qwen-3.8-27b' }) });
  assert.equal(r.status, 200);
  const result = await r.json();
  assert.equal(result.model.id, 'qwen-3.8-27b');
  assert.equal(result.model.label, 'Qwen 3.8 27B');
  assert.equal(result.content, 'Hello world');
  const call = provider.calls.at(-1);
  assert.equal(call.body.model, 'qwen/qwen3.8-27b');
  assert.equal(call.body.stream, false);
  assert.equal(call.body.temperature, 1.0);
  assert.equal(call.body.top_p, 0.95);
});

test('Qwen keeps chat history, creator instructions, server-side search routing, and Groq-specific request options', async () => {
  // Include groq.com in the mock URL path so this isolated server exercises the
  // Groq-only parameter branch while still sending every request to localhost.
    const groqMockApi = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, LLM_BASE_URL: `http://127.0.0.1:${provider.port}/v1/groq.com` });
  try {
    const r = await fetch(`${groqMockApi.url}/api/chat/stream`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        model: 'qwen-3.8-27b',
        tools: 'auto',
        messages: [
          { role: 'user', content: 'Previous question' },
          { role: 'assistant', content: 'Previous answer' },
          { role: 'user', content: 'Search online for a current Qwen release' },
        ],
      }),
    });
    assert.equal(r.status, 200);
    const events = parseSSE(await r.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    assert.equal(meta?.model.id, 'qwen-3.8-27b');
    assert.equal(meta?.model.label, 'Qwen 3.8 27B');
    assert.equal(meta?.toolErrors?.[0]?.type, 'search');
    assert.deepEqual(meta?.sources, []);

    const call = provider.calls.at(-1);
    assert.equal(call.body.model, 'qwen/qwen3.8-27b');
    assert.equal(call.body.stream, true);
    assert.equal(call.body.temperature, 1.0);
    assert.equal(call.body.top_p, 0.95);
    assert.equal(call.body.reasoning_effort, 'medium');
    assert.equal(call.body.reasoning_format, 'hidden');
    assert.equal(call.body.include_reasoning, undefined);
    assert.ok(call.body.messages.some((message) => message.role === 'assistant' && message.content === 'Previous answer'));
    assert.match(call.body.messages[0].content, /Abdul Qadir created Lumora AI/);
    assert.match(call.body.messages[0].content, /LIVE DATA FAILURES/);
  } finally {
    groqMockApi.child.kill();
  }
});

test('input validation', async () => {
  const post = (body, url = '/api/chat/stream') => fetch(`${api}${url}`, { method: 'POST', headers: auth, body });
  const cases = [
    ['{bad json', 'invalid_json'],
    [JSON.stringify({ model: 'gpt-oss-20b', messages: [] }), 'invalid_request'],
    [JSON.stringify({ model: 'gpt-oss-20b', messages: [{ role: 'system', content: 'x' }] }), 'invalid_request'],
    [JSON.stringify({ model: 'gpt-oss-20b', messages: [{ role: 'user', content: '   ' }] }), 'invalid_request'],
    [JSON.stringify({ model: 'gpt-oss-20b', messages: [{ role: 'assistant', content: 'x' }] }), 'invalid_request'],
    [JSON.stringify({ model: 'gpt-oss-20b', messages: [{ role: 'user', content: 'x'.repeat(8001) }] }), 'invalid_request'],
    [chatBody('hi', { tools: 'everything' }), 'invalid_request'],
    [chatBody('hi', { model: 'gpt-5-ultra' }), 'invalid_model'],
  ];
  for (const [body, code] of cases) {
    const r = await post(body);
    assert.equal(r.status, 400, body.slice(0, 40));
    assert.equal((await r.json()).error.code, code);
  }
  assert.equal((await post(JSON.stringify({ location: 'x'.repeat(101) }), '/api/tools/weather')).status, 400);
  assert.equal((await post(JSON.stringify({ location: { $ne: 1 } }), '/api/tools/weather')).status, 400);
  assert.equal((await post(JSON.stringify({ from: 'US', to: 'EUR' }), '/api/tools/currency')).status, 400);
  assert.equal((await post(JSON.stringify({ from: 'USD', to: 'EUR', amount: -5 }), '/api/tools/currency')).status, 400);
  assert.equal((await post(JSON.stringify({ from: 'ZZZ', to: 'EUR' }), '/api/tools/currency')).status, 400);
  assert.equal((await post(JSON.stringify({ from: 'USD', to: 'EUR', amount: 0 }), '/api/tools/currency')).status, 400);
  assert.equal((await post(JSON.stringify({ assets: [] }), '/api/tools/crypto')).status, 400);
  assert.equal((await post(JSON.stringify({ query: '' }), '/api/tools/search')).status, 400);
  assert.equal((await post('x'.repeat(300 * 1024))).status, 413);
  assert.equal((await fetch(`${api}/api/nope`, { headers: auth })).status, 404);
});

test('explicit web-search phrasing routes to search and reports missing configuration without sources', async () => {
  const requests = [
    'Search the web for Salar and Imama',
    'Search online for Salar and Imama',
    'Search Google for Salar and Imama',
    'Browse the web for Salar and Imama',
    'Look this up online',
    'Find information online about Salar and Imama',
    'Search for the character Salar and Imama',
    'Who is Imama? Search the web for her history',
  ];

  for (const content of requests) {
    const r = await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody(content) });
    assert.equal(r.status, 200, content);
    const events = parseSSE(await r.text());
    const meta = events.find((e) => e.event === 'meta')?.data;
    assert.ok(meta, `${content}: expected stream metadata`);
    assert.deepEqual(meta.sources, [], `${content}: no results means no citations`);
    assert.deepEqual(meta.tools, [], `${content}: no results means no search result cards`);
    assert.deepEqual(meta.toolErrors, [
      { type: 'search', message: 'Web search could not be retrieved: Web search is not configured on the server.' },
    ], `${content}: missing Tavily configuration should be reported clearly`);
  }
});

test('successful Tavily results reach the Groq streaming context and match numbered source metadata', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const callStart = provider.calls.length;
    const response = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth, body: chatBody('Search the web for fixture search facts'),
    });
    assert.equal(response.status, 200);
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    assert.ok(meta);
    const search = meta.tools.find((tool) => tool.type === 'search');
    assert.ok(search);
    assert.deepEqual(
      search.data.results.map(({ n, title, url: sourceUrl, domain }) => ({ n, title, url: sourceUrl, domain })),
      [
        { n: 1, title: 'Fixture Search Source One', url: 'https://source-one.example.test/search-fact', domain: 'source-one.example.test' },
        { n: 2, title: 'Fixture Search Source Two', url: 'https://source-two.example.test/second-fact', domain: 'source-two.example.test' },
      ],
    );
    assert.deepEqual(
      meta.sources.map(({ n, title, url: sourceUrl, domain }) => ({ n, title, url: sourceUrl, domain })),
      search.data.results.map(({ n, title, url: sourceUrl, domain }) => ({ n, title, url: sourceUrl, domain })),
    );

    const call = provider.calls.slice(callStart).at(-1);
    assert.equal(call.body.stream, true);
    const system = call.body.messages[0].content;
    assert.match(system, /\[1\] SEARCH RESULT \(Tavily, published .* retrieved at .*\): Fixture Search Source One — source-one\.example\.test\. URL: https:\/\/source-one\.example\.test\/search-fact\nFixture search fact one/);
    assert.match(system, /\[2\] SEARCH RESULT \(Tavily, published .* retrieved at .*\): Fixture Search Source Two — source-two\.example\.test\. URL: https:\/\/source-two\.example\.test\/second-fact\nFixture search fact two/);
    assert.match(system, /WEB SEARCH RESPONSE RULES: Validated live search results are present/);
    assert.match(system, /Never claim that web search or real-time browsing is unavailable while search results are present/);
    assert.match(system, /existing numbered references/);
    assert.match(system, /UNTRUSTED WEB CONTENT/);
  } finally {
    child.kill();
  }
});

test('successful Tavily results reach the Groq non-streaming context', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const callStart = provider.calls.length;
    const response = await fetch(`${url}/api/chat`, {
      method: 'POST', headers: auth, body: chatBody('Search online for fixture search facts'),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.sources.map(({ n, title, url: sourceUrl }) => ({ n, title, url: sourceUrl })), [
      { n: 1, title: 'Fixture Search Source One', url: 'https://source-one.example.test/search-fact' },
      { n: 2, title: 'Fixture Search Source Two', url: 'https://source-two.example.test/second-fact' },
    ]);
    assert.deepEqual(result.tools.find((tool) => tool.type === 'search').data.results.map((entry) => entry.n), [1, 2]);

    const call = provider.calls.slice(callStart).at(-1);
    assert.equal(call.body.stream, false);
    assert.match(call.body.messages[0].content, /\[1\] SEARCH RESULT \(Tavily, published .* retrieved at .*\): Fixture Search Source One — source-one\.example\.test\. URL: https:\/\/source-one\.example\.test\/search-fact\nFixture search fact one/);
    assert.match(call.body.messages[0].content, /\[2\] SEARCH RESULT \(Tavily, published .* retrieved at .*\): Fixture Search Source Two — source-two\.example\.test\. URL: https:\/\/source-two\.example\.test\/second-fact\nFixture search fact two/);
    assert.match(call.body.messages[0].content, /WEB SEARCH RESPONSE RULES: Validated live search results are present/);
  } finally {
    child.kill();
  }
});

test('gold price follow-up performs a fresh dated search and an authoritative AED-to-INR calculation', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const history = [
    { role: 'user', content: 'Search on web current 22K gold price in Dubai' },
    { role: 'assistant', content: 'Earlier answer guessed AED 999 per gram [1].' },
    { role: 'user', content: 'Convert in INR' },
  ];
  try {
    const streamStart = provider.calls.length;
    const streamFxCallsBefore = provider.fxCalls;
    const streamed = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth, body: chatConversationBody(history),
    });
    assert.equal(streamed.status, 200);
    const events = parseSSE(await streamed.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    const search = meta.tools.find((tool) => tool.type === 'search');
    const fx = meta.tools.find((tool) => tool.type === 'currency');
    assert.ok(search);
    assert.ok(fx);
    assert.equal(search.data.results[0].n, 1);
    assert.equal(search.data.results[0].publishedAt, meta.sources[0].publishedAt);
    assert.ok(search.data.results[0].retrievedAt);
    assert.equal(fx.data.from, 'AED');
    assert.equal(fx.data.to, 'INR');
    assert.equal(fx.data.amount, 300);
    assert.equal(fx.data.rate, 22.5);
    assert.equal(fx.data.result, 6750);
    assert.equal(fx.data.unit, 'per gram');
    assert.equal(fx.data.quote.karat, '22K');
    assert.equal(fx.data.quoteSourceN, 1);
    assert.equal(fx.data.n, 2);
    assert.equal(fx.data.rateType, 'indicative_midpoint');
    assert.equal(meta.tools.filter((tool) => tool.type === 'currency').length, 1);
    assert.equal(provider.fxCalls - streamFxCallsBefore, 1, 'one FX request should serve the verified quote');
    assert.ok(fx.data.providerUpdatedAt);
    assert.ok(fx.data.retrievedAt);
    assert.match(fx.data.calculation, /300 AED per gram × 22\.5 INR\/AED = 6750 INR per gram/);
    assert.deepEqual(meta.sources.map((source) => source.n), [1, 2]);
    const streamedCall = provider.calls.slice(streamStart).at(-1);
    assert.match(streamedCall.body.messages[0].content, /source date .* retrieved at/);
    assert.match(streamedCall.body.messages[0].content, /indicative midpoint/);
    assert.match(streamedCall.body.messages[0].content, /Use citations \[1\] for the quote and \[2\] for the rate/);
    assert.doesNotMatch(streamedCall.body.messages[0].content, /AED 999 per gram/);
    const streamedText = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
    assert.match(streamedText, /300 AED per gram.*6750 INR per gram/s);
    assert.match(streamedText, /\[1\].*\[2\]/s);

    const nonStreamStart = provider.calls.length;
    const nonStreamFxCallsBefore = provider.fxCalls;
    const nonStreamed = await fetch(`${url}/api/chat`, {
      method: 'POST', headers: auth, body: chatConversationBody(history),
    });
    assert.equal(nonStreamed.status, 200);
    const result = await nonStreamed.json();
    const nonStreamFx = result.tools.find((tool) => tool.type === 'currency').data;
    assert.equal(nonStreamFx.result, fx.data.result);
    assert.equal(nonStreamFx.unit, fx.data.unit);
    assert.equal(result.tools.filter((tool) => tool.type === 'currency').length, 1);
    assert.equal(provider.fxCalls - nonStreamFxCallsBefore, 1, 'non-streaming should also make one FX request');
    assert.deepEqual(result.sources.map((source) => source.n), [1, 2]);
    const nonStreamCall = provider.calls.slice(nonStreamStart).at(-1);
    assert.equal(nonStreamCall.body.stream, false);
    assert.match(nonStreamCall.body.messages[0].content, /Verified calculation: 300 AED per gram/);
  } finally {
    child.kill();
  }
});

test('gold conversion follow-ups apply an explicit purity, retain location, and scope citations per response', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const original = { role: 'user', content: 'Current gold price in Dubai' };
  const request = async (messages, streaming) => {
    const response = await fetch(`${url}/api/chat${streaming ? '/stream' : ''}`, {
      method: 'POST', headers: auth, body: chatConversationBody(messages),
    });
    assert.equal(response.status, 200);
    if (!streaming) {
      const result = await response.json();
      return { content: result.content, meta: result };
    }
    const events = parseSSE(await response.text());
    return {
      content: events.filter((event) => event.event === 'token').map((event) => event.data.t).join(''),
      meta: events.find((event) => event.event === 'meta')?.data,
    };
  };

  try {
    const first = await request([original], false);
    assert.deepEqual(first.meta.sources.map((source) => source.n), [1]);

    for (const item of [
      { phrase: '22K', karat: '22K', amount: 300, result: 6750, streaming: true },
      { phrase: '24 karat', karat: '24K', amount: 350, result: 7875, streaming: false },
      { phrase: '18K', karat: '18K', amount: 250, result: 5625, streaming: true },
      { phrase: '18 karat', karat: '18K', amount: 250, result: 5625, streaming: false },
    ]) {
      const staleAssistant = { role: 'assistant', content: 'Earlier answer mentioned AED 999 per gram [7].' };
      const history = [original, staleAssistant, { role: 'user', content: `Convert ${item.phrase} to INR` }];
      const fxCallsBefore = provider.fxCalls;
      const result = await request(history, item.streaming);
      const search = result.meta.tools.find((tool) => tool.type === 'search');
      const fxTools = result.meta.tools.filter((tool) => tool.type === 'currency');
      const fx = fxTools[0]?.data;

      assert.ok(search);
      assert.match(search.data.query, new RegExp(`gold ${item.karat}.*Dubai`, 'i'));
      assert.equal(fxTools.length, 1);
      assert.equal(fx.from, 'AED');
      assert.equal(fx.to, 'INR');
      assert.equal(fx.amount, item.amount);
      assert.equal(fx.result, item.result);
      assert.equal(fx.quote.karat, item.karat);
      assert.equal(fx.quote.label, 'gold');
      assert.equal(fx.quoteSourceN, 1);
      assert.equal(fx.n, 2);
      assert.equal(provider.fxCalls - fxCallsBefore, 1);
      assert.deepEqual(result.meta.sources.map((source) => source.n), [1, 2], 'each response numbers its own sources from one');
      assert.equal(result.meta.sources[0].url, search.data.results[0].url);
      assert.equal(result.meta.sources[1].provider, 'ExchangeRate-API');
      assert.match(result.content, new RegExp(`${item.amount} AED per gram.*${item.result} INR per gram`, 's'));
      assert.match(result.content, /\[1\].*\[2\]/s);
      assert.doesNotMatch(result.content, /\[7\]|999/);

      const currentPrompt = provider.calls.at(-1).body.messages[0].content;
      assert.match(currentPrompt, /Use citations \[1\] for the quote and \[2\] for the rate/);
      assert.doesNotMatch(currentPrompt, /\[7\]|999/);

      const alternate = await request(history, !item.streaming);
      assert.equal(alternate.content, result.content, 'stream and non-stream responses should match');
      assert.deepEqual(alternate.meta.sources.map((source) => source.n), [1, 2]);
      assert.equal(provider.fxCalls - fxCallsBefore, 2, 'each separate chat request should make exactly one FX request');
    }

    const conflictingHistory = [
      { role: 'user', content: 'Current gold price in Dubai GoldAmbiguousFixture' },
      { role: 'user', content: 'Convert 22K to INR' },
    ];
    const callsBeforeConflict = provider.calls.length;
    const conflictFxCallsBefore = provider.fxCalls;
    const conflicting = await requestGoldResponse(url, conflictingHistory, true);
    const conflictRates = conflicting.meta.tools.filter((tool) => tool.type === 'currency');
    assert.equal(conflictRates.length, 1);
    assert.equal(conflictRates[0].data.quote, undefined);
    assert.equal(conflictRates[0].data.from, 'AED');
    assert.deepEqual(conflicting.meta.sources.map((source) => source.n), [1, 2, 3]);
    assert.match(conflicting.content, /22K gold listings conflict.*Which source listing should I use/i);
    assert.doesNotMatch(conflicting.content, /300 AED|305 AED/);
    assert.match(conflicting.meta.toolErrors.map((error) => error.message).join('\n'), /conflicting current prices/);
    assert.equal(provider.fxCalls - conflictFxCallsBefore, 1);
    assert.equal(provider.calls.length, callsBeforeConflict, 'conflicting quote must bypass Groq');

    const conflictingNonStream = await requestGoldResponse(url, conflictingHistory, false);
    const normalizeTimestamp = (text) => text.replace(/\(provider updated [^)]+\)/g, '(provider updated timestamp)');
    assert.equal(normalizeTimestamp(conflictingNonStream.content), normalizeTimestamp(conflicting.content));
    assert.deepEqual(conflictingNonStream.meta.sources.map((source) => source.n), [1, 2, 3]);
    assert.equal(provider.fxCalls - conflictFxCallsBefore, 2, 'a separate non-stream request should also make one FX call');
    assert.equal(provider.calls.length, callsBeforeConflict);
  } finally {
    child.kill();
  }
});

test('purity omitted from a gold conversion follow-up remains rejected with one rate-only result', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const history = [
    { role: 'user', content: 'Current gold price in Dubai' },
    { role: 'assistant', content: 'An earlier answer guessed 24K gold was AED 350 per gram [1].' },
    { role: 'user', content: 'Convert to INR' },
  ];
  try {
    const callsBefore = provider.calls.length;
    const streamFxCallsBefore = provider.fxCalls;
    const streamed = await requestGoldResponse(url, history, true);
    const streamFx = streamed.meta.tools.filter((tool) => tool.type === 'currency');
    assert.equal(streamFx.length, 1);
    assert.equal(streamFx[0].data.quote, undefined);
    assert.equal(streamFx[0].data.from, 'AED');
    assert.equal(streamFx[0].data.result, 22.5);
    assert.equal(provider.fxCalls - streamFxCallsBefore, 1);
    assert.match(streamed.content, /Which purity should I use—22K, 24K, or another karat/);
    assert.doesNotMatch(streamed.content, /350 AED|7,875|7875/);
    assert.equal(provider.calls.length, callsBefore, 'deterministic rejection bypasses Groq');

    const nonStreamFxCallsBefore = provider.fxCalls;
    const nonStreamed = await requestGoldResponse(url, history, false);
    const normalizeTimestamp = (text) => text.replace(/\(provider updated [^)]+\)/g, '(provider updated timestamp)');
    assert.equal(normalizeTimestamp(nonStreamed.content), normalizeTimestamp(streamed.content));
    assert.equal(nonStreamed.meta.tools.filter((tool) => tool.type === 'currency').length, 1);
    assert.equal(provider.fxCalls - nonStreamFxCallsBefore, 1);
    assert.equal(provider.calls.length, callsBefore);
  } finally {
    child.kill();
  }
});

test('currency routing retrieves AED, USD, GBP, and EUR rates to INR', async () => {
  for (const [from, rate] of [['AED', 22.5], ['USD', 83.5], ['GBP', 105.5], ['EUR', 90.5]]) {
    const current = await fetch(`${api}/api/chat/stream`, {
      method: 'POST', headers: auth, body: chatBody(`What is ${from} to INR today?`),
    });
    assert.equal(current.status, 200);
    const currentMeta = parseSSE(await current.text()).find((event) => event.event === 'meta')?.data;
    const currentFx = currentMeta.tools.find((tool) => tool.type === 'currency')?.data;
    assert.equal(currentFx.from, from);
    assert.equal(currentFx.to, 'INR');
    assert.equal(currentFx.amount, 1);
    assert.equal(currentFx.rate, rate);
  }

  const pairResponse = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth,
    body: chatConversationBody([
      { role: 'user', content: 'What is USD to INR today?' },
      { role: 'assistant', content: 'The current indicative pair was checked.' },
      { role: 'user', content: 'What about 100 dollars?' },
    ]),
  });
  assert.equal(pairResponse.status, 200);
  const pairEvents = parseSSE(await pairResponse.text());
  const pairMeta = pairEvents.find((event) => event.event === 'meta')?.data;
  const pairFx = pairMeta.tools.find((tool) => tool.type === 'currency')?.data;
  assert.equal(pairFx.from, 'USD');
  assert.equal(pairFx.to, 'INR');
  assert.equal(pairFx.amount, 100);
  assert.equal(pairFx.result, 8350);
  assert.equal(pairMeta.tools.some((tool) => tool.type === 'search'), false);
  assert.match(provider.calls.at(-1).body.messages[0].content, /indicative midpoint/);

  const assistantContext = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth,
    body: chatConversationBody([
      { role: 'user', content: 'What was the exchange pair?' },
      { role: 'assistant', content: 'It was USD to INR, at a guessed 9999 INR per dollar.' },
      { role: 'user', content: 'What about 100 dollars?' },
    ]),
  });
  const assistantContextEvents = parseSSE(await assistantContext.text());
  const assistantContextMeta = assistantContextEvents.find((event) => event.event === 'meta')?.data;
  const assistantContextFx = assistantContextMeta.tools.find((tool) => tool.type === 'currency')?.data;
  assert.equal(assistantContextFx.from, 'USD');
  assert.equal(assistantContextFx.to, 'INR');
  assert.equal(assistantContextFx.amount, 100);
  assert.equal(assistantContextFx.rate, 83.5);
  assert.doesNotMatch(provider.calls.at(-1).body.messages[0].content, /9999 INR per dollar/);

  const unclear = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth, body: chatBody('What about 100 dollars?'),
  });
  const unclearEvents = parseSSE(await unclear.text());
  const unclearMeta = unclearEvents.find((event) => event.event === 'meta')?.data;
  assert.deepEqual(unclearMeta.tools, []);
  assert.deepEqual(unclearMeta.sources, []);
  assert.match(unclearEvents.filter((event) => event.event === 'token').map((event) => event.data.t).join(''), /Which target currency/);

  const missingAmount = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth, body: chatBody('Convert in INR'),
  });
  const missingAmountEvents = parseSSE(await missingAmount.text());
  assert.deepEqual(missingAmountEvents.find((event) => event.event === 'meta')?.data.tools, []);
  assert.match(missingAmountEvents.filter((event) => event.event === 'token').map((event) => event.data.t).join(''), /What amount and source currency/);
});

test('missing gold purity rejects the search amount but independently returns the USD-to-INR rate', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const history = [
    { role: 'user', content: 'Search current gold price in USA MissingPurityFixture' },
    { role: 'assistant', content: 'The earlier search showed USD 61.70 for 24K gold.' },
    { role: 'user', content: 'Convert in INR' },
  ];
  const callsBefore = provider.calls.length;
  try {
    const response = await fetch(`${url}/api/chat/stream`, { method: 'POST', headers: auth, body: chatConversationBody(history) });
    assert.equal(response.status, 200);
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    const fx = meta.tools.find((tool) => tool.type === 'currency')?.data;
    const content = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
    assert.ok(meta.tools.some((tool) => tool.type === 'search'));
    assert.ok(fx);
    assert.equal(fx.from, 'USD');
    assert.equal(fx.to, 'INR');
    assert.equal(fx.rate, 83.5);
    assert.equal(fx.quote, undefined);
    assert.match(content, /Which purity should I use—22K, 24K, or another karat/);
    assert.match(content, /1 USD = 83\.5 INR/);
    assert.match(content, /provider updated .*\[\d+\]/);
    assert.doesNotMatch(content, /61\.70|24K gold price was USD/i);
    assert.match(meta.toolErrors.map((error) => error.message).join('\n'), /Gold purity was not specified/);
    assert.equal(provider.calls.length, callsBefore, 'rejected quote must bypass Groq generation');
  } finally {
    child.kill();
  }
});

test('ambiguous current gold quotes ask the user to choose and never expose candidate amounts to Groq', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const history = [
    { role: 'user', content: 'Search current 22K gold price in Dubai GoldAmbiguousFixture' },
    { role: 'user', content: 'Convert in INR' },
  ];
  const callsBefore = provider.calls.length;
  try {
    const response = await fetch(`${url}/api/chat/stream`, { method: 'POST', headers: auth, body: chatConversationBody(history) });
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    const fx = meta.tools.find((tool) => tool.type === 'currency')?.data;
    const content = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
    assert.equal(response.status, 200);
    assert.ok(fx);
    assert.equal(fx.from, 'AED');
    assert.equal(fx.rate, 22.5);
    assert.equal(fx.quote, undefined);
    assert.match(content, /listings conflict.*Which source listing should I use/i);
    assert.match(content, /1 AED = 22\.5 INR/);
    assert.doesNotMatch(content, /300 AED|305 AED/);
    assert.equal(meta.sources.length, 3);
    assert.equal(provider.calls.length, callsBefore);
  } finally {
    child.kill();
  }
});

test('rejected iPhone price stays out of the model while AED-to-INR retrieval succeeds', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const history = [
    { role: 'user', content: 'Latest iPhone 17 Pro price in UAE RejectedProductQuoteFixture' },
    { role: 'assistant', content: 'An earlier answer guessed AED 5,349.' },
    { role: 'user', content: 'Convert to INR' },
  ];
  const callsBefore = provider.calls.length;
  try {
    const response = await fetch(`${url}/api/chat/stream`, { method: 'POST', headers: auth, body: chatConversationBody(history) });
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    const fx = meta.tools.find((tool) => tool.type === 'currency')?.data;
    const content = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
    assert.equal(response.status, 200);
    assert.ok(fx);
    assert.equal(fx.from, 'AED');
    assert.equal(fx.to, 'INR');
    assert.equal(fx.rate, 22.5);
    assert.equal(fx.quote, undefined);
    assert.match(content, /Please choose or share a current listing that names the exact model beside its price/);
    assert.match(content, /1 AED = 22\.5 INR/);
    assert.doesNotMatch(content, /5,349|5349/);
    assert.match(meta.toolErrors.map((error) => error.message).join('\n'), /does not clearly associate that price/);
    assert.equal(meta.sources.length, 2);
    assert.equal(provider.calls.length, callsBefore, 'rejected price and its snippets must not reach Groq');
  } finally {
    child.kill();
  }
});

test('quote rejection is identical for streaming and non-streaming when the FX lookup fails', async () => {
  const { url, child } = await startServer({
    LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY, MOCK_EXCHANGE_RATE_FAILURE: '1',
  });
  const history = [
    { role: 'user', content: 'Latest iPhone 17 Pro price in UAE RejectedProductQuoteFixture' },
    { role: 'user', content: 'Convert to INR' },
  ];
  const callsBefore = provider.calls.length;
  try {
    const streamed = await fetch(`${url}/api/chat/stream`, { method: 'POST', headers: auth, body: chatConversationBody(history) });
    const streamEvents = parseSSE(await streamed.text());
    const streamMeta = streamEvents.find((event) => event.event === 'meta')?.data;
    const streamContent = streamEvents.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
    const nonStreamed = await fetch(`${url}/api/chat`, { method: 'POST', headers: auth, body: chatConversationBody(history) });
    const nonStream = await nonStreamed.json();
    assert.equal(streamed.status, 200);
    assert.equal(nonStreamed.status, 200);
    assert.equal(streamContent, nonStream.content);
    assert.equal(streamMeta.tools.some((tool) => tool.type === 'currency'), false);
    assert.equal(nonStream.tools.some((tool) => tool.type === 'currency'), false);
    assert.match(streamContent, /AED → INR exchange-rate lookup also failed/);
    assert.doesNotMatch(streamContent, /5,349|5349|22\.5|83\.5|provider updated|2026-/);
    assert.match(streamMeta.toolErrors.map((error) => error.message).join('\n'), /Exchange rates could not be retrieved for AED → INR/);
    assert.equal(provider.calls.length, callsBefore);
  } finally {
    child.kill();
  }
});

test('weather follow-up replaces the city and retains the prior forecast period', async () => {
  const response = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth,
    body: chatConversationBody([
      { role: 'user', content: 'Weather in Dubai tomorrow' },
      { role: 'assistant', content: 'Tomorrow in Dubai will be clear.' },
      { role: 'user', content: 'What about Abu Dhabi?' },
    ]),
  });
  assert.equal(response.status, 200);
  const events = parseSSE(await response.text());
  const meta = events.find((event) => event.event === 'meta')?.data;
  const weather = meta.tools.find((tool) => tool.type === 'weather')?.data;
  assert.ok(weather.location.startsWith('Abu Dhabi'));
  assert.equal(weather.requestedPeriod, 'tomorrow');
  assert.equal(weather.requestedForecastDate, weather.daily[1].date);
  assert.match(provider.calls.at(-1).body.messages[0].content, /requested period tomorrow/);
  assert.match(provider.calls.at(-1).body.messages[0].content, /Replace the previous location with the newly resolved location/);
});

test('product price follow-up re-searches and preserves the identified product and source', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const response = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth,
      body: chatConversationBody([
        { role: 'user', content: 'Latest iPhone price in UAE' },
        { role: 'assistant', content: 'I guessed AED 9,999.' },
        { role: 'user', content: 'Convert to INR' },
      ]),
    });
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    const fx = meta.tools.find((tool) => tool.type === 'currency')?.data;
    assert.equal(fx.from, 'AED');
    assert.equal(fx.to, 'INR');
    assert.equal(fx.amount, 3999);
    assert.equal(fx.unit, 'per item');
    assert.equal(fx.quote.label, 'iPhone 17');
    assert.equal(fx.quote.displayPrice, 'AED 3,999');
    assert.equal(fx.quote.title, 'Latest iPhone price listing');
    assert.equal(fx.quote.url, 'https://shop.example.test/iphone-price');
    assert.equal(fx.quote.domain, 'shop.example.test');
    assert.ok(fx.quote.publishedAt);
    assert.ok(fx.quote.retrievedAt);
    assert.equal(fx.result, 89977.5);
    assert.equal(fx.quoteSourceN, 1);
    assert.equal(fx.n, 2);
    assert.doesNotMatch(provider.calls.at(-1).body.messages[0].content, /AED 9,999/);
  } finally {
    child.kill();
  }
});

test('gold karat changes trigger a fresh exact-purity search, never reuse the prior karat quote', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const response = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth,
      body: chatConversationBody([
        { role: 'user', content: 'Current gold price' },
        { role: 'assistant', content: 'The 22K quote was AED 300 per gram.' },
        { role: 'user', content: 'What about 24K?' },
      ]),
    });
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    const search = meta.tools.find((tool) => tool.type === 'search');
    assert.ok(search);
    assert.equal(search.data.results[0].publishedAt != null, true);
    assert.match(search.data.results[0].snippet, /24K gold/);
    assert.doesNotMatch(search.data.results[0].snippet, /22K/);
    assert.equal(meta.tools.some((tool) => tool.type === 'currency'), false);
    assert.match(provider.calls.at(-1).body.messages[0].content, /fresh search for that purity only/);
  } finally {
    child.kill();
  }
});

test('stale, undated, and conflicting market prices never create a conversion', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    for (const [marker, expected] of [
      ['StaleFixture', /older than 24 hours/],
      ['UndatedFixture', /undated or older than 24 hours/],
      ['AmbiguousFixture', /conflicting current product prices/],
    ]) {
      const callsBefore = provider.calls.length;
      const response = await fetch(`${url}/api/chat/stream`, {
        method: 'POST', headers: auth,
        body: chatConversationBody([
          { role: 'user', content: `Latest iPhone price in UAE ${marker}` },
          { role: 'assistant', content: 'An old price was AED 3,000.' },
          { role: 'user', content: 'Convert to INR' },
        ]),
      });
      assert.equal(response.status, 200);
      const events = parseSSE(await response.text());
      const meta = events.find((event) => event.event === 'meta')?.data;
      assert.equal(meta.tools.some((tool) => tool.type === 'search'), true);
      const rateOnly = meta.tools.find((tool) => tool.type === 'currency')?.data;
      assert.ok(rateOnly, marker);
      assert.equal(rateOnly.from, 'AED', marker);
      assert.equal(rateOnly.to, 'INR', marker);
      assert.equal(rateOnly.amount, 1, marker);
      assert.equal(rateOnly.quote, undefined, marker);
      assert.equal(meta.sources.some((source) => source.provider === 'ExchangeRate-API'), true, marker);
      assert.match(meta.toolErrors.map((error) => error.message).join('\n'), expected);
      const answer = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
      assert.doesNotMatch(answer, /AED 4,699|AED 4,099|3,000/);
      assert.equal(provider.calls.length, callsBefore, `${marker}: rejected quote must bypass Groq`);
      if (marker === 'AmbiguousFixture') assert.match(answer, /Which source listing should I use/);
    }
  } finally {
    child.kill();
  }
});

test('product price formats map explicit currencies to fresh backend conversions', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const cases = [
    { marker: 'AEDPrefixFixture', location: 'UAE', target: 'INR', from: 'AED', amount: 4699, displayPrice: 'AED 4,699', rate: 22.5, result: 105727.5 },
    { marker: 'AEDDecimalFixture', location: 'UAE', target: 'INR', from: 'AED', amount: 4699, displayPrice: 'AED 4,699.00', rate: 22.5, result: 105727.5 },
    { marker: 'AEDSuffixFixture', location: 'UAE', target: 'INR', from: 'AED', amount: 4699, displayPrice: '4,699 AED', rate: 22.5, result: 105727.5 },
    { marker: 'USDCodeFixture', location: 'USA', target: 'INR', from: 'USD', amount: 999, displayPrice: 'USD 999', rate: 83.5, result: 83416.5 },
    { marker: 'INRCodeFixture', location: 'India', target: 'AED', from: 'INR', amount: 79900, displayPrice: 'INR 79,900', rate: 0.044, result: 3515.6 },
    { marker: 'RupeeSymbolFixture', location: 'India', target: 'AED', from: 'INR', amount: 79900, displayPrice: '₹79,900', rate: 0.044, result: 3515.6 },
    { marker: 'DollarSymbolFixture', location: 'USA', target: 'INR', from: 'USD', amount: 999, displayPrice: '$999', rate: 83.5, result: 83416.5 },
  ];
  try {
    for (const item of cases) {
      const history = [
        { role: 'user', content: `Latest iPhone 17 price in ${item.location} ${item.marker}` },
        { role: 'assistant', content: 'A previous answer guessed a different price.' },
        { role: 'user', content: `Convert to ${item.target}` },
      ];
      const response = await fetch(`${url}/api/chat/stream`, {
        method: 'POST', headers: auth, body: chatConversationBody(history),
      });
      assert.equal(response.status, 200, item.marker);
      const events = parseSSE(await response.text());
      const meta = events.find((event) => event.event === 'meta')?.data;
      const fx = meta.tools.find((tool) => tool.type === 'currency')?.data;
      assert.ok(fx, item.marker);
      assert.equal(fx.from, item.from, item.marker);
      assert.equal(fx.to, item.target, item.marker);
      assert.equal(fx.amount, item.amount, item.marker);
      assert.equal(fx.rate, item.rate, item.marker);
      assert.equal(fx.result, item.result, item.marker);
      assert.equal(fx.quote.label, 'iPhone 17', item.marker);
      assert.equal(fx.quote.displayPrice, item.displayPrice, item.marker);
      assert.equal(fx.quoteSourceN, 1, item.marker);
      assert.equal(fx.n, 2, item.marker);
      assert.deepEqual(meta.sources.map((source) => source.n), [1, 2], item.marker);
      const answer = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
      assert.ok(answer.includes(item.displayPrice), item.marker);
      assert.match(answer, new RegExp(`${item.amount} ${item.from} per item.*${item.result} ${item.target} per item`, 's'), item.marker);
      assert.match(answer, /\[1\].*\[2\]/s, item.marker);
    }

    const history = [
      { role: 'user', content: 'Latest iPhone 17 price in UAE AEDPrefixFixture' },
      { role: 'assistant', content: 'A previous answer guessed AED 8,888.' },
      { role: 'user', content: 'Convert to INR' },
    ];
    const streamResult = await fetch(`${url}/api/chat/stream`, { method: 'POST', headers: auth, body: chatConversationBody(history) });
    const streamMeta = parseSSE(await streamResult.text()).find((event) => event.event === 'meta')?.data;
    const nonStreamResult = await fetch(`${url}/api/chat`, { method: 'POST', headers: auth, body: chatConversationBody(history) });
    const nonStream = await nonStreamResult.json();
    assert.equal(streamResult.status, 200);
    assert.equal(nonStreamResult.status, 200);
    assert.equal(nonStream.tools.find((tool) => tool.type === 'currency').data.result, streamMeta.tools.find((tool) => tool.type === 'currency').data.result);
    assert.deepEqual(nonStream.sources.map((source) => source.n), [1, 2]);
    assert.match(provider.calls.at(-1).body.messages[0].content, /Verified calculation: 4699 AED per item/);
    assert.doesNotMatch(provider.calls.at(-1).body.messages[0].content, /AED 8,888/);
  } finally {
    child.kill();
  }
});

test('product-price validation excludes shipping, discounts without final prices, and ambiguous listings', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const shipping = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth,
      body: chatConversationBody([
        { role: 'user', content: 'Latest iPhone 17 price in UAE ShippingFixture' },
        { role: 'user', content: 'Convert to INR' },
      ]),
    });
    const shippingMeta = parseSSE(await shipping.text()).find((event) => event.event === 'meta')?.data;
    assert.equal(shippingMeta.tools.find((tool) => tool.type === 'currency').data.amount, 4699);

    for (const [marker, location, target, expectedError] of [
      ['ConflictingFixture', 'UAE', 'INR', /conflicting current product prices.*choose a listing/i],
      ['ShippingOnlyFixture', 'UAE', 'INR', /No unambiguous numeric product price and currency/],
      ['MissingCurrencyFixture', 'UAE', 'INR', /No unambiguous numeric product price and currency/],
      ['MissingPriceFixture', 'UAE', 'INR', /No unambiguous numeric product price and currency/],
      ['AmbiguousProductFixture', 'UAE', 'INR', /does not clearly associate that price with one specific iPhone model/],
      ['AmbiguousDollarFixture', '', 'INR', /currency symbol that is ambiguous/],
      ['DiscountFixture', 'UAE', 'INR', /No unambiguous numeric product price and currency/],
    ]) {
      const locationText = location ? ` in ${location}` : '';
      const callsBefore = provider.calls.length;
      const response = await fetch(`${url}/api/chat/stream`, {
        method: 'POST', headers: auth,
        body: chatConversationBody([
          { role: 'user', content: `Latest iPhone 17 price${locationText} ${marker}` },
          { role: 'user', content: `Convert to ${target}` },
        ]),
      });
      assert.equal(response.status, 200, marker);
      const events = parseSSE(await response.text());
      const meta = events.find((event) => event.event === 'meta')?.data;
      assert.ok(meta.tools.some((tool) => tool.type === 'search'), marker);
      const rateOnly = meta.tools.find((tool) => tool.type === 'currency')?.data;
      if (location) {
        assert.ok(rateOnly, marker);
        assert.equal(rateOnly.from, 'AED', marker);
        assert.equal(rateOnly.to, target, marker);
        assert.equal(rateOnly.quote, undefined, marker);
        assert.equal(meta.sources.some((source) => source.provider === 'ExchangeRate-API'), true, marker);
      } else {
        assert.equal(rateOnly, undefined, marker);
        assert.equal(meta.sources.some((source) => source.provider === 'ExchangeRate-API'), false, marker);
      }
      assert.match(meta.toolErrors.map((error) => error.message).join('\n'), expectedError, marker);
      const answer = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
      assert.equal(provider.calls.length, callsBefore, `${marker}: rejected quote must bypass Groq`);
      if (marker === 'ConflictingFixture') {
        assert.deepEqual(meta.sources.slice(0, 2).map((source) => source.url), [
          'https://shop.example.test/iphone-price',
          'https://other-retailer.example.test/iphone-price',
        ]);
        assert.match(answer, /Which source listing should I use/);
      }
    }

    const finalPrice = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth,
      body: chatConversationBody([
        { role: 'user', content: 'Latest iPhone 17 price in UAE DiscountFinalFixture' },
        { role: 'user', content: 'Convert to INR' },
      ]),
    });
    const finalMeta = parseSSE(await finalPrice.text()).find((event) => event.event === 'meta')?.data;
    const finalCurrency = finalMeta.tools.find((tool) => tool.type === 'currency');
    assert.ok(finalCurrency, JSON.stringify(finalMeta.toolErrors));
    assert.equal(finalCurrency.data.amount, 4399);
  } finally {
    child.kill();
  }
});

test('product prices stay associated with their iPhone model in mixed and multi-model results', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  const request = async (firstMessage, marker) => {
    const response = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth,
      body: chatConversationBody([
        { role: 'user', content: `${firstMessage} ${marker}` },
        { role: 'assistant', content: 'I will use only a current, source-verified listing.' },
        { role: 'user', content: 'Convert to INR' },
      ]),
    });
    assert.equal(response.status, 200, marker);
    return parseSSE(await response.text());
  };
  try {
    const mixedEvents = await request('Latest iPhone 17 Pro price in UAE', 'MixedProductFixture');
    const mixedMeta = mixedEvents.find((event) => event.event === 'meta')?.data;
    const mixedFx = mixedMeta.tools.find((tool) => tool.type === 'currency')?.data;
    assert.equal(mixedFx.amount, 4699);
    assert.equal(mixedFx.from, 'AED');
    assert.equal(mixedFx.quote.label, 'iPhone 17 Pro');
    assert.equal(mixedFx.quote.displayPrice, 'AED 4,699');
    assert.equal(mixedMeta.sources[0].url, 'https://shop.example.test/iphone-price');
    assert.equal(mixedFx.quoteSourceN, mixedMeta.sources[0].n);

    const titleOnlyEvents = await request('Latest iPhone 17 Pro price in UAE', 'TitleOnlyProductFixture');
    const titleOnlyMeta = titleOnlyEvents.find((event) => event.event === 'meta')?.data;
    const titleOnlyFx = titleOnlyMeta.tools.find((tool) => tool.type === 'currency')?.data;
    assert.ok(titleOnlyFx);
    assert.equal(titleOnlyFx.from, 'AED');
    assert.equal(titleOnlyFx.rate, 22.5);
    assert.equal(titleOnlyFx.quote, undefined);
    assert.equal(titleOnlyMeta.sources.some((source) => source.provider === 'ExchangeRate-API'), true);
    assert.match(titleOnlyMeta.toolErrors.map((error) => error.message).join('\n'), /does not clearly associate that price.*clearer listing/i);
    const titleOnlyAnswer = titleOnlyEvents.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
    assert.match(titleOnlyAnswer, /choose or share a current listing that names the exact model beside its price/);
    assert.doesNotMatch(titleOnlyAnswer, /3,299/);

    const explicitEvents = await request('Latest iPhone 17 Pro price in UAE', 'ExplicitProductFixture');
    const explicitMeta = explicitEvents.find((event) => event.event === 'meta')?.data;
    assert.equal(explicitMeta.tools.find((tool) => tool.type === 'currency').data.amount, 4699);
    assert.equal(explicitMeta.tools.find((tool) => tool.type === 'currency').data.quote.label, 'iPhone 17 Pro');

    const multiModelEvents = await request('Latest iPhone 17 Pro price in UAE', 'MultiModelFixture');
    const multiModelMeta = multiModelEvents.find((event) => event.event === 'meta')?.data;
    const multiModelFx = multiModelMeta.tools.find((tool) => tool.type === 'currency')?.data;
    assert.equal(multiModelFx.amount, 4699);
    assert.equal(multiModelFx.quote.label, 'iPhone 17 Pro');
    assert.equal(multiModelFx.quote.displayPrice, 'AED 4,699');
  } finally {
    child.kill();
  }
});

test('Live tools Off suppresses search and currency work for a contextual conversion', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const response = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth,
      body: chatConversationBody([
        { role: 'user', content: 'Current 22K gold price in Dubai' },
        { role: 'assistant', content: 'AED 300 per gram.' },
        { role: 'user', content: 'Convert in INR' },
      ], { tools: 'off' }),
    });
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    assert.deepEqual(meta.tools, []);
    assert.deepEqual(meta.sources, []);
    assert.deepEqual(meta.toolErrors, []);
    assert.match(provider.calls.at(-1).body.messages[0].content, /LIVE TOOLS DISABLED/);
  } finally {
    child.kill();
  }
});

test('news requests use one existing news provider rather than duplicating Tavily search', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const response = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth, body: chatBody('Latest news about fusion energy'),
    });
    assert.equal(response.status, 200);
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    assert.deepEqual(meta.tools.map((tool) => tool.type), ['news']);
    assert.equal(meta.sources[0].provider, 'Google News');
  } finally {
    child.kill();
  }
});

test('failed or disabled search is disclosed without inventing successful results', async () => {
  const failedStart = provider.calls.length;
  const failedResponse = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth, body: chatBody('Search the web for fixture search facts'),
  });
  const failedEvents = parseSSE(await failedResponse.text());
  const failedMeta = failedEvents.find((event) => event.event === 'meta')?.data;
  assert.deepEqual(failedMeta?.sources, []);
  assert.deepEqual(failedMeta?.tools, []);
  assert.equal(failedMeta?.toolErrors?.[0]?.type, 'search');
  const failedSystem = provider.calls.slice(failedStart).at(-1).body.messages[0].content;
  assert.match(failedSystem, /WEB SEARCH RESPONSE RULES: No validated live search results are available because the search request failed/);
  assert.doesNotMatch(failedSystem, /Fixture Search Source One|Fixture search fact one/);

  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, TAVILY_API_KEY: TAVILY_TEST_KEY });
  try {
    const disabledStart = provider.calls.length;
    const disabledResponse = await fetch(`${url}/api/chat/stream`, {
      method: 'POST', headers: auth, body: chatBody('Search the web for fixture search facts', { tools: 'off' }),
    });
    const disabledEvents = parseSSE(await disabledResponse.text());
    const disabledMeta = disabledEvents.find((event) => event.event === 'meta')?.data;
    assert.deepEqual(disabledMeta?.sources, []);
    assert.deepEqual(disabledMeta?.tools, []);
    assert.deepEqual(disabledMeta?.toolErrors, []);
    const disabledSystem = provider.calls.slice(disabledStart).at(-1).body.messages[0].content;
    assert.match(disabledSystem, /WEB SEARCH RESPONSE RULES: The user requested web search, but Live tools are disabled/);
    assert.doesNotMatch(disabledSystem, /Fixture Search Source One|Fixture search fact one/);
  } finally {
    child.kill();
  }
});

test('tools on enables explicit search and tools off prevents it', async () => {
  const enabled = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth, body: chatBody('Search online for Salar and Imama', { tools: 'on' }),
  });
  assert.equal(enabled.status, 200);
  const enabledMeta = parseSSE(await enabled.text()).find((e) => e.event === 'meta')?.data;
  assert.equal(enabledMeta?.toolErrors?.[0]?.type, 'search');
  assert.match(enabledMeta?.toolErrors?.[0]?.message || '', /Web search is not configured/);
  assert.deepEqual(enabledMeta?.sources, []);

  const disabled = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth, body: chatBody('Search online for Salar and Imama', { tools: 'off' }),
  });
  assert.equal(disabled.status, 200);
  const disabledMeta = parseSSE(await disabled.text()).find((e) => e.event === 'meta')?.data;
  assert.deepEqual(disabledMeta?.tools, []);
  assert.deepEqual(disabledMeta?.sources, []);
  assert.deepEqual(disabledMeta?.toolErrors, []);
});

test('direct search endpoint returns its clear missing-key error', async () => {
  const r = await fetch(`${api}/api/tools/search`, {
    method: 'POST', headers: auth, body: JSON.stringify({ query: 'Salar and Imama' }),
  });
  assert.equal(r.status, 503);
  assert.deepEqual(await r.json(), {
    error: { code: 'search_not_configured', message: 'Web search is not configured on the server.' },
  });
});

test('existing recency search routing remains active', async () => {
  const r = await fetch(`${api}/api/chat/stream`, {
    method: 'POST', headers: auth, body: chatBody('Latest developments in fusion energy'),
  });
  assert.equal(r.status, 200);
  const meta = parseSSE(await r.text()).find((e) => e.event === 'meta')?.data;
  assert.deepEqual(meta?.toolErrors, [
    { type: 'search', message: 'Web search could not be retrieved: Web search is not configured on the server.' },
  ]);
});

test('existing news and weather intents still route to their tools', async () => {
  const expectStatusAndAbort = async (content, label) => {
    const ctrl = new AbortController();
    const r = await fetch(`${api}/api/chat/stream`, {
      method: 'POST', headers: auth, body: chatBody(content), signal: ctrl.signal,
    });
    assert.equal(r.status, 200);
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    try {
      while (!text.includes(label)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      assert.ok(text.includes(label), `${content}: expected ${label}`);
    } finally {
      ctrl.abort();
      await reader.cancel().catch(() => {});
    }
  };

  await expectStatusAndAbort('Latest news about fusion energy', 'Scanning the latest headlines');
  await expectStatusAndAbort('Weather in Paris tomorrow', 'Checking live weather');
});

test('weather phrasing resolves the city and gives both GPT-OSS and Qwen the same authoritative result', async () => {
  const cases = [
    ['gpt-oss-20b', 'Current weather of Delhi'],
    ['gpt-oss-20b', "What's the weather in Delhi right now?"],
    ['qwen-3.8-27b', 'Current weather of Delhi'],
    ['qwen-3.8-27b', "What's the weather in Delhi right now?"],
  ];
  const answers = [];

  for (const [model, content] of cases) {
    const response = await fetch(`${api}/api/chat/stream`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ model, tools: 'auto', messages: [{ role: 'user', content }] }),
    });
    assert.equal(response.status, 200, content);
    const events = parseSSE(await response.text());
    const meta = events.find((event) => event.event === 'meta')?.data;
    const assistantText = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');

    assert.equal(meta?.model.id, model);
    assert.equal(meta?.tools.length, 1);
    assert.equal(meta?.tools[0].type, 'weather');
    assert.equal(meta?.tools[0].data.location, 'Delhi, Delhi, India');
    assert.equal(meta?.tools[0].data.current.temperatureC, 28);
    assert.equal(meta?.tools[0].data.provider, 'Open-Meteo');
    assert.deepEqual(meta?.toolErrors, []);
    assert.equal(meta?.sources.length, 1);
    assert.equal(meta?.sources[0].title, 'Live weather — Open-Meteo');
    assert.match(assistantText, /Current weather in Delhi, Delhi, India is 28°C, mainly clear \[1\]/);
    answers.push(assistantText);

    const call = provider.calls.at(-1);
    assert.equal(call.body.model, model === 'qwen-3.8-27b' ? 'qwen/qwen3.8-27b' : 'openai/gpt-oss-20b');
    assert.match(call.body.messages[0].content, /\[1\] WEATHER \(Open-Meteo, observation time .*retrieved at .*Delhi, Delhi, India\): 28°C/);
    assert.match(call.body.messages[0].content, /WEATHER RESPONSE RULES: The server weather result is authoritative/);
    assert.match(call.body.messages[0].content, /Never say that no location was given or that weather was not fetched when a WEATHER record is present/);
  }

  assert.equal(answers[0], answers[1]);
  assert.equal(answers[0], answers[2]);
  assert.equal(answers[0], answers[3]);
});

test('weather requests use the Worker GET endpoints with only their allowed parameters', async () => {
  const response = await fetch(`${api}/api/tools/weather`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ location: 'WorkerRouteProbe' }),
  });
  assert.equal(response.status, 200);
  const data = (await response.json()).data;
  assert.equal(data.location, 'WorkerRouteProbe, Test Region, Test Country');
  assert.equal(data.provider, 'Open-Meteo');
  assert.equal(data.providerUrl, 'https://open-meteo.com');
});

test('missing weather location asks for a city without generating a tool card or source', async () => {
  const response = await fetch(`${api}/api/chat/stream`, {
    method: 'POST',
    headers: auth,
    body: chatBody('Current weather'),
  });
  assert.equal(response.status, 200);
  const events = parseSSE(await response.text());
  const meta = events.find((event) => event.event === 'meta')?.data;
  const assistantText = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
  assert.deepEqual(meta?.tools, []);
  assert.deepEqual(meta?.sources, []);
  assert.equal(meta?.toolErrors?.[0]?.type, 'weather');
  assert.match(meta?.toolErrors?.[0]?.message || '', /No location was given/);
  assert.match(assistantText, /Which city would you like the current weather for/);
});

test('weather lookup failures report the failure and never emit a success card or citation', async () => {
  const response = await fetch(`${api}/api/chat/stream`, {
    method: 'POST',
    headers: auth,
    body: chatBody('Current weather of NoSuchCity'),
  });
  assert.equal(response.status, 200);
  const events = parseSSE(await response.text());
  const meta = events.find((event) => event.event === 'meta')?.data;
  const assistantText = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
  assert.deepEqual(meta?.tools, []);
  assert.deepEqual(meta?.sources, []);
  assert.equal(meta?.toolErrors?.[0]?.type, 'weather');
  assert.match(meta?.toolErrors?.[0]?.message || '', /Could not find a location named "NoSuchCity"/);
  assert.match(assistantText, /couldn't retrieve live weather/i);
  assert.doesNotMatch(assistantText, /\b\d+°C|\[1\]/);
});

test('weather cache reuses successful results by normalized location without collisions', async () => {
  const { url } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN });
  const lookup = async (location) => {
    const response = await fetch(`${url}/api/tools/weather`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ location }),
    });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };

  const first = await lookup('ProbeReuse');
  const repeated = await lookup('ProbeReuse');
  const caseVariant = await lookup('probereuse');
  const different = await lookup('ProbeDifferent');

  assert.equal(first.location, 'ProbeReuse #1, Probe Region, Probe Test');
  assert.deepEqual(repeated, first);
  assert.deepEqual(caseVariant, first);
  assert.equal(different.location, 'ProbeDifferent #1, Probe Region, Probe Test');
  assert.notEqual(different.location, first.location);
});

test('weather failures are not cached', async () => {
  const { url } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN });
  const lookup = () => fetch(`${url}/api/tools/weather`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ location: 'RetryCity' }),
  });

  const failed = await lookup();
  assert.equal(failed.status, 404);
  assert.equal((await failed.json()).error.code, 'location_not_found');

  const retried = await lookup();
  assert.equal(retried.status, 200);
  const data = (await retried.json()).data;
  assert.equal(data.location, 'RetryCity #2, Probe Region, Probe Test');
});

test('concurrent weather lookups are shared and one caller cancellation does not abort the other', async () => {
  const { url } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN });
  const request = (signal) => fetch(`${url}/api/tools/weather`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ location: 'ProbeConcurrent' }),
    signal,
  });
  const firstController = new AbortController();
  const first = request(firstController.signal);
  const firstSettled = first.then((response) => ({ response }), (error) => ({ error }));
  await new Promise((resolve) => setTimeout(resolve, 40));
  const second = request();
  await new Promise((resolve) => setTimeout(resolve, 40));
  firstController.abort();

  const firstResult = await firstSettled;
  assert.equal(firstResult.error?.name, 'AbortError');
  const secondResponse = await second;
  assert.equal(secondResponse.status, 200);
  const data = (await secondResponse.json()).data;
  assert.equal(data.location, 'ProbeConcurrent #1, Probe Region, Probe Test');
});

test('weather provider rate limits are reported clearly without success cards or citations', async () => {
  const response = await fetch(`${api}/api/chat/stream`, {
    method: 'POST',
    headers: auth,
    body: chatBody('Current weather of RateLimitWeather'),
  });
  assert.equal(response.status, 200);
  const events = parseSSE(await response.text());
  const meta = events.find((event) => event.event === 'meta')?.data;
  const assistantText = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');

  assert.deepEqual(meta?.tools, []);
  assert.deepEqual(meta?.sources, []);
  assert.equal(meta?.toolErrors?.[0]?.type, 'weather');
  assert.match(meta?.toolErrors?.[0]?.message || '', /temporarily rate limiting/i);
  assert.match(assistantText, /couldn't retrieve live weather/i);
  assert.doesNotMatch(assistantText, /\b\d+°C|\[1\]/);
});

test('provider failures log safe diagnostics while preserving public errors', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN });
  const logLines = [];
  let stderrBuffer = '';
  const diagnosticsReady = new Promise((resolve) => {
    const onStderr = (chunk) => {
      const pieces = (stderrBuffer + chunk.toString()).split('\n');
      stderrBuffer = pieces.pop();
      for (const line of pieces) {
        if (line.includes('[lumora] provider request failed')) logLines.push(line);
      }
      if (logLines.length >= 2) {
        clearTimeout(timer);
        child.stderr.off('data', onStderr);
        resolve(logLines.slice(0, 2));
      }
    };
    const timer = setTimeout(() => {
      child.stderr.off('data', onStderr);
      resolve(logLines);
    }, 1500);
    child.stderr.on('data', onStderr);
  });

  const networkResponse = await fetch(`${url}/api/tools/weather`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ location: 'NetworkFailureSentinel' }),
  });
  const networkError = await networkResponse.json();
  assert.equal(networkResponse.status, 502);
  assert.deepEqual(networkError.error, { code: 'tool_network', message: 'Provider could not be reached' });

  const httpResponse = await fetch(`${url}/api/tools/weather`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ location: 'HttpFailureSentinel' }),
  });
  const httpError = await httpResponse.json();
  assert.equal(httpResponse.status, 502);
  assert.deepEqual(httpError.error, { code: 'tool_http', message: 'Provider responded with HTTP 503' });

  const lines = await diagnosticsReady;
  const diagnostics = lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))));
  const network = diagnostics.find((entry) => entry.lumoraCode === 'tool_network');
  const upstreamHttp = diagnostics.find((entry) => entry.lumoraCode === 'tool_http');
  assert.deepEqual(network, {
    stage: 'weather_geocoding',
    providerHostname: 'lumora-weather-relay.abdulqadir04a.workers.dev',
    errorName: 'TypeError',
    lumoraCode: 'tool_network',
    causeCode: 'ECONNRESET',
    causeName: 'Error',
    timedOut: false,
  });
  assert.deepEqual(upstreamHttp, {
    stage: 'weather_geocoding',
    providerHostname: 'lumora-weather-relay.abdulqadir04a.workers.dev',
    errorName: 'Error',
    httpStatus: 503,
    lumoraCode: 'tool_http',
    timedOut: false,
  });
  assert.doesNotMatch(lines.join('\n'), /NetworkFailureSentinel|HttpFailureSentinel|fixture failure detail|fixture response body sentinel|Authorization|Bearer/);
});

test('geocoding and forecast 429 diagnostics use fixed stages and only sanitized metadata', async () => {
  const { url, child } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN });
  const logLines = [];
  let stderrBuffer = '';
  const diagnosticsReady = new Promise((resolve) => {
    const onStderr = (chunk) => {
      const pieces = (stderrBuffer + chunk.toString()).split('\n');
      stderrBuffer = pieces.pop();
      for (const line of pieces) {
        if (line.includes('[lumora] provider request failed')) logLines.push(line);
      }
      if (logLines.length >= 2) {
        clearTimeout(timer);
        child.stderr.off('data', onStderr);
        resolve(logLines.slice(0, 2));
      }
    };
    const timer = setTimeout(() => {
      child.stderr.off('data', onStderr);
      resolve(logLines);
    }, 1500);
    child.stderr.on('data', onStderr);
  });

  const geocodingResponse = await fetch(`${url}/api/tools/weather`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ location: 'GeocodeRateLimitSentinel' }),
  });
  assert.equal(geocodingResponse.status, 503);
  assert.deepEqual((await geocodingResponse.json()).error, {
    code: 'tool_rate_limited',
    message: 'Provider rate limit reached — try again in a minute',
  });

  const forecastResponse = await fetch(`${url}/api/chat/stream`, {
    method: 'POST',
    headers: auth,
    body: chatBody('Current weather of ForecastRateLimitSentinel'),
  });
  assert.equal(forecastResponse.status, 200);
  const events = parseSSE(await forecastResponse.text());
  const meta = events.find((event) => event.event === 'meta')?.data;
  const assistantText = events.filter((event) => event.event === 'token').map((event) => event.data.t).join('');
  assert.deepEqual(meta?.tools, []);
  assert.deepEqual(meta?.sources, []);
  assert.equal(meta?.toolErrors?.[0]?.type, 'weather');
  assert.match(meta?.toolErrors?.[0]?.message || '', /temporarily rate limiting/i);
  assert.match(assistantText, /couldn't retrieve live weather/i);
  assert.doesNotMatch(assistantText, /\b\d+°C|\[1\]/);

  const lines = await diagnosticsReady;
  const diagnostics = lines.map((line) => JSON.parse(line.slice(line.indexOf('{'))));
  const geocoding = diagnostics.find((entry) => entry.stage === 'weather_geocoding');
  const forecast = diagnostics.find((entry) => entry.stage === 'weather_forecast');
  assert.deepEqual(geocoding, {
    stage: 'weather_geocoding',
    providerHostname: 'lumora-weather-relay.abdulqadir04a.workers.dev',
    errorName: 'Error',
    httpStatus: 429,
    lumoraCode: 'tool_rate_limited',
    retryAfterSeconds: geocoding.retryAfterSeconds,
    rateLimitRemaining: 0,
    timedOut: false,
  });
  assert.ok(Number.isInteger(geocoding.retryAfterSeconds) && geocoding.retryAfterSeconds > 0 && geocoding.retryAfterSeconds <= 60);
  assert.deepEqual(forecast, {
    stage: 'weather_forecast',
    providerHostname: 'lumora-weather-relay.abdulqadir04a.workers.dev',
    errorName: 'Error',
    httpStatus: 429,
    lumoraCode: 'tool_rate_limited',
    retryAfterSeconds: 12,
    rateLimitLimit: 600,
    rateLimitRemaining: 0,
    rateLimitResetSeconds: 60,
    timedOut: false,
  });
  const serializedLogs = lines.join('\n');
  assert.doesNotMatch(
    serializedLogs,
    /GeocodeRateLimitSentinel|ForecastRateLimitSentinel|fixture .*response body sentinel|\?name=|latitude=|longitude=|Authorization|Bearer|0123456789abcdef0123456789abcdef/,
  );
});

test('an explicit Google web search about weather routes to search, not the weather resolver', async () => {
  const response = await fetch(`${api}/api/chat/stream`, {
    method: 'POST',
    headers: auth,
    body: chatBody('Search Google for weather in Delhi'),
  });
  assert.equal(response.status, 200);
  const events = parseSSE(await response.text());
  const meta = events.find((event) => event.event === 'meta')?.data;
  assert.deepEqual(meta?.tools, []);
  assert.deepEqual(meta?.sources, []);
  assert.deepEqual(meta?.toolErrors?.map((error) => error.type), ['search']);
  assert.match(meta?.toolErrors?.[0]?.message || '', /Web search is not configured/);
  assert.equal(provider.calls.at(-1).body.messages[0].content.includes('[1] WEATHER'), false);
});

test('SSE stream: status → meta → tokens → done; reasoning params sent only for Groq', async () => {
  const r = await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('hello', { timezone: 'Asia/Tokyo' }) });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const events = parseSSE(await r.text());
  const names = events.map((e) => e.event);
  assert.deepEqual([names[0], names.at(-1)], ['status', 'done']);
  assert.ok(names.indexOf('meta') < names.indexOf('token'));
  assert.equal(
    events.filter((e) => e.event === 'token').map((e) => e.data.t).join(''),
    'Hello world',
  );
  const call = provider.calls.at(-1);
  assert.equal(call.body.stream, true);
  assert.equal(call.body.model, 'openai/gpt-oss-20b');
  assert.equal(call.body.reasoning_effort, undefined); // mock base URL is not groq.com
  assert.match(call.body.messages[0].content, /JST|GMT\+9/);
});

test('system prompt gives consistent creator identity', async () => {
  const r = await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('Who built you?') });
  assert.equal(r.status, 200);
  await r.text();

  const system = provider.calls.at(-1).body.messages[0];
  assert.equal(system.role, 'system');
  assert.match(system.content, /Abdul Qadir created Lumora AI as an AI application project/);
  assert.match(system.content, /undergraduate student in Applied AI and Data Science at IIT Jodhpur, India/);
  assert.match(system.content, /"Who built you\?".*approximately 70–110 words/);
  assert.match(system.content, /Do not invent Abdul's employment, awards, affiliations, or achievements/);
});

test('system prompt distinguishes Lumora, its provider, and the selected model', async () => {
  const r = await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('Who are you?') });
  assert.equal(r.status, 200);
  await r.text();

  const call = provider.calls.at(-1);
  const system = call.body.messages[0];
  assert.equal(call.body.model, 'openai/gpt-oss-20b');
  assert.match(system.content, /backend uses Node\.js and Express, and the mobile app uses React Native and Expo/);
  assert.match(system.content, /conversational AI, code generation, model selection, and live weather integration/);
  assert.match(system.content, /configured AI inference provider is Groq; the actual model generating this response is openai\/gpt-oss-20b/);
  assert.match(system.content, /Lumora AI is the application, Groq is the provider, and openai\/gpt-oss-20b is the model/);
  assert.match(system.content, /Never claim Lumora was developed by OpenAI or that it is ChatGPT\/GPT-4/);
  assert.match(system.content, /For "Who are you\?", use a shorter answer focused on Lumora itself/);
  assert.match(system.content, /Answer simple questions directly and concisely/);
  assert.match(system.content, /On mobile, prefer sections or lists to wide tables/);
  assert.match(system.content, /Give detailed step-by-step guidance when requested/);
  assert.match(system.content, /Never omit accuracy caveats or important safety information for brevity/);
});

test('non-streaming /api/chat returns 502 provider_malformed when provider streams anyway', async () => {
  const r = await fetch(`${api}/api/chat`, { method: 'POST', headers: auth, body: chatBody('FORCE_STREAM_IN_NONSTREAM') });
  assert.equal(r.status, 502);
});

test('client disconnect aborts the upstream LLM request', async () => {
  const before = provider.aborted;
  const ctrl = new AbortController();
  const r = await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('SLOW story'), signal: ctrl.signal });
  const reader = r.body.getReader();
  let text = '';
  while (!text.includes('event: token')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(provider.aborted, before + 1);
});

test('provider errors distinguish auth, model retirement, quota, rate limits, and transient failures', async () => {
  let n = provider.calls.length;
  let events = parseSSE(await (await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('UPSTREAM401 now') })).text());
  assert.equal(events.at(-1).event, 'error');
  assert.equal(events.at(-1).data.code, 'provider_auth');
  assert.equal(provider.calls.length - n, 1);

  n = provider.calls.length;
  events = parseSSE(await (await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('UPSTREAM403 now') })).text());
  assert.equal(events.at(-1).data.code, 'provider_access_denied');
  assert.equal(provider.calls.length - n, 1);

  n = provider.calls.length;
  events = parseSSE(await (await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('UPSTREAMMODEL400 now') })).text());
  assert.equal(events.at(-1).data.code, 'model_unavailable');
  assert.equal(provider.calls.length - n, 1);
  assert.doesNotMatch(events.at(-1).data.message, /credential detail/i);

  n = provider.calls.length;
  events = parseSSE(await (await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('UPSTREAMQUOTA now') })).text());
  assert.equal(events.at(-1).data.code, 'provider_quota_exceeded');
  assert.equal(events.at(-1).data.status, 503);
  assert.equal(provider.calls.length - n, 1); // quota errors are not retried

  n = provider.calls.length;
  events = parseSSE(await (await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('UPSTREAM429 now') })).text());
  assert.equal(events.at(-1).data.code, 'provider_rate_limited');
  assert.equal(provider.calls.length - n, 3); // rate limits remain retryable

  n = provider.calls.length;
  events = parseSSE(await (await fetch(`${api}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('UPSTREAM500 now') })).text());
  assert.equal(events.at(-1).data.code, 'provider_unavailable');
  assert.equal(provider.calls.length - n, 3); // 1 + 2 retries
});

test('rate limiting returns 429 with standard headers', async () => {
  const { url } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, CHAT_RATE_PER_MIN: '2' });
  const go = () => fetch(`${url}/api/chat/stream`, { method: 'POST', headers: auth, body: chatBody('hello') }).then(async (r) => (await r.text(), r));
  assert.equal((await go()).status, 200);
  assert.equal((await go()).status, 200);
  const limited = await go();
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.get('ratelimit-policy') || limited.headers.get('ratelimit'));
});

test('pre-auth limiter throttles invalid-token floods', async () => {
  const { url } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, API_RATE_PER_MIN: '3' });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${url}/api/models`, { headers: { Authorization: 'Bearer wrong' } })).status);
  assert.deepEqual(codes, [401, 401, 401, 429, 429]);
});

test('untrusted forwarded client IP headers cannot rotate the per-IP rate-limit key', async () => {
  const { url } = await startServer({ LUMORA_CLIENT_TOKENS: TOKEN, API_RATE_PER_MIN: '3' });
  const codes = [];
  for (let i = 1; i <= 5; i++) {
    const response = await fetch(`${url}/api/models`, {
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-Forwarded-For': `198.51.100.${i}` },
    });
    codes.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
});

test('test mode requires client tokens; local development without tokens remains available', async () => {
  await assert.rejects(startServer({ NODE_ENV: 'test' }), (e) => e.code === 1);

  const local = await startServer({ NODE_ENV: 'development' });
  try {
    assert.match(local.output, /backend listening on 127\.0\.0\.1:/);
    assert.equal((await fetch(`${local.url}/api/models`)).status, 200);
  } finally {
    local.child.kill();
  }

  await assert.rejects(startServer({ NODE_ENV: 'development', HOST: '0.0.0.0' }), (e) => e.code === 1);
  await assert.rejects(startServer({ NODE_ENV: 'development', HOST: '0.0.0.0', LUMORA_CLIENT_TOKENS: '' }), (e) => e.code === 1);
  await assert.rejects(startServer({ NODE_ENV: 'development', HOST: '0.0.0.0', LUMORA_CLIENT_TOKENS: 'too-short' }), (e) => e.code === 1);

  const ipv6Local = await startServer({ NODE_ENV: 'development', HOST: '::1' });
  try {
    assert.match(ipv6Local.output, /backend listening on ::1:/);
  } finally {
    ipv6Local.child.kill();
  }
});

test('production refuses to start without client tokens', async () => {
  await assert.rejects(startServer({ NODE_ENV: 'production', LLM_BASE_URL: 'https://api.groq.com/openai/v1' }), (e) => e.code === 1);
  await assert.rejects(startServer({ NODE_ENV: 'staging', LLM_BASE_URL: 'https://api.groq.com/openai/v1' }), (e) => e.code === 1);
});

test('production refuses weak tokens, HTTP upstreams, and numeric proxy hop counts', async () => {
  await assert.rejects(startServer({ NODE_ENV: 'production', LUMORA_CLIENT_TOKENS: 'too-short', LLM_BASE_URL: 'https://api.groq.com/openai/v1' }), (e) => e.code === 1);
  await assert.rejects(startServer({ NODE_ENV: 'production', LUMORA_CLIENT_TOKENS: TOKEN }), (e) => e.code === 1);
  await assert.rejects(startServer({ NODE_ENV: 'production', LUMORA_CLIENT_TOKENS: TOKEN, LLM_BASE_URL: 'https://api.groq.com/openai/v1', TRUST_PROXY: '1' }), (e) => e.code === 1);
  await assert.rejects(startServer({ NODE_ENV: 'production', LUMORA_CLIENT_TOKENS: TOKEN, LLM_BASE_URL: 'https://api.groq.com/openai/v1', TRUST_PROXY: 'render' }), (e) => e.code === 1);
  await assert.rejects(
    startServer({
      NODE_ENV: 'production',
      LUMORA_CLIENT_TOKENS: TOKEN,
      LLM_BASE_URL: 'https://api.groq.com/openai/v1',
      TRUST_PROXY: 'render',
      RENDER: 'true',
      RENDER_SERVICE_TYPE: 'worker',
    }),
    (e) => e.code === 1,
  );
});

test('production HTTPS enforcement accepts only trusted proxy scheme signals', async () => {
  const direct = await startServer({ NODE_ENV: 'production', LUMORA_CLIENT_TOKENS: TOKEN, LLM_BASE_URL: 'https://api.groq.com/openai/v1' });
  const spoofed = await fetch(`${direct.url}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.equal(spoofed.status, 403);

  const proxied = await startServer({ NODE_ENV: 'production', LUMORA_CLIENT_TOKENS: TOKEN, LLM_BASE_URL: 'https://api.groq.com/openai/v1', TRUST_PROXY: '127.0.0.1' });
  assert.equal((await fetch(`${proxied.url}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
  assert.equal((await fetch(`${proxied.url}/api/health`, { headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await fetch(`${proxied.url}/api/health`, { headers: { 'X-Forwarded-Proto': 'https, http' } })).status, 403);

  const render = await startServer({
    NODE_ENV: 'production',
    LUMORA_CLIENT_TOKENS: TOKEN,
    LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    TRUST_PROXY: 'render',
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web',
  });
  assert.equal((await fetch(`${render.url}/api/health`, { headers: { 'X-Forwarded-Proto': 'https' } })).status, 200);
  assert.equal((await fetch(`${render.url}/api/health`, { headers: { 'X-Forwarded-Proto': 'http' } })).status, 403);
  assert.equal((await fetch(`${render.url}/api/health`, { headers: { 'X-Forwarded-Proto': 'https, http' } })).status, 403);
  assert.equal((await fetch(`${render.url}/api/models`, { headers: { 'X-Forwarded-Proto': 'https' } })).status, 401);
});

test('Render rate limits fall back to the socket IP for absent or invalid Cloudflare IP headers', async () => {
  const render = await startServer({
    NODE_ENV: 'production',
    LUMORA_CLIENT_TOKENS: TOKEN,
    LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    TRUST_PROXY: 'render',
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web',
    API_RATE_PER_MIN: '2',
  });
  const clientIpInputs = [undefined, '', '   ', 'not-an-ip', '2001:db8::not-an-ip'];
  const responses = [];
  for (const [index, clientIp] of clientIpInputs.entries()) {
    const headers = {
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-For': `198.51.100.${index + 1}`,
    };
    if (clientIp !== undefined) headers['CF-Connecting-IP'] = clientIp;
    responses.push(await fetch(`${render.url}/api/health`, { headers }));
  }
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 429, 429, 429]);
});

test('Render-only Cloudflare IP keying stays disabled when TRUST_PROXY is not render', async () => {
  const nonRenderMode = await startServer({
    LUMORA_CLIENT_TOKENS: TOKEN,
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web',
    TRUST_PROXY: '',
    API_RATE_PER_MIN: '2',
  });
  const request = (clientIp) => fetch(`${nonRenderMode.url}/api/health`, {
    headers: { 'CF-Connecting-IP': clientIp },
  });
  const responses = [await request('203.0.113.10'), await request('203.0.113.20'), await request('203.0.113.10')];
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 429]);
});

test('Render rate limits accept IPv4 and IPv6 client IPs and ignore spoofed X-Forwarded-For', async () => {
  const render = await startServer({
    NODE_ENV: 'production',
    LUMORA_CLIENT_TOKENS: TOKEN,
    LLM_BASE_URL: 'https://api.groq.com/openai/v1',
    TRUST_PROXY: 'render',
    RENDER: 'true',
    RENDER_SERVICE_TYPE: 'web',
    API_RATE_PER_MIN: '2',
  });
  const request = (clientIp, spoofedIp) => fetch(`${render.url}/api/health`, {
    headers: {
      'X-Forwarded-Proto': 'https',
      'CF-Connecting-IP': clientIp,
      'X-Forwarded-For': spoofedIp,
    },
  });

  const responses = [
    await request('203.0.113.10', '198.51.100.1'),
    await request('2001:db8::20', '198.51.100.2'),
    await request('203.0.113.10', '198.51.100.3'),
    await request('203.0.113.10', '198.51.100.4'),
    await request('2001:db8::20', '198.51.100.5'),
    await request('2001:db8::20', '198.51.100.6'),
  ];
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 429, 200, 429]);
});
