#!/usr/bin/env node
// scripts/updateNbaRatings.mjs
// Descarga los ratings en vivo de la NBA desde ESPN y los guarda en data/nba_ratings.json
// (artefacto de diagnóstico/auditoría; el runtime los carga en memoria en cada escaneo).
// Uso: npm run nba:ratings
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchLiveNbaRatings } from '../src/services/nbaRatings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dirname, '..', 'data', 'nba_ratings.json');

try {
  const payload = await fetchLiveNbaRatings({ force: true });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  const rows = Object.entries(payload.ratings)
    .map(([key, r]) => ({ team: key, ...r }))
    .sort((a, b) => (b.ortg - b.drtg) - (a.ortg - a.drtg));
  console.log(`\nRatings NBA en vivo — ${payload.season || 'temporada en curso'} (${payload.teams} equipos, ${payload.fetchedAt})`);
  console.log(`Promedio liga: Pace ${payload.leagueAvg.pace} | ORtg ${payload.leagueAvg.ortg} | DRtg ${payload.leagueAvg.drtg} (encogimiento K=6 partidos)`);
  console.log('Equipo'.padEnd(26) + 'Pace   ORtg   DRtg   Neto   PJ');
  for (const r of rows) {
    const net = (r.ortg - r.drtg).toFixed(1);
    console.log(`${r.team.padEnd(26)}${String(r.pace).padEnd(7)}${String(r.ortg).padEnd(7)}${String(r.drtg).padEnd(7)}${String(net).padEnd(7)}${r.games}`);
  }
  if (payload.notices?.length) {
    console.log('\nAvisos:');
    payload.notices.forEach((n) => console.log(` • ${n}`));
  }
  console.log(`\nGuardado en ${outPath}`);
  process.exit(0);
} catch (err) {
  console.error('❌ No se pudieron descargar los ratings en vivo:', err.message);
  process.exit(1);
}
