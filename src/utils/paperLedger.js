// src/utils/paperLedger.js
// MODO PAPER (2026-11-10): registro y medición de picks SIN despachar ni apostar.
//
// Problema que resuelve: el ledger real solo guarda picks despachados, así que
// nadie puede medir (a) si los 5 candados vetan ganadores, (b) qué acierto
// tendrían los picks con la calibración actual, ni (c) qué umbral conviene.
// El modo paper corre el motor completo y registra TODO: emitidos, aprobados
// que no entraron al slate, y vetados con su motivo. Nada de esto toca el
// ledger real (data/pick_ledger.jsonl) ni el canal VIP de picks reales.
//
// Este módulo es PURO (sin fs ni red): construir entradas, compactarlas para
// el cloud cache, formatear el slate de Telegram y calcular estadísticas.
// El I/O (archivo local, espejo Telegram, cloud cache) vive en
// scripts/alertEngine.js junto a recordPickToLedger.
//
// Persistencia en producción (Vercel, disco de solo lectura):
//  - Espejo Telegram (TELEGRAM_LEDGER_CHAT_ID): "PAPER_LEDGER {json}" por pick.
//  - Cloud cache: _meta.paperLedger, entradas compactas, tope 30 pendientes.
//    Al calificarse, salen del stash y solo quedan los agregados en
//    _meta.paperReport. El stash es best-effort con tope de tamaño: si no
//    cabe, no se guarda (el espejo Telegram sigue siendo el registro).
//  - Local: data/paper_ledger.jsonl (misma forma que el ledger real + campos paper).

export const PAPER_LEDGER_FILENAME = 'paper_ledger.jsonl';
export const PAPER_CLOSURES_FILENAME = 'paper_ledger_closures.jsonl';
export const PAPER_MAX_STASH_ENTRIES = 30;
export const PAPER_MAX_STASH_JSON_CHARS = 6000;

// Motivos de veto del filtro de aprobación (mismo orden y condiciones que
// classifyOpportunity en scripts/alertEngine.js). 'slate_cupo' es aparte:
// el pick pasó el filtro pero no entró al Top Slate (cupo/props/anti-DNP).
export const PAPER_VETO_REASONS = {
  postponed: 'Partido pospuesto',
  odds_invalid: 'Cuota inválida o menor a 1.10',
  odds_proxy: 'Cuota proxy de otro deporte',
  ev_below_min: 'EV por debajo del mínimo (y no es base de confianza)',
  consensus_votes: 'Tribunal: menos de 2 de 3 votos (aquí caen los 5 candados)',
  rlm_trap: 'Veto RLM: trampa institucional / flujo adverso',
  league_not_tier1: 'Liga fuera de la whitelist Tier 1',
  ncaaf_road_favorite: 'Veto favorito visitante en spread colegial',
  tipster_audit: 'Veto cualitativo Tipster Pro (fatiga/vestidor/clima)',
  burned_odds: 'Momio quemado: RLM favorable pero edge remanente < 3% o cuota < 1.45',
  prob_below_min: 'Probabilidad calibrada por debajo del mínimo del mercado',
  spread_paused: 'Spreads en pausa: mercado en medición (1W-9L en el ledger real)',
  slate_cupo: 'Aprobado pero sin cupo en el Top Slate',
};

export function vetoReasonLabel(code) {
  return PAPER_VETO_REASONS[code] || `Veto: ${code}`;
}

