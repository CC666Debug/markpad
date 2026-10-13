import { EditorView } from '@codemirror/view';
import { SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, replaceNext, replaceAll,
  openSearchPanel, closeSearchPanel, searchPanelOpen } from '@codemirror/search';
import { markdown, esc, slug, startsBlock, FENCE_RE, H_RE, DEF_RE } from './md.js';
import { createEditor } from './editor.js';
import { host } from './host.js';

const VERSION = '2.0.0';
const $ = s => document.querySelector(s);
const pv = $('#preview'), main = $('#main');
const KEY = 'markpad.v1.';
const store = {
  get(k){ try { return localStorage.getItem(KEY + k); } catch (e){ return null; } },
  set(k, v){ try { localStorage.setItem(KEY + k, v); } catch (e){} },
};
// IndexedDB holds things localStorage can't (browser file and folder handles)
const idb = (mode, fn) => new Promise((res, rej) => {
  const r = indexedDB.open('markpad', 1);
  r.onupgradeneeded = () => r.result.createObjectStore('kv');
  r.onerror = () => rej(r.error);
  r.onsuccess = () => {
    const tx = r.result.transaction('kv', mode), q = fn(tx.objectStore('kv'));
    tx.oncomplete = () => res(q.result); tx.onerror = () => rej(tx.error);
  };
});
const kvGet = k => idb('readonly', st => st.get(k)).catch(() => undefined);
const kvSet = (k, v) => idb('readwrite', st => st.put(v, k)).catch(() => {});

let toastTimer;
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------------- Dialogs (no browser prompt/confirm, so they look the same in every edition) ---------------- */
function ask(msg, { input = null, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] } = {}){
  return new Promise(res => {
    const box = $('#ask'), inp = $('#askInput'), btns = $('#askBtns');
    $('#askMsg').textContent = msg;
    inp.hidden = input == null; inp.value = input ?? '';
    btns.innerHTML = '';
    const done = v => { box.hidden = true; document.removeEventListener('keydown', key, true); res(v); };
    const primary = buttons.find(b => b.primary) || buttons[buttons.length - 1];
    const val = b => b.value === true && input != null ? inp.value.trim() || null : b.value;
    for (const b of buttons){
      const el = document.createElement('button');
      el.textContent = b.label; if (b.primary) el.className = 'primary';
      el.onclick = () => done(val(b));
      btns.appendChild(el);
    }
    const key = e => {
      if (e.key === 'Escape'){ e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && (e.target === inp || input == null)){ e.preventDefault(); e.stopPropagation(); done(val(primary)); }
    };
    document.addEventListener('keydown', key, true);
    box.hidden = false;
    if (input != null){ inp.focus(); inp.setSelectionRange(0, inp.value.replace(/\.md$/, '').length); }
    else btns.lastChild.focus();
  });
}
const confirmBox = (msg, ok = 'OK') => ask(msg, { buttons: [{ label: 'Cancel', value: false }, { label: ok, value: true, primary: true }] });

/* ---------------- Paths ---------------- */
const dirname = p => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
const basename = p => p.slice(p.lastIndexOf('/') + 1);
const joinPath = (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/');
function normPath(p){
  const out = [];
  for (const part of p.split('/')){ if (!part || part === '.') continue; if (part === '..') out.pop(); else out.push(part); }
  return out.join('/');
}
function relPath(fromDir, to){
  const a = fromDir ? fromDir.split('/') : [], b = to.split('/');
  while (a.length && b.length > 1 && a[0] === b[0]){ a.shift(); b.shift(); }
  return '../'.repeat(a.length) + b.join('/');
}
const isNote = n => /\.(md|markdown|mdown|mkd|txt)$/i.test(n);

/* ---------------- Editor ---------------- */
let cm, view;
const text = () => view.state.doc.toString();
const sel = () => view.state.selection.main;
function replaceRange(s, e, insert, selS, selE){
  view.dispatch({
    changes: { from: s, to: e, insert },
    selection: selS != null ? { anchor: selS, head: selE ?? selS } : undefined,
    scrollIntoView: true, userEvent: 'input',
  });
  view.focus();
}

/* ---------------- Document state ---------------- */
// cur.kind: 'scratch' (not a file yet) | 'loose' (a file opened on its own) | 'lib' (a note in the library)
let cur = { kind: 'scratch', name: 'untitled.md' }, dirty = false, renderTimer = 0, draftTimer = 0, saveTimer = 0, loading = false;
let autosave = store.get('autosave') !== '0';

function updateTitle(){
  const name = cur.kind === 'lib' ? cur.path : cur.name;
  $('#fname').textContent = name + (cur.kind === 'scratch' && dirty ? ' (not saved to disk)' : '');
  $('#dirtyDot').textContent = dirty ? '●' : '';
  host.setTitle((dirty ? '• ' : '') + cur.name + ' — Markpad');
}
function setDirty(d){
  dirty = d; updateTitle(); saveDraft();
  clearTimeout(saveTimer);
  if (d && autosave && cur.kind === 'lib') saveTimer = setTimeout(() => save(false, true), 1200);
}
function saveDraft(){
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => store.set('draft', JSON.stringify({
    text: text(), name: cur.name, dirty, kind: cur.kind, path: cur.path || null, lib: cur.kind === 'lib' ? lib?.desc.id : null,
  })), 300);
}
function loadText(t, info){
  loading = true;
  cur = { kind: 'scratch', name: 'untitled.md', ...info };
  cm.reset(t.replace(/\r\n?/g, '\n'));
  loading = false;
  setDirty(false); render(); updateCursor(); markTree();
  pv.scrollTop = 0;
  if (main.dataset.view !== 'preview') view.focus();
}

/* ---------------- Rendering ---------------- */
function render(){
  if (main.dataset.view === 'split' || main.dataset.view === 'preview'){
    pv.innerHTML = markdown(text());
    fillPreview();
  }
  const t = text(), words = (t.match(/\S+/g) || []).length;
  $('#stats').textContent = `${words.toLocaleString()} words · ${t.length.toLocaleString()} chars · ${Math.max(1, Math.round(words / 230))} min read`;
  buildOutline();
  if (scrollSrc === 'ed') syncScroll('ed');
}
function scheduleRender(){
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, view.state.doc.length > 50000 ? 250 : 60);
}
function fillPreview(){
  for (const img of pv.querySelectorAll('img[data-rel],img[data-wiki]')){
    const src = img.dataset.wiki != null ? 'wiki:' + img.dataset.wiki : img.dataset.rel;
    resolveImage(src).then(u => { if (u) img.src = u; });
  }
  for (const a of pv.querySelectorAll('a.wikilink')) a.classList.toggle('missing', !!lib && !resolveWiki(a.dataset.wiki));
}
function updateCursor(){
  const r = sel(), line = view.state.doc.lineAt(r.head);
  $('#cursor').textContent = `Ln ${line.number}, Col ${r.head - line.from + 1}` + (r.empty ? '' : ` (${r.to - r.from} selected)`);
}

