import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { OUT } from './config.mjs';
import { claudeAsk } from './claude.mjs';
import { plantilla } from './extract.mjs';

const EJEMPLO = `<p>En <em><strong>MAESTROS </strong></em>se encuentra la opción <strong><em>ESCALA PREMIACION PUESTOS</em></strong> , el cual nos permite ver el siguiente formulario, el cual cuenta con : <br>Filtros : <br> - Periodo : Selección de periodos activos<br> - Estado : Activos o inactivos <br>Botones: <br> - Limpiar Filtros: Quita los filtros seleccionados<br> - Actualizar : Actualiza los registros de los filtros y la tabla: <br> - Nuevo Registro : Registra una nueva escala <br>{{IMG:principal}}</p>`;

export const outDir = (clave) => join(OUT, clave);

async function lanzarNavegador() {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* prueba el siguiente */ }
  }
  throw new Error('No se encontró Chrome ni Edge instalados.');
}

export function leerCodigo(repo, manual, log) {
  if (!repo.path) throw new Error('Configura la ruta del repositorio en Configuración.');
  const ref = repo.ref || 'origin/develop';
  log(`Leyendo código de ${ref} (no se toca tu carpeta de trabajo)…`);
  try { execFileSync('git', ['fetch', '-q', 'origin'], { cwd: repo.path }); } catch { log('  (no se pudo hacer git fetch, se usa lo que hay local)'); }
  const base = manual.componente.trim().replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.(html|ts)$/i, '');
  const show = (ext) => execFileSync('git', ['show', `${ref}:${base}.${ext}`], { cwd: repo.path, encoding: 'utf8', maxBuffer: 1 << 26 });
  try { return { html: show('html'), ts: show('ts') }; }
  catch { throw new Error(`No se encontró ${base}.html/.ts en ${ref}. Revisa la ruta del componente.`); }
}

export async function capturar({ manual, entorno, dir, log }) {
  const shots = [];
  log('Abriendo navegador…');
  const browser = await lanzarNavegador();
  try {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 }, locale: 'es-PE' });
    const page = await ctx.newPage();
    await page.goto(entorno.url, { waitUntil: 'networkidle' });
    if (page.url().includes('login')) {
      log(`Iniciando sesión en ${entorno.nombre} como ${entorno.usuario}…`);
      await page.fill(entorno.selUser, entorno.usuario);
      await page.fill(entorno.selPass, entorno.clave);
      await page.click(entorno.selSubmit);
      await page.waitForURL((u) => !u.href.includes('login'), { timeout: 30000 }).catch(() => { throw new Error('No se pudo iniciar sesión: revisa usuario y contraseña del entorno.'); });
    }
    log(`Abriendo ${manual.ruta}…`);
    await page.goto(`${entorno.url.replace(/\/$/, '')}/#${manual.ruta}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('p-table, .p-datatable, form, .p-toolbar', { timeout: 30000 });
    await page.waitForTimeout(1500);
    // Si una ventana emergente tiene scroll interno (formularios largos), se agranda
    // el viewport lo necesario para que salga completa. La pantalla principal no se agranda.
    const VIEW = { width: 1920, height: 1000 };
    const extraScroll = (sel) => page.evaluate((s) => {
      const raiz = s ? document.querySelector(s) : document.body;
      if (!raiz) return 0;
      let max = 0;
      for (const el of [raiz, ...raiz.querySelectorAll('*')]) {
        const oy = getComputedStyle(el).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight - el.clientHeight > 20) max = Math.max(max, el.scrollHeight - el.clientHeight);
      }
      return max;
    }, sel);
    const snap = async (id, nombre, loc) => {
      const extra = loc ? Math.min(await extraScroll('.p-dialog').catch(() => 0), 600) : 0; // la pantalla principal es solo lo que cabe en una pantalla
      if (extra) { await page.setViewportSize({ width: VIEW.width, height: VIEW.height + extra + 40 }); await page.waitForTimeout(600); }
      const file = join(dir, `${id}.png`);
      const box = loc ? await loc.boundingBox() : null;
      if (box) { // la ventana con un margen, para que no se corten bordes ni sombra
        const m = 16, x = Math.max(0, box.x - m), y = Math.max(0, box.y - m);
        await page.screenshot({ path: file, clip: { x, y, width: box.width + (box.x - x) + m, height: box.height + (box.y - y) + m } });
      } else await page.screenshot({ path: file });
      if (extra) await page.setViewportSize(VIEW);
      shots.push({ id, nombre, file: `${id}.png` });
      log(`  captura: ${nombre}`);
    };
    await snap('principal', 'Pantalla principal del formulario');
    let lista = manual.dialogos ?? [];
    const auto = !lista.length;
    if (auto) {
      // Sin ventanas definidas: se buscan solo botones que abren una ventana (nunca guardar ni confirmar).
      const textos = await page.locator('button:visible').evaluateAll((bs) => bs
        .filter((b) => !b.closest('.p-dialog, tr, td'))
        .map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()));
      const vistos = new Set();
      lista = textos
        .filter((t) => /^(nuevo|nueva|agregar|añadir|anadir|registrar|crear|copiar|duplicar)\b/i.test(t) && t.length <= 40 && !vistos.has(t) && vistos.add(t))
        .slice(0, 5)
        .map((t, i) => ({ id: `auto${i + 1}`, abrir: `button:has-text("${t.replace(/"/g, '')}")`, nombre: t }));
      // Acciones de la primera fila (iconos de PrimeNG): editar, ver detalle y eliminar (solo abre la confirmación).
      for (const [id, icono, nombre] of [['editar', 'pi-pencil', 'Editar (lápiz de la fila)'], ['ver', 'pi-eye', 'Ver detalle (ojo de la fila)'], ['eliminar', 'pi-trash', 'Eliminar (papelera de la fila)']]) {
        const abrir = `tbody tr:first-child button:has(.${icono})`;
        if (await page.locator(abrir).count()) lista.push({ id, abrir, nombre });
      }
      log(lista.length ? `  ventanas detectadas: ${lista.map((d) => d.nombre).join(', ')}` : '  no se detectaron botones de ventana');
    }
    for (const d of lista) {
      try {
        const btn = page.locator(d.abrir).first();
        if (!(await btn.count()) || !(await btn.isEnabled())) { log(`  sin captura "${d.nombre}": el botón no está disponible`); continue; }
        await btn.click();
        const dlg = page.locator('.p-dialog').first();
        await dlg.waitFor({ timeout: auto ? 5000 : 10000 });
        await page.waitForTimeout(700);
        await snap(d.id, d.nombre, dlg);
        await page.keyboard.press('Escape'); // solo se abre y se cierra: nunca se guarda nada
        await dlg.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => page.locator('.p-dialog button:has-text("Cancelar")').first().click().catch(() => {}));
        await page.waitForTimeout(300);
      } catch (e) {
        if (!auto) throw e;
        log(`  sin captura "${d.nombre}": no se abrió ninguna ventana`);
      }
    }
  } finally { await browser.close(); }
  return shots;
}

