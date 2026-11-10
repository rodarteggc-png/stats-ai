// src/services/providerGuard.js
// GUARDRAILS PARA API-SPORTS (api-sports.io / API-Football).
//
// Mejora 2 del plan 2026-11-10. El 2026-11-10 la cuenta se suspendió tras
// ráfagas de escaneos que superaron el límite de 10 peticiones/minuto y la
// llave estaba publicada en el repo. Este guard no puede limitar entre
// instancias serverless distintas (no comparten memoria), pero sí evita que
// UNA invocación dispare ráfagas, y convierte un 429 o una suspensión en una
// señal de "cambiar a respaldo" en vez de reintentar en bucle:
//  - Las peticiones se serializan (nunca dos en el mismo instante).
//  - Ritmo mínimo entre peticiones (pacing) para no parecer una ráfaga.
//  - 429 → proveedor degradado N minutos: las siguientes peticiones fallan
//    rápido sin tocar la red, y el llamador debe usar el respaldo.
//  - Cuerpo con error de suspensión → error distinguible 'suspended'.
//  - El saldo diario se sigue respetando vía /status (ver parlayLive.js).
//
// Sin dependencias: funciona en Node (serverless) y en el navegador.

export const API_SPORTS_RATE_LIMIT_PER_MIN = 10;
export const API_SPORTS_MIN_INTERVAL_MS = 1000;
export const API_SPORTS_COOLDOWN_MS = 5 * 60 * 1000;

export function createProviderGuard({
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  minIntervalMs = API_SPORTS_MIN_INTERVAL_MS,
  cooldownMs = API_SPORTS_COOLDOWN_MS,
} = {}) {
  let lastCallAt = 0;
  let degradedUntil = 0;
  let remaining = null;
  // Cadena de promesas que serializa las peticiones de esta instancia.
  let queue = Promise.resolve();

  function isDegraded() {
    return now() < degradedUntil;
  }

  // Espera su turno antes de disparar una petición. Lanza si el proveedor
  // está degradado (el llamador debe ir al respaldo, no reintentar).
  async function acquire() {
    const turn = queue.then(async () => {
      if (isDegraded()) {
        throw new Error(
          `API-Sports degradado hasta ${new Date(degradedUntil).toISOString()} tras un 429; usa el respaldo.`,
        );
      }
      const wait = lastCallAt ? minIntervalMs - (now() - lastCallAt) : 0;
      if (wait > 0) await sleep(wait);
      lastCallAt = now();
    });
    // La cadena sigue aunque este turno falle, para no bloquear los demás.
    queue = turn.catch(() => {});
    return turn;
  }

  function noteSuccess({ remaining: rem } = {}) {
    if (Number.isFinite(rem)) remaining = rem;
  }

  // Devuelve { degraded: true } si el fallo obliga a parar y usar respaldo.
  function noteFailure({ status, body } = {}) {
    const text = JSON.stringify(body || '');
    if (typeof text === 'string' && /suspended/i.test(text)) {
      return { degraded: false, suspended: true };
    }
    if (status === 429) {
      degradedUntil = now() + cooldownMs;
      return { degraded: true, suspended: false };
    }
    return { degraded: false, suspended: false };
  }

  function state() {
    return { remaining, degradedUntil, lastCallAt, degraded: isDegraded() };
  }

  return { acquire, noteSuccess, noteFailure, state, isDegraded };
}

// Detecta en el cuerpo de error de API-Sports una cuenta suspendida.
export function isSuspendedError(message) {
  return /suspended/i.test(String(message || ''));
}