/* ---------------- Images ---------------- */
async function resolveImage(src){
  if (/^(https?:|data:|blob:)/i.test(src)) return src;
  if (src.startsWith('wiki:')){
    const p = lib && findFile(src.slice(5));
    return p ? lib.fs.url(p) : null;
  }
  let p; try { p = decodeURI(src); } catch (_) { p = src; }
  if (cur.kind === 'lib' && lib) return lib.fs.url(normPath(joinPath(dirname(cur.path), p)));
  if (cur.kind === 'loose' && host.looseUrl) return host.looseUrl(cur.ref, p);
  return null;
}
async function imageData(file){
  const raw = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(file); });
  if (/gif|svg/.test(file.type)) return raw;
  try {
    const bmp = await createImageBitmap(file), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const out = c.toDataURL('image/webp', 0.85);
    return out.length < raw.length ? out : raw;
  } catch (_) { return raw; }
}
// Obsidian keeps pasted images as files; follow its attachment setting when the library is a vault.
async function attachmentDir(){
  let setting = null;
  try { setting = JSON.parse(await lib.fs.read('.obsidian/app.json')).attachmentFolderPath; } catch (_) {}
  const noteDir = dirname(cur.path);
  if (setting == null) return lib.desc.portable ? 'attachments' : '';
  if (setting === '/' || setting === '') return '';
  if (setting === './') return noteDir;
  if (setting.startsWith('./')) return normPath(joinPath(noteDir, setting.slice(2)));
  return normPath(setting);
}
async function insertImages(files){
  if (main.dataset.view === 'preview') setView(lastEditView);
  const r = sel(), s = r.from, e = r.to, v = text();
  if (cur.kind === 'lib' && lib){
    const dir = await attachmentDir(), names = new Set(allFiles().map(f => f.path.toLowerCase()));
    const d = new Date(), stamp = [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()].map(x => String(x).padStart(2, '0')).join('');
    let out = '';
    for (const f of files){
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
      let base = f.name && !/^image\.\w+$/i.test(f.name) ? f.name.replace(/\.\w+$/, '') : 'Pasted image ' + stamp, p, n = 1;
      do { p = joinPath(dir, base + (n > 1 ? ' ' + n : '') + '.' + ext); n++; } while (names.has(p.toLowerCase()));
      names.add(p.toLowerCase());
      await lib.fs.writeBin(p, new Uint8Array(await f.arrayBuffer()));
      out += (out ? '\n' : '') + `![](${encodeURI(relPath(dirname(cur.path), p))})`;
    }
    replaceRange(s, e, out, s + out.length);
    refreshTree();
  } else {
    // not in a library: shrink the image and keep it inside the note as a reference link at the bottom
    const used = new Set((v.match(/^ {0,3}\[[^\]]+\]:/gm) || []).map(x => x.trim().slice(1, -2).toLowerCase()));
    let n = 1, img = '', defs = '';
    for (const f of files){
      while (used.has('image-' + n)) n++;
      const id = 'image-' + n; used.add(id);
      const alt = (f.name && !/^image\.\w+$/i.test(f.name) ? f.name.replace(/\.\w+$/, '') : 'image').replace(/[[\]]/g, '');
      img += (img ? '\n' : '') + `![${alt}][${id}]`;
      defs += `[${id}]: ${await imageData(f)}\n`;
    }
    const body = v.slice(0, s) + img + v.slice(e).replace(/\s+$/, '');
    const glue = DEF_RE.test(body.slice(body.lastIndexOf('\n') + 1)) ? '\n' : '\n\n';
    replaceRange(s, v.length, img + v.slice(e).replace(/\s+$/, '') + glue + defs, s + img.length);
  }
  toast(files.length > 1 ? `Added ${files.length} images` : 'Image added');
}
const imageFiles = dt => [...(dt?.files || [])].filter(f => f.type.startsWith('image/'));

/* ---------------- Files ---------------- */
const okToDiscard = async () => !dirty || cur.kind === 'lib' && await flush() ||
  await ask(`${cur.name} has unsaved changes.`, { buttons: [{ label: 'Cancel', value: false }, { label: 'Discard', value: true, primary: true }] });
async function flush(){ if (cur.kind === 'lib' && dirty) await save(false, true); return !dirty; }

async function newNote(){
  if (lib){
    const dir = selectedDir();
    const name = await ask('New note', { input: 'Untitled' });
    if (name) await createNote(dir, name);
    return;
  }
  if (await okToDiscard()) loadText('', { kind: 'scratch', name: 'untitled.md' });
}
async function openFile(){
  if (!(await okToDiscard())) return;
  try {
    const f = await host.openFile();
    if (f){ loadText(f.text, { kind: f.ref ? 'loose' : 'scratch', name: f.name, ref: f.ref }); addRecent({ name: f.name, ref: f.ref }); }
  } catch (e){ if (e.name !== 'AbortError') toast('Could not open: ' + e.message); }
}
async function save(saveAs, quiet){
  clearTimeout(saveTimer);
  const t = text();
  try {
    if (!saveAs && cur.kind === 'lib' && lib){
      const m = await lib.fs.mtime(cur.path).catch(() => 0);
      if (cur.mtime && m && m !== cur.mtime){
        const pick = await ask(`${cur.name} was changed outside Markpad (maybe by Obsidian or sync).`, { buttons: [
          { label: 'Load theirs', value: 'theirs' }, { label: 'Keep mine', value: 'mine', primary: true }] });
        if (pick === 'theirs'){ await openLibFile(cur.path, true); return; }
        if (!pick) return;
      }
      await lib.fs.write(cur.path, t);
      cur.mtime = await lib.fs.mtime(cur.path).catch(() => 0);
      if (text() === t) setDirty(false);
      if (!quiet) toast('Saved');
      return;
    }
    if (!saveAs && cur.kind === 'loose' && cur.ref){
      await host.writeRef(cur.ref, t); setDirty(false); toast('Saved'); return;
    }
    if (!saveAs && cur.kind === 'scratch' && lib){
      const name = await ask('Save as a note in ' + lib.desc.name, { input: (titleOf(t) || 'Untitled') });
      if (name){ const p = await uniquePath(selectedDir(), name.replace(/\.md$/i, '') + '.md'); await lib.fs.write(p, t); await refreshTree(); await openLibFile(p, true); toast('Saved'); }
      return;
    }
    const r = await host.saveAs(cur.name, t);
    if (!r) return;
    cur = { kind: r.ref ? 'loose' : 'scratch', name: r.name, ref: r.ref };
    setDirty(false); toast(r.ref ? 'Saved' : 'Downloaded ' + r.name); addRecent({ name: r.name, ref: r.ref });
  } catch (e){ if (e.name !== 'AbortError') toast('Save failed: ' + (e.message || e)); }
}
const titleOf = t => (t.match(/^#\s+(.+)$/m) || [])[1]?.replace(/[\\/:*?"<>|#^[\]]/g, '').trim().slice(0, 80);

function exportHtml(){
  const title = (titleOf(text()) || cur.name.replace(/\.\w+$/, '')).trim();
  const css = $('#tokens').textContent + $('#mdcss').textContent + 'body{background:var(--bg);margin:0;padding:40px 16px}';
  const body = markdown(text()).replace(/<input type="checkbox" class="task"/g, '<input type="checkbox" class="task" disabled');
  const html = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><article class="md">\n${body}\n</article></body></html>`;
  host.download(cur.name.replace(/\.\w+$/, '') + '.html', html, 'text/html');
}

/* ---------------- Recent files ---------------- */
let recent = [];
async function addRecent(entry){
  if (!entry.ref && !entry.path) return;
  const keep = [];
  for (const r of recent){
    const same = entry.path ? r.path === entry.path && r.lib === entry.lib : r.ref && await Promise.resolve(host.sameRef(r.ref, entry.ref)).catch(() => false);
    if (!same) keep.push(r);
  }
  recent = [entry, ...keep].slice(0, 8);
  showRecent(); kvSet('recent', recent);
}
function showRecent(){
  $('#recentBox').innerHTML = recent.length ? '<div class="sub">Recent</div>' + recent.map((r, k) =>
    `<button class="recent" data-k="${k}" title="${esc(r.path || r.name)}">${esc(r.name)}${r.libName ? ` <span style="color:var(--muted)">· ${esc(r.libName)}</span>` : ''}</button>`).join('') : '';
}
$('#recentBox').addEventListener('click', async e => {
  const b = e.target.closest('button'), r = b && recent[+b.dataset.k];
  if (!r) return;
  menu.open = false;
  try {
    if (r.path){
      if (!lib || lib.desc.id !== r.lib){
        const d = libs.find(l => l.id === r.lib);
        if (!d) throw new Error('library gone');
        await openLibrary(d, true);
      }
      await openLibFile(r.path);
      return;
    }
    if (!(await okToDiscard())) return;
    loadText(await host.readRef(r.ref), { kind: 'loose', name: r.name, ref: r.ref }); addRecent(r);
  } catch (_) {
    toast(`Couldn't open ${r.name}. Was it moved or deleted?`);
    recent = recent.filter(x => x !== r); showRecent(); kvSet('recent', recent);
  }
});

