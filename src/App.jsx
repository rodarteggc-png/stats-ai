import { useState, useRef } from "react";

const SPORTS = [
  { id: "futbol", label: "Fútbol",  icon: "⚽" },
  { id: "nba",    label: "NBA",     icon: "🏀" },
  { id: "nfl",    label: "NFL",     icon: "🏈" },
  { id: "mlb",    label: "MLB",     icon: "⚾" },
  { id: "nhl",    label: "NHL",     icon: "🏒" },
];

const _SP = [
  "Eres un analista de datos deportivos de élite. DOS fases estrictas y secuenciales.",
  "",
  "FASE 1 — DATOS CRUDOS",
  "Busca con web_search los últimos 10 juegos de cada equipo y extrae estadísticas reales.",
  "Usa fuentes como FBref, SofaScore, ESPN, Basketball-Reference, Baseball-Reference, Hockey-Reference, NFL.com.",
  "",
  "FASE 2 — PICKS DE VALOR",
  "Genera picks con escala de confianza 1-10 basados únicamente en estadísticas.",
  "",
  "Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional, sin markdown, sin backticks:",
  JSON.stringify({
    partido: { equipoLocal:"nombre", equipoVisitante:"nombre", liga:"nombre", deporte:"futbol|nba|nfl|mlb|nhl", fecha:"fecha" },
    estadisticas: {
      categorias: ["Jugados","Ganados","Empatados (si aplica)","Perdidos","Pts/Goles a Favor (prom.)","Pts/Goles en Contra (prom.)","Posición (tabla/conferencia)","Over/Under métrica 1","Over/Under métrica 2","Over/Under métrica 3","Métrica específica 1","Métrica específica 2","Métrica específica 3","Métrica específica 4","Métrica específica 5"],
      local:     ["v1","v2","v3","v4","v5","v6","v7","v8","v9","v10","v11","v12","v13","v14","v15"],
      visitante: ["v1","v2","v3","v4","v5","v6","v7","v8","v9","v10","v11","v12","v13","v14","v15"]
    },
    picks: [
      { mercado:"RESULTADO",       pick:"descripción", confianza:7, razon:"razón basada en datos, máximo 2 líneas" },
      { mercado:"TOTALES",         pick:"descripción", confianza:6, razon:"razón" },
      { mercado:"HÁNDICAP/SPREAD", pick:"descripción", confianza:5, razon:"razón" },
      { mercado:"AMBOS ANOTAN",    pick:"Sí o No (solo si es fútbol)", confianza:6, razon:"razón" },
      { mercado:"MERCADOS ALT.",   pick:"descripción mercado alternativo", confianza:7, razon:"razón" }
    ],
    pickPrincipal: { descripcion:"pick con mayor confianza", confianza:8, mercado:"nombre del mercado" },
    notas: "lesiones, condiciones, contexto relevante"
  }, null, 2),
  "",
  "REGLAS:",
  "- El array categorias, local y visitante deben tener EXACTAMENTE el mismo número de elementos.",
  "- Adapta las categorías al deporte (fútbol: córners, BTTS; NBA: % tiro, rebotes; etc).",
  "- Si un dato no está disponible, usa N/D.",
  "- Omite picks con confianza menor a 5.",
  "- Responde SOLO el JSON, nada más."
];
const SYSTEM_PROMPT = _SP.join("\n");

function ConfidenceBadge({ value }) {
  const color = value >= 8 ? "#00e5a0" : value >= 6 ? "#f0b429" : "#ff6b6b";
  const label = value >= 8 ? "ALTO"    : value >= 6 ? "MEDIO"   : "BAJO";
  return (
    <span style={{ background:`${color}22`, color, border:`1px solid ${color}55`,
      borderRadius:6, padding:"2px 10px", fontSize:11, fontWeight:700,
      letterSpacing:1, fontFamily:"monospace" }}>
      {value}/10 · {label}
    </span>
  );
}

function ConfidenceBar({ value }) {
  const color = value >= 8 ? "#00e5a0" : value >= 6 ? "#f0b429" : "#ff6b6b";
  return (
    <div style={{ display:"flex", alignItems:"center", gap:8 }}>
      <div style={{ flex:1, height:4, background:"#ffffff12", borderRadius:2, overflow:"hidden" }}>
        <div style={{ width:`${(value/10)*100}%`, height:"100%", background:color,
          borderRadius:2, transition:"width 1s ease" }} />
      </div>
      <span style={{ fontSize:12, color, fontWeight:700, minWidth:32 }}>{value}/10</span>
    </div>
  );
}

