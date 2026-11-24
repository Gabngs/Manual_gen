import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, renameSync, rmSync, readdirSync, rmdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSea, getAsset } from 'node:sea';
import { CIFRADO, proteger, desproteger } from './secure.mjs';

// En el .exe (Node SEA) los archivos de la interfaz viajan embebidos como "assets".
export const SEA = isSea();
const srcDir = SEA ? '' : typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
const ROOT = SEA ? dirname(process.execPath) : join(srcDir, '..');
export const asset = (name) =>
  SEA ? getAsset(name, 'utf8') : readFileSync(join(ROOT, name === 'manuales.default.json' ? '' : 'public', name), 'utf8');

// Los datos viven fuera del .exe, por usuario: sobreviven a nuevas versiones y no quedan junto al programa.
export const APP_HOME = process.env.APPDATA ? join(process.env.APPDATA, 'ManualGen') : join(homedir(), '.config', 'manual-gen');
export const OUT = join(APP_HOME, 'out');
const SETTINGS = join(APP_HOME, 'settings.dat'); // cifrado con DPAPI (ver secure.mjs)
const MANUALES = join(APP_HOME, 'manuales.json');
const FORMATO = 1; // versión del formato de archivo, para poder migrar en futuras versiones

mkdirSync(APP_HOME, { recursive: true });
mkdirSync(OUT, { recursive: true });

const DEFAULT_SETTINGS = {
  repo: { path: '', ref: 'origin/develop' },
  entornoActivo: '',
  entornos: [],
  bookstackActivo: '',
  bookstacks: [],
};

let cache = null;
const actualizar = (obj) => ({ ...DEFAULT_SETTINGS, ...obj }); // aquí irán las migraciones entre formatos

export function saveSettings(s) {
  const json = JSON.stringify(s);
  const doc = CIFRADO
    ? { version: FORMATO, cifrado: true, data: proteger(json) }
    : { version: FORMATO, cifrado: false, data: json };
  writeFileSync(SETTINGS, JSON.stringify(doc), { mode: 0o600 });
  cache = actualizar(s);
}

export function loadSettings() {
  if (!cache) {
    cache = DEFAULT_SETTINGS;
    if (existsSync(SETTINGS)) {
      try {
        const doc = JSON.parse(readFileSync(SETTINGS, 'utf8'));
        cache = actualizar(JSON.parse(doc.cifrado ? desproteger(doc.data) : doc.data));
      } catch {
        // archivo de otro usuario/equipo o dañado: se aparta y se empieza limpio
        renameSync(SETTINGS, `${SETTINGS}.ilegible`);
      }
    }
  }
  return structuredClone(cache);
}

/** Migra la carpeta data/ de versiones anteriores (texto plano junto al .exe) al almacén cifrado. */
function migrarLegado() {
  const legado = join(ROOT, 'data');
  const viejo = join(legado, 'settings.json');
  if (!existsSync(SETTINGS) && existsSync(viejo)) {
    const s = JSON.parse(readFileSync(viejo, 'utf8'));
    saveSettings(s);
    cache = null;
    if (JSON.stringify(loadSettings()) === JSON.stringify(actualizar(s))) rmSync(viejo); // solo se borra si se leyó bien
  }
  const vm = join(legado, 'manuales.json');
  if (existsSync(vm) && !existsSync(MANUALES)) { copyFileSync(vm, MANUALES); rmSync(vm); }
  try { if (existsSync(legado) && !readdirSync(legado).length) rmdirSync(legado); } catch { /* no vacía */ }
}
migrarLegado();

if (!existsSync(MANUALES)) writeFileSync(MANUALES, asset('manuales.default.json'));
let cacheMan = null; // se lee del disco una sola vez; saveManuales lo invalida
export const loadManuales = () => (cacheMan ??= JSON.parse(readFileSync(MANUALES, 'utf8')));
export const saveManuales = (m) => { writeFileSync(MANUALES, JSON.stringify(m, null, 2)); cacheMan = null; };

/** Copia de los ajustes sin secretos, para enviarla a la interfaz. */
export function publicSettings(s) {
  return {
    ...s,
    entornos: s.entornos.map(({ clave, ...e }) => ({ ...e, tieneClave: !!clave })),
    bookstacks: s.bookstacks.map(({ tokenSecret, ...b }) => ({ ...b, tieneSecret: !!tokenSecret })),
  };
}

/** Une los ajustes recibidos de la interfaz con los guardados: un secreto vacío conserva el anterior. */
export function mergeSettings(old, nuevo) {
  const prevE = Object.fromEntries(old.entornos.map((e) => [e.id, e]));
  const prevB = Object.fromEntries(old.bookstacks.map((b) => [b.id, b]));
  return {
    repo: { path: nuevo.repo?.path ?? '', ref: nuevo.repo?.ref || 'origin/develop' },
    entornoActivo: nuevo.entornoActivo,
    bookstackActivo: nuevo.bookstackActivo,
    entornos: (nuevo.entornos ?? []).map(({ tieneClave, ...e }) => ({
      selUser: '#user', selPass: '#passwordInput', selSubmit: 'button[type=submit]', ...e,
      clave: e.clave || prevE[e.id]?.clave || '',
    })),
    bookstacks: (nuevo.bookstacks ?? []).map(({ tieneSecret, ...b }) => ({
      ...b, tokenSecret: b.tokenSecret || prevB[b.id]?.tokenSecret || '',
    })),
  };
}
