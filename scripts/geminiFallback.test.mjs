import { test } from 'node:test';
import assert from 'node:assert/strict';

import geminiHandler, { GEMINI_FALLBACK_ORDER } from '../api/gemini.js';

// Fallback de modelos en /api/gemini (2026-11-19).
// El simulador manual pide gemini-3.8-flash y Google devolvía 503 "This model
// is currently experiencing high demand" sin que nadie reintentara. Ahora el
// proxy prueba automáticamente el siguiente modelo ante 503/429.

function withEnv(patch, fn) {
  const prev = {};
  for (const k of Object.keys(patch)) {
    prev[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (patch[k] === undefined) delete process.env[k];
    else process.env[k] = patch[k];
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const k of Object.keys(patch)) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    });
}

function withMockFetch(handler, fn) {
  const prev = globalThis.fetch;
  globalThis.fetch = handler;
  return Promise.resolve()
    .then(fn)
    .finally(() => { globalThis.fetch = prev; });
}

function mockRes() {
  const res = {
    statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    send(body) { this.body = body; return this; },
  };
  return res;
}

const BODY = { model: 'gemini-3.8-flash', op: 'generateContent', payload: { contents: [] } };

function okResponse(text) {
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}

test('Fallback: 3.8-flash saturado (503) -> responde 3.6-flash', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined, GEMINI_API_KEY: 'test-key' }, async () => {
    const calls = [];
    await withMockFetch(async (url) => {
      calls.push(String(url));
      if (url.includes('gemini-3.8-flash')) {
        return new Response(JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }), {
          status: 503, headers: { 'content-type': 'application/json' },
        });
      }
      return okResponse('respuesta de respaldo');
    }, async () => {
      const res = mockRes();
      await geminiHandler({ method: 'POST', headers: {}, body: BODY }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.candidates[0].content.parts[0].text, 'respuesta de respaldo');
      assert.equal(calls.length, 2, `se esperaban 2 llamadas (3.8 y respaldo), hay ${calls.length}`);
      assert.ok(calls[0].includes('gemini-3.8-flash'), 'la primera llamada debe ser al modelo pedido');
      assert.ok(calls[1].includes('gemini-3.6-flash'), `el respaldo debe ser 3.6-flash, es: ${calls[1]}`);
    });
  });
});

test('Fallback: 429 (cuota) también dispara el respaldo', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined, GEMINI_API_KEY: 'test-key' }, async () => {
    const calls = [];
    await withMockFetch(async (url) => {
      calls.push(String(url));
      if (url.includes('gemini-3.8-flash')) {
        return new Response(JSON.stringify({ error: { message: 'Quota exceeded.' } }), {
          status: 429, headers: { 'content-type': 'application/json' },
        });
      }
      return okResponse('ok tras 429');
    }, async () => {
      const res = mockRes();
      await geminiHandler({ method: 'POST', headers: {}, body: BODY }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 2);
    });
  });
});

test('Sin fallback: 200 en el primer intento hace exactamente 1 llamada', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined, GEMINI_API_KEY: 'test-key' }, async () => {
    const calls = [];
    await withMockFetch(async (url) => {
      calls.push(String(url));
      return okResponse('directo');
    }, async () => {
      const res = mockRes();
      await geminiHandler({ method: 'POST', headers: {}, body: BODY }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1, 'un 200 no debe disparar respaldos');
      assert.ok(calls[0].includes('gemini-3.8-flash'));
    });
  });
});

test('Sin fallback: un 400 no prueba otro modelo', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined, GEMINI_API_KEY: 'test-key' }, async () => {
    const calls = [];
    await withMockFetch(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { message: 'Bad request.' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const res = mockRes();
      await geminiHandler({ method: 'POST', headers: {}, body: BODY }, res);
      assert.equal(res.statusCode, 400);
      assert.equal(calls.length, 1, 'un 400 es error del cliente, no se prueba otro modelo');
    });
  });
});

test('Fallback: 404 (modelo retirado) también dispara el respaldo', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined, GEMINI_API_KEY: 'test-key' }, async () => {
    const calls = [];
    await withMockFetch(async (url) => {
      calls.push(String(url));
      if (url.includes('gemini-3.8-flash')) {
        return new Response(JSON.stringify({ error: { message: 'This model is no longer available.' } }), {
          status: 404, headers: { 'content-type': 'application/json' },
        });
      }
      return okResponse('ok tras 404');
    }, async () => {
      const res = mockRes();
      await geminiHandler({ method: 'POST', headers: {}, body: BODY }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 2);
      assert.ok(calls[1].includes('gemini-3.6-flash'));
    });
  });
});

test('Todos saturados: devuelve 503 con la lista de modelos probados', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined, GEMINI_API_KEY: 'test-key' }, async () => {
    const calls = [];
    await withMockFetch(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ error: { message: 'high demand' } }), {
        status: 503, headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const res = mockRes();
      await geminiHandler({ method: 'POST', headers: {}, body: BODY }, res);
      assert.equal(res.statusCode, 503);
      assert.equal(calls.length, 5, 'máximo 5 intentos (pedido + 4 respaldos)');
      assert.ok(Array.isArray(res.body.triedModels), 'la respuesta debe listar los modelos probados');
      assert.equal(res.body.triedModels[0], 'gemini-3.8-flash', 'el primero es el modelo pedido');
      assert.ok(res.body.triedModels.includes('gemini-3.6-flash'), 'el respaldo debe incluir 3.6-flash');
      assert.ok(!res.body.triedModels.includes('gemini-2.0-flash'), '2.0-flash está retirado, no debe estar en la cascada');
      assert.match(res.body.error, /saturados o sin cuota/);
    });
  });
});

test('La cascada respeta el modelo pedido primero y no lo repite', () => {
  assert.ok(GEMINI_FALLBACK_ORDER.includes('gemini-3.6-flash'), '3.6-flash debe estar en la cascada');
  assert.ok(GEMINI_FALLBACK_ORDER.includes('gemini-3.5-flash'), '3.5-flash debe estar en la cascada');
  assert.ok(!GEMINI_FALLBACK_ORDER.includes('gemini-2.0-flash'), '2.0-flash está retirado por Google (404 verificado en vivo 2026-11-19), no debe estar en la cascada');
  assert.equal(GEMINI_FALLBACK_ORDER[0], 'gemini-3.6-flash', 'el primer respaldo es el modelo 3.x más nuevo disponible');
});
