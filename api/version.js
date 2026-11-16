// api/version.js - Endpoint ligero: qué commit está desplegado en producción.
// Sin autenticación: un hash de commit no es sensible. Sirve para verificar
// tras un push/redeploy si el código nuevo ya está en vivo.
// VERCEL_GIT_COMMIT_SHA la inyecta Vercel automáticamente en cada despliegue
// conectado a git; fuera de Vercel (o sin git) responde 'unknown'.
export default function handler(req, res) {
  const commit = process.env.VERCEL_GIT_COMMIT_SHA || 'unknown';
  return res.status(200).json({
    success: true,
    commit,
    commitShort: commit === 'unknown' ? 'unknown' : commit.slice(0, 7),
    environment: process.env.VERCEL_ENV || 'unknown',
    timestamp: new Date().toISOString()
  });
}
