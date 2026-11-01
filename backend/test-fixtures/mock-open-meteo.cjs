const nativeFetch = globalThis.fetch;

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input.url);

  if (url.hostname === 'geocoding-api.open-meteo.com') {
    const name = url.searchParams.get('name') || '';
    if (/^(nosuchcity|search on google)$/i.test(name)) return jsonResponse({ results: [] });
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

  if (url.hostname === 'api.open-meteo.com') {
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

  return nativeFetch(input, init);
};
