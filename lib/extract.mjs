// Modo "plantillas": arma el manual leyendo el HTML del componente Angular (sin IA).

const DESC = [
  [/actualizar|refrescar|recargar/i, 'Actualiza los registros de los filtros y la tabla'],
  [/limpiar/i, 'Quita los filtros seleccionados'],
  [/nuevo|crear|agregar|añadir/i, 'Registra un nuevo elemento'],
  [/copiar/i, 'Copia la información de un periodo a otro'],
  [/exportar|descargar|excel/i, 'Descarga la información en un archivo'],
  [/importar|cargar/i, 'Carga información desde un archivo'],
  [/buscar|filtrar/i, 'Aplica la búsqueda con los filtros indicados'],
  [/cancelar|cerrar/i, 'Cierra la ventana sin guardar'],
  [/guardar|aceptar/i, 'Guarda la información ingresada'],
  [/eliminar|borrar/i, 'Elimina el registro'],
  [/editar|modificar/i, 'Permite modificar el registro'],
];
const describir = (txt) => DESC.find(([re]) => re.test(txt))?.[1] ?? '';

const interp = (s) => s.replace(/\{\{([^}]*)\}\}/g, (_, e) => [...e.matchAll(/'([^']+)'/g)].map((x) => x[1]).join(' / '));
const strip = (s) => interp(s).replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const uniq = (a) => [...new Set(a)];
const conPermiso = (tag) => /ngIf="[^"]*(hasPermission|Permission)/i.test(tag) ? ' (si tiene permiso)' : '';
const li = (items) => items.map((i) => ` - ${i}`).join('<br>');

function botones(sec) {
  const out = [];
  for (const m of sec.matchAll(/<button\b[^>]*>/g)) {
    const t = m[0];
    const label = attr(t, 'label');
    const tip = attr(t, 'pTooltip');
    const nombre = label || tip;
    if (!nombre || /^\{\{/.test(nombre)) continue;
    const d = describir(nombre);
    out.push(`${nombre}${conPermiso(t)}${d ? `: ${d}` : ''}`);
  }
  return uniq(out);
}

function seccionDialogo(raw) {
  const tag = raw.match(/^[^>]*>/)?.[0] ?? '';
  const body = raw;
  let titulo = attr(tag, 'header');
  if (!titulo) titulo = strip(body.match(/<span[^>]*font-bold[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '');
  const campos = uniq(
    [...body.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/g)].map((m) => {
      const obligatorio = /\*/.test(m[1]);
      const t = strip(m[1]).replace(/\*/g, '').trim();
      return t ? `${t}${obligatorio ? ' *' : ''}` : '';
    }).filter(Boolean),
  );
  const msg = strip(body.match(/<p\b[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '');
  const bts = botones(body);
  let h = `<p><strong>${titulo || 'Ventana emergente'}</strong>`;
  if (msg.length > 15) h += `<br>${msg}`;
  if (campos.length) h += `<br>Campos (* obligatorio): <br>${li(campos)}`;
  if (bts.length) h += `<br>Botones: <br>${li(bts)}`;
  return h + '</p>';
}

export function plantilla({ html, manual, shots }) {
  const iDlg = html.indexOf('<p-dialog');
  const main = iDlg < 0 ? html : html.slice(0, iDlg);
  const dialogos = iDlg < 0 ? [] : html.slice(iDlg).split(/(?=<p-dialog\b)/).filter((x) => x.startsWith('<p-dialog'));

  const filtros = uniq([
    ...[...main.matchAll(/<p-(?:dropdown|multiSelect|calendar|autoComplete|inputNumber)\b[^>]*>/gi)].map((m) => attr(m[0], 'placeholder')),
    ...[...main.matchAll(/<input\b[^>]*>/g)].map((m) => attr(m[0], 'placeholder')),
  ].filter(Boolean));
  const botonesMain = botones(main);
  const columnas = uniq([...main.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/g)].map((m) => strip(m[1])).filter(Boolean));
  const vacio = strip(main.match(/emptymessage[\s\S]*?<td[^>]*>([\s\S]*?)<\/td>/)?.[1] ?? '');
  const hayImg = (id) => (shots.some((s) => s.id === id) ? `<br>{{IMG:${id}}}` : '');

  let h = `<p>En <em><strong>${manual.menu} </strong></em>se encuentra la opción <strong><em>${manual.opcion}</em></strong>, el cual nos permite ver el siguiente formulario, el cual cuenta con: `;
  if (filtros.length) h += `<br>Filtros: <br>${li(filtros.map((f) => `${f}: Selección o ingreso del filtro`))}`;
  if (botonesMain.length) h += `<br>Botones: <br>${li(botonesMain)}`;
  h += `${hayImg('principal')}</p>`;
  if (columnas.length)
    h += `<p>La tabla muestra las columnas: <br>${li(columnas)}${vacio ? `<br>Si no hay resultados se muestra: "${vacio}"` : ''}</p>`;
  for (const d of dialogos) h += seccionDialogo(d);
  const extra = shots.filter((s) => s.id !== 'principal');
  if (extra.length) h += `<p><strong>Capturas de las ventanas</strong></p>` + extra.map((s) => `<p>${s.nombre}<br>{{IMG:${s.id}}}</p>`).join('');
  return h;
}
