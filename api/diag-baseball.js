// api/diag-baseball.js — TEMPORAL (diagnóstico, se borra tras verificar).
// Verifica en vivo si la llave de API-Sports de Vercel sirve para la API de
// béisbol (v1.baseball.api-sports.io): ligas LMB/LMP, partidos de la LMP y si
// el plan incluye cuotas. NO expone ninguna llave: solo devuelve los últimos
// 4 caracteres como máscara y datos públicos de ligas/partidos.
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'GET only' });

  const key = process.env.APISPORTS_KEY
    || (process.env.APISPORTS_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean)[0];
  if (!key) return res.status(200).json({ ok: false, error: 'sin APISPORTS_KEY en Vercel' });

  const headers = { 'x-apisports-key': key };
  const out = {
    ok: true,
    keyMasked: `****${key.slice(-4)}`,
    leagues: null,
    lmpGames: null,
    odds: null,
    error: null
  };

  const fetchJson = async (url, timeoutMs = 10000) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      const j = await r.json().catch(() => null);
      return { http: r.status, json: j };
    } finally {
      clearTimeout(t);
    }
  };

  try {
    const { http, json } = await fetchJson('https://v1.baseball.api-sports.io/leagues');
    const list = Array.isArray(json?.response) ? json.response : [];
    const norm = (entry) => ({
      id: entry?.league?.id ?? entry?.id ?? null,
      name: entry?.league?.name ?? entry?.name ?? '',
      country: entry?.country?.name ?? '',
      seasons: Array.isArray(entry?.seasons) ? entry.seasons : []
    });
    const leagues = list.map(norm);
    const isLmb = (l) => /mexicana de b[eé]isbol/i.test(l.name) || l.name.trim().toUpperCase() === 'LMB';
    const isLmp = (l) => /pac[ií]fico/i.test(l.name) || l.name.trim().toUpperCase() === 'LMP';
    const lmb = leagues.find(isLmb) || null;
    const lmp = leagues.find(isLmp) || null;
    out.leagues = {
      http,
      total: leagues.length,
      errors: json?.errors ?? null,
      lmb: lmb ? { id: lmb.id, name: lmb.name, country: lmb.country } : null,
      lmp: lmp ? { id: lmp.id, name: lmp.name, country: lmp.country } : null
    };

    if (lmp && lmp.id) {
      const currentSeason = lmp.seasons.find((s) => s.current)?.season
        || lmp.seasons.map((s) => s.season).sort().reverse()[0]
        || 2026;
      const g = await fetchJson(
        `https://v1.baseball.api-sports.io/games?league=${lmp.id}&season=${currentSeason}`
      );
      const games = Array.isArray(g.json?.response) ? g.json.response : [];
      out.lmpGames = {
        http: g.http,
        leagueId: lmp.id,
        season: currentSeason,
        total: games.length,
        errors: g.json?.errors ?? null,
        sample: games.slice(0, 3).map((game) => ({
          date: game?.date ?? null,
          home: game?.teams?.home?.name ?? null,
          away: game?.teams?.away?.name ?? null,
          status: game?.status?.short ?? game?.status?.long ?? null
        }))
      };

      const o = await fetchJson(
        `https://v1.baseball.api-sports.io/odds?league=${lmp.id}&season=${currentSeason}`
      );
      const oddsList = Array.isArray(o.json?.response) ? o.json.response : [];
      out.odds = {
        http: o.http,
        count: oddsList.length,
        errors: o.json?.errors ?? null,
        bookmakersSample: oddsList.slice(0, 1).map((entry) => (
          (entry?.bookmakers || []).map((b) => b?.name).filter(Boolean).slice(0, 8)
        ))[0] || []
      };
    }
  } catch (e) {
    out.ok = false;
    out.error = e?.name === 'AbortError' ? 'timeout' : (e?.message || 'error desconocido');
  }

  return res.status(200).json(out);
}
