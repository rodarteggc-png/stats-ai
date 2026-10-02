# 🧠 Stats-AI Pro — Motor Cuantitativo de Inteligencia Deportiva

Plataforma cuantitativa de análisis deportivo, modelado matemático predictivo y auditoría forense automatizada. Diseñada para detectar ineficiencias matemáticas en los mercados de apuestas deportivas (+EV) a través de simulaciones Monte Carlo, modelos estructurales Poisson/Sabermétricos/Gridiron y confirmación institucional (Sharp Money).

---

## ⚡ Características Principales

### 1. 🏈 Cobertura Multideporte Completa
- **Fútbol Americano:**
  - **NFL Profesional:** Modelado EPA, Yardas Netas por Jugada (YPP), diferencial de entregas y números clave de Las Vegas (3 y 7).
  - **NCAAF Colegial FBS:** Calibración específica para fútbol colegial ($\sigma = 16.5$, HFA de 3.2 pts, totales base de 52.8 pts) con acceso a más de 60 partidos semanales y filtros de *Top 25 Rankings* vs *Todos los FBS*.
- **Fútbol Soccer (Internacional & Ligas):**
  - Modelado bivariado de Poisson con goles esperados ($xG$), ritmo de tiros de esquina, tarjetas, doble oportunidad (1X / X2) y Ambos Equipos Anotan (BTTS).
- **MLB (Grandes Ligas):**
  - Sabermetría F5 (Primeras 5 Entradas), WHIP de abridores, OPS ponderado, colapso de bullpen y props de bases totales.

### 2. 🗳️ Tribunal de Consenso Tripartito (3v1)
Ninguna selección se aprueba sin someterse a tres filtros independientes:
1. **Motor Estructural (+EV):** Verifica una ventaja matemática mínima del $+4.5\%$ frente a las cuotas justas de mercado.
2. **Simulador Monte Carlo (10,000 Iteraciones):** Evalúa la estabilidad porcentual y descarta escenarios con alto riesgo de colapso de cola.
3. **Mercado Institucional & Sharp Money:** Detecta caídas de cuotas institucionales en DraftKings (movimientos de $-5\%$ a $-26\%$) y cruza con la memoria de lecciones previas.

### 3. 🎯 Meritocracia Pura en Alertas
- **Priorización por Probabilidad Real:** Las selecciones se ordenan estrictamente por máxima probabilidad calibrada de ganar, sin forzar repartos artificiales por deporte.
- **Top 8 Diario / Top 10 en Fin de Semana:** Ampliación dinámica del cupo para capturar el valor masivo de las jornadas de sábado y domingo.
- **Picks Complementarios en Mismo Juego:** Capacidad de capturar hasta 2 selecciones de alto valor en un solo partido si pertenecen a mercados independientes (ej. Hándicap/Ganador + Totales/Goles).

### 4. 💼 Gestión de Banca con Criterio de Kelly Adaptativo
- Recomendación automatizada de unidades de riesgo ($0.5u$ a $2.0u$) calculada según el tamaño del Edge (+EV) y la estabilidad de simulación.

### 5. 🧠 Memoria IA y Aprendizaje Forense Continuo
- **Auditoría Automática Diaria:** Verificación en segundo plano de resultados oficiales contra marcadores reales de ESPN y MLB.
- **Lecciones Aprendidas:** En caso de fallo, el sistema extrae un diagnóstico táctico y aplica penalizaciones matemáticas preventivas con decaimiento temporal (10 a 45 días) para futuros partidos de ese equipo.
- **Cloud Ledger en Telegram:** Persistencia en la nube de Telegram (Deflate + Base64) que sobrevive a reinicios serverless en Vercel.

---

## 🛠️ Stack Tecnológico

- **Frontend:** React 19, Vite 8, Vanilla CSS (Diseño Glassmorphism / Dark Mode).
- **Motores Matemáticos:** Poisson Bivariado, Sabermetría MLB, Modelado Gridiron EPA/YPP, Simulación Monte Carlo (Web Worker dedicado para 60fps).
- **APIs de Datos:** ESPN API oficial (Scores, Standings, Team Stats, DraftKings embedded odds), The Odds API.
- **Despliegue & Serverless:** Vercel Cron Jobs (`/api/scan`, `/api/audit`), Node.js ES Modules.

---

## 🚀 Instalación y Uso Local

```bash
# Clonar el repositorio
git clone https://github.com/tu-usuario/stats-ai-pro.git
cd stats-ai-pro

# Instalar dependencias
npm install

# Iniciar servidor de desarrollo Vite
npm run dev

# Compilar para producción
npm run build

# Ejecutar escaneo de alertas en modo Dry-Run (sin enviar a Telegram)
npm run alert:telegram -- --dry-run --verbose

# Ejecutar suite de backtesting forense
npm run backtest
```

---

## ⚙️ Variables de Entorno (`.env`)

Copia `.env.example` a `.env` y configura tus credenciales:

```env
# Configuración del Bot de Telegram (Alertas y Cloud Ledger)
TELEGRAM_BOT_TOKEN=tu_telegram_bot_token_aqui
TELEGRAM_CHAT_ID=tu_telegram_chat_id_aqui

# The Odds API (Opcional)
ODDS_API_KEY=tu_odds_api_key_aqui
```

---

## 📄 Licencia
Privado © Stats-AI Pro. Todos los derechos reservados.
