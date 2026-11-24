import { lanzarNavegador, iniciarSesion, observarToasts, leerToasts, textoToasts, esperarDatos } from './generator.mjs';

/*
 * Grabador de pasos (macro): abre una ventana de Chrome/Edge ya con sesión iniciada en la pantalla del manual,
 * y por cada clic o campo que la persona toque en ESA ventana guarda una captura y una descripción
 * («Clic en «Nuevo Registro»»). Nunca se guardan los valores escritos (solo qué campo se tocó), ni contraseñas.
 * La grabación vive en memoria: lo que se hace fuera de esa ventana no se registra.
 * Además lee el DOM (inspector) de lo tocado —p. ej. el interruptor «Activo» y su columna— y observa las peticiones
 * de red (PUT/POST/PATCH/DELETE) que dispara cada clic: si van a la API de esta pantalla, el paso queda confirmado
 * como parte del manual («el sistema envió PUT …»).
 */
const MUTA = /^(PUT|POST|PATCH|DELETE)$/;
const RUIDO = /login|logout|auth|token|session|refresh|telemetr|analytic|track|heartbeat|\/pings?(\/|$)|\/logs?(\/|$)/i;
const GENERICO = /^(api|v\d+|rest|service|services|web|app)$/i;
const segmentos = (ruta) => ruta.split('/').filter((x) => x.length > 2 && !/^\d+$/.test(x) && !/^[0-9a-f-]{20,}$/i.test(x) && !GENERICO.test(x)).map((x) => x.toLowerCase());
const sinIds = (ruta) => ruta.replace(/\/(\d+|[0-9a-f]{8}-[0-9a-f-]{27})(?=\/|$)/gi, '/{id}');

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
  const enviar = (e) => { try { window.__mgPaso({ ...e, t: Date.now() }); } catch { /* aún no listo */ } };
  const SW = 'p-inputswitch,.p-inputswitch,p-toggleswitch,.p-toggleswitch,p-toggle-switch,[role=switch]';
  // Interruptor (Activo/Inactivo): lee el estado y el nombre de su columna en el DOM.
  const interruptor = (ev) => {
    const sw = ev.target.closest?.(SW);
    if (!sw) return null;
    const inp = sw.matches('input') ? sw : sw.querySelector('input');
    const marcado = (el) => inp ? inp.checked : (/-checked(\s|$)/.test(el.className) || el.getAttribute('aria-checked') === 'true');
    const nuevo = inp && ev.target === inp ? inp.checked : !marcado(sw); // en un checkbox nativo el clic ya lo cambió
    let nombre = '';
    const td = sw.closest('td');
    if (td) { const ths = td.closest('table')?.querySelectorAll('thead th'); nombre = limpia(ths?.[td.cellIndex]?.innerText).replace(/[↑↓]/g, '').trim(); }
    if (!nombre) nombre = limpia(sw.getAttribute('aria-label')) || etiqueta(inp ?? sw);
    return { nombre: nombre || 'Activo', nuevo, enFila: !!td };
  };
  document.addEventListener('click', (ev) => {
    const s = interruptor(ev);
    if (s) return enviar({ texto: `Se ${s.nuevo ? 'activa' : 'desactiva'} el interruptor «${s.nombre}»${s.enFila ? ' de un registro de la tabla' : ''}`, red: true });
    const c = ev.target.closest?.(SEL) ?? ev.target;
    if (!c || c.id === '__mg') return;
    let t = limpia(c.getAttribute?.('aria-label')) || limpia(c.innerText) || limpia(c.getAttribute?.('title'));
    if (!t) {
      const k = [c, ...c.querySelectorAll('[class*="pi-"]')].flatMap((e) => [...e.classList]).find((x) => ICONOS[x]);
      t = k ? ICONOS[k] : '';
    }
    const campo = /^(input|select|textarea|p-dropdown|p-multiselect|p-calendar)$/i.test(c.tagName) ? etiqueta(c) : '';
    if (campo) return enviar({ texto: `Clic en el campo «${campo}»` });
    if (t) enviar({ texto: `Clic en «${t}»`, red: /^(guardar|aceptar|si|sí|confirmar|eliminar|registrar|actualizar|copiar|crear|agregar)(\s|$)/i.test(t) });
  }, true);
  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (!/^(input|select|textarea)$/i.test(el.tagName) || el.type === 'password' || el.closest(SW)) return;
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

/** Peticiones de escritura que disparó el clic (desde `desde`) y que van a la API de esta pantalla. */
function peticionesDelPaso(desde) {
  const out = [];
  for (const r of rec.red) {
    if (r.usada || r.t < desde || !MUTA.test(r.metodo) || RUIDO.test(r.url.pathname)) continue;
    if (!rec.apis.has(r.url.origin)) continue; // no es la API de esta aplicación
    r.usada = true;
    const rel = segmentos(r.url.pathname).some((x) => rec.recursos.has(x));
    out.push({ metodo: r.metodo, ruta: sinIds(r.url.pathname), estado: r.estado, relacionada: rel });
  }
  return out;
}

