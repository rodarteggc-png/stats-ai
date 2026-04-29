# Stats.AI — Análisis Deportivo con IA

## Setup rápido (PC)

### 1. Descomprime el ZIP y entra a la carpeta
```
cd stats-ai
```

### 2. Instala dependencias
```
npm install
```

### 3. Crea tu archivo .env (copia .env.example y renómbralo)
```
VITE_ANTHROPIC_KEY=sk-ant-TU_KEY_AQUI
```
Obtén tu key en: https://console.anthropic.com

### 4. Levanta la app
```
npm run dev
```
Abre: http://localhost:5173

### Acceso desde celular/tablet en tu red local
```
npm run dev -- --host
```

## Deploy en Vercel (gratis, acceso desde cualquier lugar)
1. Sube este proyecto a GitHub
2. Importa el repo en vercel.com
3. Settings → Environment Variables → agrega VITE_ANTHROPIC_KEY
4. Deploy ✅
