import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { leerMeta, outDir, lanzarNavegador, mimeDe } from './generator.mjs';

/*
 * Exporta el manual generado (out/<clave>/meta.json + capturas) a PDF o Word (.docx).
 * Sin dependencias nuevas: el PDF lo imprime Chrome/Edge (Playwright) y el .docx se arma a mano (zip + OOXML).
 */

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const deshacer = (s) => s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
  return ENT[e.toLowerCase()] ?? m;
});
const xml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

// ---------- PDF ----------
function htmlConImagenes(meta, clave, titulo) {
  const cuerpo = meta.cuerpo.replace(/\{\{IMG:(\w+)\}\}/g, (_, id) => {
    const s = meta.shots.find((x) => x.id === id);
    if (!s) return '';
    const b64 = readFileSync(join(outDir(clave), s.file)).toString('base64');
    return `<img src="data:${mimeDe(s.file)};base64,${b64}" alt="${xml(s.nombre)}">`;
  });
  return `<!doctype html><html lang="es"><meta charset="utf-8"><title>${xml(titulo)}</title><style>
body{font:11pt/1.55 "Segoe UI",system-ui,sans-serif;color:#1d2433;margin:0}
h1{font-size:20pt;margin:0 0 14pt;padding-bottom:8pt;border-bottom:2px solid #0f9d8a;color:#0b6b5e}
img{display:block;max-width:100%;border:1px solid #d9dee8;border-radius:4px;margin:8pt 0;break-inside:avoid}
p{margin:0 0 10pt}
</style><h1>${xml(titulo)}</h1>${cuerpo}</html>`;
}

