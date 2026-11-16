// scripts/securityBatch.test.mjs — Lote 2 de seguridad 2026-11-16 (S1, S2, S3).
// S1: /api/quota autenticado (Bearer CRON_SECRET, fail-closed) + caché 90 s +
//     sin email/nombre de la cuenta API-Sports en la respuesta.
// S2: helpers fail-closed en api/_lib/security.js (requireCronAuthStrict,
//     requirePortalAuthStrict) + evidencia de que /api/gemini y /api/audit
//     quedan BLOQUEADOS para el fail-closed (sus llamadores no envían
//     credencial): los tests fijan el comportamiento actual, no lo cambian.
// S3: /api/version devuelve el commit desplegado.
// No toca la matemática de los modelos, Platt, Kelly ni el Tribunal.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import quotaHandler, { QUOTA_CACHE_TTL_MS, clearQuotaCache } from '../api/quota.js';
import geminiHandler from '../api/gemini.js';
import auditHandler from '../api/audit.js';
import versionHandler from '../api/version.js';
import {
  requireCronAuth,
  requireCronAuthStrict,
  requirePortalAuthStrict,
} from '../api/_lib/security.js';

// ---------------------------------------------------------------- helpers
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

// Proveedores simulados para /api/quota: 2 llaves Odds API + 1 API-Sports.
// El /status de API-Sports devuelve email y nombre de cuenta a propósito:
// el test verifica que /api/quota NO los expone.
function quotaMockFetch(calls) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).includes('api.the-odds-api.com')) {
      return new Response('[]', {
        status: 200,
        headers: {
          'x-requests-remaining': '400',
          'x-requests-used': '100',
          'x-requests-last': '1',
        },
      });
    }
    if (String(url).includes('v3.football.api-sports.io/status')) {
      return new Response(JSON.stringify({
        response: {
          account: { firstname: 'Test', lastname: 'User', email: 'test@example.com' },
          subscription: { plan: 'Free', active: true, end: '2027-01-01' },
          requests: { current: 12, limit_day: 100 },
        },
        errors: {},
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    throw new Error(`URL no esperada en mock: ${url}`);
  };
}

const QUOTA_ENV = {
  CRON_SECRET: 'test-cron-secret',
  ODDS_API_KEYS: 'oddskey-aaaa1111,oddskey-bbbb2222',
  APISPORTS_KEYS: 'apisportskey-cccc3333',
};

// ------------------------------------------------------- S1: /api/quota
test('S1: /api/quota sin CRON_SECRET configurado responde 503 (fail-closed)', async () => {
  await withEnv({ CRON_SECRET: undefined }, async () => {
    clearQuotaCache();
    const res = mockRes();
    await quotaHandler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 503);
    assert.equal(res.body.success, false);
    assert.match(res.body.error, /CRON_SECRET/);
  });
});

test('S1: /api/quota sin Bearer responde 401', async () => {
  await withEnv(QUOTA_ENV, async () => {
    clearQuotaCache();
    const res = mockRes();
    await quotaHandler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
  });
});

test('S1: /api/quota con Bearer incorrecto responde 401', async () => {
  await withEnv(QUOTA_ENV, async () => {
    clearQuotaCache();
    const res = mockRes();
    await quotaHandler({ method: 'GET', query: {}, headers: { authorization: 'Bearer incorrecto' } }, res);
    assert.equal(res.statusCode, 401);
  });
});

test('S1: /api/quota con Bearer correcto responde 200 sin email/nombre y con llaves enmascaradas', async () => {
  await withEnv(QUOTA_ENV, async () => {
    clearQuotaCache();
    const calls = [];
    await withMockFetch(quotaMockFetch(calls), async () => {
      const res = mockRes();
      await quotaHandler(
        { method: 'GET', query: {}, headers: { authorization: 'Bearer test-cron-secret' } },
        res
      );
      assert.equal(res.statusCode, 200);
      assert.equal(res.body.success, true);
      assert.equal(res.body.cached, false);
      // 2 llamadas Odds API (una por llave) + 1 /status API-Sports.
      assert.equal(calls.length, 3);
      // Sin datos personales en ninguna parte de la respuesta.
      const raw = JSON.stringify(res.body);
      assert.doesNotMatch(raw, /test@example\.com/);
      assert.doesNotMatch(raw, /Test User/);
      assert.equal('email' in (res.body.apiSports.keys[0] || {}), false);
      assert.equal('account' in (res.body.apiSports.keys[0] || {}), false);
      // Llaves enmascaradas, nunca completas.
      assert.equal(res.body.apiSports.keys[0].key, '****3333');
      assert.equal(res.body.theOddsApi.keys[0].key, '****1111');
      assert.equal(res.body.theOddsApi.keys[1].key, '****2222');
      assert.doesNotMatch(raw, /oddskey-aaaa1111|apisportskey-cccc3333/);
      // Los números sí llegan.
      assert.equal(res.body.theOddsApi.poolSummary.totalRemaining, 800);
      assert.equal(res.body.apiSports.requestsUsedToday, 12);
      assert.equal(res.body.apiSports.remainingToday, 88);
    });
  });
});

test('S1: /api/quota sirve del caché 90 s sin volver a llamar a los proveedores', async () => {
  assert.ok(QUOTA_CACHE_TTL_MS >= 60 * 1000 && QUOTA_CACHE_TTL_MS <= 120 * 1000);
  await withEnv(QUOTA_ENV, async () => {
    clearQuotaCache();
    const calls = [];
    await withMockFetch(quotaMockFetch(calls), async () => {
      const req = { method: 'GET', query: {}, headers: { authorization: 'Bearer test-cron-secret' } };
      const res1 = mockRes();
      await quotaHandler(req, res1);
      assert.equal(res1.statusCode, 200);
      assert.equal(res1.body.cached, false);
      assert.equal(calls.length, 3);

      const res2 = mockRes();
      await quotaHandler(req, res2);
      assert.equal(res2.statusCode, 200);
      assert.equal(res2.body.cached, true);
      assert.ok(res2.body.cacheAgeMs >= 0);
      assert.equal(calls.length, 3, 'la segunda llamada no debe golpear a los proveedores');

      clearQuotaCache();
      const res3 = mockRes();
      await quotaHandler(req, res3);
      assert.equal(res3.body.cached, false);
      assert.equal(calls.length, 6, 'tras vaciar el caché vuelve a consultar');
    });
  });
});

// ------------------------------------------- S2: helpers fail-closed
test('S2: requireCronAuth (el de scan) sigue fail-open sin CRON_SECRET', async () => {
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const res = mockRes();
    assert.equal(requireCronAuth({ headers: {} }, res), true);
    assert.equal(res.statusCode, null, 'no debe responder 401/503: scan.js depende de esto');
  });
});