/* ---------------- Library (a folder of notes: portable notes or an Obsidian vault) ---------------- */
let lib = null, libs = [], tree = [], expanded = new Set(), selectedFolder = '';
const allFiles = (list = tree, out = []) => { for (const n of list){ if (n.dir) allFiles(n.children || [], out); else out.push(n); } return out; };
function findFile(target){
  const t = target.trim().toLowerCase(), files = allFiles();
  const hits = files.filter(f => f.path.toLowerCase() === t || f.path.toLowerCase().endsWith('/' + t) || f.name.toLowerCase() === t);
  return hits.sort((a, b) => a.path.length - b.path.length)[0]?.path || null;
}
function resolveWiki(target){
  const t = target.trim().replace(/\.md$/i, '');
  if (!t) return cur.kind === 'lib' ? cur.path : null;
  return findFile(t + '.md') || findFile(t);
}
async function uniquePath(dir, name){
  const taken = new Set(allFiles().map(f => f.path.toLowerCase()));
  const [base, ext] = /\.[^.]+$/.test(name) ? [name.replace(/\.[^.]+$/, ''), name.match(/\.[^.]+$/)[0]] : [name, ''];
  let p = joinPath(dir, name), n = 2;
  while (taken.has(p.toLowerCase())) p = joinPath(dir, `${base} ${n++}${ext}`);
  return p;
}
function selectedDir(){ return selectedFolder || (cur.kind === 'lib' ? dirname(cur.path) : ''); }

