// Empaqueta la app en un único .exe: esbuild (un solo .cjs) + Node SEA (Node embebido + assets).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, rmSync, mkdirSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist', { recursive: true });

await build({
  entryPoints: ['server.mjs'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: 'dist/server.cjs',
  external: ['electron', 'chromium-bidi/*'],
  logLevel: 'error',
});

execFileSync(process.execPath, ['--experimental-sea-config', 'sea-config.json'], { stdio: 'inherit' });
const exe = process.platform === 'win32' ? 'dist/ManualGen.exe' : 'dist/ManualGen';
copyFileSync(process.execPath, exe);
execFileSync(
  process.execPath,
  [
    'node_modules/postject/dist/cli.js', exe, 'NODE_SEA_BLOB', 'dist/sea.blob',
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ],
  { stdio: 'inherit' },
);
console.log(`Listo: ${exe}`);