function promptClaude({ manual, html, ts, shots }) {
  return `Eres redactor de manuales de usuario del sistema SIREH. Redacta el manual del formulario "${manual.opcion}" (menú ${manual.menu}) a partir del código Angular de abajo.

REGLAS
- Responde SOLO con HTML (sin markdown, sin bloques de código, sin explicaciones).
- Mismo estilo que este ejemplo de otro manual: ${EJEMPLO}
- Describe: filtros (placeholder y qué hacen, opciones si las hay), botones (indica "si tiene permiso" cuando haya *ngIf de permisos), columnas de la tabla, y cada ventana emergente (campos, cuáles son obligatorios con *, y qué hace cada botón).
- Lenguaje para usuario final, no técnico: nada de nombres de variables, servicios ni código.
- No inventes funciones que el código no tenga.
- Pon un marcador de imagen donde corresponda: ${shots.map((s) => `{{IMG:${s.id}}} (${s.nombre})`).join(', ')}. Cada marcador va una sola vez, en su propia línea tras la sección que ilustra.

=== HTML DEL COMPONENTE ===
${html}

=== TS DEL COMPONENTE (para etiquetas de opciones, mensajes y permisos) ===
${ts.slice(0, 14000)}`;
}

/** Genera el manual y lo deja en out/<clave>/ (meta.json + capturas). No publica nada. */
export async function generar({ manual, settings, modo, log }) {
  const entorno = settings.entornos.find((e) => e.id === settings.entornoActivo);
  if (!entorno) throw new Error('Elige un entorno en Configuración.');
  const dir = outDir(manual.clave);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const { html, ts } = leerCodigo(settings.repo, manual, log);
  const shots = await capturar({ manual, entorno, dir, log });

  let cuerpo, usado = 'plantillas';
  if (modo === 'claude') {
    log('Redactando con Claude Code… (puede tardar 1-2 minutos)');
    try { cuerpo = (await claudeAsk(promptClaude({ manual, html, ts, shots }))).replace(/^```(?:html)?\s*|```\s*$/g, ''); usado = 'claude'; }
    catch (e) { log(`Claude no respondió (${e.message}). Se usa plantilla.`); }
  }
  if (!cuerpo) { log('Armando el manual con plantillas…'); cuerpo = plantilla({ html, manual, shots }); }

  const meta = { clave: manual.clave, usado, fecha: new Date().toISOString(), cuerpo, shots };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  log('Listo. Revisa la vista previa antes de publicar.');
  return meta;
}

export const leerMeta = (clave) => JSON.parse(readFileSync(join(outDir(clave), 'meta.json'), 'utf8'));

/** HTML del cuerpo con los marcadores {{IMG:id}} sustituidos por <img>. */
export function conImagenes(cuerpo, mapa) {
  return cuerpo.replace(/\{\{IMG:(\w+)\}\}/g, (_, id) =>
    mapa[id] ? `<a href="${mapa[id]}" target="_blank" rel="noopener"><img src="${mapa[id]}" alt="${id}" style="max-width:100%"></a>` : '');
}
