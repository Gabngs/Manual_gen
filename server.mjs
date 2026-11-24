import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { exec } from 'node:child_process';
import { asset, OUT, loadSettings, saveSettings, loadManuales, saveManuales, publicSettings, mergeSettings } from './lib/config.mjs';
import { iniciarSesionAislada, borrarSesionAlSalir } from './lib/claude.mjs';
import { iniciarIA, borrarIAAlSalir, estadoTodos, loginIA, logoutIA, PROVEEDORES } from './lib/ia.mjs';
import { generar, leerMeta, conImagenes, guardarSubidas, mimeDe } from './lib/generator.mjs';
import { iniciarGrabacion, estadoGrabacion, pausarGrabacion, terminarGrabacion } from './lib/grabador.mjs';
import { exportarPdf, exportarDocx } from './lib/exportar.mjs';
import { publicar, probar, libros, capitulos } from './lib/bookstack.mjs';

const PORT = Number(process.env.PORT) || 4317;
const jobs = new Map(); // id -> { log:[], estado:'corriendo'|'ok'|'error', resultado, error }
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};
const MAX_BODY = 256 * 1024 * 1024; // las capturas subidas viajan en base64
const readBody = (req) => new Promise((ok, no) => {
  const partes = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n > MAX_BODY) { no(new Error('La petición es demasiado grande')); req.destroy(); } else partes.push(d); });
  req.on('end', () => { try { const b = Buffer.concat(partes).toString('utf8'); ok(b ? JSON.parse(b) : {}); } catch { no(new Error('Petición inválida (JSON mal formado)')); } });
  req.on('error', no);
});
const safe = (s) => /^[\w-]+$/.test(s ?? '');

function lanzar(fn) {
  const id = Math.random().toString(36).slice(2, 10);
  const job = { log: [], estado: 'corriendo' };
  jobs.set(id, job);
  for (const [k, j] of jobs) if (j.fin && Date.now() - j.fin > 3600000) jobs.delete(k); // se descartan las tareas terminadas hace más de 1 h
  const log = (m) => job.log.push(m);
  fn(log).then((r) => { job.resultado = r; job.estado = 'ok'; }).catch((e) => { job.error = e.message; job.estado = 'error'; log(`ERROR: ${e.message}`); }).finally(() => { job.fin = Date.now(); });
  return id;
}

const idIA = (id) => { if (!PROVEEDORES.some((p) => p.id === id)) throw new Error('Proveedor de IA desconocido'); };
const manualDe = (clave) => loadManuales().find((m) => m.clave === clave);
const bookstackActivo = (s) => s.bookstacks.find((b) => b.id === s.bookstackActivo);

const activo = () => {
  const bs = bookstackActivo(loadSettings());
  if (!bs) throw new Error('Registra y elige una conexión BookStack en Configuración');
  return bs;
};

const rutas = {
  'GET /api/estado': async () => ({ settings: publicSettings(loadSettings()), manuales: loadManuales() }),
  'GET /api/ia': async () => estadoTodos(),
  'POST /api/settings': async (b) => { saveSettings(mergeSettings(loadSettings(), b)); return { ok: true }; },
  'POST /api/manuales': async (b) => {
    if (!safe(b.clave)) throw new Error('La clave solo admite letras, números, - y _');
    const lista = loadManuales().filter((m) => m.clave !== (b.claveAnterior ?? b.clave));
    saveManuales([...lista, b.manual].sort((a, c) => a.clave.localeCompare(c.clave)));
    return { ok: true };
  },
  'POST /api/manuales/borrar': async (b) => { saveManuales(loadManuales().filter((m) => m.clave !== b.clave)); return { ok: true }; },
  'POST /api/ia/login': async (b) => { idIA(b.id); loginIA(b.id); return { ok: true }; },
  'POST /api/ia/logout': async (b) => { idIA(b.id); logoutIA(b.id); return { ok: true }; },
  'POST /api/grabar/iniciar': async (b) => {
    const manual = manualDe(b.clave);
    const settings = loadSettings();
    const entorno = settings.entornos.find((e) => e.id === settings.entornoActivo);
    if (!manual) throw new Error('Manual no encontrado');
    if (!entorno) throw new Error('Elige un entorno en Configuración.');
    await iniciarGrabacion({ manual, entorno, log: () => {} });
    return { ok: true };
  },
  'GET /api/grabar/estado': async (_b, url) => estadoGrabacion(Number(url.searchParams.get('desde')) || 0),
  'POST /api/grabar/pausa': async (b) => { pausarGrabacion(!!b.pausa); return { ok: true }; },
  'POST /api/grabar/terminar': async () => { await terminarGrabacion(); return { ok: true }; },
  'POST /api/capturas': async (b) => {
    if (!manualDe(b.clave)) throw new Error('Manual no encontrado');
    return { ok: true, total: guardarSubidas(b.clave, b.imagenes) };
  },
  'POST /api/generar': async (b) => {
    const manual = manualDe(b.clave);
    if (!manual) throw new Error('Manual no encontrado');
    const settings = loadSettings();
    if (b.modo === 'ia') idIA(b.ia);
    return { job: lanzar((log) => generar({ manual, settings, modo: b.modo, ia: b.ia, origen: b.origen, log })) };
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
iniciarIA();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.on(sig, () => process.exit(0));
process.on('exit', () => { borrarSesionAlSalir(); borrarIAAlSalir(); }); // al cerrar el programa se cierran las sesiones de IA

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
    if ((m = p.match(/^\/api\/exportar\/([\w-]+)\/(pdf|docx)$/))) {
      const manual = manualDe(m[1]);
      if (!manual) throw new Error('Manual no encontrado');
      try { leerMeta(m[1]); } catch { throw new Error('Primero genera el manual para poder exportarlo.'); }
      const nombre = (manual.pagina || m[1]).replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || m[1];
      const pdf = m[2] === 'pdf';
      const buf = pdf ? await exportarPdf(m[1], manual.pagina) : exportarDocx(m[1], manual.pagina);
      res.writeHead(200, {
        'Content-Type': pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename="manual.${m[2]}"; filename*=UTF-8''${encodeURIComponent(`Manual ${nombre}.${m[2]}`)}`,
        'Cache-Control': 'no-store',
      });
      return res.end(buf);
    }
    if ((m = p.match(/^\/api\/meta\/([\w-]+)$/))) {
      try { const { cuerpo, ...resto } = leerMeta(m[1]); return send(res, 200, resto); } catch { return send(res, 200, null); }
    }
    if ((m = p.match(/^\/out\/([\w-]+)\/([\w.-]+)$/))) {
      const f = join(OUT, m[1], basename(m[2]));
      return existsSync(f) ? send(res, 200, readFileSync(f), mimeDe(f)) : send(res, 404, 'no existe', 'text/plain');
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
