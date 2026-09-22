// src/utils/monteCarlo.js
// Motor Cuantitativo de Simulación Monte Carlo (10,000 iteraciones) & Calibración Bayesiana
// Diseñado para erradicar la sobreconfianza estadística y cuantificar el riesgo de cola (Tail Risk).

/**
 * Generador rápido de distribución de Poisson (Algoritmo de Knuth con aproximación Gaussiana para valores altos).
 */
function randomPoisson(lambda) {
  if (lambda <= 0) return 0;
  if (lambda < 25) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= Math.random();
    } while (p > L);
    return k - 1;
  }
  // Aproximación Gaussiana para lambdas grandes
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}

/**
 * Generador Normal Box-Muller.
 */
function randomNormal(mean = 0, stdDev = 1) {
  const u1 = Math.random() || 0.0001;
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return mean + z * stdDev;
}

/**
 * Calibración Bayesiana (Shrinkage hacia la media empírica).
 * En deportes profesionales, los favoritos con probabilidades proyectadas de 80%+
 * históricamente ganan entre el 68% y el 73% de las veces debido a la varianza inherente.
 * Esta función comprime los extremos para evitar sobre-apostar con Kelly inflado.
 */
export function bayesianCalibrate(rawProb, sampleConfidence = 0.82, priorBaseline = 50) {
  const p = Math.max(1, Math.min(99, parseFloat(rawProb) || 50));
  let shrinkage = sampleConfidence;
  // Mayor compresión en extremos (> 75% o < 25%) donde el sesgo de sobreconfianza es más severo
  if (p > 75 || p < 25) {
    shrinkage = sampleConfidence * 0.88;
  }
  const calibrated = (p * shrinkage) + (priorBaseline * (1 - shrinkage));
  return Number(calibrated.toFixed(1));
}

/**
 * 1. SIMULACIÓN MONTE CARLO PARA FÚTBOL (10,000 Iteraciones)
 * Modela goles con inyección estocástica de tarjetas rojas y varianza de penales.
 */
export function simulateSoccerMatch(homeXg, awayXg, iterations = 10000) {
  const hLambda = Math.max(0.2, parseFloat(homeXg) || 1.35);
  const aLambda = Math.max(0.2, parseFloat(awayXg) || 1.05);

  let homeWins = 0;
  let draws = 0;
  let awayWins = 0;
  let over25 = 0;
  let btts = 0;
  let collapseEvents = 0; // Ocasiones en que el favorito proyectado no gana por eventos de varianza

  const isHomeFav = hLambda >= aLambda;

  for (let i = 0; i < iterations; i++) {
    let curHLambda = hLambda;
    let curALambda = aLambda;

    // Varianza 1: Tarjetas Rojas (probabilidad ~10% por partido)
    const redRoll = Math.random();
    if (redRoll < 0.05) {
      // Roja local
      curHLambda *= 0.65;
      curALambda *= 1.25;
    } else if (redRoll < 0.10) {
      // Roja visitante
      curALambda *= 0.65;
      curHLambda *= 1.25;
    }

    // Varianza 2: Penal fortuito (~18% chance)
    if (Math.random() < 0.09) curHLambda += 0.4;
    if (Math.random() < 0.09) curALambda += 0.4;

    const hGoals = randomPoisson(curHLambda);
    const aGoals = randomPoisson(curALambda);

    if (hGoals > aGoals) homeWins++;
    else if (hGoals === aGoals) draws++;
    else awayWins++;

    if (hGoals + aGoals > 2.5) over25++;
    if (hGoals > 0 && aGoals > 0) btts++;

    // Medir colapso del favorito
    if (isHomeFav && hGoals <= aGoals) collapseEvents++;
    if (!isHomeFav && aGoals <= hGoals) collapseEvents++;
  }

  const hProb = Number(((homeWins / iterations) * 100).toFixed(1));
  const dProb = Number(((draws / iterations) * 100).toFixed(1));
  const aProb = Number(((awayWins / iterations) * 100).toFixed(1));
  const o25Prob = Number(((over25 / iterations) * 100).toFixed(1));
  const bttsProb = Number(((btts / iterations) * 100).toFixed(1));
  const collapseRate = Number(((collapseEvents / iterations) * 100).toFixed(1));

  // Puntuación de Estabilidad (0 a 100)
  const maxWin = Math.max(hProb, aProb);
  const stabilityScore = Number(Math.max(30, Math.min(95, maxWin + (100 - dProb) * 0.2)).toFixed(0));

  let riskLevel = 'Bajo';
  if (stabilityScore < 55 || collapseRate > 42) riskLevel = 'Alto';
  else if (stabilityScore < 68 || collapseRate > 32) riskLevel = 'Medio';

  return {
    iterations,
    homeWinProb: hProb,
    drawProb: dProb,
    awayWinProb: aProb,
    over25Prob: o25Prob,
    bttsProb: bttsProb,
    calibratedHomeWin: bayesianCalibrate(hProb, 0.85, 45),
    calibratedAwayWin: bayesianCalibrate(aProb, 0.85, 30),
    stabilityScore,
    riskLevel,
    collapseRate,
    tailRiskAlert: collapseRate > 35 
      ? `⚠️ Varianza Elevada: Riesgo de colapso del favorito de ${collapseRate}% ante empates o rojas tempranas.` 
      : null
  };
}