export async function exportarPdf(clave, titulo) {
  const meta = leerMeta(clave);
  const browser = await lanzarNavegador(true);
  try {
    const page = await browser.newPage();
    await page.setContent(htmlConImagenes(meta, clave, titulo), { waitUntil: 'load' });
    return await page.pdf({ format: 'A4', printBackground: true, margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' } });
  } finally { await browser.close(); }
}

// ---------- Word (.docx) ----------
/** Convierte el HTML sencillo del manual en párrafos: { runs:[{t,b,i,br,img}], titulo? }. */
function aParrafos(html) {
  const pars = [];
  let runs = [], b = 0, i = 0, tit = 0, li = false;
  const cierra = () => {
    while (runs.length && runs.at(-1).br) runs.pop();
    if (runs.length) pars.push({ runs, titulo: tit, vineta: li });
    runs = []; li = false;
  };
  for (const tk of html.match(/<!--[\s\S]*?-->|<\/?[a-z][a-z0-9]*[^>]*>|\{\{IMG:\w+\}\}|[^<{]+|[<{]/gi) ?? []) {
    let m;
    if ((m = /^\{\{IMG:(\w+)\}\}$/.exec(tk))) { cierra(); pars.push({ runs: [{ img: m[1] }] }); continue; }
    if (tk[0] === '<' && tk.length > 1) {
      const t = /^<(\/?)([a-z0-9]+)/i.exec(tk);
      if (!t) continue;
      const fin = !!t[1], tag = t[2].toLowerCase();
      if (tag === 'strong' || tag === 'b') b += fin ? -1 : 1;
      else if (tag === 'em' || tag === 'i') i += fin ? -1 : 1;
      else if (tag === 'br') runs.push({ br: true });
      else if (/^h[1-6]$/.test(tag)) { cierra(); tit = fin ? 0 : 1; b += fin ? -1 : 1; }
      else if (tag === 'li') { cierra(); li = !fin; }
      else if (['p', 'div', 'ul', 'ol', 'table', 'tr'].includes(tag)) cierra();
      continue;
    }
    const txt = deshacer(tk).replace(/\s+/g, ' ');
    if (txt.trim() || (runs.length && !runs.at(-1).br)) runs.push({ t: txt, b: b > 0, i: i > 0 });
  }
  cierra();
  return pars;
}

function dimensiones(buf) {
  try {
    if (buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf[0] === 0xff && buf[1] === 0xd8) { // JPEG: busca el marcador SOFn
      let p = 2;
      while (p < buf.length) {
        if (buf[p] !== 0xff) { p++; continue; }
        const mk = buf[p + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
        p += 2 + buf.readUInt16BE(p + 2);
      }
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const k = buf.toString('ascii', 12, 16);
      if (k === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (k === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (k === 'VP8L') { const v = buf.readUInt32LE(21); return { w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    }
  } catch { /* usa proporción por defecto */ }
  return { w: 1600, h: 900 };
}

// zip mínimo (deflate), suficiente para un .docx
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const x of buf) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function zip(archivos) {
  const locales = [], centrales = [];
  let pos = 0;
  for (const [nombre, dato] of archivos) {
    const n = Buffer.from(nombre), d = Buffer.isBuffer(dato) ? dato : Buffer.from(dato);
    const c = deflateRawSync(d), crc = crc32(d);
    const l = Buffer.alloc(30); l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(0x0800, 6); l.writeUInt16LE(8, 8);
    l.writeUInt32LE(crc, 14); l.writeUInt32LE(c.length, 18); l.writeUInt32LE(d.length, 22); l.writeUInt16LE(n.length, 26);
    const z = Buffer.alloc(46); z.writeUInt32LE(0x02014b50, 0); z.writeUInt16LE(20, 4); z.writeUInt16LE(20, 6); z.writeUInt16LE(0x0800, 8); z.writeUInt16LE(8, 10);
    z.writeUInt32LE(crc, 16); z.writeUInt32LE(c.length, 20); z.writeUInt32LE(d.length, 24); z.writeUInt16LE(n.length, 28); z.writeUInt32LE(pos, 42);
    locales.push(l, n, c); centrales.push(z, n);
    pos += 30 + n.length + c.length;
  }
  const cd = Buffer.concat(centrales);
  const fin = Buffer.alloc(22); fin.writeUInt32LE(0x06054b50, 0); fin.writeUInt16LE(archivos.length, 8); fin.writeUInt16LE(archivos.length, 10);
  fin.writeUInt32LE(cd.length, 12); fin.writeUInt32LE(pos, 16);
  return Buffer.concat([...locales, cd, fin]);
}

export function exportarDocx(clave, titulo) {
  const meta = leerMeta(clave);
  const media = [], rels = [];
  const MAX_W = 5669280; // 6.2 pulgadas en EMU (ancho útil de una página A4 con márgenes de 1")
  let idDib = 1;

  const imagen = (id) => {
    const s = meta.shots.find((x) => x.id === id);
    if (!s) return '';
    const buf = readFileSync(join(outDir(clave), s.file));
    const ext = s.file.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
    const nombre = `imagen${media.length + 1}.${ext}`;
    media.push([`word/media/${nombre}`, buf]);
    const rid = `rIdImg${media.length}`;
    rels.push(`<Relationship Id="${rid}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${nombre}"/>`);
    const { w, h } = dimensiones(buf);
    const cx = Math.min(MAX_W, w * 9525), cy = Math.round(cx * h / w), n = idDib++;
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Imagen ${n}" descr="${xml(s.nombre)}"/>`
      + `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">`
      + `<pic:nvPicPr><pic:cNvPr id="${n}" name="${nombre}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
      + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  };

  const run = (r) => r.br ? '<w:r><w:br/></w:r>'
    : `<w:r><w:rPr>${r.b ? '<w:b/>' : ''}${r.i ? '<w:i/>' : ''}</w:rPr><w:t xml:space="preserve">${xml(r.t)}</w:t></w:r>`;
  const parrafo = (p) => {
    if (p.runs[0].img) return `<w:p><w:pPr><w:keepNext w:val="0"/><w:spacing w:before="120" w:after="200"/></w:pPr>${imagen(p.runs[0].img)}</w:p>`;
    const ind = p.vineta ? '<w:ind w:left="360" w:hanging="260"/>' : '';
    const rs = (p.vineta ? [{ t: '• ' }, ...p.runs] : p.runs).map(run).join('');
    return `<w:p><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/>${ind}</w:pPr>${rs}</w:p>`;
  };

  const tituloXml = `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="4" w:color="0F9D8A"/></w:pBdr><w:spacing w:after="240"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="0B6B5E"/><w:sz w:val="40"/></w:rPr><w:t xml:space="preserve">${xml(titulo)}</w:t></w:r></w:p>`;
  const cuerpo = aParrafos(meta.cuerpo).map(parrafo).join('');

  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${tituloXml}${cuerpo}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const estilos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/><w:lang w:val="es-PE"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>';
  const tipos = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpg" ContentType="image/jpeg"/><Default Extension="webp" ContentType="image/webp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>';
  const raiz = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
  const relsDoc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdSt" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${rels.join('')}</Relationships>`;

  return zip([['[Content_Types].xml', tipos], ['_rels/.rels', raiz], ['word/document.xml', doc], ['word/styles.xml', estilos], ['word/_rels/document.xml.rels', relsDoc], ...media]);
}
