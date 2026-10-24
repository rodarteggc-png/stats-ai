// src/services/refereeService.js
// SERVICIO DE INTELIGENCIA DE ÁRBITROS Y COLEGIADOS (LIGA MX & EUROPA)
// Provee análisis de severidad, promedio de tarjetas y penales para afinar la auditoría cualitativa de partidos.

const REFEREE_DATABASE = {
  // LIGA MX
  'cesar arturo ramos': {
    name: 'César Arturo Ramos',
    league: 'Liga MX',
    avgYellows: 4.6,
    avgReds: 0.24,
    penaltiesPerMatch: 0.32,
    strictness: 'MEDIA-ALTA',
    tendencyNote: 'Experiencia mundialista. Permite el contacto físico pero castiga reiteración de faltas tácticas.'
  },
  'marco antonio ortiz': {
    name: 'Marco Antonio Ortiz ("El Gato")',
    league: 'Liga MX',
    avgYellows: 5.4,
    avgReds: 0.38,
    penaltiesPerMatch: 0.44,
    strictness: 'MUY ALTA',
    tendencyNote: 'Colegiado protagónico y severo. Alto volumen de tarjetas amarillas y frecuencia de penales.'
  },
  'adonai escobedo': {
    name: 'Adonai Escobedo',
    league: 'Liga MX',
    avgYellows: 4.9,
    avgReds: 0.26,
    penaltiesPerMatch: 0.35,
    strictness: 'ALTA',
    tendencyNote: 'Árbitro de corte disciplinario estricto. Suele condicionar temprano con amonestaciones.'
  },
  'fernando guerrero': {
    name: 'Fernando Guerrero ("El Cantante")',
    league: 'Liga MX',
    avgYellows: 4.2,
    avgReds: 0.18,
    penaltiesPerMatch: 0.28,
    strictness: 'MEDIA',
    tendencyNote: 'Árbitro de diálogo y juego fluido. Suele reservar las tarjetas para entradas graves.'
  },
  'fernando hernandez': {
    name: 'Fernando Hernández',
    league: 'Liga MX',
    avgYellows: 5.1,
    avgReds: 0.30,
    penaltiesPerMatch: 0.36,
    strictness: 'ALTA',
    tendencyNote: 'Riguroso en jugadas divididas y reclamos al cuerpo arbitral.'
  },
  'victor alfonso caceres': {
    name: 'Víctor Alfonso Cáceres',
    league: 'Liga MX',
    avgYellows: 4.5,
    avgReds: 0.22,
    penaltiesPerMatch: 0.30,
    strictness: 'MEDIA-ALTA',
    tendencyNote: 'Perfil equilibrado con tendencia a sancionar fueras de lugar y faltas en área.'
  },

  // PREMIER LEAGUE
  'anthony taylor': {
    name: 'Anthony Taylor',
    league: 'Premier League',
    avgYellows: 4.4,
    avgReds: 0.20,
    penaltiesPerMatch: 0.35,
    strictness: 'MEDIA-ALTA',
    tendencyNote: 'De criterio estricto en el área y protestas. No duda en señalar el punto penal.'
  },
  'michael oliver': {
    name: 'Michael Oliver',
    league: 'Premier League',
    avgYellows: 3.8,
    avgReds: 0.15,
    penaltiesPerMatch: 0.30,
    strictness: 'MEDIA',
    tendencyNote: 'Uno de los colegiados más respetados de UEFA. Tiende a otorgar ley de la ventaja y favorecer ritmo alto.'
  },
  'paul tierney': {
    name: 'Paul Tierney',
    league: 'Premier League',
    avgYellows: 4.1,
    avgReds: 0.18,
    penaltiesPerMatch: 0.26,
    strictness: 'MEDIA',
    tendencyNote: 'Manejo conservador del silbato. Menor propensión a tarjetas tempranas.'
  },
  'simon hooper': {
    name: 'Simon Hooper',
    league: 'Premier League',
    avgYellows: 4.6,
    avgReds: 0.22,
    penaltiesPerMatch: 0.33,
    strictness: 'MEDIA-ALTA',
    tendencyNote: 'Castiga con rigidez las faltas tácticas de contraataque.'
  },

  // CHAMPIONS LEAGUE / UEFA
  'szymon marciniak': {
    name: 'Szymon Marciniak',
    league: 'UEFA Champions League',
    avgYellows: 4.2,
    avgReds: 0.16,
    penaltiesPerMatch: 0.36,
    strictness: 'MEDIA-ALTA',
    tendencyNote: 'Árbitro de final de Copa del Mundo. Manejo impecable de la ventaja e intensidad física.'
  },
  'clement turpin': {
    name: 'Clément Turpin',
    league: 'UEFA Champions League',
    avgYellows: 3.9,
    avgReds: 0.25,
    penaltiesPerMatch: 0.32,
    strictness: 'MEDIA',
    tendencyNote: 'Colegiado francés que prefiere juego dinámico pero severo con entradas desmedidas.'
  },
  'felix zwayer': {
    name: 'Felix Zwayer',
    league: 'UEFA Champions League',
    avgYellows: 4.7,
    avgReds: 0.28,
    penaltiesPerMatch: 0.38,
    strictness: 'ALTA',
    tendencyNote: 'Colegiado alemán de silbato riguroso con alto promedio de tarjetas en torneos internacionales.'
  },
  'istvan kovacs': {
    name: 'István Kovács',
    league: 'UEFA Champions League',
    avgYellows: 5.3,
    avgReds: 0.34,
    penaltiesPerMatch: 0.40,
    strictness: 'MUY ALTA',
    tendencyNote: 'Frecuencia muy alta de amonestaciones y expulsiones. Tiende a frenar partidos friccionados.'
  }
};

/**
 * Consulta el perfil estadístico y de severidad de un árbitro
 * @param {string} refereeName - Nombre del árbitro
 * @param {string} league - Liga del encuentro
 */
export function getRefereeProfile(refereeName = '', league = '') {
  if (!refereeName) return null;
  const clean = refereeName.toLowerCase().trim();

  for (const [key, profile] of Object.entries(REFEREE_DATABASE)) {
    if (clean.includes(key) || key.includes(clean)) {
      return profile;
    }
  }

  // Si no está en el índice exacto, retornar perfil neutro estimado según la liga
  const isMexico = (league || '').toLowerCase().includes('mex');
  return {
    name: refereeName,
    league: league || 'Oficial',
    avgYellows: isMexico ? 4.7 : 4.1,
    avgReds: 0.22,
    penaltiesPerMatch: 0.30,
    strictness: 'ESTÁNDAR',
    tendencyNote: 'Colegiado oficial de la competición con parámetros promedio de la liga.'
  };
}
