import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApiSportsTeamId,
  fetchTeamCornersAvg,
  fetchTeamCornersByName,
  extractTeamCornersFromFixture,
  clearCornersCache,
  resetApiSportsKeyHealth,
} from '../src/services/apiSports.js';
import cornersHandler from '../api/corners.js';
import {
  fetchRealCorners,
  resolveCornersValue,
  clearCornersClientCache,
} from '../src/services/cornersClient.js';
import { calculatePropProbabilities } from '../src/utils/poisson.js';

// CÓRNERS REALES (2026-11-25): dato real de API-Sports vía /v3/fixtures.
// Llave FALSA solo para los tests (nunca una llave real): el código solo la
// lee de variables de entorno y nunca la registra ni la devuelve.
const FAKE_KEY = 'test-fake-key-0123456789';
const realFetch = globalThis.fetch;

function jsonRes(data, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

function fixtureWithCorners(fixtureId, teamId, corners, teamName = 'Equipo') {
  const stats = corners === undefined
    ? [{ type: 'Shots on Goal', value: 5 }]
    : [{ type: 'Corner Kicks', value: corners }];
  return {
    fixture: { id: fixtureId },
    statistics: [
      { team: { id: teamId, name: teamName }, statistics: stats },
      { team: { id: 999, name: 'Rival' }, statistics: [{ type: 'Corner Kicks', value: 3 }] },
    ],
  };
}

beforeEach(() => {
  process.env.APISPORTS_KEY = FAKE_KEY;
  delete process.env.APISPORTS_KEYS;
  clearCornersCache();
  clearCornersClientCache();
  resetApiSportsKeyHealth();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.APISPORTS_KEY;
  delete process.env.APISPORTS_KEYS;
  clearCornersCache();
  clearCornersClientCache();
});

// Router de mocks por URL: equipos Barcelona (529) y Real Madrid (541).
function installApiSportsMock({ barcaCorners = [4, 6, 5], madridCorners = [7, 5, 6], listHasStatistics = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url));
    if (u.pathname === '/v3/teams') {
      const q = (u.searchParams.get('search') || '').toLowerCase();
      if (q.includes('barcelona')) {
        // La femenil aparece PRIMERO: la guardia femenil/varonil de
        // isTeamMatch debe descartarla y quedarse con el varonil (529).
        return jsonRes({ response: [
          { team: { id: 999, name: 'FC Barcelona Femení' } },
          { team: { id: 529, name: 'FC Barcelona' } },
        ] });
      }
      if (q.includes('barca')) {
        return jsonRes({ response: [{ team: { id: 529, name: 'FC Barcelona' } }] });
      }
      if (q.includes('madrid')) {
        return jsonRes({ response: [{ team: { id: 541, name: 'Real Madrid' } }] });
      }
      return jsonRes({ response: [] });
    }
    if (u.pathname === '/v3/fixtures') {
      const teamId = Number(u.searchParams.get('team'));
      const corners = teamId === 529 ? barcaCorners : madridCorners;
      const response = corners.map((c, i) => {
        if (!listHasStatistics) return { fixture: { id: 100 + i } };
        return fixtureWithCorners(100 + i, teamId, c, teamId === 529 ? 'FC Barcelona' : 'Real Madrid');
      });
      return jsonRes({ response });
    }
    if (u.pathname === '/v3/fixtures/statistics') {
      const fixtureId = Number(u.searchParams.get('fixture'));
      const idx = fixtureId - 100;
      const corners = barcaCorners[idx];
      return jsonRes({ response: [
        { team: { id: 529, name: 'FC Barcelona' }, statistics: [{ type: 'Corner Kicks', value: corners }] },
      ] });
    }
    return jsonRes({ response: [] }, { ok: false, status: 404 });
  };
  return calls;
}

