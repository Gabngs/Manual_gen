import { lanzarNavegador, iniciarSesion } from './generator.mjs';

/*
 * Grabador de pasos (macro): abre una ventana de Chrome/Edge ya con sesión iniciada en la pantalla del manual,
 * y por cada clic o campo que la persona toque en ESA ventana guarda una captura y una descripción
 * («Clic en «Nuevo Registro»»). Nunca se guardan los valores escritos (solo qué campo se tocó), ni contraseñas.
 * La grabación vive en memoria: lo que se hace fuera de esa ventana no se registra.
 */
let rec = null; // { estado: 'grabando'|'pausado'|'terminado', pasos:[{texto, png}], cola, browser, aviso, error }

/** Se inyecta en cada página: describe lo que la persona toca. Debe ser autosuficiente (se serializa). */
export function inyectado() {
  if (window.__mgOn) return;
  window.__mgOn = true;
  const ICONOS = { 'pi-pencil': 'Editar', 'pi-eye': 'Ver detalle', 'pi-trash': 'Eliminar', 'pi-plus': 'Agregar', 'pi-search': 'Buscar', 'pi-times': 'Cerrar', 'pi-check': 'Aceptar', 'pi-copy': 'Copiar', 'pi-download': 'Descargar', 'pi-upload': 'Cargar', 'pi-refresh': 'Actualizar', 'pi-filter-slash': 'Limpiar filtros', 'pi-calendar': 'Calendario' };
  const limpia = (s) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const SEL = 'button,a,[role=tab],[role=menuitem],[role=option],[role=button],[role=checkbox],li,label,th,p-checkbox,p-dropdown,p-multiselect,p-calendar,input,select,textarea';
  const etiqueta = (el) => {
    if (el.id) { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) return limpia(l.innerText).replace(/\*/g, '').trim(); }
    const cont = el.closest('.field,.p-field,.f,div');
    const l = cont?.querySelector('label');
    return limpia(el.getAttribute('aria-label')) || limpia(el.getAttribute('placeholder')) || (l ? limpia(l.innerText).replace(/\*/g, '').trim() : '');
  };
  const enviar = (e) => { try { window.__mgPaso(e); } catch { /* aún no listo */ } };
  document.addEventListener('click', (ev) => {
    const c = ev.target.closest?.(SEL) ?? ev.target;
    if (!c || c.id === '__mg') return;
    let t = limpia(c.getAttribute?.('aria-label')) || limpia(c.innerText) || limpia(c.getAttribute?.('title'));
    if (!t) {
      const k = [c, ...c.querySelectorAll('[class*="pi-"]')].flatMap((e) => [...e.classList]).find((x) => ICONOS[x]);
      t = k ? ICONOS[k] : '';
    }
    const campo = /^(input|select|textarea|p-dropdown|p-multiselect|p-calendar)$/i.test(c.tagName) ? etiqueta(c) : '';
    if (campo) return enviar({ texto: `Clic en el campo «${campo}»` });
    if (t) enviar({ texto: `Clic en «${t}»` });
  }, true);
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!/^(input|select|textarea)$/i.test(el.tagName) || el.type === 'password') return;
    const nombre = etiqueta(el);
    if (nombre) enviar({ texto: `Se completa el campo «${nombre}»` });
  }, true);
}

async function capturar(page) {
  const dlg = page.locator('.p-dialog:visible').last();
  const box = (await dlg.count()) ? await dlg.boundingBox().catch(() => null) : null;
  if (box) {
    const m = 16, x = Math.max(0, box.x - m), y = Math.max(0, box.y - m);
    return page.screenshot({ clip: { x, y, width: box.width + (box.x - x) + m, height: box.height + (box.y - y) + m } });
  }
  return page.screenshot();
}

async function agregar(page, texto, espera) {
  if (!rec || rec.estado !== 'grabando') return;
  await page.waitForTimeout(espera); // deja que la pantalla termine de reaccionar al clic
  if (!rec || rec.estado !== 'grabando') return;
  const ult = rec.pasos.at(-1);
  if (ult && ult.texto === texto && Date.now() - ult.t < 1200) return; // evento repetido
  rec.pasos.push({ texto, png: await capturar(page), t: Date.now() });
}

export async function iniciarGrabacion({ manual, entorno, log }) {
  if (rec && rec.estado !== 'terminado') throw new Error('Ya hay una grabación en curso: termínala primero.');
  rec = { estado: 'pausado', pasos: [], cola: Promise.resolve(), browser: null, aviso: '', error: '' };
  const mia = rec;
  const browser = await lanzarNavegador(false);
  mia.browser = browser;
  browser.on('disconnected', () => { mia.estado = 'terminado'; });
  try {
    const ctx = await browser.newContext({ viewport: null, locale: 'es-PE' });
    await ctx.exposeBinding('__mgPaso', ({ page }, e) => {
      mia.cola = mia.cola.then(() => agregar(page, String(e.texto).slice(0, 200), 700)).catch(() => {});
    });
    await ctx.addInitScript(inyectado);
    const page = await ctx.newPage();
    await iniciarSesion(page, entorno, log);
    log(`Abriendo ${manual.ruta}…`);
    await page.goto(`${entorno.url.replace(/\/$/, '')}/#${manual.ruta}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('p-table, .p-datatable, form, .p-toolbar', { timeout: 30000 });
    await page.waitForTimeout(1500);
    mia.estado = 'grabando';
    await agregar(page, 'Pantalla inicial del formulario', 0);
    log('Grabando: haz el flujo en la ventana que se abrió. Cada clic y campo quedará como un paso.');
  } catch (e) {
    mia.estado = 'terminado'; mia.error = e.message;
    await browser.close().catch(() => {});
    throw e;
  }
}

/** Pasos nuevos desde el índice `desde` (con su captura en base64) y el estado actual. */
export function estadoGrabacion(desde = 0) {
  if (!rec) return { estado: 'inactivo', total: 0, pasos: [] };
  return {
    estado: rec.estado, total: rec.pasos.length, aviso: rec.aviso, error: rec.error,
    pasos: rec.pasos.slice(desde).map((p) => ({ texto: p.texto, data: `data:image/png;base64,${p.png.toString('base64')}` })),
  };
}
export function pausarGrabacion(pausa) {
  if (rec && rec.estado !== 'terminado') rec.estado = pausa ? 'pausado' : 'grabando';
}
export async function terminarGrabacion() {
  if (!rec) return;
  await rec.cola.catch(() => {});
  if (rec.estado !== 'terminado') rec.estado = 'terminado';
  await rec.browser?.close().catch(() => {});
}