test('S2: requireCronAuthStrict: 503 sin variable, 401 sin Bearer o incorrecto, true con Bearer correcto', async () => {
  await withEnv({ CRON_SECRET: undefined }, async () => {
    const res = mockRes();
    assert.equal(requireCronAuthStrict({ headers: {} }, res), false);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /CRON_SECRET/);
  });
  await withEnv({ CRON_SECRET: 's3cr3t' }, async () => {
    const noHeader = mockRes();
    assert.equal(requireCronAuthStrict({ headers: {} }, noHeader), false);
    assert.equal(noHeader.statusCode, 401);
    const wrong = mockRes();
    assert.equal(requireCronAuthStrict({ headers: { authorization: 'Bearer nope' } }, wrong), false);
    assert.equal(wrong.statusCode, 401);
    const ok = mockRes();
    assert.equal(requireCronAuthStrict({ headers: { authorization: 'Bearer s3cr3t' } }, ok), true);
    assert.equal(ok.statusCode, null);
  });
});

test('S2: requirePortalAuthStrict: 503 sin variable, 401 sin header o incorrecto, true con header correcto', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined }, async () => {
    const res = mockRes();
    assert.equal(requirePortalAuthStrict({ headers: {} }, res), false);
    assert.equal(res.statusCode, 503);
    assert.match(res.body.error, /PORTAL_ACCESS_TOKEN/);
  });
  await withEnv({ PORTAL_ACCESS_TOKEN: 'portal-tok' }, async () => {
    const noHeader = mockRes();
    assert.equal(requirePortalAuthStrict({ headers: {} }, noHeader), false);
    assert.equal(noHeader.statusCode, 401);
    const wrong = mockRes();
    assert.equal(requirePortalAuthStrict({ headers: { 'x-portal-token': 'nope' } }, wrong), false);
    assert.equal(wrong.statusCode, 401);
    const ok = mockRes();
    assert.equal(requirePortalAuthStrict({ headers: { 'x-portal-token': 'portal-tok' } }, ok), true);
    assert.equal(ok.statusCode, null);
  });
});