function num(v, fallback = null) {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Construye una entrada paper con la misma forma que una fila del ledger real
 * (para que gradeLedger la pueda calificar tal cual) + campos paper.
 * opts: { vetoReason, vetoDetail, shift, brakeBlocked, wouldStake }
 */
export function buildPaperEntry(pick = {}, opts = {}) {
  const vetoReason = opts.vetoReason || null;
  const shift = opts.shift || 'matutino';
  const dateStr = (pick.gameDate || new Date().toISOString()).slice(0, 10);
  const baseId = pick.id || `${pick.sport || 'pick'}-${Date.now()}`;
  const id = vetoReason ? `${baseId}::veto-${shift}-${dateStr}` : baseId;
  return {
    id,
    timestamp: new Date().toISOString(),
    paper: true,
    status: 'PENDING',
    result: null,
    score: null,
    pnlUnits: null,
    sport: pick.sport || 'Deporte',
    league: pick.league || pick.sport || 'General',
    game: pick.game || `${pick.match?.home?.name || 'Local'} vs ${pick.match?.away?.name || 'Visitante'}`,
    gameDate: pick.gameDate || new Date().toISOString(),
    pick: pick.pick,
    type: pick.type || 'Apuesta',
    placedOdds: num(pick.odds, 1.9),
    closingOdds: null,
    clvPct: null,
    prob: num(pick.prob, 60),
    rawProb: pick.rawProb !== undefined && pick.rawProb !== null ? num(pick.rawProb, null) : null,
    evPct: Number.isFinite(pick.evPct) ? Number(pick.evPct.toFixed(2)) : null,
    consensus: `${pick.consensus?.votesPassed ?? 3}/3`,
    oddsSource: pick.oddsSource || 'market',
    stakeUnits: num(opts.wouldStake, 1.0),
    shift,
    vetoReason,
    vetoDetail: opts.vetoDetail || null,
    brakeBlocked: Boolean(opts.brakeBlocked),
    source: 'paper',
  };
}

// Compactación para el cloud cache (_meta.paperLedger): array posicional.
export function compactPaperEntry(e) {
  return [
    e.id, (e.gameDate || '').slice(0, 10), e.sport, e.game, e.pick, e.type,
    e.placedOdds, e.prob, e.rawProb, e.stakeUnits, e.vetoReason, e.shift,
    e.status, e.result, e.score, e.pnlUnits,
  ];
}

export function expandPaperEntry(a) {
  if (!Array.isArray(a) || a.length < 12) return null;
  return {
    id: a[0], gameDate: a[1], sport: a[2], game: a[3], pick: a[4], type: a[5],
    placedOdds: a[6], prob: a[7], rawProb: a[8], stakeUnits: a[9],
    vetoReason: a[10] || null, shift: a[11] || 'matutino',
    status: a[12] || 'PENDING', result: a[13] || null, score: a[14] || null,
    pnlUnits: a[15] ?? null, paper: true, source: 'paper',
  };
}

export function summarizeVetoes(entries = []) {
  const vetoed = entries.filter(e => e.vetoReason);
  const byReason = {};
  for (const e of vetoed) {
    const r = byReason[e.vetoReason] || { count: 0, won: 0, lost: 0, push: 0, pending: 0 };
    r.count += 1;
    if (e.status === 'CLOSED' && e.result === 'WON') r.won += 1;
    else if (e.status === 'CLOSED' && e.result === 'LOST') r.lost += 1;
    else if (e.status === 'CLOSED') r.push += 1;
    else r.pending += 1;
    byReason[e.vetoReason] = r;
  }
  for (const r of Object.values(byReason)) {
    const decided = r.won + r.lost;
    r.winRate = decided > 0 ? Number(((r.won / decided) * 100).toFixed(1)) : null;
  }
  return { total: vetoed.length, byReason };
}

function bucketOf(probPct) {
  if (probPct >= 80) return '80%+';
  if (probPct >= 70) return '70-80%';
  if (probPct >= 60) return '60-70%';
  return '50-60%';
}

function emptyGroup() {
  return { n: 0, won: 0, lost: 0, push: 0, pending: 0, staked: 0, net: 0, hitRate: null, roi: null };
}

function finalizeGroup(g) {
  const decided = g.won + g.lost;
  g.hitRate = decided > 0 ? Number(((g.won / decided) * 100).toFixed(1)) : null;
  g.roi = g.staked > 0 ? Number(((g.net / g.staked) * 100).toFixed(1)) : null;
  g.net = Number(g.net.toFixed(2));
  g.staked = Number(g.staked.toFixed(2));
  return g;
}

function brier(entries, field) {
  const decided = entries.filter(e => e.status === 'CLOSED' && (e.result === 'WON' || e.result === 'LOST'));
  if (!decided.length) return null;
  const s = decided.reduce((acc, e) => {
    const p = Math.max(0.01, Math.min(0.99, (num(e[field], 60)) / 100));
    const y = e.result === 'WON' ? 1 : 0;
    return acc + (p - y) ** 2;
  }, 0);
  return Number((s / decided.length).toFixed(4));
}

/**
 * Ajuste Platt pooled (todos los deportes juntos) sobre picks calificados.
 * Misma formulación que src/utils/calibration.js: logit(p_cal) = A*logit(p_raw) + B.
 * Devuelve el ajuste SIN clamp (honesto) y el clampado a los límites del
 * motor (A [0.40, 1.80], B [-0.60, 0.60]) para que la decisión sea informada.
 */
export function fitPlattPooled(graded = []) {
  const valid = graded.filter(e =>
    e.status === 'CLOSED' && (e.result === 'WON' || e.result === 'LOST') &&
    Number.isFinite(num(e.rawProb ?? e.prob)));
  if (valid.length < 10) return { n: valid.length, A: null, B: null, Aclamped: null, Bclamped: null, note: 'Muestra insuficiente (<10 calificados).' };
  let A = 1.0;
  let B = 0.0;
  const lr = 0.015;
  for (let epoch = 0; epoch < 600; epoch++) {
    let gA = 0;
    let gB = 0;
    for (const e of valid) {
      const raw = Math.max(0.01, Math.min(0.99, num(e.rawProb ?? e.prob) / 100));
      const logit = Math.log(raw / (1 - raw));
      const z = Math.max(-15, Math.min(15, A * logit + B));
      const cal = 1 / (1 + Math.exp(-z));
      const y = e.result === 'WON' ? 1 : 0;
      const err = cal - y;
      gA += err * logit;
      gB += err;
    }
    A -= lr * (gA / valid.length);
    B -= lr * (gB / valid.length);
  }
  return {
    n: valid.length,
    A: Number(A.toFixed(3)),
    B: Number(B.toFixed(3)),
    Aclamped: Number(Math.max(0.4, Math.min(1.8, A)).toFixed(3)),
    Bclamped: Number(Math.max(-0.6, Math.min(0.6, B)).toFixed(3)),
    note: null,
  };
}

/**
 * Estadísticas del ledger paper (local o del cache). Separa emitidos
 * (vetoReason null), vetados y aprobados sin cupo. El grupo "vetados" es la
 * respuesta a si los candados bloquean ganadores: su hit rate realizado.
 */
export function computePaperStats(entries = []) {
  const emitted = emptyGroup();
  const vetoed = emptyGroup();
  const noCupo = emptyGroup();
  const byBucket = { '50-60%': emptyGroup(), '60-70%': emptyGroup(), '70-80%': emptyGroup(), '80%+': emptyGroup() };
  const byMarket = {};
  const byReason = summarizeVetoes(entries).byReason;

  for (const e of entries) {
    const g = e.vetoReason === 'slate_cupo' ? noCupo : (e.vetoReason ? vetoed : emitted);
    g.n += 1;
    const st = num(e.stakeUnits, 1);
    if (e.status === 'CLOSED' && e.result === 'WON') { g.won += 1; g.staked += st; g.net += num(e.pnlUnits, 0); }
    else if (e.status === 'CLOSED' && e.result === 'LOST') { g.lost += 1; g.staked += st; g.net += num(e.pnlUnits, 0); }
    else if (e.status === 'CLOSED') { g.push += 1; g.staked += st; g.net += num(e.pnlUnits, 0); }
    else g.pending += 1;
    if (!e.vetoReason) {
      const b = byBucket[bucketOf(num(e.prob, 60))];
      b.n += 1;
      if (e.status === 'CLOSED' && e.result === 'WON') { b.won += 1; b.staked += st; b.net += num(e.pnlUnits, 0); }
      else if (e.status === 'CLOSED' && e.result === 'LOST') { b.lost += 1; b.staked += st; b.net += num(e.pnlUnits, 0); }
      else if (e.status === 'CLOSED') { b.push += 1; b.staked += st; b.net += num(e.pnlUnits, 0); }
      else b.pending += 1;
      const mk = (e.type || 'Apuesta').slice(0, 40);
      const m = byMarket[mk] || emptyGroup();
      m.n += 1;
      if (e.status === 'CLOSED' && e.result === 'WON') { m.won += 1; m.staked += st; m.net += num(e.pnlUnits, 0); }
      else if (e.status === 'CLOSED' && e.result === 'LOST') { m.lost += 1; m.staked += st; m.net += num(e.pnlUnits, 0); }
      else if (e.status === 'CLOSED') { m.push += 1; m.staked += st; m.net += num(e.pnlUnits, 0); }
      else m.pending += 1;
      byMarket[mk] = m;
    }
  }
  for (const b of Object.values(byBucket)) finalizeGroup(b);
  for (const m of Object.values(byMarket)) finalizeGroup(m);
  const graded = entries.filter(e => e.status === 'CLOSED' && (e.result === 'WON' || e.result === 'LOST'));
  return {
    total: entries.length,
    graded: graded.length,
    emitted: finalizeGroup(emitted),
    vetoed: finalizeGroup(vetoed),
    approvedNoCupo: finalizeGroup(noCupo),
    byBucket,
    byMarket,
    vetoReasons: byReason,
    brierRaw: brier(entries, 'rawProb'),
    brierCal: brier(entries, 'prob'),
    plattFit: fitPlattPooled(graded),
  };
}

// Acumulador del reporte paper en producción (_meta.paperReport): solo
// agregados + pares de calibración, nunca picks individuales, para que quepa
// en el cloud cache. Los picks calificados salen del stash tras acumularse.
export function accumulatePaperReport(prev, newlyGraded = []) {
  const r = prev || {
    totalGraded: 0,
    emitted: { n: 0, won: 0, lost: 0, push: 0, staked: 0, net: 0 },
    vetoed: { n: 0, won: 0, lost: 0, push: 0, staked: 0, net: 0 },
    approvedNoCupo: { n: 0, won: 0, lost: 0, push: 0, staked: 0, net: 0 },
    vetoReasons: {},
    byBucket: { '50-60%': { n: 0, won: 0, lost: 0 }, '60-70%': { n: 0, won: 0, lost: 0 }, '70-80%': { n: 0, won: 0, lost: 0 }, '80%+': { n: 0, won: 0, lost: 0 } },
    calibrationPairs: [],
    updatedAt: null,
  };
  for (const e of newlyGraded) {
    const g = e.vetoReason === 'slate_cupo' ? r.approvedNoCupo : (e.vetoReason ? r.vetoed : r.emitted);
    const st = Number.isFinite(Number(e.stakeUnits)) ? Number(e.stakeUnits) : 1;
    g.n += 1;
    if (e.result === 'WON') { g.won += 1; g.staked += st; g.net += Number(e.pnlUnits) || 0; }
    else if (e.result === 'LOST') { g.lost += 1; g.staked += st; g.net += Number(e.pnlUnits) || 0; }
    else { g.push += 1; g.staked += st; g.net += Number(e.pnlUnits) || 0; }
    if (e.vetoReason) {
      const vr = r.vetoReasons[e.vetoReason] || { n: 0, won: 0, lost: 0 };
      vr.n += 1;
      if (e.result === 'WON') vr.won += 1;
      else if (e.result === 'LOST') vr.lost += 1;
      r.vetoReasons[e.vetoReason] = vr;
    } else {
      const b = r.byBucket[bucketOf(Number(e.prob) || 60)];
      b.n += 1;
      if (e.result === 'WON') b.won += 1;
      else if (e.result === 'LOST') b.lost += 1;
    }
    if (e.result === 'WON' || e.result === 'LOST') {
      const raw = Number(e.rawProb ?? e.prob);
      const cal = Number(e.prob);
      if (Number.isFinite(raw) && Number.isFinite(cal)) {
        r.calibrationPairs.push([Number(raw.toFixed(1)), Number(cal.toFixed(1)), e.result === 'WON' ? 1 : 0]);
      }
    }
    r.totalGraded += 1;
  }
  r.calibrationPairs = r.calibrationPairs.slice(-300);
  r.updatedAt = new Date().toISOString();
  return r;
}

function groupLine(label, g) {
  const decided = (g.won || 0) + (g.lost || 0);
  const hr = decided > 0 ? `${((g.won / decided) * 100).toFixed(0)}%` : '—';
  const roi = (g.staked || 0) > 0 ? `${(((g.net || 0) / g.staked) * 100).toFixed(1)}%` : '—';
  const net = Number(g.net || 0);
  return `${label}: \`${g.won || 0}G - ${g.lost || 0}P${g.push ? ` - ${g.push}E` : ''} (${hr})\` | \`${net >= 0 ? '+' : ''}${net.toFixed(2)}u\` | ROI \`${roi}\``;
}

// Líneas de la sección 🧪 PAPER para el Corte de Caja diario. No es récord
// oficial: es la simulación acumulada (unidades paper, sin dinero real).
export function paperReportSectionLines(report) {
  if (!report || !report.totalGraded) return [];
  const lines = [
    ``,
    `🧪 *MODO PAPER — SIMULACIÓN ACUMULADA (${report.totalGraded} calificados)* 🧪`,
    `_Unidades paper, sin dinero real. No forma parte del récord oficial._`,
    groupLine('📤 Emitidos paper', report.emitted),
    groupLine('🚫 Vetados paper (habrían jugado)', report.vetoed),
  ];
  const reasonLines = Object.entries(report.vetoReasons || {})
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, 4)
    .map(([code, vr]) => {
      const decided = (vr.won || 0) + (vr.lost || 0);
      const hr = decided > 0 ? `${((vr.won / decided) * 100).toFixed(0)}%` : '—';
      return `• ${vetoReasonLabel(code)}: ${vr.n} vetados, habrían ganado ${vr.won} (${hr})`;
    });
  if (reasonLines.length) lines.push(...reasonLines);
  const pairs = report.calibrationPairs || [];
  if (pairs.length >= 10) {
    const pseudo = pairs.map(([raw, cal, y]) => ({ rawProb: raw, prob: cal, status: 'CLOSED', result: y === 1 ? 'WON' : 'LOST' }));
    const fit = fitPlattPooled(pseudo);
    if (fit.A !== null) {
      lines.push(`🔧 *Recalibración sugerida (pooled, n=${fit.n}):* A=${fit.A} B=${fit.B} (con clamp del motor: A=${fit.Aclamped} B=${fit.Bclamped})`);
    }
    const brier = (field) => {
      const s = pseudo.reduce((acc, e) => {
        const p = Math.max(0.01, Math.min(0.99, Number(e[field]) / 100));
        return acc + (p - (e.result === 'WON' ? 1 : 0)) ** 2;
      }, 0);
      return (s / pseudo.length).toFixed(3);
    };
    lines.push(`📏 Brier crudo ${brier('rawProb')} vs calibrado ${brier('prob')} (menor es mejor; 0.25 = predecir siempre el promedio)`);
  }
  return lines;
}

