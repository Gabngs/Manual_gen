import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, APP_HOME } from './config.mjs';
import { preguntarIA } from './ia.mjs';
import { plantilla, apertura } from './extract.mjs';

const EJEMPLO = `<p>En <em><strong>MAESTROS </strong></em>se encuentra la opción <strong><em>ESCALA PREMIACION PUESTOS</em></strong> , el cual nos permite ver el siguiente formulario, el cual cuenta con : <br>Filtros : <br> - Periodo : Selección de periodos activos<br> - Estado : Activos o inactivos <br>Botones: <br> - Limpiar Filtros: Quita los filtros seleccionados<br> - Actualizar : Actualiza los registros de los filtros y la tabla: <br> - Nuevo Registro : Registra una nueva escala <br>{{IMG:principal}}</p>`;

export const outDir = (clave) => join(OUT, clave);

/** Se inyecta en cada página (debe ser autosuficiente): anota los mensajes emergentes (toast de PrimeNG) que aparecen. */
export function observarToasts() {
  if (window.__mgToasts) return;
  window.__mgToasts = [];
  const sev = (c) => (/error|danger/.test(c) ? 'error' : /warn/.test(c) ? 'advertencia' : /success/.test(c) ? 'éxito' : 'información');
  const iniciar = () => new MutationObserver((ms) => {
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      for (const el of n.matches('.p-toast-message') ? [n] : [...n.querySelectorAll('.p-toast-message')]) {
        const txt = [el.querySelector('.p-toast-summary'), el.querySelector('.p-toast-detail')].map((x) => (x?.innerText || '').trim()).filter(Boolean).join(': ') || (el.innerText || '').trim();
        if (txt) window.__mgToasts.push({ t: Date.now(), sev: sev(String(el.className)), txt: txt.slice(0, 200) });
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  if (document.documentElement) iniciar(); else document.addEventListener('DOMContentLoaded', iniciar);
}
/** Mensajes emergentes que salieron desde `desde` (ms epoch). */
export const leerToasts = (page, desde = 0) => page.evaluate((d) => (window.__mgToasts ?? []).filter((x) => x.t >= d), desde).catch(() => []);
export const textoToasts = (ts) => ts.map((t) => `«${t.txt}» (${t.sev})`).join(', ');

const CARGANDO = '.p-progress-spinner, p-progressspinner, p-progress-spinner, .p-datatable-loading-overlay, .p-datatable-loading-icon, .p-skeleton, .p-blockui, mat-spinner, .spinner, .loading';
/**
 * Espera a que la pantalla termine de cargar y a que las tablas visibles tengan datos (no «Seleccione un período»,
 * «Sin registros», etc.). Devuelve { ok, motivo }: nunca lanza. Se estabiliza dos lecturas seguidas.
 */
export async function esperarDatos(page, ms = 15000) {
  const fin = Date.now() + ms;
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  let motivo = '', buenas = 0;
  while (Date.now() < fin) {
    const e = await page.evaluate((sel) => {
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      if ([...document.querySelectorAll(sel)].some(vis)) return 'la pantalla sigue cargando';
      const VACIO = /selecci[oó]n|no hay|sin (datos|resultados|registros)|no se encontr|vac[ií]o/i;
      const tablas = [...document.querySelectorAll('.p-datatable')].filter(vis);
      const vacias = tablas.filter((t) => ![...t.querySelectorAll('tbody tr')].some((tr) => !tr.matches('.p-datatable-emptymessage, .p-datatable-empty-message') && !(tr.cells.length === 1 && VACIO.test(tr.innerText))));
      return vacias.length ? 'la tabla no muestra datos' : '';
    }, CARGANDO).catch(() => 'no se pudo leer la pantalla');
    if (!e) { if (++buenas >= 2) return { ok: true, motivo: '' }; } else { buenas = 0; motivo = e; }
    await page.waitForTimeout(350);
  }
  return { ok: false, motivo: motivo || 'sin datos' };
}

/** Reglas comunes a los prompts: mensajes emergentes, datos y el contexto libre que escribe la persona para este formulario. */
const reglasExtra = (manual) => `- Si en una captura se ve un mensaje emergente (toast) o una nota dice «el sistema mostró el mensaje…», cita ese mensaje textual entre comillas como resultado de la acción (éxito, advertencia o error). Un mensaje de error significa que la acción NO se completó: no la describas como exitosa.
- Describe solo lo que se ve con datos cargados; no presentes una tabla vacía como si tuviera datos ni inventes filas.${manual.contexto?.trim() ? `
- CONTEXTO DADO POR LA PERSONA para este formulario (tiene prioridad sobre las reglas anteriores, salvo la de no inventar; síguelo al pie de la letra, por ejemplo cómo organizar el manual o qué casos cubrir):
${manual.contexto.trim()}` : ''}`;

const FETCHADO = new Map(); // ruta del repo -> última vez que se hizo git fetch (evita repetirlo en cada generación)

export async function lanzarNavegador(headless = true) {
  for (const channel of ['chrome', 'msedge']) {
    try { return await chromium.launch({ channel, headless, ...(headless ? {} : { args: ['--start-maximized'] }) }); } catch { /* prueba el siguiente */ }
  }
  throw new Error('No se encontró Chrome ni Edge instalados.');
}

/** Abre el entorno y, si pide login, inicia sesión con las credenciales guardadas. */
export async function iniciarSesion(page, entorno, log) {
  await page.goto(entorno.url, { waitUntil: 'networkidle' });
  if (page.url().includes('login')) {
    log(`Iniciando sesión en ${entorno.nombre} como ${entorno.usuario}…`);
    await page.fill(entorno.selUser, entorno.usuario);
    await page.fill(entorno.selPass, entorno.clave);
    await page.click(entorno.selSubmit);
    await page.waitForURL((u) => !u.href.includes('login'), { timeout: 30000 }).catch(() => { throw new Error('No se pudo iniciar sesión: revisa usuario y contraseña del entorno.'); });
  }
}

export function leerCodigo(repo, manual, log) {
  if (!repo.path) throw new Error('Configura la ruta del repositorio en Configuración.');
  const ref = repo.ref || 'origin/develop';
  log(`Leyendo código de ${ref} (no se toca tu carpeta de trabajo)…`);
  if (Date.now() - (FETCHADO.get(repo.path) ?? 0) > 120000) {
    try { execFileSync('git', ['fetch', '-q', 'origin'], { cwd: repo.path, timeout: 45000 }); FETCHADO.set(repo.path, Date.now()); } catch { log('  (no se pudo hacer git fetch, se usa lo que hay local)'); }
  }
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
    await ctx.addInitScript(observarToasts);
    const page = await ctx.newPage();
    await iniciarSesion(page, entorno, log);
    log(`Abriendo ${manual.ruta}…`);
    await page.goto(`${entorno.url.replace(/\/$/, '')}/#${manual.ruta}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('p-table, .p-datatable, form, .p-toolbar', { timeout: 30000 });
    await page.waitForTimeout(1500);
    const t0 = Date.now() - 20000; // incluye los mensajes emergentes que salieron al abrir la pantalla
    if (manual.pestana) {
      log(`Abriendo la pestaña "${manual.pestana}"…`);
      const tab = page.locator('[role=tab], .p-tabview-nav a').filter({ hasText: manual.pestana }).first();
      if (!(await tab.count())) throw new Error(`No se encontró la pestaña "${manual.pestana}" en la pantalla.`);
      await tab.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(1500);
    }
    {
      log('Esperando a que carguen los datos…');
      const d = await esperarDatos(page);
      const errores = (await leerToasts(page, t0)).filter((t) => t.sev === 'error');
      if (errores.length) throw new Error(`El sistema mostró un error al cargar la pantalla: ${textoToasts(errores)}. No se toman capturas así.`);
      if (!d.ok) throw new Error(`La pantalla principal no muestra datos (${d.motivo}), así que no se toma la captura. Si necesita elegir un filtro antes (p. ej. un período), usa «Grabar pasos» o «Subir imágenes».`);
    }
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
    const snap = async (id, nombre, loc, desde = t0) => {
      const toasts = await leerToasts(page, desde);
      const extra = loc ? Math.min(await extraScroll('.p-dialog').catch(() => 0), 600) : 0; // la pantalla principal es solo lo que cabe en una pantalla
      if (extra) { await page.setViewportSize({ width: VIEW.width, height: VIEW.height + extra + 40 }); await page.waitForTimeout(600); }
      const file = join(dir, `${id}.png`);
      const box = loc ? await loc.boundingBox() : null;
      if (box) { // la ventana con un margen, para que no se corten bordes ni sombra
        const m = 16, x = Math.max(0, box.x - m), y = Math.max(0, box.y - m);
        await page.screenshot({ path: file, clip: { x, y, width: box.width + (box.x - x) + m, height: box.height + (box.y - y) + m } });
      } else await page.screenshot({ path: file });
      if (extra) await page.setViewportSize(VIEW);
      shots.push({ id, nombre, file: `${id}.png`, ...(toasts.length ? { toasts: textoToasts(toasts) } : {}) });
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
        const tClick = Date.now();
        await btn.click();
        const dlg = page.locator('.p-dialog').first();
        await dlg.waitFor({ timeout: auto ? 5000 : 10000 });
        await page.waitForTimeout(700);
        const dd = await esperarDatos(page, 8000);
        if (!dd.ok && !/tabla/.test(dd.motivo)) { log(`  sin captura "${d.nombre}": ${dd.motivo}`); await page.keyboard.press('Escape'); await page.waitForTimeout(300); continue; }
        await snap(d.id, d.nombre, dlg, tClick);
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
  return `Eres redactor de manuales de usuario del sistema SIREH. Redacta el manual del formulario "${manual.opcion}" (menú ${manual.menu}${manual.dentro_de ? `, dentro de ${manual.dentro_de}` : ''}${manual.pestana ? `, pestaña ${manual.pestana}` : ''}) a partir del código Angular de abajo.

REGLAS
- Responde SOLO con HTML (sin markdown, sin bloques de código, sin explicaciones).
- La primera frase debe ser EXACTAMENTE esta apertura (sin llamarlo "submenú"; sigue con ", el cual nos permite ver el siguiente formulario…"): ${apertura(manual)}
- Mismo estilo que este ejemplo de otro manual: ${EJEMPLO}
- Describe: filtros (placeholder y qué hacen, opciones si las hay), botones (indica "si tiene permiso" cuando haya *ngIf de permisos), columnas de la tabla, y cada ventana emergente (campos, cuáles son obligatorios con *, y qué hace cada botón).
- Lenguaje para usuario final, no técnico: nada de nombres de variables, servicios ni código.
${reglasExtra(manual)}
- No inventes funciones que el código no tenga.
- Pon un marcador de imagen donde corresponda: ${shots.map((s) => `{{IMG:${s.id}}} (${s.nombre}${s.toasts ? `; mensaje que mostró el sistema: ${s.toasts}` : ''})`).join(', ')}. Cada marcador va una sola vez, en su propia línea tras la sección que ilustra.

=== HTML DEL COMPONENTE ===
${html}

=== TS DEL COMPONENTE (para etiquetas de opciones, mensajes y permisos) ===
${ts.slice(0, 14000)}`;
}

// ---------- capturas subidas a mano ----------
const SUBIDAS = join(APP_HOME, 'subidas');
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MIME_EXT = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
export const mimeDe = (file) => MIME_EXT[file.split('.').pop().toLowerCase()] ?? 'image/png';

/** Guarda las capturas recibidas (en el orden indicado) en una carpeta de paso; luego las toma generar(). */
export function guardarSubidas(clave, imagenes) {
  if (!Array.isArray(imagenes) || !imagenes.length) throw new Error('Añade al menos una captura.');
  const dir = join(SUBIDAS, clave);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const lista = imagenes.map((im, i) => {
    const m = /^data:(image\/(?:png|jpeg|webp));base64,(.+)$/.exec(im.data ?? '');
    if (!m) throw new Error(`La captura ${i + 1} no es una imagen PNG, JPG o WebP.`);
    const file = `sub${i + 1}.${EXT[m[1]]}`;
    writeFileSync(join(dir, file), Buffer.from(m[2], 'base64'));
    return { id: `sub${i + 1}`, file, nombre: String(im.nota ?? '').trim().slice(0, 300) || `Captura ${i + 1}` };
  });
  writeFileSync(join(dir, 'lista.json'), JSON.stringify(lista));
  return lista.length;
}
function tomarSubidas(clave, dir) {
  let lista;
  try { lista = JSON.parse(readFileSync(join(SUBIDAS, clave, 'lista.json'), 'utf8')); }
  catch { throw new Error('No hay capturas subidas para este formulario: súbelas y vuelve a generar.'); }
  for (const s of lista) copyFileSync(join(SUBIDAS, clave, s.file), join(dir, s.file));
  rmSync(join(SUBIDAS, clave), { recursive: true, force: true }); // las imágenes quedan solo en out/<clave>
  return lista;
}

function promptCapturas({ manual, codigo, shots }) {
  return `Eres redactor de manuales de usuario del sistema SIREH. Redacta el manual del formulario "${manual.opcion}" (menú ${manual.menu}${manual.dentro_de ? `, dentro de ${manual.dentro_de}` : ''}${manual.pestana ? `, pestaña ${manual.pestana}` : ''}) a partir de las CAPTURAS DE PANTALLA adjuntas${codigo ? ' y del código Angular' : ''}.

REGLAS
- Responde SOLO con HTML (sin markdown, sin bloques de código, sin explicaciones).
- La primera frase debe ser EXACTAMENTE esta apertura (sin llamarlo "submenú"; sigue con ", el cual nos permite ver el siguiente formulario…"): ${apertura(manual)}
- Mismo estilo que este ejemplo de otro manual: ${EJEMPLO}
- Las capturas van EN ORDEN y cada una es un paso o pantalla del flujo. Descríbelas en ese orden: filtros, botones, columnas de la tabla, ventanas emergentes (campos, cuáles son obligatorios con *, y qué hace cada botón), según lo que se VE en cada imagen.
- Si una nota dice «confirmado por el sistema: se envió PUT/POST…», esa acción realmente guardó el cambio: descríbela como parte del manual (p. ej. activar o desactivar un registro con el interruptor «Activo»). NUNCA menciones la petición, rutas ni métodos. Si dice que el sistema respondió con error, no la describas como una acción que funcione.
- Lenguaje para usuario final, no técnico.
${reglasExtra(manual)}
- No inventes nada que no se vea en las capturas${codigo ? ' o no esté en el código' : ''}. Si algo no se distingue bien, no lo menciones.
- Pon el marcador de cada imagen una sola vez, en su propia línea, tras el texto que la explica. Capturas (en orden):
${shots.map((s, i) => `  ${i + 1}. {{IMG:${s.id}}}${/^Captura \d+$/.test(s.nombre) ? '' : ` — nota de la persona: ${s.nombre}`}`).join('\n')}
${codigo ? `
=== HTML DEL COMPONENTE ===
${codigo.html}

=== TS DEL COMPONENTE (para etiquetas de opciones, mensajes y permisos) ===
${codigo.ts.slice(0, 14000)}` : ''}`;
}

function plantillaCapturas({ manual, shots }) {
  return `<p>${apertura(manual)}, el cual nos permite ver el siguiente formulario:</p>` + shots.map((s) => `<p>${/^Captura \d+$/.test(s.nombre) ? '' : `${s.nombre}<br>`}{{IMG:${s.id}}}</p>`).join('');
}

/** Genera el manual y lo deja en out/<clave>/ (meta.json + capturas). No publica nada. */
export async function generar({ manual, settings, modo, ia, origen, log }) {
  const subidas = origen === 'subidas';
  const entorno = settings.entornos.find((e) => e.id === settings.entornoActivo);
  if (!subidas && !entorno) throw new Error('Elige un entorno en Configuración.');
  const dir = outDir(manual.clave);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let codigo = null, shots;
  if (subidas) {
    shots = tomarSubidas(manual.clave, dir);
    log(`Usando ${shots.length} captura(s) subida(s), en el orden indicado.`);
    if (settings.repo.path && manual.componente) {
      try { codigo = leerCodigo(settings.repo, manual, log); } catch (e) { log(`  sin código del componente (${e.message}); se usan solo las capturas.`); }
    }
  } else {
    codigo = leerCodigo(settings.repo, manual, log);
    shots = await capturar({ manual, entorno, dir, log });
  }

  let cuerpo, usado = 'plantillas';
  if (modo === 'ia' && ia) {
    log(`Redactando con ${ia}… (puede tardar 1-2 minutos)`);
    try {
      const prompt = subidas ? promptCapturas({ manual, codigo, shots }) : promptClaude({ manual, html: codigo.html, ts: codigo.ts, shots });
      const imgs = subidas ? shots.map((s) => ({ id: s.id, path: join(dir, s.file) })) : [];
      cuerpo = (await preguntarIA(ia, prompt, imgs)).replace(/^```(?:html)?\s*|```\s*$/g, '');
      usado = ia;
    } catch (e) { log(`La IA no respondió (${e.message}). Se usa plantilla.`); }
  }
  if (!cuerpo) { log('Armando el manual con plantillas…'); cuerpo = codigo ? plantilla({ html: codigo.html, manual, shots }) : plantillaCapturas({ manual, shots }); }

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
