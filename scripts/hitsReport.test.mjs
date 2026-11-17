import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { computeHitsReport } from './hitsReport.mjs';

test('el reporte de aciertos combina hits y ROI sin mezclarlos', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hits-report-'));
  try {
    const hitsPath = path.join(tmpDir, 'hits_ledger.jsonl');
    const ledgerPath = path.join(tmpDir, 'pick_ledger.jsonl');
    const hits = [
      { id: 'h1', sport: 'Fútbol', market: 'total', result: 'WON', countsForHits: true, countsForROI: false, priceReal: false },
      { id: 'h2', sport: 'Fútbol', market: 'moneyline', result: 'WON', countsForHits: true, countsForROI: false, priceReal: false },
      { id: 'h3', sport: 'Fútbol', market: 'total', result: 'LOST', countsForHits: true, countsForROI: false, priceReal: false },
    ];
    const ledger = [
      { id: 'l1', sport: 'Fútbol', market: 'total', result: 'WON', stakeUnits: 1, pnlUnits: 0.9, placedOdds: 1.9 },
      { id: 'l2', sport: 'Fútbol', market: 'total', result: 'WON', stakeUnits: 1, pnlUnits: 0.9, placedOdds: 1.9 },
      { id: 'l3', sport: 'Fútbol', market: 'spread', result: 'LOST', stakeUnits: 1, pnlUnits: -1, placedOdds: 1.9 },
    ];
    fs.writeFileSync(hitsPath, hits.map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(ledgerPath, ledger.map((r) => JSON.stringify(r)).join('\n') + '\n');

    const report = computeHitsReport({ hitsPath, ledgerPath });

    // Aciertos: 2W-1L, 66.67%
    assert.equal(report.hits.n, 3);
    assert.equal(report.hits.wins, 2);
    assert.equal(report.hits.losses, 1);
    assert.equal(report.hits.hitRatePct, 66.67);
    // ROI solo del ledger: neto +0.8u sobre 3u = +26.67%
    assert.equal(report.ledger.netUnits, 0.8);
    assert.equal(report.ledger.stakedUnits, 3);
    assert.equal(report.ledger.roiPct, 26.67);
    // Combinado: 6 picks, 4W-2L, 66.67% — el ROI no cambia por los aciertos
    assert.equal(report.combined.n, 6);
    assert.equal(report.combined.closed, 6);
    assert.equal(report.combined.wins, 4);
    assert.equal(report.combined.losses, 2);
    assert.equal(report.combined.hitRatePct, 66.67);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('el archivo real de aciertos del 16 nov tiene 6 picks, 4W-2L', () => {
  const hitsPath = path.join(process.cwd(), 'data', 'hits_ledger.jsonl');
  const ledgerPath = path.join(process.cwd(), 'data', 'pick_ledger.jsonl');
  const report = computeHitsReport({ hitsPath, ledgerPath });
  assert.equal(report.hits.n, 6);
  assert.equal(report.hits.closed, 6);
  assert.equal(report.hits.wins, 4);
  assert.equal(report.hits.losses, 2);
  assert.equal(report.hits.hitRatePct, 66.67);
  // Combinado con el ledger real (64 picks, 63 cerrados, 30W-33L):
  // 70 picks, 69 cerrados, 34W-35L, acierto 49.28%. ROI solo del ledger.
  assert.equal(report.combined.n, 70);
  assert.equal(report.combined.closed, 69);
  assert.equal(report.combined.wins, 34);
  assert.equal(report.combined.losses, 35);
  assert.equal(report.combined.hitRatePct, 49.28);
  assert.equal(report.ledger.netUnits, -6.55);
  assert.equal(report.ledger.roiPct, -12.82);
});
