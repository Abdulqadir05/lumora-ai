/**
 * Integration tests for Lumora AI (runs the real App.js in Jest via jest-expo).
 * Native modules and the network are mocked; nothing here exercises a real device.
 */
import React from 'react';
import { AccessibilityInfo, Alert, Animated, Linking, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
import { fetch as expoFetch } from 'expo/fetch';
import { TextEncoder } from 'util';
import App from '../App';

const encoder = new TextEncoder();

/** A controllable ReadableStream-like body that behaves like expo/fetch. */
function createStream(signal) {
  const queue = [];
  let waiter = null;
  let closed = false;
  let error = null;
  const wake = () => {
    const w = waiter;
    waiter = null;
    if (w) w();
  };
  const reader = {
    read: () =>
      new Promise((resolve, reject) => {
        const attempt = () => {
          if (error) return reject(error);
          if (queue.length) return resolve({ done: false, value: queue.shift() });
          if (closed) return resolve({ done: true, value: undefined });
          waiter = attempt;
          return undefined;
        };
        attempt();
      }),
    cancel: jest.fn(async () => {
      closed = true;
      wake();
    }),
  };
  if (signal) {
    signal.addEventListener('abort', () => {
      const e = new Error('Aborted');
      e.name = 'AbortError';
      error = e;
      wake();
    });
  }
  return {
    reader,
    body: { getReader: () => reader },
    raw(text) {
      queue.push(encoder.encode(text));
      wake();
    },
    send(event, data) {
      this.raw(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      closed = true;
      wake();
    },
  };
}

const okResponse = (body) => ({ ok: true, status: 200, body, headers: { get: () => null }, text: async () => '' });
const errorResponse = (status, code, message) => ({
  ok: false,
  status,
  body: null,
  headers: { get: () => null },
  text: async () => JSON.stringify({ error: { code, message } }),
});

const MODELS_ALL = {
  provider: 'Groq',
  models: [
    { id: 'gpt-oss-20b', available: true },
    { id: 'gpt-oss-120b', available: true },
    { id: 'qwen-3.8-27b', available: true },
  ],
};

let streams;
let modelsPayload;

function mockBackend() {
  global.fetch = jest.fn(async (url) => {
    if (String(url).endsWith('/api/models')) return { ok: true, status: 200, json: async () => modelsPayload, headers: { get: () => null } };
    if (String(url).endsWith('/api/health'))
      return { ok: true, status: 200, json: async () => ({ ok: true, provider: { name: 'Groq', configured: true }, tools: {} }), headers: { get: () => null } };
    throw new Error('unexpected url ' + url);
  });
  expoFetch.mockImplementation(async (url, init) => {
    const s = createStream(init.signal);
    s.url = url;
    s.init = init;
    s.body_ = JSON.parse(init.body);
    streams.push(s);
    return okResponse(s.body);
  });
}

async function renderReady() {
  const utils = await render(<App />);
  await screen.findByLabelText('Choose model');
  await waitFor(() => expect(global.fetch).toHaveBeenCalled());
  await screen.findByText(/Online/);
  return utils;
}

async function send(text) {
  await fireEvent.changeText(screen.getByLabelText('Message input'), text);
  await fireEvent.press(screen.getByLabelText('Send message'));
  await waitFor(() => expect(streams.length).toBeGreaterThan(0));
  return streams[streams.length - 1];
}

beforeEach(async () => {
  streams = [];
  modelsPayload = MODELS_ALL;
  await AsyncStorage.clear();
  jest.clearAllMocks();
  mockBackend();
});

describe('layout', () => {
  it('renders the redesigned header, model picker and starter prompts', async () => {
    await renderReady();
    expect(screen.getByText('AI')).toBeTruthy();
    expect(screen.getByLabelText('Choose model')).toBeTruthy();
    expect(screen.getByText('GPT-OSS 20B')).toBeTruthy();
    expect(screen.getByTestId('starter-prompts-rail').props.horizontal).toBe(true);
    await fireEvent.press(screen.getByLabelText('Choose model'));
    for (const label of ['GPT-OSS 20B', 'GPT-OSS 120B', 'Qwen 3.8 27B']) {
      expect(screen.getByLabelText(`Select ${label}`)).toBeTruthy();
    }
    expect(screen.queryByLabelText('Select Llama 3.3 70B')).toBeNull();
    for (const title of ['Explain a concept', 'Write Python', 'Summarize a topic', 'Search the web', 'Live weather'])
      expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByLabelText('New chat')).toBeTruthy();
    expect(screen.getByLabelText('Settings')).toBeTruthy();
  });

  it('starter card sends its prompt', async () => {
    await renderReady();
    await fireEvent.press(screen.getByLabelText('Live weather'));
    await waitFor(() => expect(streams.length).toBe(1));
    const last = streams[0].body_.messages.at(-1);
    expect(last).toEqual({ role: 'user', content: 'Can you check the current weather?' });
    expect(last.content).not.toMatch(/London/i);
  });

  it('keeps connection details available without showing developer configuration in the default settings view', async () => {
    await renderReady();
    await fireEvent.press(screen.getByLabelText('Settings'));

    expect(screen.queryByLabelText('Server address')).toBeNull();
    expect(screen.queryByText(/EXPO_PUBLIC_LUMORA_API_URL/)).toBeNull();
    await fireEvent.press(screen.getByLabelText('Show connection details'));
    expect(screen.getByLabelText('Server address')).toBeTruthy();
    expect(screen.getByLabelText('Check connection')).toBeTruthy();
    expect(screen.queryByText(/EXPO_PUBLIC_LUMORA_API_URL/)).toBeNull();
  });

  it('keeps Send and Stop controls at 48 point touch targets and readable starter copy at 12 points', async () => {
    const motionPreference = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    try {
      await renderReady();
      const sendSurface = screen.getByTestId('send-touch-target');
      expect(StyleSheet.flatten(sendSurface.props.style)).toMatchObject({ width: 48, height: 48 });
      expect(StyleSheet.flatten(screen.getByText('Make a difficult idea feel simple.').props.style).fontSize).toBeGreaterThanOrEqual(12);

      const stream = await send('hello');
      const stopButton = await screen.findByLabelText('Stop generating');
      const stopSurface = screen.getByTestId('stop-touch-target');
      expect(StyleSheet.flatten(stopSurface.props.style)).toMatchObject({ width: 48, height: 48 });
      await fireEvent.press(stopButton);
      expect(stream.init.signal.aborted).toBe(true);
    } finally {
      motionPreference.mockRestore();
    }
  });

  it('announces streaming progress, completion, and errors to screen readers', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => {});
    try {
      await renderReady();
      const stream = await send('hello');
      await waitFor(() => expect(announce).toHaveBeenCalledWith('Connecting to Lumora…'));
      await act(async () => stream.send('status', { label: 'Checking live weather…' }));
      await waitFor(() => expect(announce).toHaveBeenCalledWith('Checking live weather…'));
      await act(async () => {
        stream.send('token', { t: 'Done' });
        stream.send('done', {});
        stream.close();
      });
      await waitFor(() => expect(announce).toHaveBeenCalledWith('Response complete'));

      const failed = await send('try again');
      await act(async () => failed.send('error', { code: 'provider_rate_limited', status: 429 }));
      await screen.findByText(/Too many requests/);
      await waitFor(() => expect(announce).toHaveBeenCalledWith(expect.stringMatching(/^Error: Too many requests/)));
    } finally {
      announce.mockRestore();
    }
  });

  it('suppresses repeating animations when the system requests reduced motion', async () => {
    const motionPreference = jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true);
    const loops = [];
    const loopSpy = jest.spyOn(Animated, 'loop').mockImplementation(() => {
      const loop = { start: jest.fn(), stop: jest.fn() };
      loops.push(loop);
      return loop;
    });

    try {
      await renderReady();
      await waitFor(() => expect(motionPreference).toHaveBeenCalled());
      const startedLoopCount = loopSpy.mock.calls.length;

      await send('hello');
      await screen.findByLabelText('Stop generating');

      expect(loopSpy).toHaveBeenCalledTimes(startedLoopCount);
      expect(loops.every((loop) => loop.stop.mock.calls.length > 0)).toBe(true);
    } finally {
      loopSpy.mockRestore();
      motionPreference.mockRestore();
    }
  });

  it('exposes live-tool and haptic settings with accessible labels and selection states', async () => {
    await renderReady();
    await fireEvent.press(screen.getByLabelText('Settings'));

    expect(screen.getByLabelText('Live intelligence Auto').props.accessibilityState).toMatchObject({ selected: true });
    expect(screen.getByLabelText('Haptic feedback')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Live intelligence Off'));
    expect(screen.getByLabelText('Live intelligence Off').props.accessibilityState).toMatchObject({ selected: true });
    await fireEvent.press(screen.getByLabelText('Save settings'));

    expect(screen.getByLabelText('Live tools off').props.accessibilityState).toMatchObject({ selected: false });
  });

  it('uses the same blue selected state for Live tools and a high-contrast Send icon', async () => {
    await renderReady();
    const liveToggle = screen.getByLabelText('Live tools on');
    expect(StyleSheet.flatten(liveToggle.props.style).backgroundColor).toBe('#6758D9');

    await fireEvent.changeText(screen.getByLabelText('Message input'), 'hello');
    expect(screen.getByTestId('send-touch-target').props.colors).toEqual(['#6758D9', '#5142B8']);
  });

  it('keeps assistant model metadata without repeating the Lumora wordmark in each reply', async () => {
    await renderReady();
    const stream = await send('What is AI?');
    await act(async () => {
      stream.send('token', { t: 'A concise answer.' });
      stream.send('done', {});
      stream.close();
    });

    await screen.findByText('A concise answer.');
    expect(screen.getAllByText('GPT-OSS 20B')).toHaveLength(2);
    expect(screen.getAllByText('Lumora')).toHaveLength(1);
  });
});

