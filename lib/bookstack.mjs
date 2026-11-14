import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { conImagenes, leerMeta, outDir } from './generator.mjs';

const cliente = (bs) => {
  const base = bs.url.replace(/\/$/, '');
  const H = { Authorization: `Token ${bs.tokenId}:${bs.tokenSecret}` };
  const api = async (path, init = {}) => {
    const r = await fetch(`${base}/api${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
    if (!r.ok) throw new Error(`BookStack ${init.method ?? 'GET'} ${path} → ${r.status} ${(await r.text()).slice(0, 200)}`);
    return r.json();
  };
  const json = (path, body, method = 'POST') => api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { base, api, json };
};

const buscar = (c, manual) =>
  c.api(`/pages?filter[name]=${encodeURIComponent(manual.pagina)}&filter[book_id]=${manual.libro_id}`).then((r) => r.data[0]);

/** Comprueba conexión y si la página ya existe (para avisar antes de sobrescribir). */
export async function probar(bs, manual) {
  const c = cliente(bs);
  const p = manual ? await buscar(c, manual) : null;
  await c.api('/pages?count=1');
  return { ok: true, existe: !!p, url: p ? `${c.base}/books/${p.book_slug}/page/${p.slug}` : null };
}

export async function publicar({ manual, bookstack, log }) {
  const meta = leerMeta(manual.clave);
  const c = cliente(bookstack);
  let page = await buscar(c, manual);
  if (!page) {
    page = await c.json('/pages', { chapter_id: manual.capitulo_id, name: manual.pagina, html: '<p>Generando…</p>' });
    log(`Página creada (id ${page.id})`);
  } else log(`La página ya existe (id ${page.id}): se actualiza su contenido`);
  const urls = {};
  for (const s of meta.shots) {
    const fd = new FormData();
    fd.append('type', 'gallery');
    fd.append('uploaded_to', String(page.id));
    fd.append('name', `${manual.clave}-${s.id}.png`);
    fd.append('image', new Blob([readFileSync(join(outDir(manual.clave), s.file))], { type: 'image/png' }), `${manual.clave}-${s.id}.png`);
    urls[s.id] = (await c.api('/image-gallery', { method: 'POST', body: fd })).url;
    log(`  imagen subida: ${s.id}`);
  }
  const res = await c.json(`/pages/${page.id}`, { name: manual.pagina, html: conImagenes(meta.cuerpo, urls) }, 'PUT');
  const url = `${c.base}/books/${res.book_slug}/page/${res.slug}`;
  log(`Publicado: ${url}`);
  return { url };
}