async function openLibrary(desc, quiet){
  if (!(await host.ready(desc, true))) { toast('Markpad needs permission to use ' + desc.name); renderLibEmpty(desc); return false; }
  lib = { desc, fs: host.lib(desc) };
  expanded = new Set(JSON.parse(store.get('open.' + desc.id) || '[]'));
  libs = [desc, ...libs.filter(l => l.id !== desc.id)].slice(0, 6);
  kvSet('libs', libs); store.set('lib', desc.id);
  $('#libName').textContent = desc.name; $('#libName').title = desc.path || desc.uri || desc.name;
  await refreshTree();
  if (!quiet) toast('Library: ' + desc.name);
  return true;
}
async function refreshTree(){
  if (!lib) return renderLibEmpty();
  try { tree = await lib.fs.list(); }
  catch (e){ tree = []; toast("Couldn't read the library: " + (e.message || e)); }
  renderTree();
}
function renderLibEmpty(needs){
  $('#libHead').hidden = !lib; $('#tree').hidden = !lib;
  const box = $('#libEmpty');
  box.hidden = !!lib;
  if (lib) return;
  if (!host.canLibrary){ box.innerHTML = 'Libraries need Chrome or Edge, or the Markpad app.'; return; }
  box.innerHTML = 'Keep your notes in a folder and browse them here.' +
    (needs ? `<button data-act="reconnect">↻ Reconnect to ${esc(needs.name)}</button>` : '') +
    (host.canPortable ? `<button data-act="portable">📁 Portable notes<br><small style="color:var(--muted)">${host.kind === 'android' ? 'kept inside the app' : 'a Notes folder next to Markpad'}</small></button>` : '') +
    `<button data-act="pick">🗂 Open a folder or Obsidian vault…</button>` +
    libs.filter(l => !needs || l.id !== needs.id).map((l, k) => `<button data-act="lib" data-k="${k}">↺ ${esc(l.name)}</button>`).join('');
  box.onclick = async e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'reconnect') openLibrary(needs);
    else if (a === 'portable') openLibrary(await host.portableLibrary());
    else if (a === 'pick') pickLibrary();
    else if (a === 'lib') openLibrary(libs.filter(l => !needs || l.id !== needs.id)[+b.dataset.k]);
  };
}
async function pickLibrary(){
  try { const d = await host.pickLibrary(); if (d) await openLibrary(d); }
  catch (e){ if (e.name !== 'AbortError') toast("Couldn't open that folder: " + (e.message || e)); }
}
function closeLibrary(){
  lib = null; tree = []; store.set('lib', '');
  if (cur.kind === 'lib') cur = { kind: 'scratch', name: cur.name };
  renderLibEmpty(); updateTitle();
}
function renderTree(){
  renderLibEmpty();
  if (!lib) return;
  const rows = [];
  const walk = (list, depth) => {
    for (const n of list){
      if (!n.dir && !isNote(n.name)) continue;
      const open = expanded.has(n.path);
      rows.push(`<button class="row${n.dir ? ' dir' + (open ? ' open' : '') : ''}" data-path="${esc(n.path)}" data-dir="${n.dir ? 1 : ''}" style="padding-left:${6 + depth * 14}px">` +
        `<span class="car">${n.dir ? '▶' : ''}</span><span class="nm">${esc(n.dir ? n.name : n.name.replace(/\.md$/i, ''))}</span></button>`);
      if (n.dir && open) walk(n.children || [], depth + 1);
    }
  };
  walk(tree, 0);
  $('#tree').innerHTML = rows.join('') || '<div class="empty">No notes yet. Press + to make one.</div>';
  markTree();
}
function markTree(){
  for (const b of document.querySelectorAll('#tree .row'))
    b.classList.toggle('on', cur.kind === 'lib' && b.dataset.path === cur.path || !!b.dataset.dir && b.dataset.path === selectedFolder && cur.kind !== 'lib');
}
$('#tree').addEventListener('click', e => {
  const b = e.target.closest('.row'); if (!b) return;
  const p = b.dataset.path;
  if (b.dataset.dir){
    expanded.has(p) ? expanded.delete(p) : expanded.add(p);
    selectedFolder = p;
    store.set('open.' + lib.desc.id, JSON.stringify([...expanded]));
    renderTree();
  } else {
    selectedFolder = dirname(p);
    openLibFile(p);
    if (window.innerWidth <= 700) toggleSide(false);
  }
});
async function openLibFile(path, force){
  if (!force && cur.kind === 'lib' && cur.path === path) return;
  if (!force && !(await okToDiscard())) return;
  try {
    const t = await lib.fs.read(path), mtime = await lib.fs.mtime(path).catch(() => 0);
    loadText(t, { kind: 'lib', name: basename(path), path, mtime });
    for (let d = dirname(path); d; d = dirname(d)) expanded.add(d);
    renderTree();
    addRecent({ name: basename(path), path, lib: lib.desc.id, libName: lib.desc.name });
  } catch (e){ toast("Couldn't open " + path + ': ' + (e.message || e)); }
}
async function createNote(dir, name){
  const p = await uniquePath(dir, name.replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '-') + '.md');
  await lib.fs.write(p, '');
  await refreshTree();
  await openLibFile(p, true);
  return p;
}
async function openWiki(target){
  if (!lib){ toast('Wiki links work inside a library (open the sidebar)'); return; }
  const [name, hash] = target.split('#');
  let p = resolveWiki(name);
  if (!p){
    if (!(await confirmBox(`"${name}" doesn't exist yet. Create it?`, 'Create'))) return;
    if (!(await flush())) return;
    p = await createNote('', name.trim());
    return;
  }
  if (p !== cur.path) await openLibFile(p);
  if (hash){
    const h = heads.find(x => slug(x.t) === slug(hash));
    if (h) jumpToLine(h.line);
  }
}
function openLink(href){
  if (!href || href === '#') return;
  if (href.startsWith('#')){
    const h = heads.find(x => slug(x.t) === decodeURIComponent(href.slice(1)));
    if (h) jumpToLine(h.line);
    return;
  }
  if (!/^[a-z][\w+.-]*:/i.test(href) && lib && cur.kind === 'lib'){   // a relative link to another note
    let p; try { p = decodeURI(href.split('#')[0]); } catch (_) { p = href; }
    p = normPath(joinPath(dirname(cur.path), p));
    if (allFiles().some(f => f.path === p)){ openLibFile(p); return; }
  }
  host.openExternal(href);
}

