import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeStatus, claudeLogin, cerrarSesion as cerrarClaude, claudeAsk } from './claude.mjs';

/*
 * Proveedores de IA: Claude Code, Gemini CLI y ChatGPT (Codex CLI).
 * Todos usan la suscripción de la persona (sin API key) y con una sesión TEMPORAL y aislada:
 * Claude en CLAUDE_CONFIG_DIR (ver claude.mjs), Gemini en GEMINI_CLI_HOME y Codex en CODEX_HOME,
 * carpetas propias que se borran al cerrar el programa. Nunca se toca la sesión que la persona ya tenga.
 */
const PREFIJO = 'manual-gen-ia-';
const HOME = join(tmpdir(), `${PREFIJO}${process.pid}`);
const WIN = process.platform === 'win32';
const dirDe = (id) => join(HOME, id);

export const PROVEEDORES = [
  { id: 'claude', nombre: 'Claude', cli: 'claude', instalar: 'https://claude.com/claude-code' },
  { id: 'gemini', nombre: 'Gemini', cli: 'gemini', instalar: 'npm i -g @google/gemini-cli' },
  { id: 'chatgpt', nombre: 'ChatGPT', cli: 'codex', instalar: 'npm i -g @openai/codex' },
];
const envDe = (id) => ({ ...process.env, ...(id === 'gemini' ? { GEMINI_CLI_HOME: dirDe('gemini') } : id === 'chatgpt' ? { CODEX_HOME: dirDe('chatgpt') } : {}) });

export function iniciarIA() {
  for (const d of readdirSync(tmpdir())) { // restos de ejecuciones anteriores que se cerraron mal
    if (!d.startsWith(PREFIJO)) continue;
    const pid = Number(d.slice(PREFIJO.length));
    let vivo = false;
    try { process.kill(pid, 0); vivo = pid !== process.pid; } catch { /* no existe */ }
    if (!vivo && pid !== process.pid) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
  for (const id of ['gemini', 'chatgpt', 'trabajo']) mkdirSync(dirDe(id), { recursive: true });
}
export const borrarIAAlSalir = () => rmSync(HOME, { recursive: true, force: true });

const instalado = (cli) => new Promise((ok) => execFile(WIN ? 'where' : 'which', [cli], { timeout: 8000 }, (e) => ok(!e)));

/** { instalado, sesion } de un proveedor. */
export async function estadoIA(id) {
  const p = PROVEEDORES.find((x) => x.id === id);
  if (!p) throw new Error('Proveedor de IA desconocido');
  if (id === 'claude') return claudeStatus();
  if (!(await instalado(p.cli))) return { instalado: false, sesion: false };
  const cred = id === 'gemini' ? join(dirDe('gemini'), '.gemini', 'oauth_creds.json') : join(dirDe('chatgpt'), 'auth.json');
  return { instalado: true, sesion: existsSync(cred) };
}
export async function estadoTodos() {
  const r = await Promise.all(PROVEEDORES.map(async (p) => [p.id, { nombre: p.nombre, instalar: p.instalar, ...(await estadoIA(p.id)) }]));
  return Object.fromEntries(r);
}

/** Abre una consola aparte con el inicio de sesión del proveedor (se abre el navegador). */
export function loginIA(id) {
  if (id === 'claude') return claudeLogin();
  const cmd = id === 'gemini' ? 'gemini' : 'codex login'; // Gemini pide elegir «Login with Google» en su primera pantalla
  const opts = { detached: true, stdio: 'ignore', env: envDe(id) };
  if (WIN) spawn('cmd', ['/c', 'start', `"${id} login"`, 'cmd', '/k', cmd], { ...opts, windowsVerbatimArguments: true }).unref();
  else spawn(cmd, { ...opts, shell: true }).unref();
}
export function logoutIA(id) {
  if (id === 'claude') return cerrarClaude();
  rmSync(dirDe(id), { recursive: true, force: true });
  mkdirSync(dirDe(id), { recursive: true });
}

function ejecutar(cmd, { cwd, env, input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, { shell: true, cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('La IA tardó demasiado')); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
    p.stdin.end(input);
  });
}
const falla = (n, r) => new Error((r.err.trim() || r.out.trim()).slice(0, 300) || `${n} terminó con código ${r.code}`);

/**
 * Pide al proveedor que responda al prompt.
 * imagenes: [{ id, path }] (rutas absolutas, todas en la misma carpeta). Los tres proveedores leen imágenes.
 */
export async function preguntarIA(id, prompt, imagenes = [], timeoutMs = 300000) {
  const dir = imagenes.length ? join(imagenes[0].path, '..') : dirDe('trabajo');
  const nombre = (i) => i.path.split(/[\\/]/).pop();
  if (id === 'claude')
    return claudeAsk(imagenes.length ? `${prompt}\n\nLas imágenes están en estas rutas; ábrelas con la herramienta Read antes de redactar:\n${imagenes.map((i) => `- ${i.id}: ${i.path}`).join('\n')}` : prompt, timeoutMs, imagenes.length ? dir : null);
  if (id === 'gemini') {
    const r = await ejecutar(`gemini -p "Sigue estrictamente las instrucciones recibidas por entrada estandar. ${imagenes.map((i) => `@${nombre(i)}`).join(' ')}"`, { cwd: dir, env: envDe(id), input: prompt, timeoutMs });
    if (r.code !== 0 || !r.out.trim()) throw falla('Gemini', r);
    return r.out.trim();
  }
  if (id === 'chatgpt') {
    const salida = join(dirDe('trabajo'), `respuesta-${Date.now()}.txt`);
    const r = await ejecutar(`codex exec --skip-git-repo-check --sandbox read-only -o "${salida}" ${imagenes.length ? `-i "${imagenes.map((i) => i.path).join(',')}"` : ''}`, { cwd: dirDe('trabajo'), env: envDe(id), input: prompt, timeoutMs });
    let txt = '';
    try { txt = readFileSync(salida, 'utf8'); rmSync(salida, { force: true }); } catch { txt = r.out; }
    if (!txt.trim()) throw falla('ChatGPT', r);
    return txt.trim();
  }
  throw new Error('Proveedor de IA desconocido');
}