/**
 * Mensaje del slate paper para el chat VIP de Tavo. No es un despacho de
 * picks: es la cartelera que el motor HABRÍA enviado, para que vea el nivel.
 */
export function paperSlateMessage({ shiftLabel = '', dateStr = '', emitted = [], vetoed = [], approvedNotInSlate = [], brakeBlocked = false, brakeReasons = [] } = {}) {
  const lines = [
    `🧪 *MODO PAPER — SLATE SIMULADO [${shiftLabel}]* 🧪`,
    `📅 *${dateStr}* | CDMX`,
    `_No se despacharon picks reales. Esto es lo que el motor habría enviado con la calibración actual._`,
    ``,
  ];
  if (brakeBlocked) {
    lines.push(`⛔ *El freno de banca habría bloqueado el despacho* (${brakeReasons.join(' ') || 'drawdown sobre el límite'}). Los picks de abajo son solo simulación.`, ``);
  }
  if (emitted.length) {
    lines.push(`📊 *EMITIDOS (habrían salido): ${emitted.length}*`);
    emitted.forEach((p, i) => {
      lines.push(`${i + 1}. *${p.sport}:* ${p.game}\n   👉 \`${p.pick}\` @ \`${p.odds}\` | Prob cal. ${p.prob} (cruda ${p.rawProb ?? '?'}) | EV ${p.evPct ?? '?'}% | Stake ${p.stakeUnits ?? 1}u`);
    });
    lines.push(``);
  } else {
    lines.push(`📊 *Emitidos: 0* — el motor no habría enviado picks en este turno.`, ``);
  }
  if (approvedNotInSlate.length) {
    lines.push(`🪑 *Aprobados sin cupo en el slate: ${approvedNotInSlate.length}*`);
    approvedNotInSlate.forEach(p => lines.push(`• ${p.game} — ${p.pick} @ ${p.odds}`));
    lines.push(``);
  }
  const vetoSummary = summarizeVetoes(vetoed);
  lines.push(`🚫 *Vetados por los candados/filtros: ${vetoed.length}*`);
  for (const [code, r] of Object.entries(vetoSummary.byReason)) {
    lines.push(`• ${vetoReasonLabel(code)}: ${r.count}`);
  }
  if (!vetoed.length) lines.push(`• Ninguno.`);
  lines.push(``, `_Se califican contra resultados reales. El reporte paper dirá si los vetados habrían ganado._`);
  return lines.join('\n');
}
