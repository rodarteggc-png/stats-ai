// src/services/simulationBridge.js
// Puente de simulación Monte Carlo con fallback automático síncrono.
// Garantiza 0 fallos de ejecución si el navegador no soporta Web Workers.

import { simulateSoccerMatch, simulateMlbMatch, simulateNflMatch } from '../utils/monteCarlo.js';

let workerInstance = null;
let currentTaskId = 0;
const pendingCallbacks = new Map();

function getWorker() {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return null;
  }
  if (!workerInstance) {
    try {
      workerInstance = new Worker(new URL('../workers/monteCarlo.worker.js', import.meta.url), {
        type: 'module'
      });
      workerInstance.onmessage = (e) => {
        const { taskId, success, results, error } = e.data;
        const cb = pendingCallbacks.get(taskId);
        if (cb) {
          pendingCallbacks.delete(taskId);
          if (success) {
            cb.resolve(results);
          } else {
            cb.reject(new Error(error || 'Worker simulation failed'));
          }
        }
      };
      workerInstance.onerror = () => {
        // En caso de error fatal en el worker, destruir y limpiar callbacks pendientes
        workerInstance = null;
        pendingCallbacks.forEach((cb) => {
          cb.reject(new Error('Worker error'));
        });
        pendingCallbacks.clear();
      };
    } catch {
      workerInstance = null;
    }
  }
  return workerInstance;
}

/**
 * Ejecuta simulaciones para un lote de partidos.
 * Usa Web Worker si está disponible; si no, ejecuta síncronamente sin romper la aplicación.
 */
export async function runBatchMonteCarlo(items) {
  const worker = getWorker();
  
  if (worker) {
    return new Promise((resolve) => {
      const taskId = ++currentTaskId;
      
      // Timeout de seguridad: si el worker tarda más de 6 segundos, caer en fallback síncrono
      const timer = setTimeout(() => {
        if (pendingCallbacks.has(taskId)) {
          pendingCallbacks.delete(taskId);
          resolve(runBatchSyncFallback(items));
        }
      }, 6000);

      pendingCallbacks.set(taskId, {
        resolve: (results) => {
          clearTimeout(timer);
          resolve(results);
        },
        reject: () => {
          clearTimeout(timer);
          resolve(runBatchSyncFallback(items));
        }
      });

      worker.postMessage({ taskId, type: 'BATCH_SIMULATE', items });
    });
  }

  // Fallback síncrono directo (Node.js o navegadores sin soporte)
  return runBatchSyncFallback(items);
}

function runBatchSyncFallback(items) {
  const results = {};
  for (const item of items) {
    const { id, sport, params } = item;
    try {
      if (sport === 'futbol') {
        results[id] = simulateSoccerMatch(params.homeXg, params.awayXg, params.iterations || 10000);
      } else if (sport === 'mlb') {
        results[id] = simulateMlbMatch(
          params.homeWhip, params.awayWhip,
          params.homeOps, params.awayOps,
          params.iterations || 10000,
          params.homeElo, params.awayElo
        );
      } else if (sport === 'nfl' || sport === 'ncaaf') {
        results[id] = simulateNflMatch(
          params.lead, params.spread, params.total, params.wind,
          params.iterations || 10000,
          params.isCollege || (sport === 'ncaaf')
        );
      }
    } catch (e) {
      console.warn("Fallback Monte Carlo error:", e);
    }
  }
  return results;
}