async function agregar(page, texto, espera, desde = 0, red = false) {
  if (!rec || rec.estado !== 'grabando') return;
  await page.waitForTimeout(espera); // deja que la pantalla termine de reaccionar al clic
  if (red) await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {}); // da tiempo a que salga el PUT/POST
  // La captura solo se toma con la pantalla cargada y con datos (hasta 8 s de espera).
  const datos = await esperarDatos(page, 8000);
  // Mensajes emergentes (toast) que dejó este paso; si se espera una escritura, se les da hasta 2,5 s para aparecer.
  const desdeToast = Math.max(desde - 300, rec?.ultToast ?? 0);
  let toasts = await leerToasts(page, desdeToast);
  for (let i = 0; red && !toasts.length && i < 5; i++) { await page.waitForTimeout(500); toasts = await leerToasts(page, desdeToast); }
  if (toasts.length) rec.ultToast = toasts.at(-1).t + 1;
  if (!rec || rec.estado !== 'grabando') return;
  const ult = rec.pasos.at(-1);
  if (ult && ult.base === texto && Date.now() - ult.t < 1200) return; // evento repetido
  const peticiones = desde ? peticionesDelPaso(desde - 300) : [];
  const ok = peticiones.filter((p) => p.estado < 400);
  const p0 = ok.find((p) => p.relacionada) ?? ok[0];
  const fallo = peticiones.find((p) => p.estado >= 400);
  let nota = texto;
  if (p0) nota += ` · confirmado por el sistema: se envió ${p0.metodo} ${p0.ruta} (respuesta ${p0.estado})${p0.relacionada ? '' : ' [API de la aplicación, sin coincidir con el nombre de la pantalla]'}`;
  else if (fallo) nota += ` · el sistema respondió con error ${fallo.estado} a ${fallo.metodo} ${fallo.ruta}: la acción no se guardó`;
  if (toasts.length) {
    nota += ` · el sistema mostró el mensaje ${textoToasts(toasts)}`;
    if (toasts.some((t) => t.sev === 'error')) nota += ': la acción no se completó';
  }
  if (!datos.ok && /tabla/.test(datos.motivo)) nota += ' · en esta captura la tabla aparece sin datos';
  rec.pasos.push({ texto: nota, base: texto, png: await capturar(page), t: Date.now(), peticiones });
}

export async function iniciarGrabacion({ manual, entorno, log }) {
  if (rec && rec.estado !== 'terminado') throw new Error('Ya hay una grabación en curso: termínala primero.');
  rec = { estado: 'pausado', pasos: [], cola: Promise.resolve(), browser: null, aviso: '', error: '', red: [], apis: new Set(), recursos: new Set() };
  const mia = rec;
  const browser = await lanzarNavegador(false);
  mia.browser = browser;
  browser.on('disconnected', () => { mia.estado = 'terminado'; });
  try {
    const ctx = await browser.newContext({ viewport: null, locale: 'es-PE' });
    await ctx.exposeBinding('__mgPaso', ({ page }, e) => {
      mia.cola = mia.cola.then(() => agregar(page, String(e.texto).slice(0, 200), 700, Number(e.t) || Date.now(), !!e.red)).catch(() => {});
    });
    await ctx.addInitScript(inyectado);
    await ctx.addInitScript(observarToasts);
    // Peticiones XHR/fetch: mientras carga la pantalla se aprende cuál es su API; luego se vigilan las de escritura.
    ctx.on('request', (rq) => {
      if (!['xhr', 'fetch'].includes(rq.resourceType())) return;
      let u; try { u = new URL(rq.url()); } catch { return; }
      if (!mia.listo) { mia.apis.add(u.origin); if (rq.method() === 'GET') segmentos(u.pathname).forEach((x) => mia.recursos.add(x)); return; }
      mia.red.push({ t: Date.now(), metodo: rq.method(), url: u, rq, estado: 0 });
      if (mia.red.length > 300) mia.red.shift();
    });
    ctx.on('response', (rs) => { const e = mia.red.findLast((x) => x.rq === rs.request()); if (e) e.estado = rs.status(); });
    const page = await ctx.newPage();
    await iniciarSesion(page, entorno, log);
    log(`Abriendo ${manual.ruta}…`);
    await page.goto(`${entorno.url.replace(/\/$/, '')}/#${manual.ruta}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('p-table, .p-datatable, form, .p-toolbar', { timeout: 30000 });
    await page.waitForTimeout(1500);
    mia.listo = true;
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
