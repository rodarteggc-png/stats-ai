// api/corners.js - Proxy server-side de córners reales (API-Sports, 2026-11-25):
// la llave nunca viaja al navegador (mismo patrón que api/gemini.js: el
// cliente llama al endpoint y el servidor usa la llave de entorno).
// GET /api/corners?home={nombreEquipoLocal}&away={nombreEquipoVisitante}&season={año}
// (season opcional, por defecto el año actual).
// Responde { success: true, home: { avg, n } | null, away: { avg, n } | null,
// source: 'api-sports' }.
// Fail-safe: cualquier fallo (sin llave, sin id, sin dato, error de red)
// responde con nulls y success:true (el cliente usa el fallback xG); nunca
// responde 500 por falta de dato. La llave nunca se registra ni se devuelve.
// Público (sin PORTAL_ACCESS_TOKEN ni CRON_SECRET): es un derivado
// estadístico de solo lectura para el simulador web público; no expone
// credenciales ni datos personales. El costo por equipo está acotado por el
// caché de 24 h en src/services/apiSports.js (1 request/día por equipo en el
// camino feliz; 1 + 10 como peor caso si la lista no trae statistics).
import { fetchTeamCornersByName } from '../src/services/apiSports.js';

const strip = (r) => (r ? { avg: r.avg, n: r.n } : null);

export default async function handler(req, res) {
  try {
    if (req.method && req.method !== 'GET') {
      return res.status(405).json({ success: false, error: 'Método no permitido' });
    }
    const query = req.query || {};
    const homeName = typeof query.home === 'string' ? query.home : '';
    const awayName = typeof query.away === 'string' ? query.away : '';
    const seasonRaw = parseInt(query.season, 10);
    const season = Number.isInteger(seasonRaw) ? seasonRaw : new Date().getFullYear();
    const [home, away] = await Promise.all([
      homeName ? fetchTeamCornersByName(homeName, season) : Promise.resolve(null),
      awayName ? fetchTeamCornersByName(awayName, season) : Promise.resolve(null),
    ]);
    return res.status(200).json({ success: true, home: strip(home), away: strip(away), source: 'api-sports' });
  } catch {
    // Nunca 500 por falta de dato: el cliente usa el fallback xG.
    return res.status(200).json({ success: true, home: null, away: null, source: 'api-sports', error: 'corners_unavailable' });
  }
}
