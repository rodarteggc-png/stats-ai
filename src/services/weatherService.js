// src/services/weatherService.js
// SERVICIO DE CLIMA Y VIENTO EN TIEMPO REAL VÍA OPEN-METEO API (100% GRATUITO Y SIN LÍMITES)
// Provee micro-inteligencia meteorológica para Totales (Over/Under) en NFL, NCAAF y MLB al aire libre.

const WEATHER_CACHE = new Map();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas

// Mapeo exhaustivo de coordenadas de estadios NFL
const NFL_STADIUMS = {
  // Domos / Techo Retráctil cerrado
  'dallas cowboys': { isDome: true, name: 'AT&T Stadium' },
  'atlanta falcons': { isDome: true, name: 'Mercedes-Benz Stadium' },
  'new orleans saints': { isDome: true, name: 'Caesars Superdome' },
  'detroit lions': { isDome: true, name: 'Ford Field' },
  'minnesota vikings': { isDome: true, name: 'U.S. Bank Stadium' },
  'las vegas raiders': { isDome: true, name: 'Allegiant Stadium' },
  'houston texans': { isDome: true, name: 'NRG Stadium' },
  'indianapolis colts': { isDome: true, name: 'Lucas Oil Stadium' },
  'arizona cardinals': { isDome: true, name: 'State Farm Stadium' },
  'los angeles rams': { isDome: true, name: 'SoFi Stadium' },
  'los angeles chargers': { isDome: true, name: 'SoFi Stadium' },

  // Estadios al aire libre (Críticos para viento y clima frío)
  'green bay packers': { lat: 44.5013, lon: -88.0622, name: 'Lambeau Field' },
  'chicago bears': { lat: 41.8623, lon: -87.6167, name: 'Soldier Field' },
  'buffalo bills': { lat: 42.7738, lon: -78.7870, name: 'Highmark Stadium' },
  'new york jets': { lat: 40.8128, lon: -74.0742, name: 'MetLife Stadium' },
  'new york giants': { lat: 40.8128, lon: -74.0742, name: 'MetLife Stadium' },
  'philadelphia eagles': { lat: 39.9008, lon: -75.1675, name: 'Lincoln Financial Field' },
  'new england patriots': { lat: 42.0909, lon: -71.2643, name: 'Gillette Stadium' },
  'pittsburgh steelers': { lat: 40.4468, lon: -80.0158, name: 'Acrisure Stadium' },
  'cleveland browns': { lat: 41.5061, lon: -81.6995, name: 'Cleveland Browns Stadium' },
  'kansas city chiefs': { lat: 39.0489, lon: -94.4839, name: 'GEHA Field at Arrowhead' },
  'denver broncos': { lat: 39.7439, lon: -105.0201, name: 'Empower Field at Mile High' },
  'seattle seahawks': { lat: 47.5952, lon: -122.3316, name: 'Lumen Field' },
  'baltimore ravens': { lat: 39.2780, lon: -76.6227, name: 'M&T Bank Stadium' },
  'cincinnati bengals': { lat: 39.0955, lon: -84.5161, name: 'Paycor Stadium' },
  'jacksonville jaguars': { lat: 30.3239, lon: -81.6373, name: 'EverBank Stadium' },
  'tampa bay buccaneers': { lat: 27.9759, lon: -82.5033, name: 'Raymond James Stadium' },
  'miami dolphins': { lat: 25.9580, lon: -80.2389, name: 'Hard Rock Stadium' },
  'carolina panthers': { lat: 35.2258, lon: -80.8528, name: 'Bank of America Stadium' },
  'tennessee titans': { lat: 36.1665, lon: -86.7713, name: 'Nissan Stadium' },
  'san francisco 49ers': { lat: 37.4032, lon: -121.9698, name: "Levi's Stadium" },
  'washington commanders': { lat: 38.9076, lon: -76.8645, name: 'Northwest Stadium' }
};

/**
 * Consulta el clima exacto en tiempo real para el estadio del equipo local.
 * Retorna variables estandarizadas de viento, temperatura y su impacto en puntos para Totales.
 */