describe('streaming engine', () => {
  it('renders tokens progressively, tool cards, citations and sources', async () => {
    await renderReady();
    const s = await send('Weather in London?');
    expect(s.url).toBe('http://localhost:8787/api/chat/stream');
    expect(s.init.headers.Accept).toBe('text/event-stream');
    expect(s.body_).toMatchObject({ model: 'gpt-oss-20b', tools: 'auto', messages: [{ role: 'user', content: 'Weather in London?' }] });

    await act(async () => s.send('status', { label: 'Checking live weather…' }));
    await screen.findByText('Checking live weather…');

    await act(async () =>
      s.send('meta', {
        model: { id: 'gpt-oss-20b', label: 'GPT-OSS 20B' },
        sources: [{ n: 1, title: 'Live weather — Open-Meteo', url: 'https://open-meteo.com', domain: 'open-meteo.com' }],
        tools: [
          {
            type: 'weather',
            data: {
              location: 'London, England, United Kingdom',
              current: { time: '2026-10-31T09:45', temperatureC: 11, apparentC: 9, humidity: 82, windKph: 7, description: 'Partly cloudy' },
              daily: [{ date: '2026-10-31', description: 'Overcast', minC: 10, maxC: 14, precipProb: 0 }],
              provider: 'Open-Meteo',
              providerUrl: 'https://open-meteo.com',
              n: 1,
            },
          },
        ],
        toolErrors: [],
      }),
    );
    await screen.findByText('London, England, United Kingdom');
    expect(screen.getByText('82% humidity')).toBeTruthy();

    // Split a multi-byte character and an SSE frame across chunks.
    await act(async () => s.raw('event: token\ndata: {"t":"It is **11°C**'));
    await act(async () => s.raw('"}\n\n'));
    await screen.findByText(/It is/, {}, { timeout: 2000 });
    expect(screen.queryByLabelText('Copy')).toBeNull(); // actions hidden while streaming

    await act(async () => s.send('token', { t: ' and partly cloudy [1].' }));
    await act(async () => s.send('done', { finishReason: 'stop' }));
    await act(async () => s.close());

    await screen.findByLabelText('Copy');
    expect(screen.getByText(/and partly cloudy/)).toBeTruthy();

    const cite = screen.getByLabelText('Citation 1: Live weather — Open-Meteo');
    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await fireEvent.press(cite);
    expect(openSpy).toHaveBeenCalledWith('https://open-meteo.com');
    expect(screen.getByLabelText('Open source 1: Live weather — Open-Meteo')).toBeTruthy();
  });

  it('shows a weather failure without a successful weather card or source chip', async () => {
    await renderReady();
    const s = await send('Current weather of NoSuchCity');
    await act(async () =>
      s.send('meta', {
        model: { id: 'gpt-oss-20b', label: 'GPT-OSS 20B' },
        sources: [],
        tools: [],
        toolErrors: [{ type: 'weather', message: 'Live weather could not be retrieved: Could not find a location named "NoSuchCity".' }],
      }),
    );
    await act(async () => {
      s.send('token', { t: "I couldn't retrieve live weather, so I don't have current conditions." });
      s.send('done', {});
      s.close();
    });

    await screen.findByText(/Could not find a location named "NoSuchCity"/);
    expect(screen.getByText(/couldn.t retrieve live weather/i)).toBeTruthy();
    expect(screen.queryByText('SOURCES')).toBeNull();
    expect(screen.queryByText('Open-Meteo')).toBeNull();
    expect(screen.queryByText(/\b\d+°C/)).toBeNull();
  });

  it('Stop aborts the request, keeps partial text and never retries', async () => {
    await renderReady();
    const s = await send('Tell me a long story');
    await act(async () => s.send('token', { t: 'Once upon a time' }));
    await screen.findByText(/Once upon a time/);
    await fireEvent.press(screen.getByLabelText('Stop generating'));
    await screen.findByText('Generation stopped');
    expect(s.init.signal.aborted).toBe(true);
    expect(s.reader.cancel).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 1200));
    expect(expoFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Send message')).toBeTruthy();
  });

  it('prevents duplicate requests from rapid taps', async () => {
    await renderReady();
    await fireEvent.changeText(screen.getByLabelText('Message input'), 'hello');
    // Two taps delivered before React re-renders (the button is still "Send").
    const button = screen.getByLabelText('Send message');
    await act(async () => {
      await Promise.all([fireEvent.press(button), fireEvent.press(button)]);
    });
    await waitFor(() => expect(streams.length).toBe(1));
    expect(screen.queryByLabelText('Send message')).toBeNull();
    expect(screen.getByLabelText('Stop generating')).toBeTruthy();
    await new Promise((r) => setTimeout(r, 100));
    expect(expoFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores empty messages', async () => {
    await renderReady();
    await fireEvent.changeText(screen.getByLabelText('Message input'), '   ');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await new Promise((r) => setTimeout(r, 50));
    expect(expoFetch).not.toHaveBeenCalled();
  });

  it('retries a network failure with backoff, then streams', async () => {
    await renderReady();
    let calls = 0;
    const realImpl = expoFetch.getMockImplementation();
    expoFetch.mockImplementation(async (url, init) => {
      calls += 1;
      if (calls === 1) throw new TypeError('Network request failed');
      return realImpl(url, init);
    });
    await fireEvent.changeText(screen.getByLabelText('Message input'), 'hi');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await waitFor(() => expect(streams.length).toBe(1), { timeout: 3000 });
    expect(calls).toBe(2);
    await act(async () => {
      streams[0].send('token', { t: 'Recovered' });
      streams[0].send('done', {});
    });
    await screen.findByText('Recovered');
  });

  it('does not retry 401 and shows a friendly message', async () => {
    await renderReady();
    expoFetch.mockImplementation(async () => errorResponse(401, 'unauthorized', 'Missing or invalid client token.'));
    await fireEvent.changeText(screen.getByLabelText('Message input'), 'hi');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await screen.findByText(/couldn't verify this app's backend access/i);
    expect(screen.queryByText(/EXPO_PUBLIC_LUMORA_CLIENT_TOKEN/)).toBeNull();
    expect(expoFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Retry')).toBeTruthy();
  });

  it('maps server error events (429) and keeps partial text', async () => {
    await renderReady();
    const s = await send('hi');
    await act(async () => {
      s.send('token', { t: 'Partial' });
      s.send('error', { code: 'provider_rate_limited', message: 'x', status: 429 });
    });
    await screen.findByText(/Too many requests/);
    expect(screen.getByText('Partial')).toBeTruthy();
  });

  it.each([
    ['model_unavailable', /choose another available model from the selector/i],
    ['provider_quota_exceeded', /no available quota or billing capacity/i],
    ['provider_access_denied', /denied access to this project or model/i],
  ])('shows a specific safe message for %s', async (code, expected) => {
    await renderReady();
    const s = await send('hi');
    await act(async () => s.send('error', { code, message: 'provider detail should not be needed by the app', status: 503 }));
    await screen.findByText(expected);
  });

  it('flags an interrupted stream (closed without done)', async () => {
    await renderReady();
    const s = await send('hi');
    await act(async () => {
      s.send('token', { t: 'Half an answer' });
      s.close();
    });
    await screen.findByText(/interrupted before it finished/);
    expect(screen.getByText('Half an answer')).toBeTruthy();
  });

  it('rejects malformed SSE payloads safely', async () => {
    await renderReady();
    const s = await send('hi');
    await act(async () => s.raw('event: token\ndata: {not json\n\n'));
    await screen.findByText(/unexpected response/);
  });

  it('regenerate replaces the last answer and resends history', async () => {
    await renderReady();
    const s = await send('first question');
    await act(async () => {
      s.send('token', { t: 'First answer' });
      s.send('done', {});
    });
    await fireEvent.press(await screen.findByLabelText('Regenerate'));
    await waitFor(() => expect(streams.length).toBe(2));
    expect(streams[1].body_.messages).toEqual([{ role: 'user', content: 'first question' }]);
    expect(screen.queryByText('First answer')).toBeNull();
  });
});

describe('models', () => {
  it('selecting Qwen sends its Lumora model ID and persists the selection', async () => {
    await renderReady();
    await fireEvent.press(screen.getByLabelText('Choose model'));
    await fireEvent.press(screen.getByLabelText('Select Qwen 3.8 27B'));
    const s = await send('hi');
    expect(s.body_.model).toBe('qwen-3.8-27b');
    await waitFor(async () => {
      const prefs = JSON.parse(await AsyncStorage.getItem('lumora.v1.prefs'));
      expect(prefs.modelId).toBe('qwen-3.8-27b');
    });
  });

  it.each([
    ['GPT-OSS 20B', 'gpt-oss-20b'],
    ['GPT-OSS 120B', 'gpt-oss-120b'],
  ])('%s remains selectable and persists', async (label, id) => {
    await renderReady();
    await fireEvent.press(screen.getByLabelText('Choose model'));
    await fireEvent.press(screen.getByLabelText(`Select ${label}`));
    const s = await send('hi');
    expect(s.body_.model).toBe(id);
    await waitFor(async () => {
      const prefs = JSON.parse(await AsyncStorage.getItem('lumora.v1.prefs'));
      expect(prefs.modelId).toBe(id);
    });
  });

  it('migrates a saved Llama selection to Qwen with a visible notice', async () => {
    await AsyncStorage.setItem('lumora.v1.prefs', JSON.stringify({ modelId: 'llama-3.3-70b' }));
    await renderReady();
    await screen.findByText(/Llama 3\.3 70B was replaced in Lumora; Qwen 3\.8 27B is selected/);
    await waitFor(async () => {
      const prefs = JSON.parse(await AsyncStorage.getItem('lumora.v1.prefs'));
      expect(prefs.modelId).toBe('qwen-3.8-27b');
    });
  });

  it('keeps an unavailable Qwen selection and blocks it visibly without switching', async () => {
    await AsyncStorage.setItem('lumora.v1.prefs', JSON.stringify({ modelId: 'qwen-3.8-27b' }));
    modelsPayload = {
      provider: 'Groq',
      models: [
        { id: 'gpt-oss-20b', available: true },
        { id: 'gpt-oss-120b', available: true },
        { id: 'qwen-3.8-27b', available: false, reason: 'Groq does not offer qwen/qwen3.8-27b.' },
      ],
    };
    await renderReady();
    expect(screen.getByText('Unavailable')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Choose model'));
    expect(screen.getByText('Unavailable on this provider')).toBeTruthy();
    expect(screen.getByText('Groq does not offer qwen/qwen3.8-27b.')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Select Qwen 3.8 27B'));
    await screen.findByText('Groq does not offer qwen/qwen3.8-27b.');
    await fireEvent.changeText(screen.getByLabelText('Message input'), 'hello');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await screen.findByText(/This model is not available on the configured provider/);
    expect(streams).toHaveLength(0);
    const prefs = JSON.parse(await AsyncStorage.getItem('lumora.v1.prefs'));
    expect(prefs.modelId).toBe('qwen-3.8-27b');
  });

  it('shows offline state when the backend is unreachable', async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError('Network request failed');
    });
    await render(<App />);
    await screen.findByText('Backend unreachable');
  });
});