// ---------------- S2 BLOQUEADO: /api/gemini (llamador sin credencial)
// geminiClient.js envía x-portal-token solo si localStorage tiene
// 'fstats_portal_token', y nada lo escribe jamás. El comportamiento actual
// se fija aquí para que nadie lo cambie en silencio: proxy abierto si
// PORTAL_ACCESS_TOKEN no está configurado.
test('S2 BLOQUEADO: /api/gemini sin PORTAL_ACCESS_TOKEN sigue sirviendo sin header (proxy abierto)', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: undefined, GEMINI_API_KEY: 'test-gemini-key-123' }, async () => {
    const calls = [];
    await withMockFetch(async (url, options) => {
      calls.push({ url: String(url), key: options?.headers?.['x-goog-api-key'] });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const res = mockRes();
      await geminiHandler({
        method: 'POST',
        headers: {},
        body: { model: 'gemini-2.5-flash', op: 'generateContent', payload: { contents: [] } },
      }, res);
      assert.equal(res.statusCode, 200);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].key, 'test-gemini-key-123');
    });
  });
});

test('S2: /api/gemini con PORTAL_ACCESS_TOKEN configurado ya exige el header (401 sin él, 200 con él)', async () => {
  await withEnv({ PORTAL_ACCESS_TOKEN: 'portal-tok', GEMINI_API_KEY: 'test-gemini-key-123' }, async () => {
    const calls = [];
    await withMockFetch(async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }, async () => {
      const body = { model: 'gemini-2.5-flash', op: 'generateContent', payload: { contents: [] } };
      const noHeader = mockRes();
      await geminiHandler({ method: 'POST', headers: {}, body }, noHeader);
      assert.equal(noHeader.statusCode, 401);
      const wrong = mockRes();
      await geminiHandler({ method: 'POST', headers: { 'x-portal-token': 'nope' }, body }, wrong);
      assert.equal(wrong.statusCode, 401);
      assert.equal(calls.length, 0, 'ninguna llamada al proveedor sin autenticar');
      const ok = mockRes();
      await geminiHandler({ method: 'POST', headers: { 'x-portal-token': 'portal-tok' }, body }, ok);
      assert.equal(ok.statusCode, 200);
      assert.equal(calls.length, 1);
    });
  });
});

// ---------------- S2 BLOQUEADO: /api/audit (llamadores sin credencial)
// Sus únicos llamadores son el navegador (history.js: POST de unánimes y GET
// de sincronización) sin ningún header de auth. Si CRON_SECRET está
// configurado, el gate actual ya les responde 401: evidencia de que el
// fail-closed los rompería. El test solo verifica el gate, sin ejecutar el motor.
test('S2 BLOQUEADO: /api/audit con CRON_SECRET configurado responde 401 sin Bearer (sus llamadores del navegador no lo envían)', async () => {
  await withEnv({ CRON_SECRET: 'test-cron-secret' }, async () => {
    const res = mockRes();
    await auditHandler(
      { method: 'POST', query: {}, headers: {}, body: { picks: [] } },
      res
    );
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.success, false);
  });
});

// ------------------------------------------------------- S3: /api/version
test('S3: /api/version devuelve el commit de VERCEL_GIT_COMMIT_SHA', async () => {
  await withEnv({ VERCEL_GIT_COMMIT_SHA: 'abcdef1234567890abcdef1234567890abcdef12', VERCEL_ENV: 'production' }, async () => {
    const res = mockRes();
    await versionHandler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.commit, 'abcdef1234567890abcdef1234567890abcdef12');
    assert.equal(res.body.commitShort, 'abcdef1');
    assert.equal(res.body.environment, 'production');
    assert.ok(res.body.timestamp);
  });
});

test('S3: /api/version sin variable responde commit unknown (fallback sensato)', async () => {
  await withEnv({ VERCEL_GIT_COMMIT_SHA: undefined, VERCEL_ENV: undefined }, async () => {
    const res = mockRes();
    await versionHandler({ method: 'GET', query: {}, headers: {} }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.commit, 'unknown');
    assert.equal(res.body.commitShort, 'unknown');
    assert.equal(res.body.environment, 'unknown');
  });
});