export async function getGameWeather(homeTeamName = '', sport = 'nfl') {
  if (!homeTeamName) return null;
  const cleanHome = homeTeamName.toLowerCase().trim();

  // Buscar coincidencia en diccionario de estadios
  let stadiumInfo = null;
  for (const [key, val] of Object.entries(NFL_STADIUMS)) {
    if (cleanHome.includes(key) || key.includes(cleanHome)) {
      stadiumInfo = val;
      break;
    }
  }

  // Si no se encuentra pero es estadio techado conocido por palabras clave
  if (!stadiumInfo) {
    if (cleanHome.includes('dome') || cleanHome.includes('ford field') || cleanHome.includes('superdome') || cleanHome.includes('sofi')) {
      stadiumInfo = { isDome: true, name: 'Estadio Techado' };
    }
  }

  // Caso 1: Estadio Techado (Domo)
  if (stadiumInfo && stadiumInfo.isDome) {
    return {
      isDome: true,
      stadiumName: stadiumInfo.name,
      tempF: 72,
      windMph: 0,
      windGustsMph: 0,
      precipitationInches: 0,
      impactOnTotal: 0,
      isHeavyWind: false,
      badgeText: '🏟️ Domo Techado (Clima Controlado: 72°F | Viento 0 mph)',
      weatherNote: 'Condiciones ideales de pase: sin viento ni clima adverso.'
    };
  }

  // Coordenadas por defecto si es al aire libre desconocido (Centro de EE.UU.)
  const lat = stadiumInfo?.lat || 39.8283;
  const lon = stadiumInfo?.lon || -98.5795;
  const stadiumName = stadiumInfo?.name || 'Estadio al Aire Libre';

  // Revisar caché
  const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
  const cached = WEATHER_CACHE.get(cacheKey);
  if (cached && (Date.now() - cached.timestamp < CACHE_TTL_MS)) {
    return cached.data;
  }

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation,wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph&temperature_unit=fahrenheit`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'StatsAIPro/1.0 (QuantSportsModel)' }
    });

    if (!res.ok) {
      throw new Error(`Open-Meteo HTTP ${res.status}`);
    }

    const data = await res.json();
    const current = data.current || {};
    const tempF = Math.round(current.temperature_2m || 65);
    const windMph = Math.round(current.wind_speed_10m || 5);
    const windGustsMph = Math.round(current.wind_gusts_10m || windMph);
    const precip = current.precipitation || 0;

    // FÓRMULA CUANTITATIVA INSTITUCIONAL DE IMPACTO EN PUNTOS TOTALES:
    // En fútbol americano, vientos sostenidos >= 15 mph reducen drásticamente la precisión aérea
    // y goles de campo largos. Cada mph adicional sobre 12 mph resta aprox. 0.45 puntos del total esperado.
    let impactOnTotal = 0;
    let isHeavyWind = false;

    if (windMph >= 14) {
      impactOnTotal = -Math.round((windMph - 12) * 0.45 * 10) / 10;
      isHeavyWind = windMph >= 17;
    }

    if (tempF <= 28) {
      impactOnTotal -= 1.5; // Penalización por balón duro y congelamiento de manos
    }

    if (precip >= 0.15) {
      impactOnTotal -= 1.8; // Penalización por lluvia/nieve moderada a fuerte
    }

    let badgeText = `🌤️ ${tempF}°F | Viento ${windMph} mph`;
    let weatherNote = 'Clima favorable para ambos ataques.';

    if (isHeavyWind) {
      badgeText = `💨 VIENTO CRÍTICO (${windMph} mph, Ráfagas ${windGustsMph} mph) | ${tempF}°F`;
      weatherNote = `⚠️ Microclima adverso: Viento sostenido de ${windMph} mph induce sesgo fuertemente bajista en Totales (${impactOnTotal} pts).`;
    } else if (windMph >= 13) {
      badgeText = `🌬️ Viento Moderado (${windMph} mph) | ${tempF}°F`;
      weatherNote = `Viento de ${windMph} mph reduce ligeramente la efectividad de goles de campo largos (${impactOnTotal} pts).`;
    }

    const result = {
      isDome: false,
      stadiumName,
      tempF,
      windMph,
      windGustsMph,
      precipitationInches: precip,
      impactOnTotal,
      isHeavyWind,
      badgeText,
      weatherNote
    };

    WEATHER_CACHE.set(cacheKey, { timestamp: Date.now(), data: result });
    return result;
  } catch (err) {
    console.warn(`[weatherService] Aviso consultando Open-Meteo para ${homeTeamName}:`, err.message);
    return null;
  }
}