describe('markdown rendering', () => {
  it('renders headings, lists, tables, quotes, links and copyable code blocks', async () => {
    await renderReady();
    const s = await send('show markdown');
    const md = [
      '# Title',
      '- **Bold item** and *italic*',
      '1. first',
      '> quoted',
      '',
      '| Name | Value |',
      '| --- | --- |',
      '| alpha | 1 |',
      '',
      'Visit [Expo](https://expo.dev) and use `inline()`',
      '',
      '```python',
      'def add(a, b):',
      '    return a + b',
      '```',
    ].join('\n');
    await act(async () => {
      s.send('token', { t: md });
      s.send('done', {});
    });
    await screen.findByText('Title');
    expect(screen.getByText('Bold item')).toBeTruthy();
    expect(screen.getByText('italic')).toBeTruthy();
    expect(screen.getByText('quoted')).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('PYTHON')).toBeTruthy();
    expect(screen.getByText('inline()')).toBeTruthy();

    const openSpy = jest.spyOn(Linking, 'openURL').mockResolvedValue(true);
    await fireEvent.press(screen.getByText('Expo'));
    expect(openSpy).toHaveBeenCalledWith('https://expo.dev');

    await fireEvent.press(screen.getByLabelText('Copy code'));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('def add(a, b):\n    return a + b'));
    await screen.findByText('Copied');

    await fireEvent.press(screen.getByLabelText('Copy'));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith(md));
  });

  it('renders an unterminated code fence while streaming without crashing', async () => {
    await renderReady();
    const s = await send('code');
    await act(async () => s.send('token', { t: 'Here:\n```js\nconst a = [1, 2' }));
    await screen.findByText('JS');
  });

  it('turns HTML break variants into Markdown line breaks but preserves code and other HTML literally', async () => {
    await renderReady();
    const s = await send('formatting');
    const md = [
      'First<br>second<br/>third<br />fourth<br><br>fifth',
      'soft line one',
      'soft line two',
      '',
      'Inline code: `<br>`',
      '',
      '```html',
      '<div>literal<br /></div>',
      '```',
      '',
      '<img src=x>',
    ].join('\n');
    await act(async () => {
      s.send('token', { t: md });
      s.send('done', {});
    });
    for (const word of ['First', 'second', 'third', 'fourth', 'fifth']) await screen.findByText(word);
    expect(screen.getByText('<br>')).toBeTruthy();
    expect(screen.getByText('<img src=x>')).toBeTruthy();
    await fireEvent.press(screen.getByLabelText('Copy code'));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith('<div>literal<br /></div>'));
  });

  it('stacks wide tables into labeled mobile records without dropping columns', async () => {
    await renderReady();
    const s = await send('compare features');
    const md = [
      '| Feature | GPT-OSS | Qwen | Notes |',
      '| --- | --- | --- | --- |',
      '| Speed | Fast | Versatile | More context |',
      '| Search | Tavily | Tavily | [1] source |',
    ].join('\n');
    await act(async () => {
      s.send('token', { t: md });
      s.send('done', {});
    });
    await waitFor(() => expect(screen.getByTestId('responsive-table-record-0')).toBeTruthy());
    for (const value of ['Feature', 'GPT-OSS', 'Qwen', 'Notes', 'Speed', 'Fast', 'Versatile', 'More context', 'Search', 'Tavily'])
      expect(screen.getAllByText(value).length).toBeGreaterThan(0);
  });
});

