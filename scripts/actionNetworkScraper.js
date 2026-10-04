// scripts/actionNetworkScraper.js
/**
 * Scraper ligero para la API interna de Action Network.
 * Extrae el consenso público (% de apuestas y % de dinero) para cruzarlo con el RLM.
 * 
 * Uso: node scripts/actionNetworkScraper.js
 */

import fs from 'fs';
import path from 'path';
import https from 'https';

const CACHE_FILE = path.join(process.cwd(), 'src', 'data', 'public_consensus.json');
const SPORTS = ['mlb', 'nfl', 'ncaaf'];

function fetchActionNetwork(sport) {
  return new Promise((resolve, reject) => {
    const url = `https://api.actionnetwork.com/web/v1/scoreboard/publicbetting/${sport}?period=game`;
    
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.warn(`[API] Código ${res.statusCode} al buscar ${sport}`);
            resolve([]);
            return;
          }
          const json = JSON.parse(data);
          resolve(json.games || []);
        } catch (e) {
          reject(e);
        }
      });
    }).on('error', reject);
  });
}

async function runScraper() {
  console.log("Iniciando extracción de Consenso Público (Action Network)...");
  
  const consensusData = {};

  for (const sport of SPORTS) {
    try {
      console.log(`Buscando datos de ${sport}...`);
      const games = await fetchActionNetwork(sport);
      
      games.forEach(game => {
        if (!game.odds || game.odds.length === 0) return;
        const mainOdds = game.odds[0]; // La primera es el consenso principal
        
        // Crear un ID único basado en los nombres de los equipos
        const homeName = game.teams.find(t => t.id === game.home_team_id)?.full_name || 'Home';
        const awayName = game.teams.find(t => t.id === game.away_team_id)?.full_name || 'Away';
        const matchKey = `${homeName.toLowerCase()} vs ${awayName.toLowerCase()}`;
        
        consensusData[matchKey] = {
          sport,
          startTime: game.start_time,
          ml_home_public: mainOdds.ml_home_public,
          ml_away_public: mainOdds.ml_away_public,
          ml_home_money: mainOdds.ml_home_money,
          ml_away_money: mainOdds.ml_away_money,
          spread_home_public: mainOdds.spread_home_public,
          spread_away_public: mainOdds.spread_away_public,
          spread_home_money: mainOdds.spread_home_money,
          spread_away_money: mainOdds.spread_away_money,
          total_over_public: mainOdds.total_over_public,
          total_under_public: mainOdds.total_under_public,
          total_over_money: mainOdds.total_over_money,
          total_under_money: mainOdds.total_under_money,
          num_bets: game.num_bets || mainOdds.num_bets
        };
      });
      
    } catch (e) {
      console.error(`Error procesando ${sport}:`, e.message);
    }
  }

  // Asegurar que el directorio exista
  const dir = path.dirname(CACHE_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(CACHE_FILE, JSON.stringify(consensusData, null, 2));
  console.log(`✅ ¡Scraping exitoso! Datos guardados en ${CACHE_FILE} (${Object.keys(consensusData).length} partidos)`);
}

runScraper();