// right-click (long-press on phones) on the file tree
const ctx = $('#ctx');
function showCtx(x, y, items){
  ctx.innerHTML = '';
  for (const [label, fn] of items){
    const b = document.createElement('button'); b.textContent = label;
    b.onclick = () => { ctx.hidden = true; fn(); };
    ctx.appendChild(b);
  }
  ctx.hidden = false;
  ctx.style.left = Math.min(x, innerWidth - 200) + 'px';
  ctx.style.top = Math.min(y, innerHeight - ctx.offsetHeight - 8) + 'px';
}
document.addEventListener('pointerdown', e => { if (!ctx.hidden && !ctx.contains(e.target)) ctx.hidden = true; });
$('#tree').addEventListener('contextmenu', e => {
  const b = e.target.closest('.row'); if (!b) return;
  e.preventDefault();
  const p = b.dataset.path, isDir = !!b.dataset.dir, dir = isDir ? p : dirname(p);
  showCtx(e.clientX, e.clientY, [
    ['New note here', async () => { const n = await ask('New note', { input: 'Untitled' }); if (n) createNote(dir, n); }],
    ['New folder here', () => newFolder(dir)],
    ['Rename…', () => renamePath(p, isDir)],
    ['Delete (move to .trash)', () => trashPath(p, isDir)],
  ]);
});
async function newFolder(dir = selectedDir()){
  const n = await ask('New folder', { input: 'New folder' });
  if (!n) return;
  const p = await uniquePath(dir, n.replace(/[\\/:*?"<>|]/g, '-'));
  await lib.fs.mkdir(p); expanded.add(p); selectedFolder = p;
  refreshTree();
}
async function renamePath(p, isDir){
  const old = basename(p);
  let n = await ask('Rename', { input: isDir ? old : old.replace(/\.md$/i, '') });
  if (!n || n === old) return;
  n = n.replace(/[\\/:*?"<>|]/g, '-');
  if (!isDir && isNote(old) && !isNote(n)) n += old.match(/\.[^.]+$/)[0];
  const to = joinPath(dirname(p), n);
  if (allFiles().some(f => f.path.toLowerCase() === to.toLowerCase()) && to.toLowerCase() !== p.toLowerCase()){ toast(n + ' already exists'); return; }
  if (cur.kind === 'lib' && (cur.path === p || cur.path.startsWith(p + '/'))) await flush();
  try {
    await lib.fs.rename(p, to);
    if (cur.kind === 'lib' && (cur.path === p || cur.path.startsWith(p + '/'))){
      cur.path = to + cur.path.slice(p.length); cur.name = basename(cur.path);
      cur.mtime = await lib.fs.mtime(cur.path).catch(() => 0); updateTitle();
    }
    if (expanded.delete(p)) expanded.add(to);
    await refreshTree();
  } catch (e){ toast("Couldn't rename: " + (e.message || e)); }
}
async function trashPath(p, isDir){
  if (!(await confirmBox(`Move ${basename(p)}${isDir ? ' and everything in it' : ''} to the library's .trash folder?`, 'Move to trash'))) return;
  try {
    if (cur.kind === 'lib' && (cur.path === p || cur.path.startsWith(p + '/'))){ dirty = false; loadText('', { kind: 'scratch', name: 'untitled.md' }); }
    await lib.fs.trash(p);
    await refreshTree(); toast('Moved to .trash');
  } catch (e){ toast("Couldn't delete: " + (e.message || e)); }
}
$('#bNewNote').addEventListener('click', newNote);
$('#bNewFolder').addEventListener('click', () => newFolder());
$('#bRefresh').addEventListener('click', refreshTree);
$('#bLibMenu').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  showCtx(r.left, r.bottom + 4, [
    ...libs.filter(l => l.id !== lib?.desc.id).map(l => ['Switch to ' + l.name, () => switchLibrary(l)]),
    ...(host.canPortable && !lib?.desc.portable ? [['Portable notes', async () => switchLibrary(await host.portableLibrary())]] : []),
    ['Open a folder or vault…', async () => { if (await flush()) pickLibrary(); }],
    ['Close library', closeLibrary],
  ]);
});
async function switchLibrary(d){ if (await flush()) openLibrary(d); }

/* ---------------- Quick switcher (Ctrl+P) ---------------- */
let qsHits = [], qsOn = 0;
function openSwitcher(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  $('#qs').hidden = false; $('#qsInput').value = ''; qsFilter(); $('#qsInput').focus();
}
function qsFilter(){
  const q = $('#qsInput').value.trim().toLowerCase();
  const score = f => {
    const n = f.name.toLowerCase(), p = f.path.toLowerCase();
    if (!q) return 1;
    if (n.startsWith(q)) return 3;
    if (n.includes(q)) return 2;
    let i = 0; for (const ch of p){ if (ch === q[i]) i++; if (i === q.length) return 1; }
    return 0;
  };
  qsHits = allFiles().filter(f => isNote(f.name)).map(f => [score(f), f]).filter(x => x[0]).sort((a, b) => b[0] - a[0] || a[1].path.length - b[1].path.length).slice(0, 50).map(x => x[1]);
  qsOn = 0;
  const create = q && !qsHits.some(f => f.name.toLowerCase().replace(/\.md$/, '') === q) ? `<button data-new="1">＋ Create “${esc($('#qsInput').value.trim())}”</button>` : '';
  $('#qsList').innerHTML = qsHits.map((f, k) => `<button data-k="${k}"${k ? '' : ' class="on"'}>${esc(f.name.replace(/\.md$/i, ''))}<small>${esc(dirname(f.path) || '/')}</small></button>`).join('') + create;
  if (!qsHits.length && create) $('#qsList').firstChild.classList.add('on');
}
function qsPick(b){
  $('#qs').hidden = true;
  if (!b) return;
  if (b.dataset.new) flush().then(() => createNote(selectedDir(), $('#qsInput').value.trim()));
  else openLibFile(qsHits[+b.dataset.k].path);
}
$('#qsInput').addEventListener('input', qsFilter);
$('#qsInput').addEventListener('keydown', e => {
  const items = [...$('#qsList').children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    items[qsOn]?.classList.remove('on');
    qsOn = (qsOn + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length);
    items[qsOn]?.classList.add('on'); items[qsOn]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter'){ e.preventDefault(); qsPick(items[qsOn]); }
  else if (e.key === 'Escape'){ e.preventDefault(); $('#qs').hidden = true; view.focus(); }
});
$('#qsList').addEventListener('click', e => qsPick(e.target.closest('button')));
$('#qs').addEventListener('pointerdown', e => { if (e.target.id === 'qs') $('#qs').hidden = true; });

/* ---------------- Sidebar & outline ---------------- */
let heads = [];
const plain = t => t.replace(/!?\[\[([^\]|]*\|)?([^\]]*)\]\]/g, '$2').replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_~=`]+/g, '').trim();
function buildOutline(){
  const lines = text().split('\n'); heads = []; let inFence = false;
  lines.forEach((l, i) => {
    if (FENCE_RE.test(l)){ inFence = !inFence; return; }
    if (inFence) return;
    const m = l.match(H_RE);
    if (m && m[2]) heads.push({ n: m[1].length, t: plain(m[2]), line: i });
    else if (l.trim() && i + 1 < lines.length && /^ {0,3}(=+|-+) *$/.test(lines[i + 1]) && !startsBlock(l) && !/^\s*[|>]/.test(l) && (!lines[i - 1] || !lines[i - 1].trim()))
      heads.push({ n: lines[i + 1].trim()[0] === '=' ? 1 : 2, t: plain(l), line: i });
  });
  if ($('#olPane').hidden || $('#side').hidden) return;
  const min = Math.min(...heads.map(h => h.n));
  $('#olList').innerHTML = heads.length
    ? heads.map((h, k) => `<button data-k="${k}" style="padding-left:${8 + (h.n - min) * 14}px">${esc(h.t) || '(empty)'}</button>`).join('')
    : '<div class="empty">No headings yet. Start a line with # to add one.</div>';
  markOutline();
}
const docOffset = () => view.documentTop - view.scrollDOM.getBoundingClientRect().top + view.scrollDOM.scrollTop;
const lineY = line => view.lineBlockAt(view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from).top + docOffset();
function topLine(){
  if (main.dataset.view === 'preview'){
    let ln = 0;
    for (const el of pv.querySelectorAll('[data-line]')){ if (el.offsetTop > pv.scrollTop + 40) break; ln = +el.dataset.line; }
    return ln;
  }
  const b = view.lineBlockAtHeight(view.scrollDOM.scrollTop - docOffset() + 40);
  return view.state.doc.lineAt(b.from).number - 1;
}
function markOutline(){
  if ($('#olPane').hidden || $('#side').hidden || !heads.length) return;
  const ln = topLine(); let k = -1;
  heads.forEach((h, i) => { if (h.line <= ln) k = i; });
  $('#olList').querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === k));
}
function jumpToLine(line){
  const pos = view.state.doc.line(Math.min(line + 1, view.state.doc.lines)).from;
  if (main.dataset.view !== 'preview'){
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 }) });
    view.focus();
  }
  let target = null;
  for (const el of pv.querySelectorAll('[data-line]')){ if (+el.dataset.line > line) break; target = el; }
  if (target && main.dataset.view !== 'live' && main.dataset.view !== 'editor'){ syncing = main.dataset.view === 'split' ? 'pv' : null; pv.scrollTop = target.offsetTop - 12; }
  updateCursor();
}
$('#olList').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  jumpToLine(heads[+b.dataset.k].line);
  if (window.innerWidth <= 700) toggleSide(false);
});
function toggleSide(on = $('#side').hidden){
  $('#side').hidden = !on; $('#bSide').setAttribute('aria-pressed', String(on));
  if (window.innerWidth > 700) store.set('side', on ? '1' : '');
  buildOutline();
}
function showTab(tab){
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#filesPane').hidden = tab !== 'files'; $('#olPane').hidden = tab !== 'outline';
  store.set('tab', tab); buildOutline();
}
$('#bSide').addEventListener('click', () => toggleSide());
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------------- Scroll sync (Split view) ---------------- */
let scrollSrc = 'ed', syncing = null;
function pairs(){
  const out = [[0, 0]];
  pv.querySelectorAll('[data-line]').forEach(el => out.push([lineY(+el.dataset.line), el.offsetTop]));
  out.push([view.scrollDOM.scrollHeight, pv.scrollHeight]);
  return out;
}
function syncScroll(from){
  if (main.dataset.view !== 'split' || document.body.classList.contains('focus')) return;
  const f = from === 'ed' ? view.scrollDOM : pv, to = from === 'ed' ? pv : view.scrollDOM, a = from === 'ed' ? 0 : 1, b = 1 - a;
  const max = f.scrollHeight - f.clientHeight, tmax = to.scrollHeight - to.clientHeight;
  let y;
  if (f.scrollTop >= max - 2) y = tmax;
  else {
    const P = pairs(), s = f.scrollTop;
    let k = 0; while (k < P.length - 2 && P[k + 1][a] <= s) k++;
    const [p, q] = [P[k], P[k + 1]], span = q[a] - p[a];
    y = p[b] + (span > 0 ? (s - p[a]) / span : 0) * (q[b] - p[b]);
  }
  syncing = from === 'ed' ? 'pv' : 'ed'; to.scrollTop = y;
}

/* ---------------- Formatting ---------------- */
function wrap(b, a = b, ph = 'text'){
  const { from: s, to: e } = sel(), v = text(), picked = v.slice(s, e);
  if (v.slice(s - b.length, s) === b && v.slice(e, e + a.length) === a){
    replaceRange(s - b.length, e + a.length, picked, s - b.length, e - b.length); return;
  }
  const t = picked || ph;
  replaceRange(s, e, b + t + a, s + b.length, s + b.length + t.length);
}
function lineRange(){
  const v = text(), { from: s } = sel(); let { to: e } = sel();
  if (e > s && v[e - 1] === '\n') e--;
  const ls = v.lastIndexOf('\n', s - 1) + 1;
  let le = v.indexOf('\n', e); if (le < 0) le = v.length;
  return [ls, le];
}
function mapLines(fn){
  const [ls, le] = lineRange();
  const out = fn(text().slice(ls, le).split('\n')).join('\n');
  replaceRange(ls, le, out, ls, ls + out.length);
}
function toggleLines(re, make){
  mapLines(ls => {
    const all = ls.every(l => !l.trim() || re.test(l));
    let n = 0;
    return ls.map(l => !l.trim() ? l : all ? l.replace(re, '') : make(l.replace(/^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s?)/, '$1'), ++n));
  });
}
function insertBlock(t, selFrom, selLen){
  const { from: s, to: e } = sel(), v = text();
  const before = s === 0 ? '' : v.slice(0, s).endsWith('\n\n') ? '' : v.slice(0, s).endsWith('\n') ? '\n' : '\n\n';
  const after = v.slice(e).startsWith('\n') ? '\n' : '\n\n';
  const at = s + before.length;
  replaceRange(s, e, before + t + after, selFrom != null ? at + selFrom : at + t.length + after.length, selFrom != null ? at + selFrom + selLen : undefined);
}
const indentOf = l => l.match(/^\s*/)[0];
const FORMATS = {
  bold:   () => wrap('**', '**', 'bold text'),
  italic: () => wrap('*', '*', 'italic text'),
  strike: () => wrap('~~', '~~', 'text'),
  code:   () => { const r = sel(); text().slice(r.from, r.to).includes('\n') ? wrap('```\n', '\n```', '') : wrap('`', '`', 'code'); },
  heading: () => mapLines(ls => ls.map(l => {
    const m = l.match(/^(#{1,6})\s+/);
    if (!m) return '# ' + l;
    return m[1].length >= 6 ? l.slice(m[0].length) : '#' + l;
  })),
  quote: () => toggleLines(/^\s*>\s?/, l => '> ' + l),
  ul:    () => toggleLines(/^\s*[-*+]\s+(?!\[[ xX]\])/, l => indentOf(l) + '- ' + l.trimStart()),
  ol:    () => toggleLines(/^\s*\d+[.)]\s+/, (l, n) => indentOf(l) + n + '. ' + l.trimStart()),
  task:  () => toggleLines(/^\s*[-*+]\s+\[[ xX]\]\s+/, l => indentOf(l) + '- [ ] ' + l.trimStart()),
  link:  () => {
    const { from: s, to: e } = sel(), picked = text().slice(s, e);
    if (/^https?:\/\/\S+$/.test(picked)) replaceRange(s, e, `[link text](${picked})`, s + 1, s + 10);
    else { const t = picked || 'link text'; replaceRange(s, e, `[${t}](https://)`, s + t.length + 3, s + t.length + 11); }
  },
  image: () => {
    const { from: s, to: e } = sel(), t = text().slice(s, e) || 'alt text';
    replaceRange(s, e, `![${t}](https://)`, s + t.length + 4, s + t.length + 12);
  },
  table: () => insertBlock('| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |', 2, 10),
  hr:    () => insertBlock('---'),
};
document.querySelectorAll('.fmt button').forEach(b => b.addEventListener('click', () => {
  if (main.dataset.view === 'preview') setView(lastEditView);
  FORMATS[b.dataset.f]();
}));

/* ---------------- Preview interactions ---------------- */
function toggleTask(n){
  const lines = text().split('\n'); let inFence = false, k = 0, off = 0;
  for (const line of lines){
    if (FENCE_RE.test(line)) inFence = !inFence;
    else if (!inFence){
      const m = line.match(/^((?: {0,3}> ?)*\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\[)([ xX])(?=\](?:\s|$))/);
      if (m){
        if (k === n){
          const at = off + m[1].length, keep = pv.scrollTop;
          view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === ' ' ? 'x' : ' ' } });
          render(); pv.scrollTop = keep;
          return;
        }
        k++;
      }
    }
    off += line.length + 1;
  }
}
pv.addEventListener('click', e => {
  const box = e.target.closest('input.task');
  if (box){ e.preventDefault(); toggleTask([...pv.querySelectorAll('input.task')].indexOf(box)); return; }
  const a = e.target.closest('a[href]');
  if (!a) return;
  e.preventDefault();
  if (a.classList.contains('wikilink')) openWiki(a.dataset.wiki + (a.dataset.hash ? '#' + a.dataset.hash : ''));
  else openLink(a.getAttribute('href'));
});
pv.addEventListener('scroll', () => {
  if (syncing === 'pv'){ syncing = null; } else if (scrollSrc === 'pv') syncScroll('pv');
  if (main.dataset.view === 'preview') markOutline();
}, { passive: true });

