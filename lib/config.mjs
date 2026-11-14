import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isSea, getAsset } from 'node:sea';
// En el .exe (Node SEA) los archivos de la interfaz viajan embebidos como "assets".
export const SEA = isSea();
const srcDir = SEA ? '' : typeof __dirname !== 'undefined' ? __dirname : dirname(fileURLToPath(import.meta.url));
// ROOT: donde se guardan datos y salidas. En el .exe es la carpeta donde está el ejecutable.
export const ROOT = SEA ? dirname(process.execPath) : join(srcDir, '..');
export const asset = (name) =>
  SEA ? getAsset(name, 'utf8') : readFileSync(join(ROOT, name === 'manuales.default.json' ? '' : 'public', name), 'utf8');
export const DATA = join(ROOT, 'data');
export const OUT = join(ROOT, 'out');
const SETTINGS = join(DATA, 'settings.json');
const MANUALES = join(DATA, 'manuales.json');

mkdirSync(DATA, { recursive: true });
mkdirSync(OUT, { recursive: true });
if (!existsSync(MANUALES)) writeFileSync(MANUALES, asset('manuales.default.json'));

const DEFAULT_SETTINGS = {
  repo: { path: '', ref: 'origin/develop' },
  entornoActivo: '',
  entornos: [],
  bookstackActivo: '',
  bookstacks: [],
};

export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...(existsSync(SETTINGS) ? JSON.parse(readFileSync(SETTINGS, 'utf8')) : {}) });
export const saveSettings = (s) => writeFileSync(SETTINGS, JSON.stringify(s, null, 2));
export const loadManuales = () => JSON.parse(readFileSync(MANUALES, 'utf8'));
export const saveManuales = (m) => writeFileSync(MANUALES, JSON.stringify(m, null, 2));

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