function mockRes() {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

// (i) Con dato real: la proyección usa el dato real y el promedio es correcto.
test('(i) dato real: fixtures con 4, 6, 5 córners → avg 5.0, n=3', async () => {
  const calls = installApiSportsMock();
  const result = await fetchTeamCornersByName('Barcelona', 2026);
  assert.deepEqual(result, { avg: 5.0, n: 3, source: 'api-sports' });
  assert.ok(!calls.some((c) => c.includes('/fixtures/statistics?fixture=')),
    'con statistics embebidos no debe pedir /fixtures/statistics por partido');
});

test('(i) resolución de id por alias y guardia femenil/varonil', async () => {
  installApiSportsMock();
  assert.equal(await resolveApiSportsTeamId('Barca'), 529);
  // 'Barcelona' con la femenil primero en la respuesta: debe elegir el varonil.
  assert.equal(await resolveApiSportsTeamId('Barcelona'), 529);
  assert.equal(await resolveApiSportsTeamId('Real Madrid'), 541);
  assert.equal(await resolveApiSportsTeamId('Equipo Inexistente ZZ'), null);
});

// (vi) El parser ignora fixtures sin "Corner Kicks" y promedia solo los válidos.
test('(vi) parser: ignora value null, tipo ausente y bloque del rival', () => {
  const fx = (id, value) => (value === 'no-type'
    ? { fixture: { id }, statistics: [{ team: { id: 529 }, statistics: [{ type: 'Shots on Goal', value: 5 }] }] }
    : fixtureWithCorners(id, 529, value));
  assert.equal(extractTeamCornersFromFixture(fx(1, 4), 529), 4);
  assert.equal(extractTeamCornersFromFixture(fx(2, null), 529), null);
  assert.equal(extractTeamCornersFromFixture(fx(3, 'no-type'), 529), null);
  assert.equal(extractTeamCornersFromFixture({ fixture: { id: 4 } }, 529), undefined);
  assert.equal(extractTeamCornersFromFixture(fx(5, 6), 541), null); // otro equipo: no promediar el rival
});

test('(vi) promedio solo con válidos: [4, null, sin-tipo, 6] → avg 5.0, n=2', async () => {
  const calls = installApiSportsMock({ barcaCorners: [4, null, undefined, 6] });
  // undefined en el mock genera fixture sin "Corner Kicks" (otro tipo).
  const result = await fetchTeamCornersAvg(529, 2026);
  assert.deepEqual(result, { avg: 5.0, n: 2, source: 'api-sports' });
  assert.ok(calls.length >= 1);
});

test('respaldo: lista sin statistics → /fixtures/statistics por partido (hasta 10)', async () => {
  const calls = installApiSportsMock({ listHasStatistics: false });
  const result = await fetchTeamCornersAvg(529, 2026);
  assert.deepEqual(result, { avg: 5.0, n: 3, source: 'api-sports' });
  assert.equal(calls.filter((c) => c.includes('/fixtures/statistics?fixture=')).length, 3);
});

// (ii) Sin dato real (null / sin llave / respuesta sin statistics): fallback, sin fallar.
test('(ii) sin llave → null y sin llamadas de red', async () => {
  delete process.env.APISPORTS_KEY;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return jsonRes({ response: [] }); };
  assert.equal(await fetchTeamCornersAvg(529, 2026), null);
  assert.equal(await fetchTeamCornersByName('Barcelona', 2026), null);
  assert.equal(await resolveApiSportsTeamId('Barcelona'), null);
  assert.equal(fetchCalls, 0);
});

test('(ii) sin fixtures / sin dato → null, no throw', async () => {
  globalThis.fetch = async () => jsonRes({ response: [] });
  assert.equal(await fetchTeamCornersAvg(529, 2026), null);
  assert.equal(await fetchTeamCornersByName('Barcelona', 2026), null);
});

test('(ii) resolveCornersValue: con real usa el real; sin real usa el fallback xG', () => {
  assert.deepEqual(resolveCornersValue({ avg: 5, n: 8 }, '6.3'), { value: 5, source: 'real', realAvg: 5 });
  assert.deepEqual(resolveCornersValue(null, '6.3'), { value: '6.3', source: 'xg', realAvg: null });
  assert.deepEqual(resolveCornersValue({ avg: null, n: 0 }, '6.3'), { value: '6.3', source: 'xg', realAvg: null });
});