/* ---------------- Find & replace (a CodeMirror search panel with our own bar) ---------------- */
const fb = $('#findBar'), F = id => fb.querySelector(id), fFind = F('#fFind'), fRep = F('#fRep');
fb.remove();   // it only appears as the editor's search panel
const opt = id => F(id).getAttribute('aria-pressed') === 'true';
let findFrom = 0;
function setQuery(){
  view.dispatch({ effects: setSearchQuery.of(new SearchQuery({
    search: fFind.value, replace: fRep.value, caseSensitive: opt('#fCase'), regexp: opt('#fRegex'),
  })) });
}
function updateCount(){
  const q = getSearchQuery(view.state), c = F('#fCount');
  let n = 0, at = -1;
  if (q.search && q.valid){
    const r = sel(), cursor = q.getCursor(view.state);
    for (let m = cursor.next(); !m.done && n < 5000; m = cursor.next()){
      if (m.value.from === r.from && m.value.to === r.to) at = n;
      n++;
    }
  }
  c.textContent = !q.search ? '' : !q.valid ? 'Bad pattern' : !n ? 'No results' : at >= 0 ? `${at + 1} of ${n}` : `${n} found`;
  c.classList.toggle('none', !!q.search && !n);
}
function openFind(rep){
  if (main.dataset.view === 'preview') setView(lastEditView);
  const r = sel(), picked = text().slice(r.from, r.to);
  if (picked && !picked.includes('\n')) fFind.value = picked;
  fb.classList.toggle('rep-on', !!rep);
  findFrom = r.from;
  openSearchPanel(view);
  setQuery();
  $('#bFind').setAttribute('aria-pressed', 'true');
  if (rep && fFind.value) fRep.focus(); else { fFind.focus(); fFind.select(); }
  updateCount();
}
function closeFind(){ closeSearchPanel(view); view.focus(); }
const createFindPanel = () => ({
  dom: fb, top: true,
  destroy(){ $('#bFind').setAttribute('aria-pressed', 'false'); },
});
fFind.addEventListener('input', () => {
  setQuery();
  view.dispatch({ selection: { anchor: findFrom } });
  if (fFind.value) findNext(view);
  updateCount();
});
fRep.addEventListener('input', setQuery);
fb.addEventListener('keydown', e => {
  if (e.key === 'Escape'){ e.preventDefault(); closeFind(); }
  else if (e.key === 'Enter' && e.target === fFind){ e.preventDefault(); (e.shiftKey ? findPrevious : findNext)(view); updateCount(); }
  else if (e.key === 'Enter' && e.target === fRep){ e.preventDefault(); e.ctrlKey || e.metaKey ? doReplaceAll() : doReplace(); }
});
function doReplace(){ replaceNext(view); updateCount(); fRep.focus(); }
function doReplaceAll(){
  const before = F('#fCount').textContent.match(/(\d+)(?: found)?$/);
  replaceAll(view); updateCount(); fRep.focus();
  if (before) toast(`Replaced ${before[1]}`);
}
F('#fNext').addEventListener('click', () => { findNext(view); updateCount(); });
F('#fPrev').addEventListener('click', () => { findPrevious(view); updateCount(); });
F('#fOne').addEventListener('click', doReplace);
F('#fAll').addEventListener('click', doReplaceAll);
F('#fClose').addEventListener('click', closeFind);
for (const id of ['#fCase', '#fRegex']) F(id).addEventListener('click', () => {
  F(id).setAttribute('aria-pressed', String(!opt(id))); setQuery();
  view.dispatch({ selection: { anchor: findFrom } }); if (fFind.value) findNext(view); updateCount();
});
$('#bFind').addEventListener('click', () => searchPanelOpen(view.state) ? closeFind() : openFind(false));

