// Cifrado con DPAPI de Windows (la misma protección que usan Chrome/Edge para sus contraseñas).
// La clave está ligada al usuario de Windows de ESTE equipo: si el archivo se copia a otra PC u otro usuario, no se puede leer.
import { execFileSync } from 'node:child_process';

export const CIFRADO = process.platform === 'win32';
const ENTROPIA = 'ManualGen.v1'; // otras apps que usen DPAPI no pueden descifrar esto sin conocerla

const ps = (script, entrada) =>
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    input: entrada, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 1 << 26,
  }).trim();

const PRE = `Add-Type -AssemblyName System.Security; $t=[Console]::In.ReadToEnd().Trim(); $b=[Convert]::FromBase64String($t); $e=[Text.Encoding]::UTF8.GetBytes('${ENTROPIA}');`;
const PROTEGER = `${PRE} [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser'))`;
const DESPROTEGER = `${PRE} [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser'))`;

/** texto -> base64 cifrado */
export const proteger = (texto) => ps(PROTEGER, Buffer.from(texto, 'utf8').toString('base64'));
/** base64 cifrado -> texto (lanza si no es de este usuario/equipo) */
export const desproteger = (b64) => Buffer.from(ps(DESPROTEGER, b64), 'base64').toString('utf8');
