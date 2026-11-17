// scripts/hitsReport.mjs
// Registro de aciertos (hits) SEPARADO del ledger de ROI.
// Regla del proyecto: data/pick_ledger.jsonl NUNCA se toca; los aciertos
// viven en data/hits_ledger.jsonl. Un pick sin precio real cuenta en
// aciertos y calibración, pero NUNCA en ROI (el ROI se calcula solo con
// picks del ledger, que tienen precio real o precio de mensaje verificado).
// Uso: node scripts/hitsReport.mjs [--hits <ruta>] [--ledger <ruta>] [--out <dir>]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const r2 = (n) => Math.round(n * 100) / 100;

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function summarizeHits(rows) {
  const counted = rows.filter((r) => r.countsForHits !== false);
  const closed = counted.filter((r) => r.result === 'WON' || r.result === 'LOST');
  const wins = closed.filter((r) => r.result === 'WON').length;
  const losses = closed.filter((r) => r.result === 'LOST').length;
  const hitRatePct = closed.length ? r2((wins / closed.length) * 100) : null;
  const groupBy = (keyFn) => {
    const groups = new Map();
    for (const r of closed) {
      const k = keyFn(r) || 'Sin clasificar';
      const g = groups.get(k) || { key: k, n: 0, wins: 0, losses: 0 };
      g.n += 1;
      if (r.result === 'WON') g.wins += 1;
      else g.losses += 1;
      groups.set(k, g);
    }
    return [...groups.values()].map((g) => ({ ...g, hitRatePct: r2((g.wins / g.n) * 100) }));
  };
  return {
    n: counted.length,
    closed: closed.length,
    wins,
    losses,
    hitRatePct,
    bySport: groupBy((r) => r.sport),
    byMarket: groupBy((r) => r.market),
  };
}

function summarizeLedger(rows) {
  // Misma fórmula que scripts/ledgerReport.mjs: summarize(closed), donde
  // closed son solo las cerradas (WON/LOST). El pick PENDING (prop Krstovic,
  // stake 1.5u sin pnl) NO entra en lo apostado: si se contara, el ROI
  // saldría -12.45% en vez del -12.82% verificado (51.1u apostadas).
  const settled = rows.filter((r) => r.result === 'WON' || r.result === 'LOST');
  const wins = settled.filter((r) => r.result === 'WON').length;
  const losses = settled.filter((r) => r.result === 'LOST').length;
  const staked = settled.reduce((a, r) => a + (Number(r.stakeUnits) || 0), 0);
  const net = settled.reduce((a, r) => a + (Number(r.pnlUnits) || 0), 0);
  return {
    n: rows.length,
    closed: settled.length,
    wins,
    losses,
    hitRatePct: settled.length ? r2((wins / settled.length) * 100) : null,
    netUnits: r2(net),
    stakedUnits: r2(staked),
    roiPct: staked > 0 ? r2((net / staked) * 100) : null,
  };
}

export function computeHitsReport({ hitsPath, ledgerPath } = {}) {
  const hitsFile = hitsPath || path.join(__dirname, '..', 'data', 'hits_ledger.jsonl');
  const ledgerFile = ledgerPath || path.join(__dirname, '..', 'data', 'pick_ledger.jsonl');
  const hits = summarizeHits(readJsonl(hitsFile));
  const ledger = summarizeLedger(readJsonl(ledgerFile));
  const combinedClosed = hits.closed + ledger.closed;
  const combinedWins = hits.wins + ledger.wins;
  return {
    hits,
    ledger,
    combined: {
      n: hits.n + ledger.n,
      closed: combinedClosed,
      wins: combinedWins,
      losses: hits.losses + ledger.losses,
      hitRatePct: combinedClosed ? r2((combinedWins / combinedClosed) * 100) : null,
    },
    note: 'ROI solo del ledger (precio real). Los aciertos sin precio no entran en ROI.',
  };
}

function renderMd(report) {
  const { hits, ledger, combined } = report;
  const lines = [
    '# Registro de aciertos + ROI (ledger)',
    '',
    `Generado: ${new Date().toISOString()}`,
    '',
    '## Aciertos (hits_ledger.jsonl — sin precio, no entran en ROI)',
    `- Picks: ${hits.n} | Cerrados: ${hits.closed} | ${hits.wins}W-${hits.losses}L | Acierto: ${hits.hitRatePct === null ? '—' : `${hits.hitRatePct}%`}`,
    ...hits.bySport.map((g) => `- ${g.key}: ${g.n} picks, ${g.wins}W-${g.losses}L, acierto ${g.hitRatePct}%`),
    ...hits.byMarket.map((g) => `- ${g.key}: ${g.n} picks, ${g.wins}W-${g.losses}L, acierto ${g.hitRatePct}%`),
    '',
    '## ROI (pick_ledger.jsonl — solo precio real)',
    `- Picks: ${ledger.n} | Cerrados: ${ledger.closed} | ${ledger.wins}W-${ledger.losses}L | Acierto: ${ledger.hitRatePct === null ? '—' : `${ledger.hitRatePct}%`}`,
    `- Neto: ${ledger.netUnits >= 0 ? '+' : ''}${ledger.netUnits}u | Apostado: ${ledger.stakedUnits}u | ROI: ${ledger.roiPct === null ? '—' : `${ledger.roiPct}%`}`,
    '',
    '## Combinado (aciertos + ledger)',
    `- Picks: ${combined.n} | Cerrados: ${combined.closed} | ${combined.wins}W-${combined.losses}L | Acierto: ${combined.hitRatePct === null ? '—' : `${combined.hitRatePct}%`}`,
    `- ROI (solo ledger): ${ledger.roiPct === null ? '—' : `${ledger.roiPct}%`} — los aciertos no cambian el ROI.`,
    '',
    `> ${report.note}`,
    '',
  ];
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  const args = process.argv.slice(2);
  const getArg = (name, def) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : def;
  };
  const outDir = getArg('--out', path.join(__dirname, '..', 'data'));
  const report = computeHitsReport({
    hitsPath: getArg('--hits', undefined),
    ledgerPath: getArg('--ledger', undefined),
  });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'hits_report.json'), JSON.stringify(report, null, 1) + '\n');
  fs.writeFileSync(path.join(outDir, 'hits_report.md'), renderMd(report));
  console.log(`Aciertos: ${report.hits.n} picks, ${report.hits.wins}W-${report.hits.losses}L, acierto ${report.hits.hitRatePct}%`);
  console.log(`Ledger ROI: ${report.ledger.netUnits}u neto, ROI ${report.ledger.roiPct}% (solo ledger)`);
  console.log(`Combinado: ${report.combined.n} picks, ${report.combined.wins}W-${report.combined.losses}L, acierto ${report.combined.hitRatePct}%`);
}