/* ---------------- Paste / drop ---------------- */
function onPaste(e){
  const imgs = imageFiles(e.clipboardData);
  if (!imgs.length) return false;
  e.preventDefault(); insertImages(imgs); return true;
}
let dragDepth = 0;
document.addEventListener('dragenter', e => { if (e.dataTransfer.types.includes('Files')){ dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0){ dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
async function onDropFiles(e){
  if (!e.dataTransfer.types.includes('Files')) return false;
  e.preventDefault(); e.stopPropagation(); dragDepth = 0; document.body.classList.remove('dragging');
  const all = [...e.dataTransfer.files], imgs = imageFiles(e.dataTransfer);
  if (imgs.length && imgs.length === all.length){ insertImages(imgs); return true; }
  const item = e.dataTransfer.items && e.dataTransfer.items[0], file = all[0];
  const handleP = item ? host.dropHandle(item) : null;
  if (!file || !(await okToDiscard())) return true;
  let handle = null;
  try { handle = handleP ? await handleP : null; } catch (_) {}
  if (handle && handle.kind !== 'file') handle = null;
  loadText(await file.text(), { kind: handle ? 'loose' : 'scratch', name: file.name, ref: handle });
  if (handle) addRecent({ name: file.name, ref: handle });
  return true;
}
document.addEventListener('drop', onDropFiles);

/* ---------------- Views, theme, layout ---------------- */
let lastEditView = 'live';
function setView(v){
  main.dataset.view = v; store.set('view', v);
  if (v !== 'preview') lastEditView = v;
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  cm.setLive(v === 'live');
  render();
  if (v === 'split'){ scrollSrc = 'ed'; requestAnimationFrame(() => syncScroll('ed')); }
  if (v !== 'preview') view.focus();
}
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
function applyTheme(t){ if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }
$('#bTheme').addEventListener('click', () => {
  const t = getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'light' : 'dark';
  applyTheme(t); store.set('theme', t);
});
const div = $('#divider'), pane = $('#editPane');
div.addEventListener('pointerdown', e => {
  div.setPointerCapture(e.pointerId); div.classList.add('drag');
  const move = ev => {
    const r = main.getBoundingClientRect(), left = $('#side').hidden ? r.left : $('#side').getBoundingClientRect().right;
    pane.style.flexBasis = Math.min(80, Math.max(20, (ev.clientX - left) / (r.right - left) * 100)) + '%';
  };
  const up = () => { div.classList.remove('drag'); div.removeEventListener('pointermove', move); store.set('split', pane.style.flexBasis); };
  div.addEventListener('pointermove', move);
  div.addEventListener('pointerup', up, { once: true });
});
div.addEventListener('dblclick', () => { pane.style.flexBasis = '50%'; store.set('split', '50%'); });

function setFocus(on){
  document.body.classList.toggle('focus', on);
  if (on){
    toast('Focus mode · Esc to leave');
    if (host.kind === 'browser') document.documentElement.requestFullscreen?.().catch(() => {});
    view.focus();
  } else if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}
$('#bFocus').addEventListener('click', () => setFocus(true));
$('#focusExit').addEventListener('click', () => setFocus(false));
document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && document.body.classList.contains('focus')) setFocus(false); });