/**
 * 2. SIMULACIÓN MONTE CARLO PARA BÉISBOL MLB (10,000 Iteraciones)
 * Aísla la estabilidad de Primeros 5 Innings (F5) vs Colapsos del Bullpen en Innings 6-9.
 */
export function simulateMlbMatch(
  homeStarterWhip, awayStarterWhip,
  homeOps, awayOps,
  iterations = 10000
) {
  const hWhip = parseFloat(homeStarterWhip) || 1.30;
  const aWhip = parseFloat(awayStarterWhip) || 1.30;
  const hOps = parseFloat(homeOps) || 0.730;
  const aOps = parseFloat(awayOps) || 0.710;

  // Tasas de carreras esperadas por cada 5 innings
  const hF5Expected = Math.max(0.5, (hOps * 3.6) + ((aWhip - 1.20) * 1.5));
  const aF5Expected = Math.max(0.5, (aOps * 3.6) + ((hWhip - 1.20) * 1.5));

  let f5HomeWins = 0;
  let f5Ties = 0;
  let f5AwayWins = 0;
  let fullHomeWins = 0;
  let bullpenFlips = 0; // Ocasiones en que el ganador de F5 se cae por culpa del relevo

  for (let i = 0; i < iterations; i++) {
    // Simular F5 con abridores
    const hF5 = randomPoisson(hF5Expected);
    const aF5 = randomPoisson(aF5Expected);

    if (hF5 > aF5) f5HomeWins++;
    else if (hF5 === aF5) f5Ties++;
    else f5AwayWins++;

    // Simular Innings 6 a 9 con Bullpen (Inyección de Varianza de Relevo ~18% blowup)
    let hBullpen = randomPoisson(1.5);
    let aBullpen = randomPoisson(1.5);

    // Ruido de bullpen: bases por bolas o cuadrangulares tardíos
    if (Math.random() < 0.16) aBullpen += randomPoisson(1.8);
    if (Math.random() < 0.16) hBullpen += randomPoisson(1.8);

    const hTotal = hF5 + hBullpen;
    const aTotal = aF5 + aBullpen;

    const f5Leader = hF5 > aF5 ? 'home' : (aF5 > hF5 ? 'away' : 'tie');
    const fullWinner = hTotal > aTotal ? 'home' : (aTotal > hTotal ? 'away' : (Math.random() > 0.5 ? 'home' : 'away'));

    if (fullWinner === 'home') fullHomeWins++;

    // Detectar si el bullpen arruinó la ventaja de F5
    if (f5Leader === 'home' && fullWinner === 'away') bullpenFlips++;
    if (f5Leader === 'away' && fullWinner === 'home') bullpenFlips++;
  }

  const f5HomeProb = Number(((f5HomeWins / iterations) * 100).toFixed(1));
  const f5AwayProb = Number(((f5AwayWins / iterations) * 100).toFixed(1));
  const fullHomeProb = Number(((fullHomeWins / iterations) * 100).toFixed(1));
  const flipRate = Number(((bullpenFlips / iterations) * 100).toFixed(1));

  let bullpenRisk = 'Bajo';
  if (flipRate > 22) bullpenRisk = 'Alto';
  else if (flipRate > 15) bullpenRisk = 'Medio';

  const f5Stability = Number((100 - flipRate).toFixed(0));

  return {
    iterations,
    f5HomeWinProb: f5HomeProb,
    f5AwayWinProb: f5AwayProb,
    fullHomeWinProb: fullHomeProb,
    calibratedF5Home: bayesianCalibrate(f5HomeProb, 0.84, 50),
    calibratedFullHome: bayesianCalibrate(fullHomeProb, 0.80, 50),
    bullpenFlipRate: flipRate,
    bullpenRisk,
    f5Stability,
    bullpenWarning: bullpenRisk === 'Alto'
      ? `⚠️ Alerta Bullpen: ${flipRate}% de riesgo de voltereta tardía en entradas 6-9. Se recomienda aislar apostando F5.`
      : null
  };
}

