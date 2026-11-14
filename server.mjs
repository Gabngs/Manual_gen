import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { exec } from 'node:child_process';
import { asset, OUT, loadSettings, saveSettings, loadManuales, saveManuales, publicSettings, mergeSettings } from './lib/config.mjs';
import { claudeStatus, claudeLogin, iniciarSesionAislada, cerrarSesion, borrarSesionAlSalir } from './lib/claude.mjs';
import { generar, leerMeta, conImagenes } from './lib/generator.mjs';
import { publicar, probar, libros, capitulos } from './lib/bookstack.mjs';

const PORT = Number(process.env.PORT) || 4317;
const jobs = new Map(); // id -> { log:[], estado:'corriendo'|'ok'|'error', resultado, error }
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => ok(b ? JSON.parse(b) : {})); });
const safe = (s) => /^[\w-]+$/.test(s ?? '');

function lanzar(fn) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { log: [], estado: 'corriendo' };
  jobs.set(id, job);
  const log = (m) => job.log.push(m);
  fn(log).then((r) => { job.resultado = r; job.estado = 'ok'; }).catch((e) => { job.error = e.message; job.estado = 'error'; log(`ERROR: ${e.message}`); });
  return id;
}

const manualDe = (clave) => loadManuales().find((m) => m.clave === clave);
const bookstackActivo = (s) => s.bookstacks.find((b) => b.id === s.bookstackActivo);

const activo = () => {
  const bs = bookstackActivo(loadSettings());
  if (!bs) throw new Error('Registra y elige una conexión BookStack en Configuración');
  return bs;
};

const rutas = {
  'GET /api/estado': async () => ({ settings: publicSettings(loadSettings()), manuales: loadManuales() }),
  'GET /api/claude': async () => claudeStatus(),
  'POST /api/settings': async (b) => { saveSettings(mergeSettings(loadSettings(), b)); return { ok: true }; },
  'POST /api/manuales': async (b) => {
    if (!safe(b.clave)) throw new Error('La clave solo admite letras, números, - y _');
    const lista = loadManuales().filter((m) => m.clave !== (b.claveAnterior ?? b.clave));
    saveManuales([...lista, b.manual].sort((a, c) => a.clave.localeCompare(c.clave)));
    return { ok: true };
  },
  'POST /api/manuales/borrar': async (b) => { saveManuales(loadManuales().filter((m) => m.clave !== b.clave)); return { ok: true }; },
  'POST /api/claude/login': async () => { claudeLogin(); return { ok: true }; },
  'POST /api/claude/logout': async () => { cerrarSesion(); return { ok: true }; },
  'POST /api/generar': async (b) => {
    const manual = manualDe(b.clave);
    if (!manual) throw new Error('Manual no encontrado');
    const settings = loadSettings();
    return { job: lanzar((log) => generar({ manual, settings, modo: b.modo, log })) };
  },
  'POST /api/publicar': async (b) => {
    const manual = manualDe(b.clave);
    const bs = bookstackActivo(loadSettings());
    if (!manual || !bs) throw new Error('Falta el manual o la conexión a BookStack activa');
    return { job: lanzar((log) => publicar({ manual, bookstack: bs, log })) };
  },
  'GET /api/bookstack/libros': async () => libros(activo()),
  'GET /api/bookstack/capitulos': async (_b, url) => capitulos(activo(), url.searchParams.get('libro')),
  'POST /api/bookstack/probar': async (b) => {
    const s = loadSettings();
    const bs = b.id ? { ...s.bookstacks.find((x) => x.id === b.id) } : bookstackActivo(s);
    if (!bs) throw new Error('No hay conexión BookStack');
    return probar(bs, b.clave ? manualDe(b.clave) : null);
  },
};

iniciarSesionAislada();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => process.exit(0));
process.on('exit', borrarSesionAlSalir); // al cerrar el programa se cierra la sesión de Claude

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    const key = `${req.method} ${p}`;
    if (rutas[key]) return send(res, 200, await rutas[key](req.method === 'POST' ? await readBody(req) : {}, url));
    let m;
    if ((m = p.match(/^\/api\/job\/(\w+)$/))) {
      const j = jobs.get(m[1]);
      return j ? send(res, 200, j) : send(res, 404, { error: 'job no existe' });
    }
    if ((m = p.match(/^\/preview\/([\w-]+)$/))) {
      const meta = leerMeta(m[1]);
      const mapa = Object.fromEntries(meta.shots.map((s) => [s.id, `/out/${m[1]}/${s.file}`]));
      return send(res, 200, `<!doctype html><meta charset="utf-8"><style>body{font:15px/1.6 system-ui,sans-serif;margin:24px;max-width:960px;color:#1d2433}img{border:1px solid #d9dee8;border-radius:6px;margin:8px 0}</style>${conImagenes(meta.cuerpo, mapa)}`, MIME['.html']);
    }
    if ((m = p.match(/^\/api\/meta\/([\w-]+)$/))) {
      try { const { cuerpo, ...resto } = leerMeta(m[1]); return send(res, 200, resto); } catch { return send(res, 200, null); }
    }
    if ((m = p.match(/^\/out\/([\w-]+)\/([\w.-]+)$/))) {
      const f = join(OUT, m[1], basename(m[2]));
      return existsSync(f) ? send(res, 200, readFileSync(f), 'image/png') : send(res, 404, 'no existe', 'text/plain');
    }
    if (p === '/' || p === '/index.html') return send(res, 200, asset('index.html'), MIME['.html']);
    send(res, 404, 'no encontrado', 'text/plain');
  } catch (e) {
    send(res, 400, { error: e.message });
  }
}).listen(PORT, '127.0.0.1', () => {
  const u = `http://localhost:${PORT}`;
  console.log(`Manual Gen en ${u}  (Ctrl+C para cerrar)`);
  if (!process.env.NO_OPEN) exec(process.platform === 'win32' ? `start "" ${u}` : `xdg-open ${u}`);
});