describe('persistence', () => {
  it('saves conversations and restores them after restart', async () => {
    const first = await renderReady();
    const s = await send('Remember me');
    await act(async () => {
      s.send('token', { t: 'Saved answer' });
      s.send('done', {});
    });
    await screen.findByText('Saved answer');
    await waitFor(
      async () => {
        const index = JSON.parse((await AsyncStorage.getItem('lumora.v1.index')) || '[]');
        expect(index).toHaveLength(1);
        expect(index[0].title).toBe('Remember me');
      },
      { timeout: 3000 },
    );
    const prefs = JSON.parse(await AsyncStorage.getItem('lumora.v1.prefs'));
    expect(prefs.lastConversationId).toBeTruthy();
    await first.unmount();

    await renderReady();
    expect(await screen.findByText('Saved answer')).toBeTruthy();
    expect(screen.getByText('Remember me')).toBeTruthy();
  });

  it('does not write a conversation while streaming, and marks interrupted saves as stopped', async () => {
    const first = await renderReady();
    const s = await send('in flight');
    await act(async () => s.send('token', { t: 'partial' }));
    await new Promise((r) => setTimeout(r, 700));
    const keys = await AsyncStorage.getAllKeys();
    expect(keys.some((k) => k.startsWith('lumora.v1.conv.'))).toBe(false);
    // Reset mid-stream persists the old chat with a safe status.
    await fireEvent.press(screen.getByLabelText('New chat'));
    await waitFor(async () => {
      const convKey = (await AsyncStorage.getAllKeys()).find((k) => k.startsWith('lumora.v1.conv.'));
      expect(convKey).toBeTruthy();
      const msgs = JSON.parse(await AsyncStorage.getItem(convKey));
      expect(msgs.at(-1)).toMatchObject({ role: 'assistant', content: 'partial', status: 'stopped' });
    });
    expect(s.init.signal.aborted).toBe(true);
    await first.unmount();
  });

  it('flushes an in-flight conversation when the app is backgrounded', async () => {
    const { AppState } = require('react-native');
    await renderReady();
    // React Native's Jest preset already mocks AppState.addEventListener.
    const listeners = AppState.addEventListener.mock.calls.filter(([type]) => type === 'change').map(([, fn]) => fn);
    expect(listeners.length).toBeGreaterThan(0);
    const s = await send('do not lose me');
    await act(async () => s.send('token', { t: 'streaming…' }));
    await act(async () => listeners.forEach((fn) => fn('background')));
    await waitFor(async () => {
      const convKey = (await AsyncStorage.getAllKeys()).find((k) => k.startsWith('lumora.v1.conv.'));
      expect(convKey).toBeTruthy();
      const msgs = JSON.parse(await AsyncStorage.getItem(convKey));
      expect(msgs[0]).toMatchObject({ role: 'user', content: 'do not lose me' });
      expect(msgs[1]).toMatchObject({ role: 'assistant', status: 'stopped' });
    });
    expect(s.init.signal.aborted).toBe(false); // the stream keeps running
  });

  it('survives corrupted storage', async () => {
    await AsyncStorage.setItem('lumora.v1.prefs', '{broken');
    await AsyncStorage.setItem('lumora.v1.index', '"not an array"');
    await renderReady();
    expect(screen.getByText('Live weather')).toBeTruthy();
  });

  it('deletes a conversation and clears all history', async () => {
    const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation((title, msg, buttons) => {
      const destructive = buttons.find((b) => b.style === 'destructive');
      if (destructive) destructive.onPress();
    });
    await renderReady();
    const s = await send('to delete');
    await act(async () => {
      s.send('token', { t: 'bye' });
      s.send('done', {});
    });
    await waitFor(async () => expect(JSON.parse((await AsyncStorage.getItem('lumora.v1.index')) || '[]')).toHaveLength(1), { timeout: 3000 });
    await fireEvent.press(screen.getByLabelText('Conversation history'));
    await fireEvent.press(await screen.findByLabelText(/Delete conversation/));
    await waitFor(async () => {
      const keys = await AsyncStorage.getAllKeys();
      expect(keys.some((k) => k.startsWith('lumora.v1.conv.'))).toBe(false);
    });
    await screen.findByText('No saved conversations yet.');
    expect(alertSpy).toHaveBeenCalledWith('Delete conversation?', expect.any(String), expect.any(Array));
    await AsyncStorage.setItem('lumora.v1.conv.orphan', '[]');
    await fireEvent.press(screen.getByLabelText('Settings'));
    await fireEvent.press(await screen.findByLabelText('Clear all chat history'));
    await screen.findByText('All history cleared');
    await waitFor(async () => {
      const keys = await AsyncStorage.getAllKeys();
      expect(keys.filter((k) => k.startsWith('lumora.v1.conv.'))).toEqual([]);
    });
  });
});

describe('scrolling', () => {
  it('shows the scroll-to-bottom button only after a user scrolls up', async () => {
    await renderReady();
    const s = await send('hi');
    await act(async () => {
      s.send('token', { t: 'answer' });
      s.send('done', {});
    });
    await screen.findByText('answer');
    const list = screen.getByTestId('chat-list');
    const wrapperPointer = () => screen.getByTestId('scroll-bottom').props.pointerEvents;
    const ev = (y) => ({ nativeEvent: { contentOffset: { y }, layoutMeasurement: { height: 600 }, contentSize: { height: 2000 } } });
    // Programmatic scroll (no drag) never detaches auto-follow.
    await fireEvent.scroll(list, ev(200));
    expect(wrapperPointer()).toBe('none');
    await fireEvent(list, 'scrollBeginDrag');
    await fireEvent.scroll(list, ev(200));
    await waitFor(() => expect(wrapperPointer()).toBe('auto'));
    await fireEvent.scroll(list, ev(1390));
    await waitFor(() => expect(wrapperPointer()).toBe('none'));
  });
});