function StatTable({ estadisticas, equipoLocal, equipoVisitante }) {
  const { categorias, local, visitante } = estadisticas;
  return (
    <div style={{ overflowX:"auto" }}>
      <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
        <thead>
          <tr>
            <th style={{ padding:"10px 14px", textAlign:"left", color:"#888", fontWeight:600,
              fontSize:11, letterSpacing:1, borderBottom:"1px solid #ffffff15", textTransform:"uppercase" }}>
              ESTADÍSTICA
            </th>
            <th style={{ padding:"10px 14px", textAlign:"center", color:"#4fc3f7",
              fontWeight:700, fontSize:12, borderBottom:"1px solid #ffffff15" }}>
              {equipoLocal}
            </th>
            <th style={{ padding:"10px 14px", textAlign:"center", color:"#f48fb1",
              fontWeight:700, fontSize:12, borderBottom:"1px solid #ffffff15" }}>
              {equipoVisitante}
            </th>
          </tr>
        </thead>
        <tbody>
          {categorias.map((cat, i) => {
            const vL = local[i] ?? "N/D", vV = visitante[i] ?? "N/D";
            const nL = parseFloat(vL), nV = parseFloat(vV);
            const lW = !isNaN(nL) && !isNaN(nV) && nL > nV;
            const vW = !isNaN(nL) && !isNaN(nV) && nV > nL;
            return (
              <tr key={i} style={{ background:i%2===0?"#ffffff05":"transparent", transition:"background 0.2s" }}>
                <td style={{ padding:"9px 14px", color:"#aaa", fontWeight:500 }}>{cat}</td>
                <td style={{ padding:"9px 14px", textAlign:"center",
                  color:lW?"#4fc3f7":"#ccc", fontWeight:lW?700:400,
                  background:lW?"#4fc3f710":"transparent" }}>{vL}</td>
                <td style={{ padding:"9px 14px", textAlign:"center",
                  color:vW?"#f48fb1":"#ccc", fontWeight:vW?700:400,
                  background:vW?"#f48fb110":"transparent" }}>{vV}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PickCard({ pick, isMain }) {
  return (
    <div style={{
      background: isMain ? "linear-gradient(135deg,#00e5a015,#00e5a005)" : "#ffffff07",
      border:     isMain ? "1px solid #00e5a040" : "1px solid #ffffff10",
      borderRadius:12, padding:"16px 18px", display:"flex", flexDirection:"column", gap:8 }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", flexWrap:"wrap", gap:6 }}>
        <span style={{ fontSize:10, fontWeight:800, letterSpacing:1.5,
          color:isMain?"#00e5a0":"#888", textTransform:"uppercase" }}>
          {isMain ? "⭐ PICK PRINCIPAL" : `▸ ${pick.mercado}`}
        </span>
        <ConfidenceBadge value={pick.confianza} />
      </div>
      <div style={{ fontSize:15, fontWeight:700, color:"#fff" }}>
        {pick.pick || pick.descripcion}
      </div>
      {pick.razon && (
        <div style={{ fontSize:12, color:"#888", lineHeight:1.5 }}>{pick.razon}</div>
      )}
      {isMain && <ConfidenceBar value={pick.confianza} />}
    </div>
  );
}

export default function App() {
  const [deporte, setDeporte] = useState("futbol");
  const [query,   setQuery]   = useState("");
  const [loading, setLoading] = useState(false);
  const [result,  setResult]  = useState(null);
  const [error,   setError]   = useState(null);
  const [step,    setStep]    = useState("");
  const inputRef = useRef();

  const placeholders = {
    futbol: "Ej: Manchester City vs Arsenal, Premier League",
    nba:    "Ej: Lakers vs Celtics, playoffs",
    nfl:    "Ej: Chiefs vs Eagles, semana 12",
    mlb:    "Ej: Yankees vs Red Sox",
    nhl:    "Ej: Maple Leafs vs Rangers",
  };

  async function analyze() {
    if (!query.trim()) return;
    setLoading(true); setResult(null); setError(null);
    setStep("Buscando datos en fuentes deportivas...");
    try {
      const sport  = SPORTS.find(s => s.id === deporte)?.label;
      const prompt = `Analiza el siguiente enfrentamiento de ${sport}: "${query}". Busca datos reales con web_search y responde SOLO el JSON.`;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type":  "application/json",
          "x-api-key":     import.meta.env.VITE_ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model:      "claude-sonnet-4-5",
          max_tokens: 4000,
          system:     SYSTEM_PROMPT,
          tools:      [{ type: "web_search_20250305", name: "web_search" }],
          messages:   [{ role: "user", content: prompt }],
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "Error en la API");
      setStep("Generando picks de valor...");
      const fullText = data.content
        .map(item => item.type === "text" ? item.text : "")
        .filter(Boolean)
        .join("\n");
      const match = fullText.match(/\{[\s\S]*\}/);
      if (!match) throw new Error("No se pudo obtener el análisis. Intenta de nuevo.");
      setResult(JSON.parse(match[0].replace(/```json|```/g, "").trim()));
    } catch (err) {
      setError(err.message || "Error inesperado. Intenta de nuevo.");
    } finally {
      setLoading(false); setStep("");
    }
  }

  return (
    <div style={{ minHeight:"100vh", background:"#0a0e1a", color:"#fff",
      fontFamily:"'DM Sans','Segoe UI',sans-serif", padding:"0 0 60px" }}>

      {/* Header */}
      <div style={{ background:"linear-gradient(180deg,#0d1229 0%,#0a0e1a 100%)",
        borderBottom:"1px solid #ffffff10", padding:"28px 24px 24px",
        textAlign:"center", position:"relative", overflow:"hidden" }}>
        <div style={{ position:"absolute", top:-60, left:"50%", transform:"translateX(-50%)",
          width:400, height:200, borderRadius:"50%",
          background:"radial-gradient(ellipse,#1a3a6640 0%,transparent 70%)",
          pointerEvents:"none" }} />
        <div style={{ position:"relative", zIndex:1 }}>
          <div style={{ fontSize:11, letterSpacing:3, color:"#4fc3f7",
            fontWeight:700, textTransform:"uppercase", marginBottom:8 }}>
            ANÁLISIS DEPORTIVO IA
          </div>
          <h1 style={{ margin:0, fontSize:28, fontWeight:900, letterSpacing:-0.5 }}>
            Stats<span style={{ color:"#4fc3f7" }}>.</span>AI
          </h1>
          <p style={{ margin:"8px 0 0", fontSize:13, color:"#666" }}>
            Datos crudos + picks de valor generados por inteligencia artificial
          </p>
        </div>
      </div>

      <div style={{ maxWidth:780, margin:"0 auto", padding:"28px 16px 0" }}>

        {/* Sport Selector */}
        <div style={{ display:"flex", gap:8, marginBottom:16, flexWrap:"wrap" }}>
          {SPORTS.map(s => (
            <button key={s.id} onClick={() => setDeporte(s.id)} style={{
              padding:"7px 14px", borderRadius:8,
              border:     deporte===s.id ? "1px solid #4fc3f7"  : "1px solid #ffffff15",
              background: deporte===s.id ? "#4fc3f715"          : "transparent",
              color:      deporte===s.id ? "#4fc3f7"            : "#888",
              cursor:"pointer", fontSize:13, fontWeight:600,
              display:"flex", alignItems:"center", gap:6, transition:"all 0.2s" }}>
              {s.icon} {s.label}
            </button>
          ))}
        </div>

        {/* Input */}
        <div style={{ display:"flex", gap:10, marginBottom:32 }}>
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === "Enter" && !loading && analyze()}
            placeholder={placeholders[deporte]}
            disabled={loading}
            style={{ flex:1, padding:"13px 18px", borderRadius:10,
              border:"1px solid #ffffff15", background:"#ffffff08",
              color:"#fff", fontSize:14, outline:"none", fontFamily:"inherit",
              transition:"border 0.2s" }}
            onFocus={e => e.target.style.border = "1px solid #4fc3f750"}
            onBlur={e  => e.target.style.border = "1px solid #ffffff15"}
          />
          <button
            onClick={analyze}
            disabled={loading || !query.trim()}
            style={{
              padding:"13px 22px", borderRadius:10, border:"none",
              background: loading || !query.trim()
                ? "#ffffff15"
                : "linear-gradient(135deg,#1565c0,#4fc3f7)",
              color:  loading || !query.trim() ? "#555" : "#fff",
              cursor: loading || !query.trim() ? "not-allowed" : "pointer",
              fontSize:14, fontWeight:700, letterSpacing:0.5,
              transition:"all 0.2s", minWidth:110, whiteSpace:"nowrap" }}>
            {loading ? "Analizando..." : "Analizar →"}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div style={{ textAlign:"center", padding:"48px 24px",
            background:"#ffffff05", borderRadius:16, border:"1px solid #ffffff10" }}>
            <div style={{ fontSize:32, marginBottom:16, display:"inline-block",
              animation:"spin 1.5s linear infinite" }}>⟳</div>
            <div style={{ color:"#4fc3f7", fontWeight:600, fontSize:14 }}>{step}</div>
            <div style={{ color:"#555", fontSize:12, marginTop:8 }}>
              Consultando fuentes deportivas en tiempo real...
            </div>
            <style>{"@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"}</style>
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{ padding:"16px 20px", background:"#ff6b6b10",
            border:"1px solid #ff6b6b30", borderRadius:12,
            color:"#ff6b6b", fontSize:13 }}>
            ⚠️ {error}
          </div>
        )}

        {/* Result */}
        {result && !loading && (
          <div style={{ display:"flex", flexDirection:"column", gap:20 }}>

            {/* Match Header */}
            <div style={{ background:"linear-gradient(135deg,#0d1229,#111827)",
              border:"1px solid #ffffff15", borderRadius:16, padding:"20px 24px" }}>
              <div style={{ fontSize:11, color:"#666", letterSpacing:1.5,
                textTransform:"uppercase", marginBottom:12 }}>
                {result.partido?.liga} · Últimos 10 juegos
              </div>
              <div style={{ display:"flex", alignItems:"center",
                justifyContent:"space-between", flexWrap:"wrap", gap:12 }}>
                <div style={{ textAlign:"center", flex:1 }}>
                  <div style={{ fontSize:18, fontWeight:800, color:"#4fc3f7" }}>
                    {result.partido?.equipoLocal}
                  </div>
                  <div style={{ fontSize:11, color:"#4fc3f7aa", marginTop:2 }}>LOCAL</div>
                </div>
                <div style={{ fontSize:22, color:"#444", fontWeight:900 }}>VS</div>
                <div style={{ textAlign:"center", flex:1 }}>
                  <div style={{ fontSize:18, fontWeight:800, color:"#f48fb1" }}>
                    {result.partido?.equipoVisitante}
                  </div>
                  <div style={{ fontSize:11, color:"#f48fb1aa", marginTop:2 }}>VISITANTE</div>
                </div>
              </div>
              {result.partido?.fecha && (
                <div style={{ textAlign:"center", marginTop:12, fontSize:12, color:"#555" }}>
                  📅 {result.partido.fecha}
                </div>
              )}
            </div>

            {/* Stats Table */}
            {result.estadisticas && (
              <div style={{ background:"#0d1229", border:"1px solid #ffffff10",
                borderRadius:16, overflow:"hidden" }}>
                <div style={{ padding:"16px 18px 12px", borderBottom:"1px solid #ffffff10" }}>
                  <span style={{ fontSize:11, fontWeight:700, letterSpacing:2,
                    color:"#888", textTransform:"uppercase" }}>
                    📊 DATOS CRUDOS — L10
                  </span>
                </div>
                <StatTable
                  estadisticas={result.estadisticas}
                  equipoLocal={result.partido?.equipoLocal}
                  equipoVisitante={result.partido?.equipoVisitante}
                />
              </div>
            )}

            {/* Pick Principal */}
            {result.pickPrincipal && (
              <PickCard pick={result.pickPrincipal} isMain={true} />
            )}

            {/* Picks Grid */}
            {result.picks?.length > 0 && (
              <div>
                <div style={{ fontSize:11, fontWeight:700, letterSpacing:2,
                  color:"#888", textTransform:"uppercase", marginBottom:12 }}>
                  TODOS LOS MERCADOS
                </div>
                <div style={{ display:"grid",
                  gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))", gap:12 }}>
                  {result.picks.map((p, i) => (
                    <PickCard key={i} pick={p} isMain={false} />
                  ))}
                </div>
              </div>
            )}

            {/* Notes */}
            {result.notas && (
              <div style={{ padding:"14px 18px", background:"#f0b42910",
                border:"1px solid #f0b42930", borderRadius:12,
                fontSize:12, color:"#f0b429", lineHeight:1.6 }}>
                ⚡ <strong>Notas:</strong> {result.notas}
              </div>
            )}

            <div style={{ fontSize:11, color:"#333", textAlign:"center", paddingTop:8 }}>
              Análisis generado por IA con datos de fuentes públicas. Solo para uso informativo personal.
            </div>
          </div>
        )}

        {/* Empty State */}
        {!result && !loading && !error && (
          <div style={{ textAlign:"center", padding:"48px 24px", color:"#333" }}>
            <div style={{ fontSize:48, marginBottom:16 }}>📊</div>
            <div style={{ fontSize:14, fontWeight:600, color:"#555" }}>
              Ingresa un partido para comenzar el análisis
            </div>
            <div style={{ fontSize:12, marginTop:8, color:"#333" }}>
              La IA buscará datos reales y generará picks de valor automáticamente
            </div>
          </div>
        )}
      </div>
    </div>
  );
}