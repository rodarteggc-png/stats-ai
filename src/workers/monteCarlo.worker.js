// src/workers/monteCarlo.worker.js
// Web Worker para ejecutar simulaciones Monte Carlo (10,000 iteraciones por partido)
// en un hilo de CPU paralelo sin congelar la UI de React.

import { simulateSoccerMatch, simulateMlbMatch, simulateNflMatch } from '../utils/monteCarlo.js';

self.onmessage = (event) => {
  const { taskId, type, items } = event.data;

  if (type === 'BATCH_SIMULATE') {
    try {
      const results = {};
      
      for (const item of items) {
        const { id, sport, params } = item;
        if (sport === 'futbol') {
          results[id] = simulateSoccerMatch(params.homeXg, params.awayXg, params.iterations || 10000);
        } else if (sport === 'mlb') {
          results[id] = simulateMlbMatch(
            params.homeWhip, params.awayWhip,
            params.homeOps, params.awayOps,
            params.iterations || 10000,
            params.homeElo, params.awayElo
          );
        } else if (sport === 'nfl') {
          results[id] = simulateNflMatch(
            params.lead, params.spread, params.total, params.wind,
            params.iterations || 10000
          );
        }
      }

      self.postMessage({ taskId, success: true, results });
    } catch (err) {
      self.postMessage({ taskId, success: false, error: err.message });
    }
  }
};
