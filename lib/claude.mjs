import { spawn, execFile } from 'node:child_process';
import { existsSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/*
 * La sesión de Claude es TEMPORAL y propia de esta app:
 * se guarda en una carpeta aislada (CLAUDE_CONFIG_DIR) que se borra al cerrar el programa.
 * Así nunca se usa la sesión de Claude Code que la persona ya tenga en su equipo,
 * ni queda ninguna sesión abierta cuando el programa termina.
 */
const PREFIJO = 'manual-gen-claude-';
export const CLAUDE_HOME = join(tmpdir(), `${PREFIJO}${process.pid}`);
const env = () => ({ ...process.env, CLAUDE_CONFIG_DIR: CLAUDE_HOME });

export function iniciarSesionAislada() {
  // limpia restos de ejecuciones anteriores que se cerraron mal
  for (const d of readdirSync(tmpdir())) {
    if (!d.startsWith(PREFIJO)) continue;
    const pid = Number(d.slice(PREFIJO.length));
    let vivo = false;
    try { process.kill(pid, 0); vivo = pid !== process.pid; } catch { /* no existe */ }
    if (!vivo && pid !== process.pid) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  }
  mkdirSync(CLAUDE_HOME, { recursive: true });
}
export function cerrarSesion() {
  rmSync(CLAUDE_HOME, { recursive: true, force: true });
  mkdirSync(CLAUDE_HOME, { recursive: true });
}
export function borrarSesionAlSalir() {
  rmSync(CLAUDE_HOME, { recursive: true, force: true });
}

/** Localiza el ejecutable de Claude Code (CLAUDE_BIN, instalación nativa, npm o extensión de VS Code). */
export function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const fijos = [join(home, '.local', 'bin', exe), join(home, '.claude', 'local', exe), process.env.APPDATA && join(process.env.APPDATA, 'npm', 'claude.cmd')].filter(Boolean);
  for (const p of fijos) if (existsSync(p)) return p;
  const base = join(home, '.vscode', 'extensions');
  if (existsSync(base)) {
    for (const d of readdirSync(base).filter((x) => x.startsWith('anthropic.claude-code')).sort().reverse()) {
      const p = join(base, d, 'resources', 'native-binary', exe);
      if (existsSync(p)) return p;
    }
  }
  return 'claude'; // que lo resuelva el PATH
}

const run = (args, opts, cb) => execFile(findClaude(), args, { env: env(), shell: findClaude().endsWith('.cmd'), ...opts }, cb);

/** Estado: { instalado, sesion, metodo }. */
export function claudeStatus() {
  return new Promise((resolve) => {
    run(['auth', 'status'], { timeout: 15000 }, (err, stdout) => {
      if (err && !stdout) return resolve({ instalado: err.code !== 'ENOENT', sesion: false });
      try {
        const j = JSON.parse(stdout);
        resolve({ instalado: true, sesion: !!j.loggedIn, metodo: j.authMethod ?? '' });
      } catch { resolve({ instalado: true, sesion: false }); }
    });
  });
}

/** Abre una consola aparte para iniciar sesión (se abre el navegador de Claude). */
export function claudeLogin() {
  const bin = findClaude();
  if (process.platform === 'win32')
    spawn('cmd', ['/c', 'start', '"Claude login"', 'cmd', '/k', `"${bin}" auth login`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, env: env() }).unref();
  else spawn(bin, ['auth', 'login'], { detached: true, stdio: 'ignore', env: env() }).unref();
}

/** Pide a Claude Code (modo headless, sin herramientas) que responda al prompt. */
export function claudeAsk(prompt, timeoutMs = 300000, dirImagenes = null) {
  return new Promise((resolve, reject) => {
    // con imágenes se permite únicamente leer archivos (Read) de la carpeta de esas imágenes
    const args = dirImagenes ? ['-p', '--tools', 'Read', '--allowedTools', 'Read', '--add-dir', dirImagenes] : ['-p', '--tools', ''];
    const p = spawn(findClaude(), args, { stdio: ['pipe', 'pipe', 'pipe'], env: env() });
    let out = '', err = '';
    const t = setTimeout(() => { p.kill(); reject(new Error('Claude tardó demasiado')); }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => { clearTimeout(t); reject(e); });
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 && out.trim() ? resolve(out.trim()) : reject(new Error(err.trim().slice(0, 300) || `Claude terminó con código ${code}`));
    });
    p.stdin.end(prompt);
  });
}
