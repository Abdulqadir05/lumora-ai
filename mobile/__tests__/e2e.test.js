/**
 * Optional end-to-end test: real backend (any provider) → real SSE → App.js.
 * Skipped unless LUMORA_E2E_URL is set, e.g.
 *   LUMORA_E2E_URL=http://127.0.0.1:8787 LUMORA_E2E_TOKEN=... npx jest e2e
 * React Native's Jest setup replaces global fetch with a mock, so a tiny node:http
 * adapter provides a streaming fetch. The bytes are the server's real SSE output.
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { fetch as expoFetch } from 'expo/fetch';
import http from 'http';

/** Minimal streaming fetch over node:http (status, headers, json/text, body.getReader, AbortSignal). */
function nodeFetch(url, init = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: init.method || 'GET', headers: init.headers || {} }, (res) => {
      const chunks = [];
      let waiter = null;
      let ended = false;
      let failure = null;
      const wake = () => {
        const w = waiter;
        waiter = null;
        if (w) w();
      };
      res.on('data', (c) => {
        chunks.push(new Uint8Array(c));
        wake();
      });
      res.on('end', () => {
        ended = true;
        wake();
      });
      res.on('error', (e) => {
        failure = e;
        wake();
      });
      const readAll = async () => {
        while (!ended) await new Promise((r) => (waiter = r));
        return Buffer.concat(chunks.splice(0)).toString('utf8');
      };
      resolve({
        ok: res.statusCode >= 200 && res.statusCode < 300,
        status: res.statusCode,
        headers: { get: (k) => res.headers[k.toLowerCase()] || null },
        text: readAll,
        json: async () => JSON.parse(await readAll()),
        body: {
          getReader: () => ({
            read: () =>
              new Promise((res2, rej2) => {
                const attempt = () => {
                  if (failure) return rej2(failure);
                  if (chunks.length) return res2({ done: false, value: chunks.shift() });
                  if (ended) return res2({ done: true, value: undefined });
                  waiter = attempt;
                  return undefined;
                };
                attempt();
              }),
            cancel: async () => req.destroy(),
          }),
        },
      });
    });
    req.on('error', reject);
    if (init.signal) init.signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('Aborted'), { name: 'AbortError' })));
    if (init.body) req.write(init.body);
    req.end();
  });
}

const URL_ = process.env.LUMORA_E2E_URL;
const maybe = URL_ ? describe : describe.skip;

maybe('e2e against a running backend', () => {
  beforeAll(() => {
    global.fetch = jest.fn(nodeFetch);
    process.env.EXPO_PUBLIC_LUMORA_API_URL = URL_;
    process.env.EXPO_PUBLIC_LUMORA_CLIENT_TOKEN = process.env.LUMORA_E2E_TOKEN || '';
    expoFetch.mockImplementation((url, init) => nodeFetch(url, init));
  });

  it('streams a real answer over SSE and renders it', async () => {
    const App = require('../App').default;
    await render(<App />);
    await screen.findByText(/Online/, {}, { timeout: 8000 });
    await fireEvent.changeText(screen.getByLabelText('Message input'), 'Say hello');
    await fireEvent.press(screen.getByLabelText('Send message'));
    await waitFor(() => expect(screen.getByLabelText('Copy')).toBeTruthy(), { timeout: 30000 });
    expect(expoFetch).toHaveBeenCalledWith(`${URL_}/api/chat/stream`, expect.objectContaining({ method: 'POST' }));
  }, 40000);
});
