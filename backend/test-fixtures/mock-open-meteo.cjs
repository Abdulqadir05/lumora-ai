const nativeFetch = globalThis.fetch;
const probeLookupCounts = new Map();
const retryLookupCounts = new Map();

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function assertQuery(url, expected) {
  const actualKeys = [...url.searchParams.keys()].sort();
  const expectedKeys = Object.keys(expected).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index]))
    throw new Error('Unexpected weather relay query parameters');
  for (const [key, value] of Object.entries(expected)) {
    if (url.searchParams.get(key) !== value) throw new Error('Unexpected weather relay query value');
  }
}

globalThis.fetch = async (input, init) => {
  if ('diagnosticStage' in (init || {})) throw new Error('diagnostic stage must not be forwarded to fetch');
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);

  if (url.hostname === 'api.tavily.com' && url.pathname === '/search') {
    if (init?.method !== 'POST') throw new Error('Tavily search requests must use POST');
    const key = process.env.TAVILY_API_KEY || '';
    if (!key || init?.headers?.Authorization !== `Bearer ${key}`) throw new Error('Unexpected Tavily request authentication');
    const body = JSON.parse(init.body || '{}');
    if (body.search_depth !== 'basic' || body.max_results < 1 || body.max_results > 8 || body.include_published_date !== true)
      throw new Error('Unexpected Tavily search options');
    const query = String(body.query || '').toLowerCase();
    const publishedAt = (ageMs = 60_000) => new Date(Date.now() - ageMs).toISOString();
    if (/iphone/.test(query)) {
      const makeResult = (content, suffix = 'shop', title = 'Latest iPhone price listing') => ({
        title,
        url: `https://${suffix}.example.test/iphone-price`,
        content,
        published_date: publishedAt(),
      });
      const content = /rejectedproductquotefixture/i.test(query) ? 'Samsung Galaxy S25 price in UAE: AED 5,349.'
        : /mixedproductfixture/i.test(query) ? 'iPhone 17 Pro price in UAE: AED 4,699. Samsung Galaxy S25 price in UAE: AED 3,299.'
        : /titleonlyproductfixture/i.test(query) ? 'Samsung Galaxy S25 price in UAE: AED 3,299.'
          : /explicitproductfixture/i.test(query) ? 'The listed price for iPhone 17 Pro in UAE is AED 4,699.'
            : /multimodelfixture/i.test(query) ? 'iPhone 17 Pro price in UAE: AED 4,699. iPhone 17 price in UAE: AED 3,299.'
              : /aedprefixfixture/i.test(query) ? 'iPhone 17 price in UAE: AED 4,699.'
        : /aedsuffixfixture/i.test(query) ? 'iPhone 17 price in UAE: 4,699 AED.'
          : /aeddecimalfixture/i.test(query) ? 'iPhone 17 price in UAE: AED 4,699.00.'
            : /usdcodefixture/i.test(query) ? 'iPhone 17 price in USA: USD 999.'
              : /inrcodefixture/i.test(query) ? 'iPhone 17 price in India: INR 79,900.'
                : /rupeesymbolfixture/i.test(query) ? 'iPhone 17 price in India: ₹79,900.'
                  : /dollarsymbolfixture/i.test(query) ? 'iPhone 17 price in USA: $999.'
                    : /ambiguousdollarfixture/i.test(query) ? 'iPhone 17 price: $999.'
                      : /conflictingfixture/i.test(query) ? 'iPhone 17 price in UAE: AED 4,699.'
                        : /shippingfixture/i.test(query) ? 'iPhone 17 price in UAE: AED 4,699. Shipping charge: AED 25.'
                          : /shippingonlyfixture/i.test(query) ? 'iPhone 17 price in UAE: Shipping charge AED 25.'
                            : /missingcurrencyfixture/i.test(query) ? 'iPhone 17 price in UAE: 4,699.'
                              : /missingpricefixture/i.test(query) ? 'iPhone 17 price in UAE: Price unavailable.'
                                : /ambiguousproductfixture/i.test(query) ? 'iPhone price in UAE: AED 4,699.'
                                  : /discountfixture/i.test(query) ? 'iPhone 17 price in UAE: AED 4,699; save AED 300.'
                                    : /discountfinalfixture/i.test(query) ? 'iPhone 17 price in UAE: List price AED 4,699. Final price: AED 4,399.'
                                      : 'iPhone 17 price in UAE: AED 3,999 per item.';
      const result = makeResult(content);
      if (/titleonlyproductfixture/i.test(query)) result.title = 'iPhone 17 Pro latest price listing in UAE';
      if (/rejectedproductquotefixture/i.test(query)) result.title = 'iPhone 17 Pro current price listing in UAE';
      if (/stale/i.test(query)) result.published_date = publishedAt(48 * 60 * 60 * 1000);
      if (/undated/i.test(query)) delete result.published_date;
      if (/conflictingfixture/i.test(query))
        return jsonResponse({ results: [result, makeResult('iPhone 17 price in UAE: AED 4,899.', 'other-retailer')] });
      if (/ambiguousfixture/i.test(query))
        return jsonResponse({ results: [result, makeResult('iPhone 17 price in UAE: AED 4,099.', 'other-shop')] });
      return jsonResponse({ results: [result] });
    }
    if (/gold/.test(query)) {
      const karat = /\b24k\b/.test(query) ? '24K' : /\b22k\b/.test(query) ? '22K' : '24K';
      const isDubai = /dubai/.test(query);
      const currency = isDubai ? 'AED' : 'USD';
      const amount = karat === '24K' ? '350' : '300';
      const result = {
        title: `${isDubai ? 'Dubai ' : ''}${karat} gold price today`,
        url: `https://${isDubai ? 'gold-dubai' : 'gold-market'}.example.test/${karat.toLowerCase()}-rate`,
        content: `${karat} gold${isDubai ? ' in Dubai' : ''} is ${currency} ${amount} per gram.`,
      };
      if (/missingpurityfixture/i.test(query)) {
        result.title = 'Current 24K gold price in the United States';
        result.content = '24K gold in the United States is USD 61.70 per gram.';
      }
      if (!/undated/i.test(query)) result.published_date = /stale/i.test(query) ? publishedAt(48 * 60 * 60 * 1000) : publishedAt();
      if (/ambiguous/i.test(query)) {
        const second = { ...result, title: `Another ${isDubai ? 'Dubai ' : ''}${karat} gold price`, url: 'https://other-gold.example.test/rate', content: `${karat} gold${isDubai ? ' in Dubai' : ''} is ${currency} ${Number(amount) + 5} per gram.` };
        if (!/undated/i.test(query)) second.published_date = publishedAt();
        return jsonResponse({ results: [result, second] });
      }
      return jsonResponse({ results: [result] });
    }
    return jsonResponse({
      results: [
        {
          title: 'Fixture Search Source One',
          url: 'https://source-one.example.test/search-fact',
          content: 'Fixture search fact one: the example result confirms the first detail.',
          published_date: '2026-11-01T00:00:00Z',
        },
        {
          title: 'Fixture Search Source Two',
          url: 'https://source-two.example.test/second-fact',
          content: 'Fixture search fact two: the second example source provides a separate detail.',
          published_date: '2026-11-01T00:00:00Z',
        },
      ],
    });
  }

  if (url.hostname === 'open.er-api.com' && /^\/v6\/latest\/[A-Z]{3}$/i.test(url.pathname)) {
    if (process.env.MOCK_EXCHANGE_RATE_FAILURE === '1') return new Response('{"result":"error"}', { status: 503, headers: { 'content-type': 'application/json' } });
    const base = url.pathname.split('/').at(-1).toUpperCase();
    const rates = {
      USD: { INR: 83.5, AED: 3.67, GBP: 0.79, EUR: 0.92 },
      AED: { INR: 22.5, USD: 0.2725, GBP: 0.215, EUR: 0.25 },
      INR: { AED: 0.044, USD: 0.012, GBP: 0.0095, EUR: 0.011 },
      GBP: { INR: 105.5, USD: 1.27, AED: 4.65, EUR: 1.17 },
      EUR: { INR: 90.5, USD: 1.09, AED: 4.0, GBP: 0.855 },
    };
    return jsonResponse({
      result: 'success',
      base_code: base,
      rates: { [base]: 1, ...(rates[base] || {}) },
      time_last_update_utc: new Date(Date.now() - 60 * 60 * 1000).toUTCString(),
      time_next_update_utc: new Date(Date.now() + 23 * 60 * 60 * 1000).toUTCString(),
    });
  }

  if (url.hostname === 'news.google.com' && url.pathname.startsWith('/rss')) {
    const published = new Date().toUTCString();
    return new Response(
      `<rss><channel><item><title>Fixture fusion news - Fixture News</title><link>https://news.example.test/fusion</link><source>Fixture News</source><pubDate>${published}</pubDate></item></channel></rss>`,
      { status: 200, headers: { 'content-type': 'application/rss+xml' } },
    );
  }

  if (url.hostname === 'lumora-weather-relay.abdulqadir04a.workers.dev' && url.pathname === '/geocoding') {
    if ((init?.method || 'GET') !== 'GET') throw new Error('Weather relay requests must use GET');
    const name = url.searchParams.get('name') || '';
    assertQuery(url, { name, count: '1', language: 'en', format: 'json' });
    const normalizedName = name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
    if (name === 'GeocodeRateLimitSentinel') {
      return new Response('fixture geocoding response body sentinel', {
        status: 429,
        headers: {
          'retry-after': new Date(Date.now() + 60_000).toUTCString(),
          'ratelimit-limit': '999999999999999999999999',
          'ratelimit-remaining': '0',
          'ratelimit-reset': 'not-a-number',
        },
      });
    }
    if (name === 'ForecastRateLimitSentinel') {
      return jsonResponse({
        results: [{ name, admin1: 'Probe Region', country: 'Probe Test', latitude: 45.6789, longitude: -123.4567 }],
      });
    }
    if (name === 'NetworkFailureSentinel') {
      const cause = Object.assign(new Error('fixture failure detail'), { code: 'ECONNRESET' });
      const error = new TypeError('fixture network failure detail', { cause });
      throw error;
    }
    if (name === 'HttpFailureSentinel') return new Response('fixture response body sentinel', { status: 503 });
    if (name === 'RateLimitWeather') return new Response('{}', { status: 429 });
    if (/^(nosuchcity|search on google)$/i.test(name)) return jsonResponse({ results: [] });
    if (name === 'RetryCity') {
      const count = (retryLookupCounts.get(normalizedName) || 0) + 1;
      retryLookupCounts.set(normalizedName, count);
      if (count === 1) return jsonResponse({ results: [] });
      return jsonResponse({ results: [{ name: `${name} #${count}`, admin1: 'Probe Region', country: 'Probe Test', latitude: 28.6, longitude: 77.2 }] });
    }
    if (/^Probe/.test(name)) {
      const count = (probeLookupCounts.get(normalizedName) || 0) + 1;
      probeLookupCounts.set(normalizedName, count);
      if (normalizedName === 'probeconcurrent') await new Promise((resolve) => setTimeout(resolve, 350));
      return jsonResponse({ results: [{ name: `${name} #${count}`, admin1: 'Probe Region', country: 'Probe Test', latitude: 28.6, longitude: 77.2 }] });
    }
    return jsonResponse({
      results: [
        {
          name,
          admin1: name.toLowerCase() === 'delhi' ? 'Delhi' : 'Test Region',
          country: name.toLowerCase() === 'delhi' ? 'India' : 'Test Country',
          latitude: 28.6139,
          longitude: 77.209,
        },
      ],
    });
  }

  if (url.hostname === 'lumora-weather-relay.abdulqadir04a.workers.dev' && url.pathname === '/forecast') {
    if ((init?.method || 'GET') !== 'GET') throw new Error('Weather relay requests must use GET');
    const latitude = url.searchParams.get('latitude');
    const longitude = url.searchParams.get('longitude');
    assertQuery(url, {
      latitude,
      longitude,
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m',
      daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
      timezone: 'auto',
      forecast_days: '4',
    });
    if (latitude === '45.6789' && longitude === '-123.4567') {
      return new Response('fixture forecast response body sentinel', {
        status: 429,
        headers: {
          'retry-after': '12',
          'ratelimit-limit': '600',
          'ratelimit-remaining': '0',
          'ratelimit-reset': '60',
        },
      });
    }
    return jsonResponse({
      timezone: 'Asia/Kolkata',
      current: {
        time: '2026-10-31T12:00',
        temperature_2m: 28,
        apparent_temperature: 30,
        relative_humidity_2m: 42,
        wind_speed_10m: 6,
        weather_code: 1,
      },
      daily: {
        time: ['2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'],
        weather_code: [1, 2, 3, 0],
        temperature_2m_min: [20, 21, 19, 20],
        temperature_2m_max: [31, 30, 29, 32],
        precipitation_probability_max: [0, 0, 5, 0],
      },
    });
  }

  if (
    url.hostname === 'lumora-weather-relay.abdulqadir04a.workers.dev' ||
    url.hostname === 'geocoding-api.open-meteo.com' ||
    url.hostname === 'api.open-meteo.com'
  )
    throw new Error('Unexpected weather relay host or path');

  return nativeFetch(input, init);
};
