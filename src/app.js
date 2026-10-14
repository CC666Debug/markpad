import { EditorView } from '@codemirror/view';
import { SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, replaceNext, replaceAll,
  openSearchPanel, closeSearchPanel, searchPanelOpen } from '@codemirror/search';
import { TAG_RE, markdown, esc, slug, startsBlock, FENCE_RE, H_RE, DEF_RE, IMG_EXT } from './md.js';
import { createEditor } from './editor.js';
import { undo, redo } from '@codemirror/commands';
import { toDocx } from './docx.js';
import { makeZip, readZip } from './zip.js';
import { host } from './host.js';
import { publish, unpublish, listPages, claim, uploadImage, pageOf, daysLeft, leftText, withPage, pageText, titleOf as pageTitle, KEY_PAGE, getSettings, setSettings, PAGE_STYLES } from './jotbird.js';

const VERSION = '2.6.1';
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
function ask(msg, { input = null, password = false, buttons = [{ label: 'Cancel', value: null }, { label: 'OK', value: true, primary: true }] } = {}){
  return new Promise(res => {
    const box = $('#ask'), inp = $('#askInput'), btns = $('#askBtns');
    $('#askMsg').textContent = msg;
    inp.hidden = input == null; inp.value = input ?? ''; inp.type = password ? 'password' : 'text';
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
  renderTabs();
  if (view) jbChip();
}
function setDirty(d){
  dirty = d; updateTitle(); saveSession();
  clearTimeout(saveTimer);
  if (d && autosave && cur.kind === 'lib') saveTimer = setTimeout(() => save(false, true), 1200);
}
// replace the current tab's text (e.g. reloaded from disk)
function replaceText(t, info){
  loading = true;
  cur = { ...cur, ...info };
  cm.reset(t.replace(/\r\n?/g, '\n'));
  loading = false;
  setDirty(false); render(); updateCursor(); markTree();
}

/* ---------------- Tabs ---------------- */
// Every open note is a tab with its own text, undo history and scroll position.
// The open tabs (and any unsaved text) are kept between sessions, like Notepad++.
let tabs = [], active = -1;
const blankTab = () => ({ cur: { kind: 'scratch', name: 'untitled.md' }, dirty: false, state: cm.newState(''), scroll: 0 });
function stash(){
  if (active >= 0 && tabs[active]) Object.assign(tabs[active], { cur, dirty, state: view.state, scroll: view.scrollDOM.scrollTop });
}
function useTab(i){
  active = i;
  const t = tabs[i];
  loading = true; cur = t.cur; dirty = t.dirty; cm.swap(t.state); loading = false;
  requestAnimationFrame(() => { view.scrollDOM.scrollTop = t.scroll || 0; });
  $('#bFind').setAttribute('aria-pressed', String(searchPanelOpen(view.state)));
  pv.scrollTop = 0;
  updateTitle(); render(); updateCursor(); markTree(); saveSession();
  if (main.dataset.view !== 'preview') view.focus();
}
async function selectTab(i){
  if (i === active || !tabs[i]) return;
  await flush();
  stash(); useTab(i); checkOutside();
}
async function findTab(info){
  for (let i = 0; i < tabs.length; i++){
    const c = i === active ? cur : tabs[i].cur;
    if (info.kind === 'lib' && c.kind === 'lib' && c.path === info.path) return i;
    if (info.kind === 'loose' && c.kind === 'loose' && info.ref && await Promise.resolve(host.sameRef(c.ref, info.ref)).catch(() => false)) return i;
  }
  return -1;
}
// Open text in a tab: switch to it if that file is already open, reuse an empty untitled tab, or add one.
// "Open notes in a new tab" off (default, like Obsidian): a note replaces the current tab, unless
// that tab has unsaved changes. Ctrl+click / middle-click always opens a new tab.
let newTabs = store.get('newtabs') === '1';
async function openInTab(t, info, forceNew){
  const k = await findTab(info);
  if (k >= 0){ await selectTab(k); return; }
  await flush();
  stash();
  const tab = { cur: { kind: 'scratch', name: 'untitled.md', ...info }, dirty: false, state: cm.newState(t.replace(/\r\n?/g, '\n')), scroll: 0 };
  let i;
  const empty = cur.kind === 'scratch' && !view.state.doc.length;
  if (active >= 0 && !dirty && (empty || !newTabs && !forceNew)){ i = active; tabs[i] = tab; }
  else { i = active + 1; tabs.splice(i, 0, tab); }
  useTab(i);
}
const newTab = () => openInTab('', { kind: 'scratch', name: 'untitled.md' });
async function closeTab(i){
  if (!tabs[i]) return;
  if (i !== active && tabs[i].dirty){ await selectTab(i); i = active; }
  if (i === active && dirty){
    if (cur.kind === 'lib' && autosave) await flush();
    if (dirty){
      const pick = await ask(`${cur.name} has unsaved changes.`, { buttons: [
        { label: 'Cancel', value: null }, { label: "Don't save", value: 'drop' }, { label: 'Save', value: 'save', primary: true }] });
      if (!pick) return;
      if (pick === 'save'){ await save(false); if (dirty) return; }
    }
  }
  if (i === active){
    tabs.splice(i, 1); active = -1;
    if (!tabs.length) tabs.push(blankTab());
    useTab(Math.min(i, tabs.length - 1));
  } else {
    tabs.splice(i, 1);
    if (i < active) active--;
    renderTabs(); saveSession();
  }
}
async function closeTabs(keep){ // close every tab where keep(i) is false, right to left
  for (let i = tabs.length - 1; i >= 0; i--) if (!keep(i)) await closeTab(i);
}
function moveTab(from, to){
  stash();
  const on = tabs[active], [t] = tabs.splice(from, 1);
  tabs.splice(to, 0, t);
  active = tabs.indexOf(on);
  renderTabs(); saveSession();
}
function renderTabs(){
  const list = $('#tabList');
  if (!list) return;
  list.innerHTML = tabs.map((t, i) => {
    const c = i === active ? cur : t.cur, d = i === active ? dirty : t.dirty;
    return `<div class="tab${i === active ? ' on' : ''}${d ? ' dirty' : ''}" data-i="${i}" draggable="true" title="${esc(c.kind === 'lib' ? c.path : c.name)}">` +
      `<span class="nm">${esc(c.name.replace(/\.md$/i, ''))}</span><button class="x" data-x="${i}" title="Close (Ctrl+W)" aria-label="Close tab">×</button></div>`;
  }).join('');
  list.querySelector('.tab.on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function saveSession(now){
  clearTimeout(draftTimer);
  const go = () => {
    stash();
    kvSet('session', { active, tabs: tabs.map(t => ({
      kind: t.cur.kind, name: t.cur.name, path: t.cur.path || null, ref: t.cur.ref || null, mtime: t.cur.mtime || 0,
      lib: t.cur.kind === 'lib' ? lib?.desc.id : null, dirty: t.dirty,
      text: t.cur.kind !== 'lib' || t.dirty ? t.state.doc.toString() : null,
    })) });
  };
  if (now) go(); else draftTimer = setTimeout(go, 400);
}
const tabList = $('#tabList');
tabList.addEventListener('click', e => {
  const x = e.target.closest('.x');
  if (x){ closeTab(+x.dataset.x); return; }
  const t = e.target.closest('.tab');
  if (t) selectTab(+t.dataset.i);
});
tabList.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
tabList.addEventListener('auxclick', e => {
  const t = e.target.closest('.tab');
  if (t && e.button === 1){ e.preventDefault(); closeTab(+t.dataset.i); }
});
$('#tabbar').addEventListener('dblclick', e => {
  const t = e.target.closest('.tab');
  if (!t) newTab(); else if (!e.target.closest('.x')) renameTab(+t.dataset.i);
});
// double-click a tab's name: library notes are renamed on disk; unsaved notes just get a new name
async function renameTab(i){
  stash();
  const c = tabs[i]?.cur; if (!c) return;
  if (c.kind === 'lib'){ if (lib) renamePath(c.path, false); return; }
  if (c.ref){ toast('Use Save as… to give this file a new name'); return; }
  let n = await ask('Rename', { input: c.name.replace(/\.md$/i, '') });
  if (!n) return;
  n = n.replace(/[\\/:*?"<>|]/g, '-');
  c.name = isNote(n) ? n : n + '.md';
  updateTitle(); saveSession();
}
$('#bNewTab').addEventListener('click', newTab);
tabList.addEventListener('contextmenu', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  e.preventDefault();
  const me = tabs[+t.dataset.i];
  showCtx(e.clientX, e.clientY, [
    ['Close', () => closeTab(tabs.indexOf(me))],
    ['Close others', () => closeTabs(k => tabs[k] === me)],
    ['Close tabs to the right', () => closeTabs(k => k <= tabs.indexOf(me))],
  ]);
});
let dragTab = -1;
tabList.addEventListener('dragstart', e => {
  const t = e.target.closest('.tab'); if (!t) return;
  dragTab = +t.dataset.i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/x-markpad-tab', String(dragTab));
});
tabList.addEventListener('dragover', e => { if (dragTab >= 0){ e.preventDefault(); e.dataTransfer.dropEffect = 'move'; } });
tabList.addEventListener('drop', e => {
  if (dragTab < 0) return;
  e.preventDefault(); e.stopPropagation();
  const t = e.target.closest('.tab');
  const to = t ? +t.dataset.i : tabs.length - 1;
  if (to !== dragTab) moveTab(dragTab, to);
  dragTab = -1;
});
tabList.addEventListener('dragend', () => { dragTab = -1; });

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
  if (moveDone) foldDone(pv);
}
// Read view: the ticked items at the end of each checklist go under a "N checked items" fold (Keep-style)
const openFolds = new Set();
function foldDone(root){
  for (const ul of root.querySelectorAll('ul.contains-task, ol.contains-task')){
    const items = [...ul.children];
    let k = items.length;
    while (k > 0 && items[k - 1].classList.contains('done')) k--;
    const done = items.slice(k);
    if (!done.length) continue;
    const key = (items[0]?.textContent || '') + '|' + done[0].textContent;
    const li = document.createElement('li'), d = document.createElement('details'), list = document.createElement(ul.tagName);
    li.className = 'done-group-li'; d.className = 'done-group'; d.open = !openFolds.has('closed:' + key); list.className = 'contains-task';
    d.innerHTML = `<summary>${done.length} checked item${done.length > 1 ? 's' : ''}</summary>`;
    d.addEventListener('toggle', () => { d.open ? openFolds.delete('closed:' + key) : openFolds.add('closed:' + key); });
    list.append(...done); d.append(list); li.append(d); ul.append(li);
  }
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
// with auto-save on, a library note is saved before Markpad moves away from it
async function flush(){ if (autosave && cur.kind === 'lib' && dirty) await save(false, true); return !dirty; }

async function newNote(){
  if (lib){
    const dir = selectedDir();
    const name = await ask('New note', { input: 'Untitled' });
    if (name) await createNote(dir, name);
    return;
  }
  newTab();
}
async function openFile(){
  try {
    const f = await host.openFile();
    if (f){ await openInTab(f.text, { kind: f.ref ? 'loose' : 'scratch', name: f.name, ref: f.ref }); addRecent({ name: f.name, ref: f.ref }); }
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
        if (pick === 'theirs'){ replaceText(await lib.fs.read(cur.path), { mtime: m }); return; }
        if (!pick) return;
      }
      await lib.fs.write(cur.path, t);
      cur.mtime = await lib.fs.mtime(cur.path).catch(() => 0);
      if (sortMode.startsWith('mod')){ mtimes.set(cur.path, cur.mtime); renderTree(); }
      if (!$('#tagPane').hidden && !$('#side').hidden){ const n = noteTexts.find(n => n.f.path === cur.path); if (n){ n.lines = t.split('\n'); buildTags(); } }
      if (text() === t) setDirty(false);
      if (!quiet) toast('Saved');
      return;
    }
    if (!saveAs && cur.kind === 'loose' && cur.ref){
      await host.writeRef(cur.ref, t); setDirty(false); toast('Saved'); return;
    }
    if (!saveAs && cur.kind === 'scratch' && lib){
      const name = await ask('Save as a note in ' + lib.desc.name, { input: (titleOf(t) || 'Untitled') });
      if (name){
        const p = await uniquePath(selectedDir(), name.replace(/\.md$/i, '') + '.md');
        await lib.fs.write(p, t);
        cur = { kind: 'lib', name: basename(p), path: p, mtime: await lib.fs.mtime(p).catch(() => 0) };
        setDirty(false); await refreshTree(); toast('Saved');
        addRecent({ name: basename(p), path: p, lib: lib.desc.id, libName: lib.desc.name });
      }
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

async function exportDocx(){
  const title = (titleOf(text()) || cur.name.replace(/\.\w+$/, '')).trim();
  try {
    const bytes = await toDocx(markdown(text().replace(/^---\n[\s\S]*?\n---\n?/, '')), title);
    if (await host.saveBytes(cur.name.replace(/\.\w+$/, '') + '.docx', bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')) toast('Saved as a Word file');
  } catch (e){ if (e.name !== 'AbortError') toast("Couldn't export: " + (e.message || e)); }
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
  recent = recentMax() ? [entry, ...keep].slice(0, recentMax()) : [];
  showRecent(); kvSet('recent', recent);
}
// how many recent notes to remember: 5, 10, 20 or 50, or 0 = off (nothing is kept)
const recentMax = () => { const v = store.get('recent.max') || '10'; return v === 'off' ? 0 : +v; };
function showRecent(){
  const max = recentMax();
  $('#recentBox').innerHTML = !max ? '<div class="empty">Recent notes are off.</div>' : recent.length ? recent.map((r, k) =>
    `<button class="recent" data-k="${k}" title="${esc(r.path || r.name)}">${esc(r.name)}${r.libName ? ` <span style="color:var(--muted)">· ${esc(r.libName)}</span>` : ''}</button>`).join('') : '<div class="empty">No recent notes yet.</div>';
  for (const b of $('#recentMax').children) b.setAttribute('aria-pressed', String(b.dataset.n === (store.get('recent.max') || '10')));
  $('#bRecentClear').hidden = !recent.length;
}
$('#recentMax').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  store.set('recent.max', b.dataset.n);
  recent = recent.slice(0, recentMax()); kvSet('recent', recent); showRecent();
  toast(recentMax() ? `Remembering the last ${recentMax()} notes` : 'Recent notes are off');
});
$('#bRecentClear').addEventListener('click', () => { recent = []; kvSet('recent', recent); showRecent(); toast('Recent list cleared'); });
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
    await openInTab(await host.readRef(r.ref), { kind: 'loose', name: r.name, ref: r.ref }); addRecent(r);
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
  if (lib && lib.desc.id !== desc.id) await detachLibTabs();
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
  try { tree = await lib.fs.list(); await loadMtimes(); }
  catch (e){ tree = []; toast("Couldn't read the library: " + (e.message || e)); }
  renderTree();
  if (!$('#tagPane').hidden) buildTags(true);
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
// Leaving a library: its saved notes' tabs close; unsaved ones stay open as untitled text.
async function detachLibTabs(){
  await flush();
  stash();
  for (const t of tabs) if (t.cur.kind === 'lib' && t.dirty) t.cur = { kind: 'scratch', name: t.cur.name };
  if (tabs[active]) cur = tabs[active].cur;
  await closeTabs(k => tabs[k].cur.kind !== 'lib');
}
async function closeLibrary(){
  await detachLibTabs();
  lib = null; tree = []; store.set('lib', '');
  renderLibEmpty(); updateTitle(); saveSession();
}
/* Sort order of the file list (like Obsidian's): name A→Z / Z→A, modified new→old / old→new.
   Folders stay on top, sorted by name. Modified times are only fetched while that order is on. */
let sortMode = store.get('sort') || 'name', mtimes = new Map();
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
function sortedList(list){
  const t = n => mtimes.get(n.path) || 0;
  return [...list].sort((a, b) => (!!b.dir - !!a.dir) || (
    sortMode === 'name-desc' ? byName(b, a)
    : a.dir || sortMode === 'name' ? byName(a, b)
    : (sortMode === 'mod' ? t(b) - t(a) : t(a) - t(b)) || byName(a, b)));
}
async function loadMtimes(){
  if (!lib || !sortMode.startsWith('mod')) return;
  const files = allFiles(), ts = await Promise.all(files.map(f => lib.fs.mtime(f.path).catch(() => 0)));
  mtimes = new Map(files.map((f, i) => [f.path, ts[i]]));
}
$('#bSort').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  const item = (mode, label) => [(sortMode === mode ? '✓ ' : '\u2003 ') + label, async () => {
    sortMode = mode; store.set('sort', mode);
    await loadMtimes(); renderTree();
  }];
  showCtx(r.left, r.bottom + 4, [
    item('name', 'File name (A to Z)'), item('name-desc', 'File name (Z to A)'),
    item('mod', 'Modified time (new to old)'), item('mod-asc', 'Modified time (old to new)'),
  ]);
});
function renderTree(){
  renderLibEmpty();
  if (!lib) return;
  const rows = [];
  const walk = (list, depth) => {
    for (const n of sortedList(list)){
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
    openLibFile(p, e.ctrlKey || e.metaKey);
    // on phones the sidebar closes after a short wait, so a double-tap can still rename
    if (window.innerWidth <= 700){ clearTimeout(sideCloseTimer); sideCloseTimer = setTimeout(() => toggleSide(false), 350); }
  }
});
let sideCloseTimer;
$('#tree').addEventListener('dblclick', e => {
  const b = e.target.closest('.row'); if (!b) return;
  clearTimeout(sideCloseTimer);
  renamePath(b.dataset.path, !!b.dataset.dir);
});
async function openLibFile(path, forceNew){
  try {
    const k = await findTab({ kind: 'lib', path });
    if (k >= 0) await selectTab(k);
    else {
      const t = await lib.fs.read(path), mtime = await lib.fs.mtime(path).catch(() => 0);
      await openInTab(t, { kind: 'lib', name: basename(path), path, mtime }, forceNew);
    }
    for (let d = dirname(path); d; d = dirname(d)) expanded.add(d);
    renderTree();
    addRecent({ name: basename(path), path, lib: lib.desc.id, libName: lib.desc.name });
  } catch (e){ toast("Couldn't open " + path + ': ' + (e.message || e)); }
}
async function createNote(dir, name){
  const p = await uniquePath(dir, name.replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '-') + '.md');
  await lib.fs.write(p, '');
  await refreshTree();
  await openLibFile(p);
  return p;
}
async function openWiki(target, forceNew){
  if (!lib){ toast('Wiki links work inside a library (open the sidebar)'); return; }
  const [name, hash] = target.split('#');
  let p = resolveWiki(name);
  if (!p){
    if (!(await confirmBox(`"${name}" doesn't exist yet. Create it?`, 'Create'))) return;
    if (!(await flush())) return;
    p = await createNote('', name.trim());
    return;
  }
  if (p !== cur.path) await openLibFile(p, forceNew);
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
// Menus: items are [label, fn] or [label, null, subItems]. A submenu opens beside its item, on hover with a mouse.
const ctxSub = $('#ctxSub'), hoverable = matchMedia('(hover: hover) and (pointer: fine)');
const closeCtx = () => { ctx.hidden = true; ctxSub.hidden = true; };
function fillMenu(box, items){
  box.innerHTML = '';
  for (const [label, fn, sub] of items){
    const b = document.createElement('button');
    if (sub){
      b.innerHTML = esc(label) + '<span class="key">▸</span>';
      b.onclick = e => { e.stopPropagation(); showSub(b, sub); };
      b.onmouseenter = () => { if (hoverable.matches) showSub(b, sub); };
    } else {
      b.textContent = label;
      b.onclick = () => { closeCtx(); menu.open = false; fn(); };
      if (box === ctx) b.onmouseenter = () => { if (hoverable.matches) ctxSub.hidden = true; };
    }
    box.appendChild(b);
  }
}
function showSub(anchor, items){
  fillMenu(ctxSub, items);
  ctxSub.hidden = false;
  const r = anchor.getBoundingClientRect(), w = ctxSub.offsetWidth;
  ctxSub.style.left = (r.right - 4 + w > innerWidth - 4 ? Math.max(4, r.left - w + 4) : r.right - 4) + 'px';
  ctxSub.style.top = Math.max(4, Math.min(r.top - 5, innerHeight - ctxSub.offsetHeight - 8)) + 'px';
}
// above: the menu opens upward from y (for things at the bottom of the window)
function showCtx(x, y, items, above){
  ctxSub.hidden = true;
  fillMenu(ctx, items);
  ctx.hidden = false;
  ctx.style.left = Math.min(x, innerWidth - 200) + 'px';
  ctx.style.top = Math.max(4, above ? y - ctx.offsetHeight : Math.min(y, innerHeight - ctx.offsetHeight - 8)) + 'px';
}
document.addEventListener('pointerdown', e => { if (!ctx.contains(e.target) && !ctxSub.contains(e.target) && e.target.id !== 'bJb') closeCtx(); });
$('#tree').addEventListener('contextmenu', async e => {
  const b = e.target.closest('.row'); if (!b) return;
  e.preventDefault();
  const p = b.dataset.path, isDir = !!b.dataset.dir, dir = isDir ? p : dirname(p), x = e.clientX, y = e.clientY;
  const items = [
    ['New note here', async () => { const n = await ask('New note', { input: 'Untitled' }); if (n) createNote(dir, n); }],
    ['New folder here', () => newFolder(dir)],
    ['Rename…', () => renamePath(p, isDir)],
    ['Delete (move to .trash)', () => trashPath(p, isDir)],
  ];
  // published notes get their JotBird options
  if (jb.on && !isDir && isNote(p)){
    const pg = pageOf(cur.kind === 'lib' && cur.path === p ? text() : (tabs.find(t => t.cur.kind === 'lib' && t.cur.path === p)?.state.doc.toString() ?? await lib.fs.read(p).catch(() => '')));
    if (pg) items.push(['Published', null, jbNoteItems(p, pg)]);
  }
  showCtx(x, y, items);
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
  const inside = c => c.kind === 'lib' && (c.path === p || c.path.startsWith(p + '/'));
  if (inside(cur)) await flush();
  try {
    const relinks = await planRelinks(p, to);
    await lib.fs.rename(p, to);
    stash();
    for (const t of tabs) if (inside(t.cur)){
      t.cur.path = to + t.cur.path.slice(p.length); t.cur.name = basename(t.cur.path);
      t.cur.mtime = await lib.fs.mtime(t.cur.path).catch(() => 0);
    }
    updateTitle(); saveSession();
    if (expanded.delete(p)) expanded.add(to);
    await refreshTree();
    await applyRelinks(relinks, p, to);
  } catch (e){ toast("Couldn't rename: " + (e.message || e)); }
}
// like Obsidian: after a rename, [[links]] in other notes follow the note to its new name
async function planRelinks(from, to){
  const moved = q => q === from || q.startsWith(from + '/');
  const plan = [];
  stash();
  for (const f of allFiles()){
    if (!/\.md$/i.test(f.name)) continue;
    const t = tabs.find(t => t.cur.kind === 'lib' && t.cur.path === f.path);
    const text = t ? t.state.doc.toString() : await lib.fs.read(f.path).catch(() => '');
    if (!text.includes('[[')) continue;
    const changes = [];
    for (const m of text.matchAll(/(!?\[\[)([^\]|#\n]+)/g)){
      const target = m[2], hit = target.trim() && resolveWiki(target);
      if (!hit || !moved(hit)) continue;
      const np = to + hit.slice(from.length), md = /\.md$/i.test(target.trim()) ? '.md' : '';
      const insert = (target.includes('/') ? np : basename(np)).replace(/\.md$/i, '') + md;
      const at = m.index + m[1].length;
      changes.push({ from: at, to: at + target.length, insert });
    }
    if (changes.length) plan.push({ path: f.path, text, changes });
  }
  return plan;
}
async function applyRelinks(plan, from, to){
  let n = 0;
  stash();
  for (const { path, text, changes } of plan){
    const p = path === from || path.startsWith(from + '/') ? to + path.slice(from.length) : path;
    try {
      const k = tabs.findIndex(t => t.cur.kind === 'lib' && t.cur.path === p);
      if (k === active){
        const clean = !dirty;
        view.dispatch({ changes });
        if (clean) await save(false, true);
      } else if (k >= 0){
        const t = tabs[k];
        t.state = t.state.update({ changes }).state;
        if (!t.dirty){ await lib.fs.write(p, t.state.doc.toString()); t.cur.mtime = await lib.fs.mtime(p).catch(() => 0); }
      } else {
        let out = '', at = 0;
        for (const c of changes){ out += text.slice(at, c.from) + c.insert; at = c.to; }
        await lib.fs.write(p, out + text.slice(at));
      }
      n++;
    } catch (_){}
  }
  if (n) toast(`Updated links in ${n} note${n > 1 ? 's' : ''}`);
}
/* ---------------- Back up & restore: the whole library as one zip, optionally with a password ---------------- */
const today = () => new Date().toLocaleDateString('sv');   // 2026-10-13
async function askPassword(msg, label){
  const go = await ask(msg, { input: '', password: true, buttons: [{ label: 'Cancel', value: null }, { label, value: 'go', primary: true }] });
  return go === 'go' ? $('#askInput').value : null;
}
async function backupLibrary(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  const pw = await askPassword(`Back up “${lib.desc.name}” as a zip.\n\nPassword (optional, leave empty for none). It can't be recovered if you forget it.`, 'Back up');
  if (pw == null) return;
  if (pw){
    if (!/^[\x20-\x7e]+$/.test(pw)){ toast('Use plain keyboard letters, numbers and symbols (no accents or emoji) so other zip apps can open it'); return; }
    if ((await askPassword('Type the password again', 'Back up')) !== pw){ toast("The passwords didn't match"); return; }
  }
  await flush(); stash();
  toast('Making the backup…');
  try {
    const te = new TextEncoder(), files = [];
    for (const f of allFiles()){
      const t = tabs.find(t => t.cur.kind === 'lib' && t.cur.path === f.path);
      files.push({ name: f.path, data: t ? te.encode(t.state.doc.toString()) : isNote(f.name) ? te.encode(await lib.fs.read(f.path)) : await lib.fs.readBin(f.path) });
    }
    if (!files.length){ toast('This library has no notes yet'); return; }
    const zip = await makeZip(files, pw);
    const name = `Markpad backup - ${lib.desc.name.replace(/[\\/:*?"<>|]/g, '-')} - ${today()}.zip`;
    if (await host.shareFile(name, zip)) toast(`Backup ready: ${files.length} file${files.length > 1 ? 's' : ''}${pw ? ', with a password' : ''}`);
  } catch (e){ toast("Couldn't back up: " + (e.message || e)); }
}
async function restoreBackup(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  let z;
  try { z = await host.openZip(); } catch (e){ toast("Couldn't open that file: " + (e.message || e)); return; }
  if (!z) return;
  let files, pw = null;
  for (;;){
    try { files = await readZip(z.bytes, pw); break; }
    catch (e){
      if (e.message !== 'password'){ toast("Couldn't restore: " + e.message); return; }
      pw = await askPassword(pw == null ? `“${z.name}” has a password` : 'Wrong password. Try again', 'Restore');
      if (pw == null) return;
    }
  }
  files = files.filter(f => SHOWN_FILE.test(f.name) && !f.name.split('/').some(p => p === '..' || p.startsWith('.')));
  if (!files.length){ toast('No notes or pictures in that zip'); return; }
  try {
    const dir = await uniquePath('', 'Restored ' + today());
    for (const f of files) await lib.fs.writeBin(normPath(joinPath(dir, f.name.replace(/^\/+/, ''))), f.data);
    expanded.add(dir); selectedFolder = dir;
    await refreshTree();
    toast(`Restored ${files.length} file${files.length > 1 ? 's' : ''} into “${dir}”`);
  } catch (e){ toast("Couldn't restore: " + (e.message || e)); }
}
const SHOWN_FILE = /\.(md|markdown|mdown|mkd|txt|png|jpe?g|gif|webp|svg|bmp|avif)$/i;
async function trashPath(p, isDir){
  if (!(await confirmBox(`Move ${basename(p)}${isDir ? ' and everything in it' : ''} to the library's .trash folder?`, 'Move to trash'))) return;
  try {
    stash();
    const gone = t => t.cur.kind === 'lib' && (t.cur.path === p || t.cur.path.startsWith(p + '/'));
    for (const t of tabs) if (gone(t)) t.dirty = false;
    if (active >= 0 && gone(tabs[active])) dirty = false;
    await closeTabs(k => !gone(tabs[k]));
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
  qsMode = 'files'; $('#qsInput').placeholder = 'Find or create a note…';
  $('#qs').hidden = false; $('#qsInput').value = ''; qsFilter(); $('#qsInput').focus();
}
/* Search in notes (Ctrl+Shift+P): plain words search every note's text; "#tag" lists the notes
   with that tag (nested ones too); empty shows all tags with their counts. */
let qsMode = 'files', noteTexts = [];
async function openSearch(q = ''){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  qsMode = 'search'; $('#qsInput').placeholder = 'Search in notes, or #tag';
  $('#qs').hidden = false; $('#qsInput').value = q; $('#qsInput').focus();
  $('#qsList').innerHTML = '<div class="empty">Reading notes…</div>';
  await readNotes();
  if (qsMode === 'search' && !$('#qs').hidden) qsFilter();
}
// every note's text, split in lines (open tabs count with their unsaved text)
async function readNotes(){
  stash();
  noteTexts = await Promise.all(allFiles().filter(f => isNote(f.name)).map(async f => {
    const t = tabs.find(t => t.cur.kind === 'lib' && t.cur.path === f.path);
    return { f, lines: (t ? t.state.doc.toString() : await lib.fs.read(f.path).catch(() => '')).split('\n') };
  }));
}
// a note's tags with their line numbers: #tags in the text (not in code) and frontmatter "tags:"
function tagsOf(lines){
  const out = [];
  let i = 0;
  if (lines[0]?.trim() === '---'){
    let inTags = false;
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++){
      const l = lines[i], m = l.match(/^tags?:\s*(.*)$/i);
      if (m){ inTags = !m[1].trim(); for (const t of m[1].replace(/[[\]"']/g, '').split(/[,\s]+/)) if (t.replace(/^#/, '')) out.push({ tag: t.replace(/^#/, ''), line: i }); }
      else if (inTags && /^\s*-\s+/.test(l)) out.push({ tag: l.replace(/^\s*-\s+/, '').replace(/["']/g, '').replace(/^#/, '').trim(), line: i });
      else inTags = false;
    }
    i++;
  }
  let fence = false;
  for (; i < lines.length; i++){
    if (FENCE_RE.test(lines[i])){ fence = !fence; continue; }
    if (fence) continue;
    for (const m of lines[i].replace(/`[^`]*`/g, '').matchAll(TAG_RE)) out.push({ tag: m[2], line: i });
  }
  return out;
}
function searchFilter(){
  const q = $('#qsInput').value.trim().toLowerCase();
  const name = f => esc(f.name.replace(/\.md$/i, ''));
  qsHits = []; qsOn = 0;
  let html = '';
  if (!q){   // every tag in the library, most used first
    const count = new Map();
    for (const { lines } of noteTexts) for (const t of new Set(tagsOf(lines).map(x => x.tag.toLowerCase()))) count.set(t, (count.get(t) || 0) + 1);
    const all = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    html = all.map(([t, n], k) => `<button data-tag="${esc(t)}"${k ? '' : ' class="on"'}>#${esc(t)}<small>${n} note${n > 1 ? 's' : ''}</small></button>`).join('')
      || '<div class="empty">No #tags yet. Type words to search inside your notes.</div>';
  } else if (/^#[^\s#]+$/.test(q)){
    const want = q.slice(1);
    for (const { f, lines } of noteTexts){
      const hit = tagsOf(lines).find(x => { const t = x.tag.toLowerCase(); return t === want || t.startsWith(want + '/'); });
      if (hit) qsHits.push({ f, line: hit.line, text: lines[hit.line] });
    }
  } else {
    for (const { f, lines } of noteTexts)
      lines.forEach((l, i) => { if (qsHits.length < 300 && l.toLowerCase().includes(q)) qsHits.push({ f, line: i, text: l }); });
  }
  if (q){
    const hl = t => { t = t.trim().slice(0, 160); const k = t.toLowerCase().indexOf(q);
      return k < 0 ? esc(t) : esc(t.slice(0, k)) + '<mark>' + esc(t.slice(k, k + q.length)) + '</mark>' + esc(t.slice(k + q.length)); };
    html = qsHits.map((h, k) => `<button data-k="${k}"${k ? '' : ' class="on"'}>${name(h.f)}<small>${hl(h.text)}</small></button>`).join('')
      || '<div class="empty">Nothing found</div>';
  }
  $('#qsList').innerHTML = html;
}
function qsFilter(){
  if (qsMode === 'search') return searchFilter();
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
function qsPick(b, forceNew){
  if (b?.dataset.tag){ $('#qsInput').value = '#' + b.dataset.tag; qsFilter(); $('#qsInput').focus(); return; }
  $('#qs').hidden = true;
  if (!b || !b.dataset.k && !b.dataset.new) return;
  if (qsMode === 'search'){ const h = qsHits[+b.dataset.k]; openLibFile(h.f.path, forceNew).then(() => jumpToLine(h.line)); }
  else if (b.dataset.new) flush().then(() => createNote(selectedDir(), $('#qsInput').value.trim()));
  else openLibFile(qsHits[+b.dataset.k].path, forceNew);
}
$('#qsInput').addEventListener('input', qsFilter);
$('#qsInput').addEventListener('keydown', e => {
  const items = [...$('#qsList').children];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
    e.preventDefault();
    items[qsOn]?.classList.remove('on');
    qsOn = (qsOn + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % Math.max(1, items.length);
    items[qsOn]?.classList.add('on'); items[qsOn]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter'){ e.preventDefault(); qsPick(items[qsOn], e.ctrlKey || e.metaKey); }
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
// drag the sidebar's right edge to resize it
const side = $('#side'), grip = $('#sideGrip');
const setSideW = w => { side.style.flexBasis = Math.min(Math.max(w, 160), Math.min(700, innerWidth - 300)) + 'px'; };
if (store.get('sidew')) setSideW(+store.get('sidew'));
grip.addEventListener('pointerdown', e => {
  if (window.innerWidth <= 700) return;
  e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
  const left = side.getBoundingClientRect().left;
  const move = ev => setSideW(ev.clientX - left);
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', () => {
    grip.classList.remove('drag'); grip.removeEventListener('pointermove', move);
    store.set('sidew', parseInt(side.style.flexBasis));
  }, { once: true });
});
grip.addEventListener('dblclick', () => { side.style.flexBasis = ''; store.set('sidew', ''); });
function toggleSide(on = $('#side').hidden){
  $('#side').hidden = !on; $('#bSide').setAttribute('aria-pressed', String(on));
  if (window.innerWidth > 700) store.set('side', on ? '1' : '');
  buildOutline();
}
function showTab(tab){
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#filesPane').hidden = tab !== 'files'; $('#olPane').hidden = tab !== 'outline'; $('#tagPane').hidden = tab !== 'tags';
  $('#pubPane').hidden = tab !== 'published';
  store.set('tab', tab); buildOutline();
  if (tab === 'tags') buildTags(true);
  if (tab === 'published'){ jb.pages = null; $('#pubList').innerHTML = '<div class="empty">Reading notes…</div>'; jbRefreshList(true); }
}
/* Tags tab: every #tag in the library, most used first; click one to see its notes */
let openTagName = null;
async function buildTags(reread){
  const box = $('#tagList');
  if (!lib){ box.innerHTML = '<div class="empty">Open a library (Files tab) to see its tags.</div>'; return; }
  if (reread){ if (!noteTexts.length) box.innerHTML = '<div class="empty">Reading notes…</div>'; await readNotes(); }
  const byTag = new Map();
  for (const { f, lines } of noteTexts){
    for (const t of new Set(tagsOf(lines).map(x => x.tag.toLowerCase()))){
      if (!byTag.has(t)) byTag.set(t, []);
      byTag.get(t).push(f);
    }
  }
  const all = [...byTag].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  box.innerHTML = all.map(([t, fs]) => `<button class="tg${t === openTagName ? ' open' : ''}" data-tag="${esc(t)}">#${esc(t)}<small>${fs.length}</small></button>` +
    (t === openTagName ? fs.map(f => `<button class="tn${cur.kind === 'lib' && cur.path === f.path ? ' on' : ''}" data-path="${esc(f.path)}">${esc(f.name.replace(/\.md$/i, ''))}</button>`).join('') : '')).join('')
    || '<div class="empty">No tags yet. Type #something in a note (like #idea) and it shows up here.</div>';
}
$('#tagList').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tag){ openTagName = openTagName === b.dataset.tag ? null : b.dataset.tag; buildTags(); }
  else { openLibFile(b.dataset.path, e.ctrlKey || e.metaKey).then(() => buildTags()); if (window.innerWidth <= 700) toggleSide(false); }
});
// Outline and Tags tabs can be hidden (Files always stays)
function setTabShown(tab, on){
  document.querySelector(`.tabs [data-tab="${tab}"]`).hidden = !on;
  store.set('hide.' + tab, on ? '' : '1');
  $(tab === 'outline' ? '#bShowOutline' : '#bShowTags').setAttribute('aria-pressed', String(on));
  if (!on && store.get('tab') === tab) showTab('files');
}
for (const [tab, id] of [['outline', '#bShowOutline'], ['tags', '#bShowTags']]){
  $(id).addEventListener('click', () => setTabShown(tab, $(id).getAttribute('aria-pressed') !== 'true'));
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
  underline: () => wrap('<u>', '</u>', 'text'),
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
  undo:  () => { undo(view); view.focus(); },
  redo:  () => { redo(view); view.focus(); },
};
document.querySelectorAll('.fmt button').forEach(b => b.addEventListener('click', () => {
  if (main.dataset.view === 'preview') setView(lastEditView);
  FORMATS[b.dataset.f]();
}));

/* ---------------- Checklists (like Google Keep / Obsidian) ---------------- */
const TASK_RE = /^(\s*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/;
let moveDone = store.get('movedone') === '1';
function setCrossOut(on){
  document.body.classList.toggle('done-strike', on); store.set('nostrike', on ? '' : '1');
  $('#bStrike').setAttribute('aria-pressed', String(on));
}
// lines that belong to the item on line i: the item itself plus anything indented under it
function itemEnd(lines, i){
  const ind = lines[i].match(/^\s*/)[0].length;
  let j = i + 1;
  while (j < lines.length && lines[j].trim() && lines[j].match(/^\s*/)[0].length > ind) j++;
  return j;
}
// Keep-style: a ticked item drops to the end of its list; an unticked one goes back above the ticked ones
function afterTask(pos, nowDone){
  if (!moveDone) return;
  const doc = view.state.doc, lines = doc.toString().split('\n'), i = doc.lineAt(pos).number - 1;
  const ind = lines[i].match(/^\s*/)[0].length, sameLevel = l => TASK_RE.test(l) && l.match(/^\s*/)[0].length === ind;
  let first = i;   // first item of this list at this level
  while (first > 0 && lines[first - 1].trim() && lines[first - 1].match(/^\s*/)[0].length >= ind && (sameLevel(lines[first - 1]) || lines[first - 1].match(/^\s*/)[0].length > ind)) first--;
  let last = i;    // line after the last item
  while (last < lines.length && lines[last].trim() && (sameLevel(lines[last]) || lines[last].match(/^\s*/)[0].length > ind)) last = sameLevel(lines[last]) ? itemEnd(lines, last) : last + 1;
  const end = itemEnd(lines, i), block = lines.slice(i, end);
  const rest = [...lines.slice(first, i), ...lines.slice(end, last)];
  let at;
  if (nowDone) at = rest.length;
  else { at = rest.findIndex(l => sameLevel(l) && /\[[xX]\]/.test(l)); if (at < 0) at = rest.length; }
  rest.splice(at, 0, ...block);
  const from = doc.line(first + 1).from, to = doc.line(last).to;
  const insert = rest.join('\n');
  if (insert !== lines.slice(first, last).join('\n')) view.dispatch({ changes: { from, to, insert }, userEvent: 'input' });
}
function eachTask(fn){ // fn(line, match) → new line or null to delete it
  const lines = view.state.doc.toString().split('\n'), out = [];
  let inFence = false, changed = 0;
  for (let i = 0; i < lines.length; i++){
    const l = lines[i];
    if (FENCE_RE.test(l)) inFence = !inFence;
    const m = !inFence && l.match(TASK_RE);
    if (!m){ out.push(l); continue; }
    const r = fn(l, m);
    if (r === null){ const e = itemEnd(lines, i); i = e - 1; changed++; continue; }
    if (r !== l) changed++;
    out.push(r);
  }
  if (changed) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: out.join('\n') }, userEvent: 'input' });
  return changed;
}
function uncheckAll(){
  const n = eachTask(l => l.replace(/\[[xX]\]/, '[ ]'));
  toast(n ? `Unchecked ${n}` : 'Nothing to uncheck');
}
async function deleteDone(){
  const count = (view.state.doc.toString().match(/^\s*(?:[-*+]|\d{1,9}[.)])[ \t]+\[[xX]\]/gm) || []).length;
  if (!count){ toast('No completed items'); return; }
  if (!(await confirmBox(`Delete ${count} completed item${count > 1 ? 's' : ''}? (Ctrl+Z brings them back)`, 'Delete'))) return;
  eachTask((l, m) => /x/i.test(m[2]) ? null : l);
  toast(`Deleted ${count}`);
}

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
          afterTask(at, m[2] === ' ');
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
  if (a.classList.contains('tag')) openSearch('#' + a.dataset.tag);
  else if (a.classList.contains('wikilink')) openWiki(a.dataset.wiki + (a.dataset.hash ? '#' + a.dataset.hash : ''), e.ctrlKey || e.metaKey);
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
  if (!file) return true;
  let handle = null;
  try { handle = handleP ? await handleP : null; } catch (_) {}
  if (handle && handle.kind !== 'file') handle = null;
  await openInTab(await file.text(), { kind: handle ? 'loose' : 'scratch', name: file.name, ref: handle });
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
function applyTheme(t){
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  host.bars?.(getComputedStyle(document.documentElement).colorScheme.includes('dark'));
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme')));
// tap: light/dark. Hold it (or right-click) for the accent colors.
{ let hold = 0, held = false;
  const bt = $('#bTheme');
  bt.title = 'Light/dark (hold for accent colors)';
  bt.addEventListener('pointerdown', () => { held = false; clearTimeout(hold); hold = setTimeout(() => { held = true; openAccent(); }, 500); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) bt.addEventListener(ev, () => clearTimeout(hold));
  bt.addEventListener('contextmenu', e => { e.preventDefault(); if (!held) openAccent(); held = true; });
  bt.addEventListener('click', () => {
    if (held){ held = false; return; }
    const t = getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'light' : 'dark';
    applyTheme(t); store.set('theme', t);
  });
}
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
// The ▾ menu's sections open beside it, on hover with a mouse or on a tap. Settings holds two more (Checklists, Backup):
// with a mouse they open beside Settings; on a phone they take Settings' place, with ‹ Back at the top.
const panels = [...menu.querySelectorAll('.panel')];
const place = (p, r) => {
  const w = p.offsetWidth;
  p.style.left = (r.right - 4 + w > innerWidth - 4 ? Math.max(4, r.left - w + 4) : r.right - 4) + 'px';
  p.style.top = Math.max(4, Math.min(r.top - 5, innerHeight - p.offsetHeight - 8)) + 'px';
};
function closePanels(only){
  for (const p of panels) if (!only || p.dataset.parent === only){ p.hidden = true; $(`[data-panel="${p.id}"]`)?.classList.remove('open'); }
}
function openPanel(trigger){
  const p = $('#' + trigger.dataset.panel), parent = p.dataset.parent && $('#' + p.dataset.parent);
  ctxSub.hidden = true;
  if (parent){
    closePanels(parent.id);
    trigger.classList.add('open'); p.hidden = false;
    if (hoverable.matches) place(p, trigger.getBoundingClientRect());
    else { p.style.left = parent.style.left; p.style.top = parent.style.top; parent.hidden = true; }   // drill down
    return;
  }
  closePanels();
  trigger.classList.add('open'); p.hidden = false;
  place(p, trigger.getBoundingClientRect());
}
menu.querySelector('.menu-list').addEventListener('mouseover', e => {
  const b = e.target.closest('button'); if (!b || !hoverable.matches) return;
  const inPanel = b.closest('.panel');
  if (b.dataset.panel){ if (!b.classList.contains('open')) openPanel(b); return; }
  if (inPanel){ if (!inPanel.dataset.parent) closePanels(inPanel.id); return; }   // other Settings items close Checklists/Backup
  closePanels(); if (b.id !== 'bJb') ctxSub.hidden = true;
});
for (const b of menu.querySelectorAll('.has-sub')) b.addEventListener('click', e => {
  e.preventDefault();
  if (b.classList.contains('open') && !hoverable.matches && !b.closest('.panel')) closePanels(); else openPanel(b);
});
for (const b of menu.querySelectorAll('.panel .back')) b.addEventListener('click', e => {
  const p = b.closest('.panel'), parent = $('#' + p.dataset.parent);
  e.preventDefault(); p.hidden = true; $(`[data-panel="${p.id}"]`)?.classList.remove('open'); parent.hidden = false;
});
menu.addEventListener('toggle', () => {
  if (!menu.open){ ctxSub.hidden = true; closePanels(); return; }
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
$('#bSearch').addEventListener('click', closeMenu(() => openSearch()));
$('#bBackup').addEventListener('click', closeMenu(backupLibrary));
$('#bRestore').addEventListener('click', closeMenu(restoreBackup));
$('#bExport').addEventListener('click', closeMenu(exportHtml));
$('#bDocx').addEventListener('click', closeMenu(exportDocx));
$('#bPrint').addEventListener('click', closeMenu(() => { pv.innerHTML = markdown(text()); fillPreview(); setTimeout(() => host.print(), 300); }));
$('#bAutosave').setAttribute('aria-pressed', String(autosave));
$('#bAutosave').addEventListener('click', () => {
  autosave = !autosave; store.set('autosave', autosave ? '1' : '0');
  $('#bAutosave').setAttribute('aria-pressed', String(autosave));
  toast(autosave ? 'Library notes save as you type' : 'Library notes save with Ctrl+S');
  if (autosave && dirty && cur.kind === 'lib') save(false, true);
});
// Readable line length (Obsidian's name): on keeps a comfortable column, off fills the window
function setReadable(on){
  document.body.classList.toggle('readable', on); store.set('readable', on ? '1' : '');
  $('#bReadable').setAttribute('aria-pressed', String(on));
}
setReadable(!!store.get('readable'));
$('#bReadable').addEventListener('click', () => { setReadable(!document.body.classList.contains('readable')); syncScroll('ed'); });
setCrossOut(!store.get('nostrike'));
$('#bStrike').addEventListener('click', () => setCrossOut(!document.body.classList.contains('done-strike')));
$('#bMoveDone').setAttribute('aria-pressed', String(moveDone));
$('#bMoveDone').addEventListener('click', () => {
  moveDone = !moveDone; store.set('movedone', moveDone ? '1' : '');
  cm.regroup(); render();
  $('#bMoveDone').setAttribute('aria-pressed', String(moveDone));
  toast(moveDone ? 'Ticked items move to the bottom of their list' : 'Ticked items stay where they are');
});
$('#bUncheck').addEventListener('click', closeMenu(uncheckAll));
$('#bDelDone').addEventListener('click', closeMenu(deleteDone));
$('#bNewTabs').setAttribute('aria-pressed', String(newTabs));
$('#bNewTabs').addEventListener('click', () => {
  newTabs = !newTabs; store.set('newtabs', newTabs ? '1' : '');
  $('#bNewTabs').setAttribute('aria-pressed', String(newTabs));
  toast(newTabs ? 'Notes open in a new tab' : 'Notes open in the current tab (Ctrl+click for a new one)');
});
// middle-click a note in the file tree: new tab
$('#tree').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
$('#tree').addEventListener('auxclick', e => {
  const b = e.target.closest('.row');
  if (b && e.button === 1 && !b.dataset.dir){ e.preventDefault(); openLibFile(b.dataset.path, true); }
});
$('#aboutLine').textContent = `Markpad ${VERSION} · ${host.kind === 'browser' ? 'web' : host.kind}`;
// hidden "Don't count me": tap the version line 5 times. skipgc is GoatCounter's own skip flag (per device).
{ let taps = 0, timer;
  $('#aboutLine').addEventListener('click', () => {
    clearTimeout(timer); timer = setTimeout(() => taps = 0, 1500);
    if (++taps < 5) return;
    taps = 0;
    const skip = localStorage.getItem('skipgc') !== 't';
    if (skip) localStorage.setItem('skipgc', 't'); else localStorage.removeItem('skipgc');
    toast(skip ? 'Not counting this device' : 'Counting this device');
  });
}

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (!$('#ask').hidden || !$('#qs').hidden) return;
  if (e.key === 'Escape'){
    if (!ctxSub.hidden){ ctxSub.hidden = true; return; }
    if (panels.some(p => !p.hidden)){ closePanels(); return; }
    if (!ctx.hidden){ ctx.hidden = true; return; }
    if (menu.open){ menu.open = false; return; }
    if (!$('#jbDlg').hidden){ $('#jbDlg').hidden = true; return; }
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
  else if (k === 'p' && e.shiftKey){ e.preventDefault(); openSearch(); }
  else if (k === 'p'){ e.preventDefault(); openSwitcher(); }
  else if (k === 'n'){ e.preventDefault(); newNote(); }
  else if (k === 't'){ e.preventDefault(); newTab(); }
  else if (k === 'w'){ e.preventDefault(); closeTab(active); }
  else if (k === 'tab' || k === 'pagedown' || k === 'pageup'){
    e.preventDefault();
    const back = k === 'pageup' || (k === 'tab' && e.shiftKey);
    selectTab((active + (back ? tabs.length - 1 : 1)) % tabs.length);
  }
  else if (/^[1-9]$/.test(k) && !e.shiftKey){ e.preventDefault(); selectTab(k === '9' ? tabs.length - 1 : +k - 1); }
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
    const keep = sel().head, top = view.scrollDOM.scrollTop, t = await lib.fs.read(cur.path);
    replaceText(t, { mtime: m });
    view.dispatch({ selection: { anchor: Math.min(keep, view.state.doc.length) } });
    view.scrollDOM.scrollTop = top;
    toast('Reloaded: changed outside Markpad');
  } else save(false, true);
}
window.addEventListener('focus', () => { checkOutside(); if (lib) refreshTree(); });
document.addEventListener('visibilitychange', () => { if (document.hidden){ flush(); saveSession(true); } });
window.addEventListener('pagehide', () => saveSession(true));
// Closing never loses anything: unsaved tabs come back next time (like Notepad++).
host.onClose(async () => { await flush(); saveSession(true); await new Promise(r => setTimeout(r, 150)); return true; });

/* ---------------- JotBird: publish a note as a web page ---------------- */
// Only the apps can publish (JotBird blocks web pages). Until it's set up, the ▾ menu shows just "Publish…";
// after that a JotBird ▸ menu, the "Published" label after the note name at the bottom, and the Published tab.
// The link lives in the note itself (jotbird_link / jotbird_expires, same as JotBird's Obsidian plugin).
// The account key and the edit tokens of no-account pages stay on this device.
// Pro things (page styles, hiding JotBird's line, passwords) only ever show when the account is Pro.
const jb = {
  can: !!host.http,
  on: store.get('jb.on') === '1',
  key: store.get('jb.key') || '',
  pro: store.get('jb.pro') === '1',
  fp: store.get('jb.fp') || (() => { const f = crypto.randomUUID(); store.set('jb.fp', f); return f; })(),
  busy: false, pages: null,   // pages: the account's own list (with real expiry dates)
};
const jbDocs = () => { try { return JSON.parse(store.get('jb.docs') || '{}'); } catch (_) { return {}; } };
const jbSaveDoc = (slug, info) => { const d = jbDocs(); if (info) d[slug] = { ...d[slug], ...info }; else delete d[slug]; store.set('jb.docs', JSON.stringify(d)); };
const jbOpt = (k, def) => (store.get('jb.' + k) ?? (def ? '1' : '')) === '1';
const jbHere = () => jb.on ? pageOf(text()) : null;
// the account's own list knows the real expiry (Pro pages never expire), so it wins over the note's copy
const jbDays = p => { const pg = jb.pages?.find(x => x.slug === p.slug); return daysLeft(pg ? pg.expiresAt : p.expires); };
// green while more than a week is left, yellow at a week, red under a week, grey once gone
const dayClass = d => d == null || d > 7 ? '' : d === 7 ? 'week' : d >= 0 ? 'soon' : 'gone';
const jbOwned = p => jb.key && !(jbDocs()[p.slug] || {}).editToken;   // page belongs to the logged-in account

async function jbCheckPro(){
  if (!jb.key){ jb.pro = false; store.set('jb.pro', ''); return; }
  try {
    const r = await listPages(jb.key);
    jb.pages = r.documents || []; jb.pro = !!r.isPro; store.set('jb.pro', jb.pro ? '1' : '');
  } catch (_) {}
  jbChip();
}

function jbRefresh(){
  const b = $('#bJb');
  b.hidden = !jb.can;
  b.innerHTML = jb.on ? 'JotBird<span class="key">▸</span>' : 'Publish…';
  $('#bShowPub').hidden = !jb.on;
  const tabOn = jb.on && !store.get('hide.published');
  document.querySelector('.tabs [data-tab="published"]').hidden = !tabOn;
  $('#bShowPub').setAttribute('aria-pressed', String(tabOn));
  if (!tabOn && store.get('tab') === 'published') showTab('files');
  jbChip();
}
function jbChip(){
  const p = jbHere(), c = $('#jbChip');
  c.hidden = !p; if (!p) return;
  const d = jbDays(p);
  $('#jbChipText').textContent = d != null && d < 0 ? 'Expired' : 'Published' + (d != null ? ` · ${d}d` : '');
  c.className = dayClass(d);
  c.title = `${p.link} · ${leftText(d)}`;
}

// what can be done with a published note (the open one, or one picked in the file list or Published tab)
function jbNoteItems(path, p){
  const open = fn => async () => { if (path && !(cur.kind === 'lib' && cur.path === path)) await openLibFile(path); fn(); };
  return [
    [jbDays(p) < 0 ? 'Publish again' : 'Update page', open(() => jbPublish())],
    ['Copy link', () => jbCopy(p.link)],
    ['Open page', () => host.openExternal(p.link)],
    ...(jbOwned(p) ? [['Page settings…', open(() => jbPageSettings())]] : []),
    ['Unpublish…', open(() => jbUnpublish())],
  ];
}
// the ▾ JotBird ▸ menu and the label's menu
function jbItems(){
  const p = jbHere();
  return [
    ...(p ? jbNoteItems(null, p) : [['Publish this note', () => jbPublish()]]),
    ['Published notes…', () => jbList()],
    ['JotBird settings…', () => jbSettings()],
  ];
}
$('#bJb').addEventListener('click', e => {
  if (!jb.on){ menu.open = false; jbSetup(); return; }
  e.stopPropagation(); closePanels(); showSub(e.currentTarget, jbItems());
});
// on a computer it opens on hover, like any menu
$('#bJb').addEventListener('mouseenter', e => { if (jb.on && hoverable.matches){ closePanels(); showSub(e.currentTarget, jbItems()); } });
$('#jbChip').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); e.stopPropagation(); showCtx(r.left, r.top - 4, jbItems(), true); });

async function jbCopy(link){
  try { await navigator.clipboard.writeText(link); toast('Link copied'); }
  catch (_) { await ask('Copy this link:', { input: link, buttons: [{ label: 'Close', value: null, primary: true }] }); }
}

// first time: with or without an account
async function jbSetup(){
  const how = await ask('Publish with JotBird\n\nJotBird turns a note into a web page with a link you can share. Publishing the note again updates the same page.\n\nWithout an account, links last 30 days. With a free account they last 90 days, and the Published list also shows pages you made elsewhere (like Obsidian).', {
    buttons: [{ label: 'Cancel', value: null }, { label: 'Without an account', value: 'anon' }, { label: 'Log in / free account', value: 'login', primary: true }],
  });
  if (!how) return;
  if (how === 'login' && !(await jbLogin())) return;
  jb.on = true; store.set('jb.on', '1'); jbRefresh();
  await jbPublish();
}
async function jbLogin(){
  host.openExternal(KEY_PAGE);
  const key = await ask('Markpad opened jotbird.com in your browser. Log in (or make a free account), copy your API key, and paste it here.', { input: '', buttons: [{ label: 'Cancel', value: null }, { label: 'Log in', value: true, primary: true }] });
  if (!key) return false;
  let r;
  try { r = await listPages(key.trim()); }
  catch (e){ toast("That key didn't work: " + e.message); return false; }
  jb.key = key.trim(); store.set('jb.key', jb.key);
  jb.pages = r.documents || []; jb.pro = !!r.isPro; store.set('jb.pro', jb.pro ? '1' : '');
  // pages made without an account on this device move into the account
  for (const [slug, d] of Object.entries(jbDocs())) if (d.editToken){
    try { await claim(jb.key, slug, d.editToken); jbSaveDoc(slug, { editToken: undefined }); } catch (_) {}
  }
  jb.pages = null; jbCheckPro();
  toast(jb.pro ? 'Logged in to JotBird (Pro)' : 'Logged in to JotBird');
  return true;
}

// rewrite the top of the open note (keeps the cursor and undo)
function jbSetPage(page){
  const old = text(), t = withPage(old, page);
  if (t === old) return;
  let tail = 0; while (tail < t.length && tail < old.length && t[t.length - 1 - tail] === old[old.length - 1 - tail]) tail++;
  view.dispatch({ changes: { from: 0, to: old.length - tail, insert: t.slice(0, t.length - tail) }, userEvent: 'input' });
}
async function jbSaveNote(){
  if (cur.kind === 'lib') await save(false, true);
  else if (cur.kind === 'loose' && cur.ref) await save(false);
}

// pictures in a library note go up to JotBird first (account only)
async function jbPictures(md, notePath){
  const found = [...md.matchAll(/!\[\[([^\]|]+\.(?:png|jpe?g|gif|webp))(?:\|[^\]]*)?\]\]|!\[([^\]]*)\]\((?!https?:)([^)\s]+\.(?:png|jpe?g|gif|webp))\)/gi)];
  if (!found.length) return { md, skipped: 0 };
  if (!jb.key || !notePath || !lib) return { md, skipped: found.length };
  let skipped = 0;
  for (const m of found){
    const p = m[1] ? findFile(m[1]) : (() => { let s = m[3]; try { s = decodeURI(s); } catch (_) {} return normPath(joinPath(dirname(notePath), s)); })();
    try {
      if (!p) throw 0;
      const url = await uploadImage(jb.key, await lib.fs.readBin(p), basename(p));
      md = md.split(m[0]).join(`![${m[2] || ''}](${url})`);
    } catch (_) { skipped++; }
  }
  return { md, skipped };
}
// publish (or update) one note's text; returns the new { link, expires } and how many pictures were left out
async function jbSend(t, name, notePath){
  const old = pageOf(t), title = pageTitle(t, name), doc = old ? jbDocs()[old.slug] || {} : {};
  const { md, skipped } = await jbPictures(pageText(t, title), notePath);
  const r = await publish({ key: jb.key, fp: jb.fp, markdown: md, title, slug: old?.slug, documentId: doc.documentId, editToken: doc.editToken });
  jbSaveDoc(r.slug, { documentId: r.documentId, publishedAt: new Date().toISOString(), ...(r.editToken ? { editToken: r.editToken } : {}) });
  return { page: { link: r.url, expires: r.ttlDays ? (r.expiresAt || '').slice(0, 10) : 'never' }, skipped };
}

async function jbPublish(){
  if (jb.busy) return;
  const t = text(), old = pageOf(t);
  if (!t.replace(/^---\n[\s\S]*?\n---\n?/, '').trim()){ toast('This note is empty'); return; }
  if (!old && jbOpt('ask') && !(await confirmBox(`Publish “${cur.name.replace(/\.md$/i, '')}” as a web page?`, 'Publish'))) return;
  jb.busy = true; toast(old ? 'Updating the page…' : 'Publishing…');
  try {
    const { page, skipped } = await jbSend(t, cur.name, cur.kind === 'lib' ? cur.path : null);
    jbSetPage(page);
    await jbSaveNote(); jb.pages = null; jbCheckPro(); jbChip(); jbRefreshList();
    if (jbOpt('copy', true)){ try { await navigator.clipboard.writeText(page.link); } catch (_) {} }
    const what = old ? 'Page updated' : 'Published';
    toast(skipped ? `${what}. ${skipped} picture${skipped > 1 ? 's' : ''} left out${jb.key ? '' : ' (pictures need a free account)'}` : jbOpt('copy', true) ? `${what} · link copied` : what);
  } catch (e){ toast("Couldn't publish: " + e.message); }
  finally { jb.busy = false; }
}

async function jbUnpublish(){
  const p = jbHere(); if (!p) return;
  if (!(await confirmBox('Take this page off the web? The link stops working. The note itself stays as it is.', 'Unpublish'))) return;
  const doc = jbDocs()[p.slug] || {};
  try {
    if (!jb.key && !doc.editToken) throw new Error('this page was published from another device or app. Log in to JotBird to remove it');
    await unpublish({ key: jb.key, fp: jb.fp, slug: p.slug, documentId: doc.documentId, editToken: doc.editToken });
  } catch (e){
    if (!/not found|404/i.test(e.message)){ toast("Couldn't unpublish: " + e.message); return; }   // already gone: just tidy the note
  }
  jbSaveDoc(p.slug, null); jbSetPage(null); await jbSaveNote(); jbChip(); jb.pages = null; jbRefreshList();
  toast('Unpublished');
}

// Renew all: publish again every page with a week or less left (or already expired), which restarts its clock
async function jbExpiring(){
  if (!lib) return [];
  await readNotes();
  return noteTexts.map(({ f, lines }) => ({ f, p: pageOf(lines.join('\n')) })).filter(x => x.p && jbDays(x.p) != null && jbDays(x.p) <= 7);
}
async function jbRenewAll(){
  if (jb.busy) return;
  const list = await jbExpiring();
  if (!list.length){ toast('Nothing is close to expiring'); return; }
  if (!(await confirmBox(`Renew ${list.length} page${list.length > 1 ? 's' : ''} that expire${list.length > 1 ? '' : 's'} within a week? Each is published again${jb.pro ? ' and then never expires' : ` and gets a fresh ${jb.key ? '90' : '30'} days`}.`, 'Renew'))) return;
  jb.busy = true; stash();
  let done = 0, failed = 0;
  for (const { f } of list){
    toast(`Renewing ${done + failed + 1} of ${list.length}…`);
    try {
      const k = tabs.findIndex(t => t.cur.kind === 'lib' && t.cur.path === f.path);
      const t = k >= 0 ? (k === active ? text() : tabs[k].state.doc.toString()) : await lib.fs.read(f.path);
      const { page } = await jbSend(t, f.name, f.path);
      if (k === active){ jbSetPage(page); await jbSaveNote(); }
      else {
        const nt = withPage(t, page);
        if (k >= 0){ tabs[k].state = cm.newState(nt); if (!tabs[k].dirty) await lib.fs.write(f.path, nt); }
        else await lib.fs.write(f.path, nt);
      }
      done++;
    } catch (_) { failed++; }
  }
  jb.busy = false; jb.pages = null; await jbCheckPro(); jbRefreshList(true);
  toast(failed ? `Renewed ${done}; ${failed} couldn't be renewed` : `Renewed ${done} page${done > 1 ? 's' : ''}`);
}

/* the Published list: notes in the library with a JotBird link, soonest to expire first, plus (with an account)
   pages that aren't in this library */
async function jbListHtml(reread){
  if (!lib) return '<div class="empty">Open a library (Files tab) to see its published notes.</div>';
  if (reread || !noteTexts.length) await readNotes();
  if (jb.key && !jb.pages) await jbCheckPro();
  const notes = [];
  for (const { f, lines } of noteTexts){
    const p = pageOf(lines.join('\n'));
    if (p) notes.push({ f, p, d: jbDays(p) });
  }
  const order = x => x.d == null ? 1e9 : x.d;
  const by = { expiry: (a, b) => order(a) - order(b), 'expiry-desc': (a, b) => order(b) - order(a),
    name: (a, b) => byName(a.f, b.f), 'name-desc': (a, b) => byName(b.f, a.f),
    pub: (a, b) => (b.when || '').localeCompare(a.when || ''), 'pub-asc': (a, b) => (a.when || '~').localeCompare(b.when || '~') };
  for (const n of notes) n.when = (jb.pages?.find(x => x.slug === n.p.slug)?.updatedAt) || jbDocs()[n.p.slug]?.publishedAt || '';
  notes.sort(by[store.get('pubsort')] || by.expiry);
  const soon = notes.filter(n => n.d != null && n.d <= 7).length;
  let html = (soon ? `<button class="renew" data-a="renew">↻ Renew ${soon} expiring page${soon > 1 ? 's' : ''}</button>` : '') +
    (notes.map(({ f, p, d }) => `<button class="pg ${dayClass(d)}${cur.kind === 'lib' && cur.path === f.path ? ' on' : ''}" data-path="${esc(f.path)}" data-link="${esc(p.link)}">${esc(f.name.replace(/\.md$/i, ''))}<small>${leftText(d)}</small></button>`).join('')
    || '<div class="empty">No published notes yet. Open a note and pick Publish this note in ▾ JotBird ▸.</div>');
  if (jb.key && jb.pages){
    const mine = new Set(notes.map(n => n.p.slug));
    const other = jb.pages.filter(pg => !mine.has(pg.slug)).map(pg => ({ pg, d: daysLeft(pg.expiresAt) })).sort((a, b) => order(a) - order(b));
    if (other.length) html += '<div class="head">On your JotBird account (not in this library)</div>' + other.map(({ pg, d }) =>
      `<button class="pg ${dayClass(d)}" data-link="${esc(pg.url)}">${esc(pg.title || pg.slug)}<small>${leftText(d)}</small></button>`).join('');
  }
  return html;
}
async function jbRefreshList(reread){
  if (!$('#pubPane').hidden) $('#pubList').innerHTML = await jbListHtml(reread);
  if (!$('#jbDlg').hidden && $('#jbBody .publist')) $('#jbBody .publist').innerHTML = await jbListHtml(reread);
}
function jbListClick(e){
  if (!e.target.closest('.publist')) return;
  if (e.target.closest('[data-a="renew"]')){ $('#jbDlg').hidden = true; jbRenewAll(); return; }
  const b = e.target.closest('button.pg'); if (!b) return;
  if (!b.dataset.path){ host.openExternal(b.dataset.link); return; }
  $('#jbDlg').hidden = true;
  openLibFile(b.dataset.path, e.ctrlKey || e.metaKey).then(() => jbRefreshList());
  if (window.innerWidth <= 700) toggleSide(false);
}
async function jbListMenu(e){
  const b = e.target.closest('button.pg'); if (!b) return;
  e.preventDefault();
  const link = b.dataset.link, path = b.dataset.path;
  if (!path){ showCtx(e.clientX, e.clientY, [['Open page', () => host.openExternal(link)], ['Copy link', () => jbCopy(link)]]); return; }
  const p = pageOf(cur.kind === 'lib' && cur.path === path ? text() : await lib.fs.read(path).catch(() => ''));
  if (p) showCtx(e.clientX, e.clientY, [['Open note', () => openLibFile(path)], ...jbNoteItems(path, p)]);
}
for (const id of ['#pubList', '#jbBody']){
  $(id).addEventListener('click', jbListClick);
  $(id).addEventListener('contextmenu', jbListMenu);
}

// save: when given, the dialog shows Cancel + Save instead of Close
let jbOnSave = null;
function jbDialog(title, html, save){
  $('#jbTitle').textContent = title; $('#jbBody').innerHTML = html; $('#jbBody').onclick = null; $('#jbDlg').hidden = false;
  jbOnSave = save || null;
  $('#jbCancel').hidden = !save; $('#jbClose').textContent = save ? 'Save' : 'Close';
}
$('#jbClose').addEventListener('click', () => { if (jbOnSave) jbOnSave(); else $('#jbDlg').hidden = true; });
$('#jbCancel').addEventListener('click', () => { $('#jbDlg').hidden = true; });
$('#jbDlg').addEventListener('click', e => { if (e.target.id === 'jbDlg') $('#jbDlg').hidden = true; });
async function jbList(){
  jbDialog('Published notes', '<div class="publist"><div class="empty">Reading notes…</div></div>');
  $('#jbBody .publist').innerHTML = await jbListHtml(true);
}

function jbSettings(){
  const sw = (k, def) => jbOpt(k, def) ? 'On' : 'Off';
  const acct = !jb.key ? 'Not logged in · links last 30 days' : jb.pro ? 'Logged in · Pro · your pages never expire' : 'Logged in · free account · links last 90 days';
  jbDialog('JotBird', `
    <div class="set"><div>Account<small>${acct}</small></div><button data-a="acct">${jb.key ? 'Log out' : 'Log in'}</button></div>
    <div class="set"><div>Copy the link after publishing</div><button data-a="copy">${sw('copy', true)}</button></div>
    <div class="set"><div>Ask before publishing<small>A quick “Publish this note?” check</small></div><button data-a="ask">${sw('ask')}</button></div>
    <div class="set"><div>Renew expiring pages<small>Publishes again every page with a week or less left</small></div><button data-a="renew">Renew all</button></div>
    <div class="set"><div>Turn off JotBird<small>Hides it again; the ▾ menu goes back to just “Publish…”. Pages stay online.</small></div><button data-a="off">Turn off</button></div>`);
  if (jb.key) jbCheckPro().then(() => { if ($('#jbTitle').textContent === 'JotBird' && !$('#jbDlg').hidden){
    const s = $('#jbBody [data-a="acct"]')?.previousElementSibling?.querySelector('small');
    if (s) s.textContent = jb.pro ? 'Logged in · Pro · your pages never expire' : 'Logged in · free account · links last 90 days';
  } });
}

// one page's settings (account pages only). Visibility for everyone; style, branding and password only with Pro.
async function jbPageSettings(){
  const p = jbHere(); if (!p || !jbOwned(p)) return;
  const target = { slug: p.slug, documentId: (jbDocs()[p.slug] || {}).documentId };
  let save = () => { $('#jbDlg').hidden = true; };
  jbDialog('Page settings', '<div class="empty">Asking JotBird…</div>', () => save());
  let v;
  try { [v] = await Promise.all([getSettings(jb.key, target), jbCheckPro()]); }
  catch (e){ $('#jbBody').innerHTML = `<div class="empty">Couldn't load this page's settings: ${esc(e.message)}</div>`; return; }
  if (v.namespaced) target.namespaced = true;
  const want = { visibility: v.visibility, theme: v.theme, hideBranding: !!v.hideBranding, password: '' };
  const choice = (key, val, label, tag) => `<button class="opt${want[key] === val ? ' on' : ''}" data-k="${key}" data-v="${val}">${label}${tag ? `<small>${tag}</small>` : ''}</button>`;
  const draw = () => {
    $('#jbBody').innerHTML = `
      <div class="pageurl">${esc(v.url || p.link)}</div>
      <div class="set col"><div>Who can find it</div><div class="opts">
        ${choice('visibility', 'unlisted', 'Link only')}${choice('visibility', 'public', 'Public')}${jb.pro ? choice('visibility', 'password', 'Password', 'Pro') : ''}
      </div>${want.visibility === 'password' ? `<input id="jbPw" type="password" placeholder="${v.visibility === 'password' ? 'Leave blank to keep the current password' : 'Password (4–64 characters)'}" value="${esc(want.password)}">` : ''}</div>
      ${jb.pro ? `<div class="set col"><div>Page style</div><div class="opts">
        ${Object.entries(PAGE_STYLES).map(([k, n]) => choice('theme', k, n, k === 'default' ? 'Free' : 'Pro')).join('')}
      </div></div>
      <div class="set"><div>Hide “Published with JotBird”<small>Pro</small></div><button class="opt${want.hideBranding ? ' on' : ''}" data-k="hideBranding" data-v="${!want.hideBranding}">${want.hideBranding ? 'Hidden' : 'Shown'}</button></div>` : ''}`;
  };
  draw();
  $('#jbBody').onclick = async e => {
    const o = e.target.closest('button[data-k]');
    if (o){ if ($('#jbPw')) want.password = $('#jbPw').value; want[o.dataset.k] = o.dataset.k === 'hideBranding' ? o.dataset.v === 'true' : o.dataset.v; draw(); }
  };
  save = async () => {
    if ($('#jbPw')) want.password = $('#jbPw').value;
    const patch = {};
    if (want.visibility !== v.visibility || want.password) patch.visibility = want.visibility;
    if (want.visibility === 'password' && want.password){
      if (want.password.length < 4 || want.password.length > 64){ toast('The password needs 4 to 64 characters'); return; }
      patch.password = want.password;
    } else if (want.visibility === 'password' && v.visibility !== 'password'){ toast('Type a password for the page'); return; }
    if (jb.pro && want.theme !== v.theme) patch.theme = want.theme;
    if (jb.pro && want.hideBranding !== !!v.hideBranding) patch.hideBranding = want.hideBranding;
    if (!Object.keys(patch).length){ $('#jbDlg').hidden = true; return; }
    try { await setSettings(jb.key, target, patch); $('#jbDlg').hidden = true; toast('Page settings saved'); }
    catch (err){ toast("Couldn't save: " + err.message); }
  };
}

$('#jbBody').addEventListener('click', async e => {
  const a = e.target.closest('button[data-a]')?.dataset.a; if (!a || $('#jbTitle').textContent !== 'JotBird') return;
  if (a === 'copy' || a === 'ask'){ store.set('jb.' + a, jbOpt(a, a === 'copy') ? '0' : '1'); jbSettings(); }
  else if (a === 'renew'){ $('#jbDlg').hidden = true; jbRenewAll(); }
  else if (a === 'acct'){
    if (jb.key){ jb.key = ''; store.set('jb.key', ''); jb.pro = false; store.set('jb.pro', ''); jb.pages = null; toast('Logged out of JotBird'); }
    else { $('#jbDlg').hidden = true; await jbLogin(); }
    jbSettings(); jbRefreshList(); jbChip();
  } else if (a === 'off'){
    if (!(await confirmBox('Turn off JotBird? Your pages stay online and the links stay in your notes.', 'Turn off'))) return;
    jb.on = false; store.set('jb.on', ''); jb.key = ''; store.set('jb.key', ''); jb.pro = false; store.set('jb.pro', ''); jb.pages = null;
    $('#jbDlg').hidden = true; jbRefresh(); toast('JotBird is off');
  }
});
const PUB_SORTS = [['expiry', 'Expiring soonest first'], ['expiry-desc', 'Expiring latest first'], ['pub', 'Published newest first'], ['pub-asc', 'Published oldest first'], ['name', 'Name A → Z'], ['name-desc', 'Name Z → A']];
$('#bPubSort').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect(), now = store.get('pubsort') || 'expiry';
  e.stopPropagation();
  showCtx(r.left, r.bottom + 4, PUB_SORTS.map(([k, n]) => [(k === now ? '✓ ' : '    ') + n, () => { store.set('pubsort', k); jbRefreshList(); }]));
});
$('#bShowPub').addEventListener('click', () => { store.set('hide.published', store.get('hide.published') ? '' : '1'); jbRefresh(); });

/* ---------------- Accent color (per device) ---------------- */
const ACCENTS = [['Blue', ''], ['Purple', '#8b5cf6'], ['Pink', '#e0457b'], ['Red', '#d64545'], ['Orange', '#e8730c'], ['Gold', '#c99a06'], ['Green', '#2f9e5a'], ['Teal', '#14a3a3']];
function setAccent(c){
  if (c) document.documentElement.style.setProperty('--accent', c); else document.documentElement.style.removeProperty('--accent');
  store.set('accent', c || '');
}
setAccent(store.get('accent') || '');
function openAccent(){
  menu.open = false;
  const now = store.get('accent') || '';
  jbDialog('Accent color', `<div class="swatches">${ACCENTS.map(([n, c]) =>
    `<button class="sw${c === now ? ' on' : ''}" data-c="${c}" title="${n}" style="--c:${c || '#3b6fd8'}"><span></span>${n}</button>`).join('')}
    <label class="sw custom"><input type="color" id="accentPick" value="${now || '#3b6fd8'}"><span>Custom…</span></label></div>`);
  $('#accentPick').addEventListener('input', e => setAccent(e.target.value));
}
$('#jbBody').addEventListener('click', e => { const s = e.target.closest('button.sw'); if (s){ setAccent(s.dataset.c); $('#jbBody').querySelectorAll('button.sw').forEach(b => b.classList.toggle('on', b === s)); } });

/* ---------------- Narrow windows: the top bar and file tabs slide sideways ---------------- */
for (const el of [document.querySelector('header'), $('#tabList')]){
  const edges = () => {
    // the file tabs are redrawn often: put the soft edges back when they go
    if (!el.querySelector(':scope > .hfade.l')) el.prepend(Object.assign(document.createElement('span'), { className: 'hfade l' }));
    if (el.lastElementChild?.className !== 'hfade r'){ el.querySelector(':scope > .hfade.r')?.remove(); el.append(Object.assign(document.createElement('span'), { className: 'hfade r' })); }
    el.classList.toggle('more-l', el.scrollLeft > 2); el.classList.toggle('more-r', el.scrollLeft + el.clientWidth < el.scrollWidth - 2); };
  el.addEventListener('wheel', e => {
    if (el.scrollWidth <= el.clientWidth + 1 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    el.scrollLeft += e.deltaY; e.preventDefault();
  }, { passive: false });
  el.addEventListener('scroll', edges, { passive: true });
  new ResizeObserver(edges).observe(el);
  new MutationObserver(edges).observe(el, { childList: true });
  edges();
}

/* ---------------- Boot ---------------- */
cm = createEditor(pane, {
  command: name => FORMATS[name](),
  afterTask,
  createFindPanel,
  onPaste,
  onDrop: e => { if (e.dataTransfer?.types.includes('Files')){ onDropFiles(e); return true; } return false; },
  resolveImage,
  openLink,
  openWiki,
  openTag: tag => openSearch('#' + tag),
  keepGroups: () => moveDone,
  onUpdate(u){
    if (u.docChanged && !loading){ scrollSrc = 'ed'; if (!dirty) setDirty(true); else { saveSession(); if (autosave && cur.kind === 'lib'){ clearTimeout(saveTimer); saveTimer = setTimeout(() => save(false, true), 1200); } } scheduleRender(); }
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
if (host.onDropPaths) host.onDropPaths(async paths => {
  const imgs = paths.filter(p => IMG_EXT.test(p));
  if (imgs.length && imgs.length === paths.length){ insertImages(await Promise.all(imgs.map(p => host.readFileAsFile(p)))); return; }
  const p = paths.find(x => !IMG_EXT.test(x));
  if (!p) return;
  try {
    const name = p.split(/[\\/]/).pop();
    await openInTab(await host.readRef(p), { kind: 'loose', name, ref: p }); addRecent({ name, ref: p });
  } catch (e){ toast('Could not open: ' + (e.message || e)); }
});
if (host.onOpenFile) host.onOpenFile(async f => { await openInTab(f.text, { kind: 'loose', name: f.name, ref: f.ref }, true); addRecent({ name: f.name, ref: f.ref }); });

(async () => {
  recent = (await kvGet('recent')) || []; showRecent();
  libs = (await kvGet('libs')) || [];
  const v = store.get('view'); setView(['live', 'editor', 'split', 'preview'].includes(v) ? v : 'live');
  setTabShown('outline', !store.get('hide.outline')); setTabShown('tags', !store.get('hide.tags'));
  jbRefresh(); if (jb.on && jb.key) jbCheckPro();
  showTab((t => t !== 'files' && (store.get('hide.' + t) || (t === 'published' && !jb.on)) ? 'files' : t)(store.get('tab') || 'files'));
  if (store.get('side') && window.innerWidth > 700) toggleSide(true);
  const libId = store.get('lib'), want = libs.find(l => l.id === libId);
  if (want && !(await host.ready(want, false))) renderLibEmpty(want);
  else if (want) await openLibrary(want, true);
  else renderLibEmpty();

  // bring back last session's tabs
  const sess = await kvGet('session');
  for (const s of sess?.tabs || []){
    let t = s.text, info = { kind: s.kind, name: s.name, path: s.path, ref: s.ref, mtime: s.mtime };
    if (s.kind === 'lib'){
      if (!lib || s.lib !== lib.desc.id){ if (t == null) continue; info = { kind: 'scratch', name: s.name }; }
      else if (!s.dirty){
        try { t = await lib.fs.read(s.path); info.mtime = await lib.fs.mtime(s.path).catch(() => 0); } catch (_) { continue; }
      }
    } else if (s.kind === 'loose' && !s.dirty && host.kind !== 'browser'){
      try { t = await host.readRef(s.ref); } catch (_) {}   // the file may have changed since
    }
    if (t == null) continue;
    tabs.push({ cur: info, dirty: !!s.dirty, state: cm.newState(t), scroll: 0 });
  }
  if (!tabs.length){
    let draft = null;   // Markpad 2.0 kept one draft instead of tabs
    try { draft = JSON.parse(store.get('draft') || 'null'); } catch (_) {}
    tabs.push(draft && typeof draft.text === 'string'
      ? { cur: { kind: 'scratch', name: draft.name || 'untitled.md' }, dirty: !!draft.dirty, state: cm.newState(draft.text), scroll: 0 }
      : { cur: { kind: 'scratch', name: 'welcome.md' }, dirty: false, state: cm.newState($('#welcome').textContent.replace(/^\n/, '')), scroll: 0 });
  }
  useTab(Math.min(Math.max(sess?.active ?? 0, 0), tabs.length - 1));
  const start = await host.startupFile().catch(() => null);
  if (start){ await openInTab(start.text, { kind: 'loose', name: start.name, ref: start.ref }, true); addRecent({ name: start.name, ref: start.ref }); }
  updateCursor();
  view.focus();
})();

// Android's back button: close whatever is open first (returns true if it closed something)
window.__mpBack = () => {
  if (!$('#ask').hidden){ $('#ask').hidden = true; return true; }
  if (!$('#qs').hidden){ $('#qs').hidden = true; return true; }
  if (!$('#jbDlg').hidden){ $('#jbDlg').hidden = true; return true; }
  if (!ctxSub.hidden){ ctxSub.hidden = true; return true; }
  if (panels.some(p => !p.hidden)){ closePanels(); return true; }
  if (!ctx.hidden){ ctx.hidden = true; return true; }
  if (menu.open){ menu.open = false; return true; }
  if (document.body.classList.contains('focus')){ setFocus(false); return true; }
  if (searchPanelOpen(view.state)){ closeFind(); return true; }
  if (!$('#side').hidden && window.innerWidth <= 700){ toggleSide(false); return true; }
  return false;
};

// for the automated tests
window.__markpad = { get view(){ return view; }, get cur(){ return cur; }, get lib(){ return lib; }, get tabs(){ return tabs; }, get active(){ return active; },
  openLibrary, openLibFile, setView, insertImages, toggleSide, showTab, openInTab, selectTab, closeTab, newTab, renamePath, host, backupLibrary, restoreBackup };