// (iii) El caché evita llamadas repetidas al mismo equipo.
test('(iii) segunda llamada al mismo equipo no hace fetch', async () => {
  const calls = installApiSportsMock();
  const first = await fetchTeamCornersAvg(529, 2026);
  const second = await fetchTeamCornersAvg(529, 2026);
  assert.deepEqual(first, second);
  assert.equal(calls.filter((c) => c.includes('/v3/fixtures?team=529')).length, 1);
  // Otro equipo sí pide (caché por equipo, no global).
  await fetchTeamCornersAvg(541, 2026);
  assert.equal(calls.filter((c) => c.includes('/v3/fixtures?team=541')).length, 1);
});

// (iv) Fail-safe ante error de red.
test('(iv) fetch que rechaza → null, no throw', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  assert.equal(await fetchTeamCornersAvg(529, 2026), null);
  assert.equal(await fetchTeamCornersByName('Barcelona', 2026), null);
});

// (v) El endpoint /api/corners responde nulls (no 500) cuando no hay llave o no hay dato.
test('(v) endpoint sin llave → 200 con nulls', async () => {
  delete process.env.APISPORTS_KEY;
  const res = mockRes();
  await cornersHandler({ method: 'GET', query: { home: 'Barcelona', away: 'Real Madrid' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { success: true, home: null, away: null, source: 'api-sports' });
});

test('(v) endpoint con dato → 200 con ambos promedios', async () => {
  installApiSportsMock();
  const res = mockRes();
  await cornersHandler({ method: 'GET', query: { home: 'Barcelona', away: 'Real Madrid', season: '2026' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    success: true,
    home: { avg: 5.0, n: 3 },
    away: { avg: 6.0, n: 3 },
    source: 'api-sports',
  });
});

test('(v) endpoint sin dato (equipos desconocidos) → 200 con nulls, no 500', async () => {
  installApiSportsMock();
  const res = mockRes();
  await cornersHandler({ method: 'GET', query: { home: 'Equipo Inexistente ZZ', away: '' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.home, null);
  assert.equal(res.body.away, null);
});

// Cliente del endpoint: caché por equipo y fail-safe.
test('cliente /api/corners: reutiliza el equipo cacheado y solo pide el faltante', async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const u = new URL(String(url), 'http://localhost');
    const home = u.searchParams.get('home');
    const away = u.searchParams.get('away');
    return jsonRes({
      success: true,
      home: home ? { avg: 5, n: 8 } : null,
      away: away === 'Sevilla' ? { avg: 6.5, n: 7 } : null,
      source: 'api-sports',
    });
  };
  const first = await fetchRealCorners('Barcelona', 'Real Madrid', 2026);
  assert.deepEqual(first, { home: { avg: 5, n: 8 }, away: null });
  const second = await fetchRealCorners('Barcelona', 'Sevilla', 2026);
  assert.deepEqual(second, { home: { avg: 5, n: 8 }, away: { avg: 6.5, n: 7 } });
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes('home=&away=Sevilla'), 'el segundo fetch solo pide el equipo faltante');
  const third = await fetchRealCorners('Barcelona', 'Sevilla', 2026);
  assert.deepEqual(third, second);
  assert.equal(calls.length, 2, 'tercera llamada: todo cacheado, sin fetch');
});

test('cliente /api/corners: error de red → nulls, no throw', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  assert.deepEqual(await fetchRealCorners('Barcelona', 'Real Madrid', 2026), { home: null, away: null });
});

// Efecto medido con la función real (sin GameStateModifier, probs=null):
// local xG 6.3 + visita 4.2 → OVER 9.5 60.3%; local real 5.0 + visita 4.2 → 43.9%.
test('efecto medido: dato real 5.0 vs xG 6.3 cambia OVER 9.5 de 60.3% a 43.9%', () => {
  const withXg = calculatePropProbabilities(6.3, 4.2, 9.5, null);
  const withReal = calculatePropProbabilities(5.0, 4.2, 9.5, null);
  assert.equal(withXg.over, 60.3);
  assert.equal(withReal.over, 43.9);
  assert.equal(withXg.expectedTotal, '10.5');
  assert.equal(withReal.expectedTotal, '9.2');
});
