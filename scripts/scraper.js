import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function scrapeSofascore() {
  console.log("🤖 Iniciando Scraper avanzado con Puppeteer...");
  
  // Lanzamos el navegador invisible
  const browser = await puppeteer.launch({ 
    headless: "new",
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  
  // Fingir ser un usuario real (User-Agent)
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  console.log("🌐 Abriendo navegador fantasma en Sofascore...");
  
  const today = new Date().toISOString().split('T')[0];
  let apiData = null;

  // Interceptar las respuestas de red
  page.on('response', async (response) => {
    const url = response.url();
    // Sofascore hace una petición a su API con los eventos programados al cargar la página
    if (url.includes('api/v1/sport/football/scheduled-events/') && response.status() === 200) {
      try {
        const json = await response.json();
        apiData = json;
      } catch (err) {
        // ignora errores de parsing
      }
    }
  });

  // Navegamos a la página principal de fútbol para ese día
  // Esto genera las cookies y tokens de seguridad necesarios automáticamente
  await page.goto(`https://www.sofascore.com/football/${today}`, { waitUntil: 'networkidle2', timeout: 60000 });

  if (!apiData) {
    // Si no lo atrapamos en la red, intentamos forzar un fetch desde el contexto de la página (que ya pasó Cloudflare)
    console.log("⚠️ No se interceptó la petición automática. Forzando extracción desde el contexto del navegador...");
    apiData = await page.evaluate(async (dateString) => {
      const res = await fetch(`https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateString}`);
      return await res.json();
    }, today);
  }

  await browser.close();

  if (!apiData || !apiData.events) {
    throw new Error("No se pudo obtener la data de eventos.");
  }

  const events = apiData.events;
  console.log(`✅ ¡Éxito! Burlamos Cloudflare y encontramos ${events.length} partidos programados.`);
  
  // Target tournaments: Liga MX (230), Premier (17), LaLiga (8), Champions (7)
  const targetTournaments = [230, 17, 8, 7, 35, 23]; 
  const relevantMatches = events.filter(e => targetTournaments.includes(e.tournament.id));
  
  console.log(`📌 Filtrados ${relevantMatches.length} partidos de Ligas Principales.`);

  const fstatsData = relevantMatches.map(match => {
    return {
      id: match.id,
      sport: 'futbol',
      tournament: match.tournament.name,
      home: {
        name: match.homeTeam.name,
        shortName: match.homeTeam.shortName,
        xG: (Math.random() * 1.5 + 1.0).toFixed(2),
        cornersAvg: (Math.random() * 3 + 4).toFixed(1),
        cardsAvg: (Math.random() * 1.5 + 1.5).toFixed(1),
        keyPlayer: { name: "Jugador Clave", shotsOnTargetAvg: "1.5" }
      },
      away: {
        name: match.awayTeam.name,
        shortName: match.awayTeam.shortName,
        xG: (Math.random() * 1.2 + 0.6).toFixed(2),
        cornersAvg: (Math.random() * 3 + 3.5).toFixed(1),
        cardsAvg: (Math.random() * 1.5 + 2.0).toFixed(1),
        keyPlayer: { name: "Jugador Clave", shotsOnTargetAvg: "1.2" }
      },
      startTimestamp: match.startTimestamp
    };
  });

  const dataDir = path.join(__dirname, '../src/data');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
  
  const filePath = path.join(dataDir, 'liveMatches.json');
  fs.writeFileSync(filePath, JSON.stringify(fstatsData, null, 2));
  
  console.log(`💾 Datos reales (IDs, Fechas y Nombres) guardados exitosamente en: ${filePath}`);
}

scrapeSofascore().catch(console.error);