const menu = $('#moreMenu');
menu.addEventListener('toggle', () => {
  if (!menu.open) return;
  const r = menu.querySelector('summary').getBoundingClientRect(), list = menu.querySelector('.menu-list');
  list.style.top = r.bottom + 'px';
  list.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
});
document.addEventListener('click', e => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
const closeMenu = fn => () => { menu.open = false; fn(); };
$('#bNew').addEventListener('click', newNote);
$('#bOpen').addEventListener('click', openFile);
$('#bSave').addEventListener('click', () => save(false));
$('#bSaveAs').addEventListener('click', closeMenu(() => save(true)));
$('#bSwitcher').addEventListener('click', closeMenu(openSwitcher));
$('#bExport').addEventListener('click', closeMenu(exportHtml));
$('#bPrint').addEventListener('click', closeMenu(() => { pv.innerHTML = markdown(text()); fillPreview(); setTimeout(() => host.print(), 300); }));
$('#bAutosave').setAttribute('aria-pressed', String(autosave));
$('#bAutosave').addEventListener('click', () => {
  autosave = !autosave; store.set('autosave', autosave ? '1' : '0');
  $('#bAutosave').setAttribute('aria-pressed', String(autosave));
  toast(autosave ? 'Library notes save as you type' : 'Library notes save with Ctrl+S');
  if (autosave && dirty && cur.kind === 'lib') save(false, true);
});
$('#aboutLine').textContent = `Markpad ${VERSION} · ${host.kind === 'browser' ? 'web' : host.kind}`;

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (!$('#ask').hidden || !$('#qs').hidden) return;
  if (e.key === 'Escape'){
    if (!ctx.hidden){ ctx.hidden = true; return; }
    if (menu.open){ menu.open = false; return; }
    if (document.body.classList.contains('focus')){ setFocus(false); return; }
    if (searchPanelOpen(view.state)){ closeFind(); return; }
    if (window.innerWidth <= 700 && !$('#side').hidden){ toggleSide(false); return; }
    return;
  }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'f' && e.shiftKey){ e.preventDefault(); setFocus(!document.body.classList.contains('focus')); }
  else if (k === 'f' || k === 'h'){ e.preventDefault(); openFind(k === 'h'); }
  else if (k === 'o' && e.shiftKey){ e.preventDefault(); if ($('#side').hidden || $('#olPane').hidden){ toggleSide(true); showTab('outline'); } else toggleSide(false); }
  else if (k === 'o'){ e.preventDefault(); openFile(); }
  else if (k === 'p'){ e.preventDefault(); openSwitcher(); }
  else if (k === 'n'){ e.preventDefault(); newNote(); }
  else if (k === '\\' || e.code === 'Backslash'){ e.preventDefault(); toggleSide(); }
  else if (k === 's'){ e.preventDefault(); save(e.shiftKey); }
  else if (k === '/' || e.code === 'Slash'){
    e.preventDefault();
    const order = ['live', 'editor', 'split', 'preview'];
    setView(order[(order.indexOf(main.dataset.view) + 1) % order.length]);
  }
});

// Notice when a library note was changed elsewhere (Obsidian, sync) while Markpad was in the background.
async function checkOutside(){
  if (cur.kind !== 'lib' || !lib || !cur.mtime) return;
  const m = await lib.fs.mtime(cur.path).catch(() => 0);
  if (!m || m === cur.mtime) return;
  if (!dirty){
    const keep = sel().head, t = await lib.fs.read(cur.path);
    cm.reset(t); cur.mtime = m;
    view.dispatch({ selection: { anchor: Math.min(keep, t.length) } });
    render(); toast('Reloaded: changed outside Markpad');
  } else save(false, true);
}
window.addEventListener('focus', () => { checkOutside(); if (lib) refreshTree(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
window.addEventListener('beforeunload', e => { if (dirty && (cur.kind === 'loose' || cur.kind === 'lib' && !autosave)){ e.preventDefault(); e.returnValue = ''; } });
host.onClose(async () => {
  if (cur.kind === 'lib') await flush();
  if (!dirty || cur.kind === 'scratch') return true;
  return await ask(`${cur.name} has unsaved changes.`, { buttons: [{ label: 'Cancel', value: false }, { label: 'Close without saving', value: true, primary: true }] });
});

/* ---------------- Boot ---------------- */
cm = createEditor(pane, {
  command: name => FORMATS[name](),
  createFindPanel,
  onPaste,
  onDrop: e => { if (e.dataTransfer?.types.includes('Files')){ onDropFiles(e); return true; } return false; },
  resolveImage,
  openLink,
  openWiki,
  onUpdate(u){
    if (u.docChanged && !loading){ scrollSrc = 'ed'; if (!dirty) setDirty(true); else { saveDraft(); if (autosave && cur.kind === 'lib'){ clearTimeout(saveTimer); saveTimer = setTimeout(() => save(false, true), 1200); } } scheduleRender(); }
    if (u.selectionSet || u.docChanged) updateCursor();
    if ((u.docChanged || u.selectionSet) && searchPanelOpen(u.state)) updateCount();
  },
});
view = cm.view;
view.scrollDOM.addEventListener('scroll', () => {
  if (syncing === 'ed'){ syncing = null; } else if (scrollSrc === 'ed') syncScroll('ed');
  markOutline();
}, { passive: true });
for (const [el, name] of [[view.dom, 'ed'], [pv, 'pv']])
  for (const ev of ['pointerenter', 'pointerdown', 'wheel', 'touchstart', 'keydown', 'focusin'])
    el.addEventListener(ev, () => { scrollSrc = name; }, { passive: true });

applyTheme(store.get('theme'));
const split = store.get('split'); if (split) pane.style.flexBasis = split;
if (host.onOpenFile) host.onOpenFile(async f => { if (await okToDiscard()){ loadText(f.text, { kind: 'loose', name: f.name, ref: f.ref }); addRecent({ name: f.name, ref: f.ref }); } });

(async () => {
  recent = (await kvGet('recent')) || []; showRecent();
  libs = (await kvGet('libs')) || [];
  const v = store.get('view'); setView(['live', 'editor', 'split', 'preview'].includes(v) ? v : 'live');
  showTab(store.get('tab') || 'files');
  if (store.get('side') && window.innerWidth > 700) toggleSide(true);
  const libId = store.get('lib'), want = libs.find(l => l.id === libId);
  if (want && !(await host.ready(want, false))) renderLibEmpty(want);
  else if (want) await openLibrary(want, true);
  else renderLibEmpty();

  let draft = null;
  try { draft = JSON.parse(store.get('draft') || 'null'); } catch (_) {}
  const start = await host.startupFile().catch(() => null);
  if (start){
    loadText(start.text, { kind: 'loose', name: start.name, ref: start.ref }); addRecent({ name: start.name, ref: start.ref });
  } else if (draft && draft.kind === 'lib' && lib && draft.lib === lib.desc.id && draft.path){
    await openLibFile(draft.path, true);
    if (draft.dirty && draft.text !== text()){ view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: draft.text } }); }
  } else if (draft && typeof draft.text === 'string'){
    const r = draft.kind === 'loose' ? recent.find(x => x.ref && x.name === draft.name) : null;
    loadText(draft.text, r ? { kind: 'loose', name: draft.name, ref: r.ref } : { kind: 'scratch', name: draft.name || 'untitled.md' });
    if (draft.dirty) setDirty(true);
  } else {
    loadText($('#welcome').textContent.replace(/^\n/, ''), { kind: 'scratch', name: 'welcome.md' });
  }
  updateCursor();
  view.focus();
})();

// for the automated tests
window.__markpad = { get view(){ return view; }, get cur(){ return cur; }, get lib(){ return lib; }, openLibrary, openLibFile, setView, insertImages, toggleSide, showTab };
