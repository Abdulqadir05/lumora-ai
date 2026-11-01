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