/**
 * 3. SIMULACIÓN MONTE CARLO PARA NFL (10,000 Iteraciones)
 * Modela dispersión de puntos con clusters en números clave (3 y 7) y varianza de entregas de balón.
 */
export function simulateNflMatch(
  expectedHomeLead,
  vegasSpread = -3.5,
  vegasTotal = 44.5,
  windMph = 0,
  iterations = 10000
) {
  const lead = parseFloat(expectedHomeLead) || 0;
  const spread = parseFloat(vegasSpread) || -3.5;
  const total = parseFloat(vegasTotal) || 44.5;
  const wind = parseFloat(windMph) || 0;

  let homeCovers = 0;
  let awayCovers = 0;
  let homeWins = 0;
  let overHits = 0;
  let keyNumberHits = 0; // Margen de exactamente 3 o 7
  let upsetEvents = 0;

  // Penalización por viento en puntos totales si es estadio abierto
  const windPen = wind > 14 ? (wind - 14) * 0.35 : 0;
  const adjTotal = Math.max(30, total - windPen);

  for (let i = 0; i < iterations; i++) {
    // Varianza 1: Diferencial de puntos con distribución Normal NFL (σ = 13.45)
    let simLead = randomNormal(lead, 13.45);

    // Varianza 2: Entregas de balón inesperadas (Turnovers aleatorios: ~3.5 pts por pérdida)
    const toSwing = (Math.random() - 0.5) * 2.2; // Rango de turnover swing
    simLead += toSwing * 3.5;

    // Cluster empírico en números clave de la NFL (Atracción matemática hacia 3 y 7)
    const rounded = Math.round(simLead);
    if (Math.abs(rounded - 3) <= 1 && Math.random() < 0.20) simLead = rounded >= 0 ? 3 : -3;
    if (Math.abs(rounded - 7) <= 1 && Math.random() < 0.18) simLead = rounded >= 0 ? 7 : -7;

    // Cobertura de spread
    if (simLead + spread > 0) homeCovers++;
    else awayCovers++;

    if (simLead > 0) homeWins++;

    const absMargin = Math.abs(Math.round(simLead));
    if (absMargin === 3 || absMargin === 7) keyNumberHits++;

    // Upset (favorito perdiendo directo)
    if (spread < -3.0 && simLead < 0) upsetEvents++;
    if (spread > 3.0 && simLead > 0) upsetEvents++;

    // Total de puntos simulado
    const simTotal = Math.max(16, randomNormal(adjTotal, 9.8));
    if (simTotal > total) overHits++;
  }

  const hCoverProb = Number(((homeCovers / iterations) * 100).toFixed(1));
  const aCoverProb = Number(((awayCovers / iterations) * 100).toFixed(1));
  const hWinProb = Number(((homeWins / iterations) * 100).toFixed(1));
  const oProb = Number(((overHits / iterations) * 100).toFixed(1));
  const keyHitRate = Number(((keyNumberHits / iterations) * 100).toFixed(1));
  const upsetRate = Number(((upsetEvents / iterations) * 100).toFixed(1));

  const stabilityScore = Number(Math.max(hCoverProb, aCoverProb).toFixed(0));

  let riskLevel = 'Bajo';
  if (upsetRate > 35 || stabilityScore < 54) riskLevel = 'Alto';
  else if (upsetRate > 25 || stabilityScore < 60) riskLevel = 'Medio';

  return {
    iterations,
    homeCoverProb: hCoverProb,
    awayCoverProb: aCoverProb,
    homeWinProb: hWinProb,
    overProb: oProb,
    underProb: Number((100 - oProb).toFixed(1)),
    calibratedHomeCover: bayesianCalibrate(hCoverProb, 0.88, 50),
    calibratedAwayCover: bayesianCalibrate(aCoverProb, 0.88, 50),
    keyNumberHitRate: keyHitRate,
    upsetRate,
    stabilityScore,
    riskLevel,
    keyNumberNotice: keyHitRate > 20 
      ? `📌 Alta Densidad en Números Clave: ${keyHitRate}% de probabilidad de definirse por 3 o 7 puntos.` 
      : null
  };
}
