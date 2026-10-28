import { EditorView } from '@codemirror/view';
import { SearchQuery, setSearchQuery, getSearchQuery, findNext, findPrevious, replaceNext, replaceAll,
  openSearchPanel, closeSearchPanel, searchPanelOpen } from '@codemirror/search';
import { TAG_RE, markdown, esc, slug, startsBlock, FENCE_RE, H_RE, DEF_RE, IMG_EXT } from './md.js';
import { createEditor } from './editor.js';
import { undo, redo } from '@codemirror/commands';
import { toDocx } from './docx.js';
import { makeZip, readZip } from './zip.js';
import { toPlain, toEpub, copyRich, noFront } from './export.js';
import { host } from './host.js';
import { publish, unpublish, listPages, claim, uploadImage, pageOf, daysLeft, leftText, withPage, pageText, titleOf as pageTitle, KEY_PAGE, getSettings, setSettings, PAGE_STYLES } from './jotbird.js';

const VERSION = '2.10.0';
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
// Long jobs (backup, restore): a box that stays until the job ends, with a bar. done/total unknown = a moving bar.
function busy(msg, done, total){
  const b = $('#busy');
  if (msg == null){ b.hidden = true; return; }
  b.hidden = false; $('#busyMsg').textContent = msg;
  b.classList.toggle('wait', !total);
  $('#busyBar').style.width = total ? Math.round(done / total * 100) + '%' : '';
}
const nf = n => n.toLocaleString();
const mb = n => n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
window.__mpProgress = (msg, done, total) => busy(msg, done, total);   // Android: "Backing up… 300 of 2,900 files"
const notice = msg => ask(msg, { buttons: [{ label: 'OK', value: true, primary: true }] });
function toast(msg){
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  if (/fail|couldn['’]t|could not|can['’]t|error/i.test(msg)) logErr(msg, 'notice');
}

/* ---------------- Error log (▾ > Settings > Error log…) ---------------- */
// Errors and failure notices are kept on this device (newest first, the last 200) so they can be copied and sent.
function errList(){ try { return JSON.parse(store.get('errlog') || '[]'); } catch (_) { return []; } }
function logErr(msg, where){
  const list = errList();
  list.unshift({ t: Date.now(), w: where || '', m: String(msg).slice(0, 3000) });
  store.set('errlog', JSON.stringify(list.slice(0, 200)));
}
window.__mpLog = logErr;
addEventListener('error', e => logErr(e.error?.stack || `${e.message} (${e.filename}:${e.lineno})`, 'error'));
addEventListener('unhandledrejection', e => logErr(e.reason?.stack || e.reason?.message || String(e.reason), 'promise'));

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
  if (linksShown()) buildLinks();
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
  snapshot(tab.cur, tab.state.doc.toString(), true);
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
  const c = tabs.indexOf(me) === active ? cur : me.cur;
  showCtx(e.clientX, e.clientY, [
    ...(c.kind === 'lib' && lib ? [[isBookmarked(c.path) ? 'Remove bookmark' : 'Bookmark', () => toggleBookmark(c.path)]] : []),
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
  if (linksShown()) linksSoon();
  if (scrollSrc === 'ed') syncScroll('ed');
  railsSoon();
}
function scheduleRender(){
  clearTimeout(renderTimer);
  renderTimer = setTimeout(render, view.state.doc.length > 50000 ? 250 : 60);
}
function fillPreview(){
  fillHtml(pv);
  if (moveDone) foldDone(pv);
}
// what markdown() leaves for the app: pictures from the library, missing-note links, ![[embeds]] and diagrams.
// Used by the Read view and by Live Preview's blocks (measure: tell the editor the block's height changed).
function fillHtml(root, depth = 0, measure){
  for (const img of root.querySelectorAll('img[data-rel],img[data-wiki]')){
    const src = img.dataset.wiki != null ? 'wiki:' + img.dataset.wiki : img.dataset.rel;
    if (measure) img.onload = measure;
    resolveImage(src).then(u => { if (u) img.src = u; });
  }
  for (const a of root.querySelectorAll('a.wikilink')) a.classList.toggle('missing', !!lib && !resolveWiki(a.dataset.wiki));
  for (const box of root.querySelectorAll('.embed:not([data-done])')) fillEmbed(box, depth, measure);
  drawDiagrams(root, measure);
}

/* ---------------- ![[Note]] embeds ---------------- */
// the text of a note, unsaved changes included when it's open in a tab
async function noteText(p){
  if (cur.kind === 'lib' && cur.path === p) return text();
  const t = tabs.find(t => t.cur.kind === 'lib' && t.cur.path === p);
  return t ? t.state.doc.toString() : lib.fs.read(p);
}
// ![[Note#Heading]]: that heading and what's under it; ![[Note#^id]]: the paragraph ending in ^id
function section(t, hash){
  if (!hash) return t;
  const lines = t.split('\n');
  if (hash[0] === '^'){
    const k = lines.findIndex(l => new RegExp('(^|\\s)\\^' + hash.slice(1).replace(/[^\w-]/g, '') + '\\s*$').test(l));
    if (k < 0) return null;
    let a = k, b = k;
    while (a > 0 && lines[a - 1].trim()) a--;
    while (b < lines.length - 1 && lines[b + 1].trim() && !/^\s*\^[\w-]+\s*$/.test(lines[b + 1])) b++;
    return lines.slice(a, b + 1).join('\n').replace(/(^|\s)\^[\w-]+\s*$/gm, '');
  }
  let start = -1, lvl = 0, fence = false;
  for (let i = 0; i < lines.length; i++){
    if (FENCE_RE.test(lines[i])) fence = !fence;
    const m = !fence && lines[i].match(H_RE);
    if (!m) continue;
    if (start < 0){ if (slug(m[2] || '') === slug(hash)){ start = i; lvl = m[1].length; } }
    else if (m[1].length <= lvl) return lines.slice(start, i).join('\n');
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}
async function fillEmbed(box, depth, measure){
  box.dataset.done = '1';
  const target = box.dataset.embed, hash = box.dataset.hash, p = lib && resolveWiki(target);
  const name = (target.replace(/^.*\//, '') || cur.name.replace(/\.md$/i, '')) + (hash ? ' › ' + hash.replace(/^\^/, '') : '');
  const head = `<a href="#" class="wikilink embed-head" data-wiki="${esc(target)}" data-hash="${hash && hash[0] !== '^' ? esc(slug(hash)) : ''}">${esc(name)}</a>`;
  if (!p){ box.classList.add('missing'); box.innerHTML = head + `<div class="embed-miss">${lib ? 'Note not found' : 'Embeds work inside a library'}</div>`; return; }
  if (depth >= 3){ box.innerHTML = head; return; }   // a note embedding itself (or a loop) stops here
  let t = null;
  try { t = section(await noteText(p), hash); } catch (_) {}
  box.innerHTML = head + '<div class="embed-body"></div>';
  const body = box.lastChild;
  if (t == null) body.innerHTML = '<div class="embed-miss">That part of the note wasn’t found</div>';
  else { body.innerHTML = markdown(t).replace(/ data-line="\d+"/g, '').replace(/ id="[^"]*"/g, ''); fillHtml(body, depth + 1, measure); }
  measure?.();
}

/* ---------------- Mermaid diagrams ---------------- */
// Mermaid is big (~3 MB), so it isn't built in: it loads from the web the first time a note has a diagram
// (then the browser keeps a copy). Without internet the diagram's text stays, with a short note.
const MERMAID = 'https://cdn.jsdelivr.net/npm/mermaid@12.2.0/dist/mermaid.esm.min.mjs';
const loadModule = u => import(u);
let mermaidP = null, mmN = 0;
const svgCache = new Map();
async function drawDiagrams(root, measure){
  const boxes = [...root.querySelectorAll('.mermaid-box:not([data-drawn])')];
  if (!boxes.length) return;
  for (const b of boxes) b.dataset.drawn = '1';
  let mm;
  try { mm = await (mermaidP ||= loadModule(MERMAID).then(m => m.default)); }
  catch (e){
    mermaidP = null;
    for (const b of boxes) b.insertAdjacentHTML('beforeend', '<div class="diagram-note">Diagrams need the internet the first time (Mermaid loads from cdn.jsdelivr.net)</div>');
    return;
  }
  const theme = getComputedStyle(document.documentElement).colorScheme.includes('dark') ? 'dark' : 'default';
  for (const b of boxes){
    const key = theme + '\n' + b.dataset.src;
    try {
      if (!svgCache.has(key)){
        mm.initialize({ startOnLoad: false, theme, securityLevel: 'strict' });
        const id = 'mmd' + ++mmN;
        try { svgCache.set(key, (await mm.render(id, b.dataset.src)).svg); }
        finally { document.getElementById('d' + id)?.remove(); }
        if (svgCache.size > 60) svgCache.delete(svgCache.keys().next().value);
      }
      b.innerHTML = svgCache.get(key); b.classList.add('drawn');
    } catch (e){
      b.insertAdjacentHTML('beforeend', `<div class="diagram-note">Diagram error: ${esc(String(e.message || e).split('\n')[0])}</div>`);
    }
  }
  measure?.();
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
      snapshot(cur, t);
      if (sortMode.startsWith('mod')){ mtimes.set(cur.path, cur.mtime); renderTree(); }
      if ((!$('#tagPane').hidden || !$('#linkPane').hidden) && !$('#side').hidden){ const n = noteTexts.find(n => n.f.path === cur.path); if (n){ n.lines = t.split('\n'); if (!$('#tagPane').hidden) buildTags(); } }
      if (text() === t) setDirty(false);
      if (!quiet) toast('Saved');
      return;
    }
    if (!saveAs && cur.kind === 'loose' && cur.ref){
      await host.writeRef(cur.ref, t); setDirty(false); snapshot(cur, t); toast('Saved'); return;
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

/* ---------------- Export ---------------- */
// notes: [{ name, path?, text }]. Several notes become one combined file (each starts on a new page)
// or a .zip of separate files, the user picks.
const EXPORTS = [['HTML', 'html'], ['Word (.docx)', 'docx'], ['PDF / Print', 'print'], ['Plain text (.txt)', 'txt'],
  ['Ebook (.epub)', 'epub'], ['Copy as rich text', 'copy']];
const MIME = { html: 'text/html', txt: 'text/plain', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', epub: 'application/epub+zip', zip: 'application/zip' };
const BREAK = '<div class="pagebreak"></div>';
const baseName = n => n.replace(/\.\w+$/, '');
const safeName = s => s.replace(/[\\/:*?"<>|]/g, '-').trim() || 'Notes';
const noteTitle = n => (titleOf(noFront(n.text)) || baseName(n.name)).trim();
// in a combined file a note without its own # title gets its name as one
const titled = (n, multi) => { const t = noFront(n.text); return multi && !/^#\s/.test(t.trimStart()) ? `# ${baseName(n.name)}\n\n${t}` : t; };
const htmlOf = (notes, multi) => notes.map(n => markdown(titled(n, multi))).join(BREAK);
function pageHtml(title, body){
  const css = $('#tokens').textContent + $('#mdcss').textContent + 'body{background:var(--bg);margin:0;padding:40px 16px}';
  body = body.replace(/<input type="checkbox" class="task"/g, '<input type="checkbox" class="task" disabled');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body><article class="md">\n${body}\n</article></body></html>`;
}
async function render1(fmt, notes, title){
  const multi = notes.length > 1;
  if (fmt === 'txt') return notes.map(n => toPlain(titled(n, multi))).join('\n────────\n\n');
  if (fmt === 'html') return pageHtml(title, htmlOf(notes, multi));
  if (fmt === 'docx') return toDocx(htmlOf(notes, multi), title);
}
const saveOut = async (name, data, type) => (await (typeof data === 'string' ? host.download(name, data, MIME[type]) : host.saveBytes(name, data, MIME[type]))) !== false;
// file names inside a .zip: the notes' paths, less the folder they all share
function zipNames(notes, ext){
  const paths = notes.map(n => n.path || n.name);
  let common = dirname(paths[0]);
  while (common && !paths.every(p => p.startsWith(common + '/'))) common = dirname(common);
  return paths.map(p => (common ? p.slice(common.length + 1) : p).replace(/\.\w+$/, '') + ext);
}
async function exportNotes(notes, fmt, title){
  if (!notes.length) return;
  const multi = notes.length > 1, te = new TextEncoder();
  title = multi ? title : noteTitle(notes[0]);
  const file = multi ? safeName(title) : safeName(baseName(notes[0].name));
  try {
    if (fmt === 'print'){ pv.innerHTML = htmlOf(notes, multi); fillPreview(); setTimeout(() => host.print(), 300); return; }
    if (fmt === 'copy'){
      const ok = await copyRich(htmlOf(notes, multi).replace(/<input type="checkbox" class="task"( checked)?[^>]*>/g, (m, c) => c ? '☑ ' : '☐ '), notes.map(n => toPlain(titled(n, multi))).join('\n'));
      toast(ok ? 'Copied with formatting. Paste it into an email or a document' : "Couldn't copy");
      return;
    }
    if (fmt === 'md'){
      const names = zipNames(notes, '.md');
      const zip = await makeZip(notes.map((n, i) => ({ name: names[i], data: te.encode(n.text) })));
      if (await saveOut(file + '.zip', zip, 'zip')) toast(`Saved ${notes.length} notes as a zip`);
      return;
    }
    if (fmt === 'epub'){
      const bytes = await toEpub(notes.map(n => ({ title: noteTitle(n), html: markdown(noFront(n.text)) })), title);
      if (await saveOut(file + '.epub', bytes, 'epub')) toast('Saved as an ebook');
      return;
    }
    let apart = false;
    if (multi){
      const c = await ask(`Export ${notes.length} notes as ${EXPORTS.find(e => e[1] === fmt)[0]}`, { buttons: [
        { label: 'Cancel', value: null }, { label: 'Separate files (.zip)', value: 'zip' }, { label: 'One combined file', value: 'one', primary: true }] });
      if (!c) return;
      apart = c === 'zip';
    }
    if (apart){
      const names = zipNames(notes, '.' + fmt), files = [];
      for (const [i, n] of notes.entries()){
        const d = await render1(fmt, [n], noteTitle(n));
        files.push({ name: names[i], data: typeof d === 'string' ? te.encode(d) : d });
      }
      if (await saveOut(file + '.zip', await makeZip(files), 'zip')) toast(`Saved ${notes.length} files in a zip`);
    } else if (await saveOut(file + '.' + fmt, await render1(fmt, notes, title), fmt))
      toast(fmt === 'docx' ? 'Saved as a Word file' : 'Saved ' + file + '.' + fmt);
  } catch (e){ if (e.name !== 'AbortError') toast("Couldn't export: " + (e.message || e)); }
}
const exportCurrent = fmt => exportNotes([{ name: cur.name, path: cur.path, text: text() }], fmt);

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
let picked = new Set(), pickAnchor = '', picking = false;   // multi-select in the file list
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
  if (!lib || lib.desc.id !== desc.id) tree = [];
  lib = { desc, fs: host.lib(desc) };
  expanded = new Set(JSON.parse(store.get('open.' + desc.id) || '[]'));
  libs = [desc, ...libs.filter(l => l.id !== desc.id && !(desc.portable && l.portable))].slice(0, 6);
  kvSet('libs', libs); store.set('lib', desc.id);
  $('#libName').textContent = desc.name; $('#libName').title = desc.path || desc.uri || desc.name;
  await refreshTree(true);
  if (!quiet) toast('Library: ' + desc.name);
  return true;
}
/* A big vault takes a while to read on phones, so each library's file list is remembered (IndexedDB 'tree.<id>'):
   it shows straight away and the fresh list replaces it when it's ready. `fast` (opening a library) doesn't wait
   for the fresh list when a remembered one is showing. */
let treeGen = 0, loadInfo = null;
async function refreshTree(fast){
  if (!lib) return renderLibEmpty();
  const gen = ++treeGen, d = lib.desc, t0 = performance.now();
  let shown = false;
  if (!tree.length){
    const saved = await kvGet('tree.' + d.id);
    if (gen !== treeGen) return;
    if (saved?.length){ tree = saved; await loadMtimes(); renderTree(); shown = true; }
    else { renderLibEmpty(); $('#tree').innerHTML = '<div class="empty">Reading the library…</div>'; }
  }
  const fresh = (async () => {
    let list;
    try { list = await lib.fs.list(); }
    catch (e){
      if (gen !== treeGen) return;
      if (!shown) tree = [];
      toast("Couldn't read the library: " + (e.message || e)); renderTree(); return;
    }
    if (gen !== treeGen || lib?.desc.id !== d.id) return;
    tree = list; kvSet('tree.' + d.id, list);
    loadInfo = { files: allFiles().length, s: (performance.now() - t0) / 1000 }; showAbout();
    await loadMtimes(); renderTree();
    if (paneShown('tagPane')) buildTags(true);
    if (paneShown('linkPane')) buildLinks(true);
  })();
  if (!(fast && shown)) await fresh;
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
  const files = allFiles(), ts = await Promise.all(files.map(f => f.mtime ?? lib.fs.mtime(f.path).catch(() => 0)));
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
  renderBookmarks();
}
function markTree(){
  for (const p of picked) if (!allFiles().some(f => f.path === p || f.path.startsWith(p + '/')) && !dirExists(p)) picked.delete(p);
  for (const b of document.querySelectorAll('#tree .row')){
    b.classList.toggle('on', cur.kind === 'lib' && b.dataset.path === cur.path || !!b.dataset.dir && b.dataset.path === selectedFolder && cur.kind !== 'lib');
    b.classList.toggle('picked', picked.has(b.dataset.path));
  }
  if (!picked.size) picking = false;
  $('#pickBar').hidden = !picked.size;
  $('#pickCount').textContent = picked.size + ' selected';
}
/* Multi-select: Ctrl+click picks notes one by one, Shift+click a run of them (like File Explorer);
   on phones "Select" in the long-press menu starts it and then taps pick. Middle-click opens in a new tab. */
const clearPicks = () => { picked.clear(); picking = false; markTree(); };
const rowPaths = () => [...document.querySelectorAll('#tree .row')].map(r => r.dataset.path);
// every folder in the library, in the order the file list shows them: [{ path, name, depth }]
function allDirs(list = tree, depth = 0, out = []){
  for (const n of sortedList(list)) if (n.dir){ out.push({ path: n.path, name: n.name, depth }); allDirs(n.children || [], depth + 1, out); }
  return out;
}
const dirExists = p => allDirs().some(d => d.path === p);
// the picked items, less anything inside a picked folder
const topPicks = () => [...picked].filter(p => ![...picked].some(q => q !== p && p.startsWith(q + '/')));
$('#tree').addEventListener('click', e => {
  const b = e.target.closest('.row'); if (!b) return;
  const p = b.dataset.path;
  if (e.shiftKey && pickAnchor){
    const rows = rowPaths(), [i, j] = [rows.indexOf(pickAnchor), rows.indexOf(p)].sort((a, b) => a - b);
    if (i >= 0){ picked = new Set(rows.slice(i, j + 1)); markTree(); return; }
  }
  if (e.ctrlKey || e.metaKey || picking){
    picked.has(p) ? picked.delete(p) : picked.add(p);
    pickAnchor = p; markTree(); return;
  }
  if (picked.size) clearPicks();
  pickAnchor = p;
  if (b.dataset.dir){
    expanded.has(p) ? expanded.delete(p) : expanded.add(p);
    selectedFolder = p;
    store.set('open.' + lib.desc.id, JSON.stringify([...expanded]));
    renderTree();
  } else {
    selectedFolder = dirname(p);
    openLibFile(p);
    // on phones the sidebar closes after a short wait, so a double-tap can still rename
    if (window.innerWidth <= 700){ clearTimeout(sideCloseTimer); sideCloseTimer = setTimeout(() => toggleSide(false), 350); }
  }
});
$('#tree').addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });   // no autoscroll on middle-click
$('#tree').addEventListener('auxclick', e => {
  const b = e.target.closest('.row');
  if (b && e.button === 1 && !b.dataset.dir){ e.preventDefault(); openLibFile(b.dataset.path, true); }
});
$('#bPickClear').addEventListener('click', clearPicks);
$('#bPickExport').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); showCtx(r.left, r.bottom + 4, exportItems(topPicks())); });
$('#bPickMove').addEventListener('click', e => { const r = e.currentTarget.getBoundingClientRect(); moveMenu(topPicks(), r.left, r.bottom + 4); });
$('#bPickDel').addEventListener('click', () => trashPaths(topPicks()));
$('#bPickMerge').addEventListener('click', () => mergeNotes(topPicks()));
let sideCloseTimer;
$('#tree').addEventListener('dblclick', e => {
  const b = e.target.closest('.row'); if (!b) return;
  if (e.ctrlKey || e.metaKey || e.shiftKey || picking) return;
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
  // on one of several picked items, the menu works on all of them
  if (picked.size > 1 && picked.has(p)){
    const ps = topPicks();
    showCtx(x, y, [
      ['Export', null, exportItems(ps)],
      ['Merge into one note…', () => mergeNotes(ps)],
      ['Move to…', () => moveMenu(ps, x, y)],
      ['Delete (move to .trash)', () => trashPaths(ps)],
      ['Clear selection', clearPicks],
    ]);
    return;
  }
  if (picked.size && !picked.has(p)) clearPicks();
  const items = [
    ...(isDir ? [] : [['Open in new tab', () => openLibFile(p, true)], [isBookmarked(p) ? 'Remove bookmark' : 'Bookmark', () => toggleBookmark(p)],
      ['Note history…', async () => { if (!(cur.kind === 'lib' && cur.path === p)) await openLibFile(p); openHistory(); }]]),
    ['New note here', async () => { const n = await ask('New note', { input: 'Untitled' }); if (n) createNote(dir, n); }],
    ['New folder here', () => newFolder(dir)],
    ['Select', () => { picking = true; picked.add(p); pickAnchor = p; markTree(); }],
    ['Rename…', () => renamePath(p, isDir)],
    ['Move to…', () => moveMenu([p], x, y)],
    ['Delete (move to .trash)', () => trashPath(p, isDir)],
    ['Export', null, exportItems([p])],
  ];
  // JotBird options: Publish for a note that isn't published yet, the page's options for one that is
  if (jb.on && !isDir && isNote(p)){
    const pg = pageOf(cur.kind === 'lib' && cur.path === p ? text() : (tabs.find(t => t.cur.kind === 'lib' && t.cur.path === p)?.state.doc.toString() ?? await lib.fs.read(p).catch(() => '')));
    items.push(['JotBird', null, pg ? jbNoteItems(p, pg)
      : [['Publish this note', async () => { if (!(cur.kind === 'lib' && cur.path === p)) await openLibFile(p); jbPublish(); }]]]);
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
  try { await movePath(p, to); } catch (e){ toast("Couldn't rename: " + (e.message || e)); }
}
// rename or move a note or folder: open tabs follow it, and so do [[links]] to it
async function movePath(p, to){
  const inside = c => c.kind === 'lib' && (c.path === p || c.path.startsWith(p + '/'));
  if (inside(cur)) await flush();
  const relinks = await planRelinks(p, to);
  await lib.fs.rename(p, to);
  moveBookmarks(p, to); histMove(p, to);
  stash();
  for (const t of tabs) if (inside(t.cur)){
    t.cur.path = to + t.cur.path.slice(p.length); t.cur.name = basename(t.cur.path);
    t.cur.mtime = await lib.fs.mtime(t.cur.path).catch(() => 0);
  }
  updateTitle(); saveSession();
  for (const d of [...expanded]) if (d === p || d.startsWith(p + '/')){ expanded.delete(d); expanded.add(to + d.slice(p.length)); }
  await refreshTree();
  await applyRelinks(relinks, p, to);
}
// Move to…: a menu of the library's folders
function moveMenu(paths, x, y){
  const blocked = d => paths.some(p => d === p || d.startsWith(p + '/'));
  const go = dest => async () => {
    let n = 0;
    for (const p of paths){
      if (dirname(p) === dest) continue;
      const to = joinPath(dest, basename(p));
      if (allFiles().some(f => f.path.toLowerCase() === to.toLowerCase()) || dirExists(to)){ toast(basename(p) + ' is already in that folder'); continue; }
      try { await movePath(p, to); n++; } catch (e){ toast(`Couldn't move ${basename(p)}: ` + (e.message || e)); break; }
    }
    if (dest){ for (let d = dest; d; d = dirname(d)) expanded.add(d); store.set('open.' + lib.desc.id, JSON.stringify([...expanded])); }
    clearPicks(); renderTree();
    if (n) toast(`Moved ${n === 1 ? basename(paths[0]).replace(/\.md$/i, '') : n + ' items'} to ${dest || 'the top of the library'}`);
  };
  showCtx(x, y, [
    ['⌂ Top of the library', go('')],
    ...allDirs().filter(d => !blocked(d.path) && !d.name.startsWith('.')).map(d => [' '.repeat(d.depth) + '📁 ' + d.name, go(d.path)]),
  ]);
}
// Export ▸ for notes and folders (a folder exports all the notes in it)
function exportItems(paths){
  const run = fmt => async () => {
    const set = new Set(paths), notes = [];
    stash();
    const walk = (list, inPick) => {
      for (const n of sortedList(list)){
        const hit = inPick || set.has(n.path);
        if (n.dir){ if (!n.name.startsWith('.')) walk(n.children || [], hit); }
        else if (hit && /\.(md|markdown|mdown|mkd|txt)$/i.test(n.name)) notes.push(n);
      }
    };
    walk(tree, false);
    if (!notes.length){ toast('No notes in there'); return; }
    const full = await Promise.all(notes.map(async n => ({ name: n.name, path: n.path,
      text: cur.kind === 'lib' && cur.path === n.path ? text() : tabs.find(t => t.cur.kind === 'lib' && t.cur.path === n.path)?.state.doc.toString() ?? await lib.fs.read(n.path) })));
    const title = paths.length === 1 ? basename(paths[0]).replace(/\.md$/i, '') : `${lib.desc.name} (${notes.length} notes)`;
    exportNotes(full, fmt, title);
  };
  const several = paths.length > 1 || paths.some(dirExists);
  return [...EXPORTS.map(([label, fmt]) => [label, run(fmt)]), ...(several ? [['Markdown files (.zip)', run('md')]] : [])];
}
// the notes inside some picked notes and folders, in file list order, with their text (open tabs as they are now)
async function notesIn(paths){
  const set = new Set(paths), notes = [];
  stash();
  const walk = (list, inPick) => {
    for (const n of sortedList(list)){
      const hit = inPick || set.has(n.path);
      if (n.dir){ if (!n.name.startsWith('.')) walk(n.children || [], hit); }
      else if (hit && isNote(n.name)) notes.push(n);
    }
  };
  walk(tree, false);
  return Promise.all(notes.map(async n => ({ name: n.name, path: n.path,
    text: cur.kind === 'lib' && cur.path === n.path ? text() : tabs.find(t => t.cur.kind === 'lib' && t.cur.path === n.path)?.state.doc.toString() ?? await lib.fs.read(n.path) })));
}
// several notes → one new note, each under its own name as a heading (properties boxes left out)
async function mergeNotes(paths){
  if (!(await flush())) return;
  const notes = await notesIn(paths);
  if (notes.length < 2){ toast('Pick two or more notes to merge'); return; }
  const name = await ask(`Merge ${notes.length} notes into one new note (in file list order). Its name:`, { input: 'Merged note', buttons: [{ label: 'Cancel', value: null }, { label: 'Next', value: true, primary: true }] });
  if (!name) return;
  const keep = await ask(`What happens to the ${notes.length} original notes?\n\nMoving them to .trash can be undone from the library's .trash folder. [[Links]] to them in other notes would stop working.`,
    { buttons: [{ label: 'Cancel', value: null }, { label: 'Move them to .trash', value: 'trash' }, { label: 'Keep them', value: 'keep', primary: true }] });
  if (!keep) return;
  const body = notes.map(n => {
    const t = noFront(n.text).trim(), title = n.name.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '');
    return /^#\s/.test(t) ? t : `# ${title}\n\n${t}`;
  }).join('\n\n');
  try {
    const p = await uniquePath(dirname(notes[0].path), name.replace(/\.md$/i, '').replace(/[\\/:*?"<>|]/g, '-') + '.md');
    await lib.fs.write(p, body + '\n');
    if (keep === 'trash') for (const n of notes) if (!(await trashPath(n.path, false, true))) break;
    clearPicks();
    await refreshTree();
    await openLibFile(p);
    toast(`Merged ${notes.length} notes into “${basename(p).replace(/\.md$/i, '')}”`);
  } catch (e){ toast("Couldn't merge: " + (e.message || e)); }
}
async function trashPaths(paths){
  if (paths.length === 1) return trashPath(paths[0], dirExists(paths[0]));
  const names = paths.slice(0, 6).map(p => '• ' + basename(p).replace(/\.md$/i, '') + (dirExists(p) ? ' (folder)' : '')).join('\n') + (paths.length > 6 ? `\n…and ${paths.length - 6} more` : '');
  if (!(await confirmBox(`Move these ${paths.length} items to the library's .trash folder?\n\n${names}`, 'Move to trash'))) return;
  for (const p of paths) if (!(await trashPath(p, dirExists(p), true))) break;
  clearPicks();
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
  // notes-only skips PDFs, audio, canvases and .obsidian; "everything" is a full copy of the folder (not the trash)
  const what = await ask(`Back up “${lib.desc.name}”: what goes in the zip?

Everything: every file in the folder, also PDFs, audio and Obsidian's settings (.obsidian). Notes and pictures: only what the file list shows.`,
    { buttons: [{ label: 'Cancel', value: null }, { label: 'Notes and pictures', value: 'notes' }, { label: 'Everything', value: 'all', primary: true }] });
  if (!what) return;
  const pw = await askPassword(`Back up “${lib.desc.name}” as a zip.\n\nPassword (optional, leave empty for none). It can't be recovered if you forget it.`, 'Back up');
  if (pw == null) return;
  if (pw){
    if (!/^[\x20-\x7e]+$/.test(pw)){ toast('Use plain keyboard letters, numbers and symbols (no accents or emoji) so other zip apps can open it'); return; }
    if ((await askPassword('Type the password again', 'Back up')) !== pw){ toast("The passwords didn't match"); return; }
  }
  if (!(await flush())) return;
  stash();
  const name = `Markpad backup - ${lib.desc.name.replace(/[\\/:*?"<>|]/g, '-')} - ${today()}.zip`;
  const ready = (n, bytes, where) => notice(`Backup ready: ${nf(n)} file${n > 1 ? 's' : ''}, ${mb(bytes)}${pw ? ', with a password' : ''}.` + (where ? `\n\nSaved as ${where}` : ''));
  // the zip is made one file at a time and goes straight out, so a big library never has to fit in memory
  try {
    if (lib.fs.backup){   // Android: the app zips from storage itself, then the share menu opens
      busy('Reading the library…');
      const r = await lib.fs.backup(name, what === 'all', pw || '');
      busy(null); await ready(r.n, r.bytes); return;
    }
    busy('Reading the library…');
    const list = what === 'all' ? allFiles(await lib.fs.list(true)) : allFiles();
    busy(null);
    if (!list.length){ toast('This library has no notes yet'); return; }
    const sink = await host.saveStream(name);
    if (!sink) return;
    const te = new TextEncoder();
    let i = 0, bytes = 0;
    busy(`Backing up… 0 of ${nf(list.length)} files`, 0, list.length);
    const files = list.map(f => ({ name: f.path, read: async () => {
      if (++i % 10 === 0 || i === list.length) busy(`Backing up… ${nf(i)} of ${nf(list.length)} files`, i, list.length);
      const t = tabs.find(t => t.cur.kind === 'lib' && t.cur.path === f.path);
      return t ? te.encode(t.state.doc.toString()) : isNote(f.name) ? te.encode(await lib.fs.read(f.path)) : lib.fs.readBin(f.path);
    } }));
    await makeZip(files, pw, async b => { bytes += b.length; await sink.write(b); });
    busy('Saving…');
    const where = await sink.done();
    busy(null);
    if (where) await ready(files.length, bytes, typeof where === 'string' ? where : '');
  } catch (e){ busy(null); await notice("Couldn't back up: " + (e.message || e)); }
}
async function restoreBackup(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  const restored = async (dir, n) => {
    expanded.add(dir); selectedFolder = dir;
    await refreshTree();
    busy(null);
    await notice(`Restored ${nf(n)} file${n > 1 ? 's' : ''} into the folder “${dir}”.`);
  };
  if (lib.fs.restore){   // Android: the app unzips straight into the library, file by file
    let z;
    try { z = await host.pickZip(); } catch (e){ toast("Couldn't open that file: " + (e.message || e)); return; }
    if (!z) return;
    const dir = await uniquePath('', 'Restored ' + today());
    for (let pw = null; ;){
      try { busy('Opening the backup…'); await restored(dir, await lib.fs.restore(z.uri, dir, pw || '')); return; }
      catch (e){
        busy(null);
        if (e.message !== 'password'){ await refreshTree(); await notice("Couldn't restore: " + e.message); return; }
        pw = await askPassword(pw == null ? `“${z.name}” has a password` : 'Wrong password. Try again', 'Restore');
        if (pw == null) return;
      }
    }
  }
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
  // everything comes back (full backups hold .obsidian and other files too), all of it inside the new "Restored" folder
  files = files.filter(f => !f.name.endsWith('/') && !f.name.split('/').some(p => p === '..'));
  if (!files.length){ toast('Nothing to restore in that zip'); return; }
  try {
    const dir = await uniquePath('', 'Restored ' + today());
    let i = 0;
    for (const f of files){
      if (++i % 10 === 0 || i === files.length) busy(`Restoring… ${nf(i)} of ${nf(files.length)} files`, i, files.length);
      await lib.fs.writeBin(normPath(joinPath(dir, f.name.replace(/^\/+/, ''))), f.data);
    }
    await restored(dir, files.length);
  } catch (e){ toast("Couldn't restore: " + (e.message || e)); }
}
async function trashPath(p, isDir, sure){
  if (!sure && !(await confirmBox(`Move ${basename(p)}${isDir ? ' and everything in it' : ''} to the library's .trash folder?`, 'Move to trash'))) return;
  try {
    stash();
    const gone = t => t.cur.kind === 'lib' && (t.cur.path === p || t.cur.path.startsWith(p + '/'));
    for (const t of tabs) if (gone(t)) t.dirty = false;
    if (active >= 0 && gone(tabs[active])) dirty = false;
    await closeTabs(k => !gone(tabs[k]));
    await lib.fs.trash(p);
    moveBookmarks(p, null);
    await refreshTree(); toast('Moved to .trash');
    return true;
  } catch (e){ toast("Couldn't delete: " + (e.message || e)); }
}
$('#bNewNote').addEventListener('click', newNote);
$('#bNewFolder').addEventListener('click', () => newFolder());
$('#bRefresh').addEventListener('click', refreshTree);
$('#bLibMenu').addEventListener('click', e => {
  const r = e.currentTarget.getBoundingClientRect();
  showCtx(r.left, r.bottom + 4, [
    // the portable library is looked up fresh (its folder can move with the app), so old remembered copies of it are left out
    ...libs.filter(l => l.id !== lib?.desc.id && !l.portable).map(l => ['Switch to ' + l.name, () => switchLibrary(l)]),
    ...(host.canPortable && !lib?.desc.portable ? [['Switch to Portable notes', async () => switchLibrary(await host.portableLibrary())]] : []),
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
  if (qsMode === 'cmds') return cmdFilter();
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
  const create = q && !qsHits.some(f => f.name.toLowerCase().replace(/\.md$/, '') === q) ? `<button data-new="1">＋ ${qsMode === 'link' ? 'Link to a new note' : 'Create'} “${esc($('#qsInput').value.trim())}”</button>` : '';
  $('#qsList').innerHTML = qsHits.map((f, k) => `<button data-k="${k}"${k ? '' : ' class="on"'}>${esc(f.name.replace(/\.md$/i, ''))}<small>${esc(dirname(f.path) || '/')}</small></button>`).join('') + create;
  if (!qsHits.length && create) $('#qsList').firstChild.classList.add('on');
}
function qsPick(b, forceNew){
  if (b?.dataset.tag){ $('#qsInput').value = '#' + b.dataset.tag; qsFilter(); $('#qsInput').focus(); return; }
  $('#qs').hidden = true;
  if (qsMode === 'cmds'){ if (b?.dataset.c) cmdHits[+b.dataset.c].run(); return; }
  if (!b || !b.dataset.k && !b.dataset.new) return;
  if (qsMode === 'link'){ insertNoteLink(b.dataset.new ? $('#qsInput').value.trim() : linkName(qsHits[+b.dataset.k].path)); return; }
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
  else if (e.key === 'Escape'){ e.preventDefault(); $('#qs').hidden = true; linkSel = null; view.focus(); }
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
// drag the sidebar's right edge to resize it. Wide windows: the sidebar sits beside the note (flex-basis);
// narrow ones (a phone held upright): it floats over the note (width), remembered separately
const side = $('#side'), grip = $('#sideGrip');
const narrow = () => window.innerWidth <= 700;
const setSideW = w => { side.style.flexBasis = Math.min(Math.max(w, 160), Math.min(700, innerWidth - 300)) + 'px'; };
const setSideNarrowW = w => { side.style.width = Math.min(Math.max(w, 180), innerWidth - 24) + 'px'; };
if (store.get('sidew')) setSideW(+store.get('sidew'));
if (store.get('sidew.narrow') && narrow()) setSideNarrowW(+store.get('sidew.narrow'));
grip.addEventListener('pointerdown', e => {
  e.preventDefault(); grip.setPointerCapture(e.pointerId); grip.classList.add('drag');
  const left = side.getBoundingClientRect().left, n = narrow();
  const move = ev => n ? setSideNarrowW(ev.clientX - left) : setSideW(ev.clientX - left);
  grip.addEventListener('pointermove', move);
  const up = () => {
    grip.classList.remove('drag'); grip.removeEventListener('pointermove', move);
    n ? store.set('sidew.narrow', parseInt(side.style.width)) : store.set('sidew', parseInt(side.style.flexBasis));
  };
  grip.addEventListener('pointerup', up, { once: true });
  grip.addEventListener('pointercancel', up, { once: true });
});
grip.addEventListener('dblclick', () => {
  if (narrow()){ side.style.width = ''; store.set('sidew.narrow', ''); } else { side.style.flexBasis = ''; store.set('sidew', ''); }
});
// turning the phone: the floating width only applies upright
matchMedia('(max-width: 700px)').addEventListener('change', m => {
  if (m.matches && store.get('sidew.narrow')) setSideNarrowW(+store.get('sidew.narrow')); else if (!m.matches) side.style.width = '';
});
function toggleSide(on = $('#side').hidden){
  $('#side').hidden = !on; $('#bSide').setAttribute('aria-pressed', String(on));
  if (window.innerWidth > 700) store.set('side', on ? '1' : '');
  buildOutline();
  if (on) showPane(!noteTexts.length);
  railsSoon();
}
// a sidebar pane that's actually on screen
const paneShown = id => !$('#' + id).hidden && !$('#side').hidden;
// Tags, Links and Published read every note in the library, so they only fill in while they're on screen
function showPane(reread){
  if (paneShown('tagPane')) buildTags(reread);
  if (paneShown('linkPane')) buildLinks(reread);
  if (paneShown('pubPane')){ if (reread){ jb.pages = null; $('#pubList').innerHTML = '<div class="empty">Reading notes…</div>'; } jbRefreshList(reread); }
}
function showTab(tab){
  for (const b of document.querySelectorAll('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  $('#filesPane').hidden = tab !== 'files'; $('#olPane').hidden = tab !== 'outline'; $('#tagPane').hidden = tab !== 'tags';
  $('#pubPane').hidden = tab !== 'published'; $('#linkPane').hidden = tab !== 'links';
  store.set('tab', tab); buildOutline();
  showPane(true);
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
/* Links tab: the notes that link to the open note ([[wiki links]] and [text](note.md)), with the line each link is on */
function linksShown(){ return paneShown('linkPane'); }
// every link inside the open note: [[notes]], [text](note.md or a web address) and bare web addresses, each once
function linksOut(t){
  const out = [], seen = new Set(), add = (key, o) => { if (!seen.has(key)){ seen.add(key); out.push(o); } };
  let fence = false;
  t.split('\n').forEach((l, i) => {
    if (FENCE_RE.test(l)){ fence = !fence; return; }
    if (fence) return;
    const s = l.replace(/`[^`]*`/g, '');
    for (const m of s.matchAll(/(!?)\[\[([^\]|\n]+)(?:\|([^\]\n]*))?\]\]/g)){
      const target = m[2].trim(), [name] = target.split('#');
      if (m[1] && IMG_EXT.test(name)) continue;   // a picture shown in the note, not a link
      add('w:' + target.toLowerCase(), { wiki: target, label: (m[3] || target).trim(), line: i, missing: !!lib && !!name.trim() && !resolveWiki(name) });
    }
    for (const m of s.matchAll(/(!?)\[([^\]]*)\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g)){
      if (m[1]) continue;
      add('h:' + m[3], { href: m[3], label: plain(m[2]) || m[3], line: i, web: /^[a-z][\w+.-]*:/i.test(m[3]) });
    }
    for (const m of s.replace(/\]\([^)]*\)/g, '').matchAll(/\bhttps?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g))
      add('h:' + m[0], { href: m[0], label: m[0], line: i, web: true });
  });
  return out;
}
let linksTimer = 0;
const linksSoon = () => { clearTimeout(linksTimer); linksTimer = setTimeout(() => { if (linksShown()) buildLinks(); }, 500); };
// the lines of a note that link to `me` (a link can only reach a note with the same file name, so check that first: big vaults stay quick)
function linesLinkingTo(f, lines, me){
  const base = basename(me).replace(/\.md$/i, '').toLowerCase(), out = [];
  const sameName = t => basename(t.trim()).replace(/\.md$/i, '').toLowerCase() === base;
  let fence = false;
  lines.forEach((l, i) => {
    if (FENCE_RE.test(l)){ fence = !fence; return; }
    if (fence || (!l.toLowerCase().includes(base) && !l.includes('%'))) return;
    for (const m of l.matchAll(/!?\[\[([^\]|#\n]+)/g)) if (sameName(m[1]) && resolveWiki(m[1]) === me){ out.push(i); return; }
    for (const m of l.matchAll(/\]\(<?([^)>#]+?\.md)(?:#[^)]*)?>?\)/gi)){
      if (/^[a-z]+:/i.test(m[1])) continue;
      let t; try { t = decodeURIComponent(m[1]); } catch (_) { t = m[1]; }
      if (sameName(t) && normPath(joinPath(dirname(f.path), t)) === me){ out.push(i); return; }
    }
  });
  return out;
}
async function buildLinks(reread){
  const box = $('#linkList');
  const outs = linksOut(text());
  const host_ = h => { try { return new URL(h).hostname.replace(/^www\./, ''); } catch (_) { return h; } };
  const outHtml = `<div class="lc">In this note: ${outs.length} link${outs.length === 1 ? '' : 's'}</div>` + (outs.length
    ? outs.map((o, k) => `<button class="lo${o.missing ? ' missing' : ''}" data-out="${k}" title="${esc(o.wiki || o.href)}">${esc(o.label)}<small>${o.wiki ? (o.missing ? 'not made yet' : 'note') : o.web ? esc(host_(o.href)) : 'note'}</small></button>`).join('')
    : '<div class="empty small">No links in this note. Type [[ to link a note, or paste a web address.</div>');
  box._outs = outs;
  if (!lib || cur.kind !== 'lib'){ box.innerHTML = outHtml; return; }
  if (reread){ if (!noteTexts.length) box.innerHTML = outHtml + '<div class="empty small">Reading notes…</div>'; await readNotes(); }
  const me = cur.path, hits = [];
  for (const { f, lines } of noteTexts){
    if (f.path === me) continue;
    const ls = linesLinkingTo(f, lines, me);
    if (ls.length) hits.push({ f, ls, lines });
  }
  hits.sort((a, b) => a.f.name.localeCompare(b.f.name, undefined, { numeric: true, sensitivity: 'base' }));
  const snip = l => esc(plain(l.replace(/^\s*(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|#+\s+|>\s?)/, '')).slice(0, 160)) || '(link)';
  box.innerHTML = outHtml + `<div class="lc" style="margin-top:10px">Linked from: ${hits.length} note${hits.length === 1 ? '' : 's'}</div>` + (hits.length
    ? hits.map(h => `<button class="lh" data-path="${esc(h.f.path)}" data-line="${h.ls[0]}">${esc(h.f.name.replace(/\.md$/i, ''))}<small>${h.ls.length}</small></button>` +
        h.ls.slice(0, 5).map(i => `<button class="ln" data-path="${esc(h.f.path)}" data-line="${i}">${snip(h.lines[i])}</button>`).join('')).join('')
    : `<div class="empty small">No other notes link here yet. Type [[${esc(cur.name.replace(/\.md$/i, ''))}]] in another note to link to this one.</div>`);
}
$('#linkList').addEventListener('click', async e => {
  const o = e.target.closest('button[data-out]');
  if (o){   // a link in this note: open the note or the web page
    const l = $('#linkList')._outs[+o.dataset.out];
    if (l.wiki) openWiki(l.wiki, e.ctrlKey || e.metaKey); else openLink(l.href);
    if (window.innerWidth <= 700 && !l.web) toggleSide(false);
    return;
  }
  const b = e.target.closest('button[data-path]'); if (!b) return;
  if (!(await flush())) return;
  await openLibFile(b.dataset.path, e.ctrlKey || e.metaKey);
  requestAnimationFrame(() => jumpToLine(+b.dataset.line));
  if (window.innerWidth <= 700) toggleSide(false);
});
// Outline, Tags and Links tabs can be hidden (Files always stays)
const TAB_SWITCH = { outline: '#bShowOutline', tags: '#bShowTags', links: '#bShowLinks' };
function setTabShown(tab, on){
  document.querySelector(`.tabs [data-tab="${tab}"]`).hidden = !on;
  store.set('hide.' + tab, on ? '' : '1');
  $(TAB_SWITCH[tab]).setAttribute('aria-pressed', String(on));
  if (!on && store.get('tab') === tab) showTab('files');
}
for (const [tab, id] of Object.entries(TAB_SWITCH)){
  $(id).addEventListener('click', () => setTabShown(tab, $(id).getAttribute('aria-pressed') !== 'true'));
}
$('#bSide').addEventListener('click', () => toggleSide());
// phones and tablets: swipe right to open the sidebar, swipe left to close it. Only quick, mostly sideways
// swipes count, and not ones that start on something that slides sideways itself (tables, code, the top bar)
// or while text is being selected.
{ let x0 = 0, y0 = 0, t0 = 0, on = false;
  const slides = el => { for (let e = el; e && e !== document.body; e = e.parentElement) if (e.scrollWidth > e.clientWidth + 2 && getComputedStyle(e).overflowX !== 'hidden' && getComputedStyle(e).overflowX !== 'visible') return true; return false; };
  document.addEventListener('touchstart', e => {
    on = e.touches.length === 1 && !e.target.closest('header, .modal, #ctx, #ctxSub, .menu-list, input, textarea, #sideGrip, #divider, .rail') && !slides(e.target);
    if (!on) return;
    x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; t0 = Date.now();
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!on) return;
    on = false;
    const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
    if (Date.now() - t0 > 700 || Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.5) return;
    if (!view.state.selection.main.empty && view.dom.contains(e.target)) return;   // dragging a text selection
    const open = !$('#side').hidden;
    if (dx > 0 && !open) toggleSide(true);
    else if (dx < 0 && open) toggleSide(false);
  }, { passive: true });
}
document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

/* ---------------- Phone scrollbar ----------------
   Android draws no scrollbar for the editor or the Read view, so phones and tablets get one of their own on the
   right edge: a thumb to drag (a bubble names the heading you're at) and a short line for every heading (longer
   for bigger headings; tap one to jump to it). Computers keep their normal scrollbar. */
// var, not const: render() may ask for railsSoon() before this part of the file has run
var railsOn = host.kind === 'android' || matchMedia('(pointer: coarse)').matches, rails = [], railTimer = 0;
function makeRail(sc, marks){
  const r = document.createElement('div');
  r.className = 'rail'; r.hidden = true;
  r.innerHTML = '<div class="ticks"></div><div class="thumb"></div><div class="bubble" hidden></div>';
  document.body.append(r);
  const ticks = r.firstChild, thumb = ticks.nextSibling, bubble = thumb.nextSibling;
  const R = { r, sc, marks, H: 0, h: 0, fade: 0, ms: [] };
  const max = () => Math.max(1, sc.scrollHeight - sc.clientHeight);
  // the thumb's middle sits on a heading's line when that heading is at the top of the page
  const yOf = top => (R.H - R.h) * Math.min(Math.max(top, 0), max()) / max() + R.h / 2;
  const near = top => { let m = null; for (const x of R.ms) if (x.y <= top + 24) m = x; return m; };
  // the editor only guesses the height of lines it hasn't drawn yet, so look again once it has
  const jump = k => {
    sc.scrollTop = R.ms[k].y - 8;
    let n = 0;
    const again = () => { const m = marks()[k]; if (m && Math.abs(sc.scrollTop - (m.y - 8)) > 2) sc.scrollTop = m.y - 8; if (++n < 3) setTimeout(again, 60); };
    setTimeout(again, 60);
  };
  R.place = () => {
    const b = sc.getBoundingClientRect();
    if (!b.width || !b.height || sc.scrollHeight <= sc.clientHeight + 4 || document.body.classList.contains('focus') && sc === pv){ r.hidden = true; return; }
    r.hidden = false;
    r.style.top = b.top + 4 + 'px'; r.style.height = b.height - 8 + 'px'; r.style.left = b.right - 30 + 'px';
    R.H = b.height - 8; R.h = Math.max(40, R.H * sc.clientHeight / sc.scrollHeight);
    R.ms = marks();
    ticks.innerHTML = R.ms.map(m => `<i class="h${Math.min(m.n, 3)}" style="top:${yOf(m.y - 8).toFixed(1)}px"></i>`).join('');
    R.move();
  };
  R.move = () => {
    if (r.hidden) return;
    thumb.style.height = R.h + 'px';
    thumb.style.top = (R.H - R.h) * sc.scrollTop / max() + 'px';
    r.classList.add('on'); clearTimeout(R.fade);
    R.fade = setTimeout(() => { if (!r.classList.contains('drag')) r.classList.remove('on'); }, 1500);
  };
  const say = () => {
    const m = near(sc.scrollTop);
    bubble.hidden = !m;
    if (m){ bubble.textContent = m.t || '(empty heading)'; bubble.style.top = (R.H - R.h) * sc.scrollTop / max() + R.h / 2 + 'px'; }
  };
  let grab = -1, y0 = 0, moved = false;
  r.addEventListener('pointerdown', e => {
    e.preventDefault(); e.stopPropagation();
    const top = r.getBoundingClientRect().top, y = e.clientY - top, tTop = parseFloat(thumb.style.top) || 0;
    y0 = e.clientY; moved = false;
    if (y >= tTop - 8 && y <= tTop + R.h + 8) grab = y - tTop;
    else {
      // a tap near a heading's line goes to that heading; anywhere else on the bar jumps there
      let best = -1, d = 18;
      R.ms.forEach((m, k) => { const dy = Math.abs(yOf(m.y - 8) - y); if (dy < d){ d = dy; best = k; } });
      if (best >= 0){ jump(best); grab = -1; R.move(); return; }
      grab = R.h / 2;
      sc.scrollTop = (y - grab) / Math.max(1, R.H - R.h) * max();
    }
    r.setPointerCapture(e.pointerId); r.classList.add('drag', 'on'); say();
  });
  r.addEventListener('pointermove', e => {
    if (grab < 0) return;
    if (Math.abs(e.clientY - y0) > 3) moved = true;
    const y = e.clientY - r.getBoundingClientRect().top - grab;
    sc.scrollTop = Math.min(Math.max(y, 0), R.H - R.h) / Math.max(1, R.H - R.h) * max();
    say();
  });
  const end = () => { if (grab < 0) return; grab = -1; r.classList.remove('drag'); bubble.hidden = true; R.move(); };
  r.addEventListener('pointerup', end); r.addEventListener('pointercancel', end);
  sc.addEventListener('scroll', () => { if (r.hidden) R.place(); else R.move(); }, { passive: true });
  rails.push(R);
}
function railsSoon(){ if (rails?.length){ clearTimeout(railTimer); railTimer = setTimeout(() => rails.forEach(R => R.place()), 120); } }

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
  link:  () => {   // a note or a web address: a small menu at the button (or at the cursor for Ctrl+K)
    if (!lib) return webLink();
    const b = fmtButton, r = b ? b.getBoundingClientRect() : view.coordsAtPos(sel().head) || { left: 100, bottom: 100 };
    fmtButton = null;
    showCtx(r.left, r.bottom + 4, [['Link to a note…', openLinkPicker], ['Web link…', webLink]]);
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
let fmtButton = null;   // the button that ran a format (menus open under it)
document.querySelectorAll('.fmt button').forEach(b => b.addEventListener('click', () => {
  if (main.dataset.view === 'preview') setView(lastEditView);
  fmtButton = b;
  FORMATS[b.dataset.f]();
  fmtButton = null;
}));

/* ---------------- Links: to a note ([[Note]]) or a web page ([text](address)) ---------------- */
let linkSel = null;   // what was selected when the note picker opened
function openLinkPicker(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  linkSel = { from: sel().from, to: sel().to };
  qsMode = 'link'; $('#qsInput').placeholder = 'Link to which note?';
  $('#qs').hidden = false; $('#qsInput').value = ''; qsFilter(); $('#qsInput').focus();
}
function insertNoteLink(name){
  const { from, to } = linkSel || sel(), picked = text().slice(from, to).trim();
  const link = `[[${name}${picked && picked !== name ? '|' + picked : ''}]]`;
  replaceRange(from, to, link, from + link.length);
  linkSel = null;
}
// the shortest name that still finds the note: its name, or its path when another note has the same name
function linkName(path){
  const n = basename(path).replace(/\.md$/i, ''), same = allFiles().filter(f => f.name.toLowerCase() === basename(path).toLowerCase());
  return same.length > 1 ? path.replace(/\.md$/i, '') : n;
}
async function webLink(){
  const { from, to } = sel(), picked = text().slice(from, to).trim(), isUrl = /^[a-z][\w+.-]*:\/\/\S+$/i.test(picked);
  const url = await ask('Web address', { input: isUrl ? picked : 'https://', buttons: [{ label: 'Cancel', value: null }, { label: 'Add link', value: true, primary: true }] });
  if (!url || url === 'https://') { view.focus(); return; }
  const full = /^[a-z][\w+.-]*:/i.test(url) ? url : 'https://' + url;
  let label = isUrl ? '' : picked;
  if (!label){ try { label = new URL(full).hostname.replace(/^www\./, ''); } catch (_) { label = 'link'; } }
  const link = `[${label}](${full.replace(/ /g, '%20').replace(/\)/g, '%29')})`;
  replaceRange(from, to, link, from + 1, from + 1 + label.length);   // the words stay selected, ready to type over
}

/* ---------------- Right-click inside a note (with a mouse; phones keep their own text menu) ---------------- */
// the link under a spot in the text: { wiki } or { href } or null
function linkAt(pos){
  const line = view.state.doc.lineAt(pos), t = line.text, at = pos - line.from;
  for (const re of [/!?\[\[([^\]|\n]+)(?:\|[^\]\n]*)?\]\]/g, /!?\[[^\]]*\]\(<?([^)>\s]+)>?(?:\s+"[^"]*")?\)/g, /\bhttps?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g])
    for (const m of t.matchAll(re)) if (at >= m.index && at <= m.index + m[0].length)
      return re.source.startsWith('!?\\[\\[') ? { wiki: m[1].trim() } : { href: m[1] || m[0] };
  return null;
}
$('#editPane').addEventListener('contextmenu', e => {
  if (!view.dom.contains(e.target)) return;
  if (!hoverable.matches) return;
  e.preventDefault();
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }), s = sel();
  if (pos != null && (s.empty || pos < s.from || pos > s.to)) view.dispatch({ selection: { anchor: pos } });
  const has = !sel().empty, l = pos != null ? linkAt(pos) : null, x = e.clientX, y = e.clientY;
  const clip = async (cut) => {
    const r = sel(), t = text().slice(r.from, r.to);
    try { await navigator.clipboard.writeText(t); if (cut) replaceRange(r.from, r.to, '', r.from); } catch (_) { toast(cut ? 'Use Ctrl+X to cut' : 'Use Ctrl+C to copy'); }
  };
  const items = [];
  if (l){
    items.push(['Open link', () => l.wiki ? openWiki(l.wiki) : openLink(l.href)]);
    items.push(['Copy link address', async () => { try { await navigator.clipboard.writeText(l.wiki ? '[[' + l.wiki + ']]' : l.href); toast('Copied'); } catch (_) {} }]);
  }
  if (has) items.push(['Cut', () => clip(true)], ['Copy', () => clip(false)]);
  items.push(['Paste', async () => {
    try { const t = await navigator.clipboard.readText(); const r = sel(); replaceRange(r.from, r.to, t, r.from + t.length); }
    catch (_) { toast('Use Ctrl+V to paste'); }
  }]);
  if (lib) items.push(['Link to a note…', openLinkPicker]);
  items.push(['Web link…', webLink]);
  showCtx(x, y, items);
});

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
  else if (/^#fn(ref)?-\d+$/.test(a.getAttribute('href'))) pv.querySelector(a.getAttribute('href'))?.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
// CodeMirror selects the whole Find box after every jump, so the next letter typed would replace it; keep the caret where it was
function jump(dir){
  const a = fFind.selectionStart, b = fFind.selectionEnd;
  (dir < 0 ? findPrevious : findNext)(view);
  if (document.activeElement === fFind) fFind.setSelectionRange(a, b);
}
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
  if (fFind.value) jump(1);
  updateCount();
});
fRep.addEventListener('input', setQuery);
fb.addEventListener('keydown', e => {
  if (e.key === 'Escape'){ e.preventDefault(); closeFind(); }
  else if (e.key === 'Enter' && e.target === fFind){ e.preventDefault(); jump(e.shiftKey ? -1 : 1); updateCount(); }
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
  const cs = getComputedStyle(document.documentElement);
  host.bars?.(cs.colorScheme.includes('dark'), cs.getPropertyValue('--panel').trim());
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(store.get('theme')));
// tap: light/dark. Hold it (or right-click) for the theme colors and accent.
{ let hold = 0, held = false;
  const bt = $('#bTheme');
  bt.title = 'Light/dark (hold for theme colors)';
  bt.addEventListener('pointerdown', () => { held = false; clearTimeout(hold); hold = setTimeout(() => { held = true; openThemes(); }, 500); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) bt.addEventListener(ev, () => clearTimeout(hold));
  bt.addEventListener('contextmenu', e => { e.preventDefault(); if (!held) openThemes(); held = true; });
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
  railsSoon();
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
$('#bCommands').addEventListener('click', closeMenu(openCommands));
$('#bHistory').addEventListener('click', closeMenu(openHistory));
$('#bErrLog').addEventListener('click', closeMenu(openErrLog));
$('#bBackup').addEventListener('click', closeMenu(backupLibrary));
$('#bRestore').addEventListener('click', closeMenu(restoreBackup));
for (const [id, fmt] of [['#bExport', 'html'], ['#bDocx', 'docx'], ['#bPrint', 'print'], ['#bTxt', 'txt'], ['#bEpub', 'epub'], ['#bCopyRich', 'copy']])
  $(id).addEventListener('click', closeMenu(() => exportCurrent(fmt)));
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
function showAbout(){
  $('#aboutLine').textContent = `Markpad ${VERSION} · ${host.kind === 'browser' ? 'web' : host.kind}` +
    (loadInfo ? ` · library: ${loadInfo.files.toLocaleString()} files in ${loadInfo.s.toFixed(1)} s` : '');
}
showAbout();
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
    if (!$('#sheet').hidden){ closeSheet(); return; }
    if (document.body.classList.contains('focus')){ setFocus(false); return; }
    if (searchPanelOpen(view.state)){ closeFind(); return; }
    if (picked.size){ clearPicks(); return; }
    if (window.innerWidth <= 700 && !$('#side').hidden){ toggleSide(false); return; }
    return;
  }
  if (e.key === 'F1'){ e.preventDefault(); openCommands(); return; }
  if (!mod || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'l' && e.shiftKey){ e.preventDefault(); openCommands(); return; }
  if (k === 'f' && e.shiftKey){ e.preventDefault(); setFocus(!document.body.classList.contains('focus')); }
  else if (k === 'f' || k === 'h'){ e.preventDefault(); openFind(k === 'h'); }
  else if (k === 'd' && e.shiftKey){ e.preventDefault(); todayNote(); }
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
  c.hidden = !jb.on;
  // not published yet: a grey label that offers Publish
  if (!p){ $('#jbChipText').textContent = 'Not published'; c.className = 'off'; c.title = 'Not published (JotBird)'; return; }
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

/* ---------------- Daily note & templates (like Obsidian's core plugins; reads their settings in a vault) ---------------- */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// the date words Obsidian uses (moment.js): YYYY-MM-DD, dddd D MMMM, HH:mm, [text in brackets] stays as it is
function fmtDate(d, f){
  const p2 = n => String(n).padStart(2, '0'), D = d.getDate();
  const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  return f.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|Do|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g, (t, lit) => lit != null ? lit : ({
    YYYY: d.getFullYear(), YY: p2(d.getFullYear() % 100), MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3), MM: p2(d.getMonth() + 1), M: d.getMonth() + 1,
    Do: ord(D), DD: p2(D), D, dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3), HH: p2(d.getHours()), H: d.getHours(),
    hh: p2(d.getHours() % 12 || 12), h: d.getHours() % 12 || 12, mm: p2(d.getMinutes()), ss: p2(d.getSeconds()), A: d.getHours() < 12 ? 'AM' : 'PM', a: d.getHours() < 12 ? 'am' : 'pm',
  })[t]);
}
// {{title}}, {{date}}, {{time}}, {{date:dddd D MMMM}} … like Obsidian's templates
const fillTemplate = (t, title, d = new Date()) => t.replace(/\{\{\s*(title|date|time)\s*(?::([^}]*))?\}\}/gi, (_, k, f) => {
  k = k.toLowerCase();
  return k === 'title' ? title : fmtDate(d, f?.trim() || (k === 'date' ? 'YYYY-MM-DD' : 'HH:mm'));
});
const DAILY_DEFAULT = { folder: 'Daily', format: 'YYYY-MM-DD', template: '', templates: 'Templates' };
async function dailyCfg(){
  const saved = store.get('daily.' + lib.desc.id);
  if (saved) return { ...DAILY_DEFAULT, ...JSON.parse(saved) };
  // first time in a vault: start from Obsidian's own daily note and template settings
  const cfg = { ...DAILY_DEFAULT };
  const json = async p => { try { return JSON.parse(await lib.fs.read(p)); } catch (_) { return null; } };
  const dn = await json('.obsidian/daily-notes.json'), tp = await json('.obsidian/templates.json');
  if (dn){ cfg.folder = dn.folder ?? ''; if (dn.format) cfg.format = dn.format; if (dn.template) cfg.template = dn.template; }
  if (tp?.folder) cfg.templates = tp.folder;
  return cfg;
}
const cleanDir = d => normPath((d || '').trim());
async function todayNote(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  const cfg = await dailyCfg(), now = new Date();
  const name = fmtDate(now, cfg.format || 'YYYY-MM-DD').replace(/[\\:*?"<>|]/g, '-');
  const path = normPath(joinPath(cleanDir(cfg.folder), name + '.md'));
  const have = allFiles().find(f => f.path.toLowerCase() === path.toLowerCase());
  if (!(await flush())) return;
  if (have){ await openLibFile(have.path); return; }
  let text = '';
  if (cfg.template.trim()){
    const tp = resolveWiki(cfg.template.trim());
    if (tp) text = fillTemplate(await lib.fs.read(tp).catch(() => ''), basename(name), now);
    else toast(`Daily template “${cfg.template}” not found, made an empty note`);
  }
  await lib.fs.write(path, text);
  await refreshTree();
  await openLibFile(path);
}
async function insertTemplate(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  const dir = cleanDir((await dailyCfg()).templates).toLowerCase();
  const list = allFiles().filter(f => isNote(f.name) && (dir ? f.path.toLowerCase().startsWith(dir + '/') : true));
  if (!list.length){ toast(`No templates yet: put notes in the “${dir || 'Templates'}” folder`); return; }
  jbDialog('Insert template', list.map(f => `<button class="tpl" data-path="${esc(f.path)}">${esc(f.path.slice(dir ? dir.length + 1 : 0).replace(/\.md$/i, ''))}</button>`).join(''));
  $('#jbBody').onclick = async e => {
    const b = e.target.closest('.tpl'); if (!b) return;
    $('#jbDlg').hidden = true;
    let t = fillTemplate(await lib.fs.read(b.dataset.path).catch(() => ''), cur.name.replace(/\.md$/i, ''));
    if (text().trim()) t = noFront(t);   // the note already has its own start, so the template's properties stay out
    const sel = view.state.selection.main;
    replaceRange(sel.from, sel.to, t, sel.from + t.length);
  };
}
async function dailySettings(){
  if (!lib){ toggleSide(true); toast('Pick a library first'); return; }
  const c = await dailyCfg();
  const fld = (id, label, v, ph) => `<label class="fld">${label}<input id="${id}" value="${esc(v)}" placeholder="${ph}" spellcheck="false"></label>`;
  jbDialog('Daily note & templates', fld('dnFolder', 'Daily notes folder (empty = top of the library)', c.folder, 'Daily') +
    fld('dnFormat', 'File name (YYYY year, MM month, DD day, dddd weekday, MMMM month name)', c.format, 'YYYY-MM-DD') +
    fld('dnTemplate', 'Template for new daily notes (a note name, optional)', c.template, 'Templates/Daily') +
    fld('dnTemplates', 'Templates folder', c.templates, 'Templates') +
    `<div class="sub">In templates, {{title}}, {{date}} and {{time}} are filled in (also {{date:dddd D MMMM}}).</div>`, () => {
      const v = id => $('#' + id).value.trim();
      store.set('daily.' + lib.desc.id, JSON.stringify({ folder: v('dnFolder'), format: v('dnFormat') || 'YYYY-MM-DD', template: v('dnTemplate'), templates: v('dnTemplates') }));
      $('#jbDlg').hidden = true; toast('Saved');
    });
}
$('#bToday').addEventListener('click', closeMenu(todayNote));
$('#bTemplate').addEventListener('click', closeMenu(insertTemplate));
$('#bDailySet').addEventListener('click', closeMenu(dailySettings));

/* ---------------- Theme: color (muted red, blue, green, yellow or plain grey), light/dark and accent, per device ---------------- */
const PALETTES = [['Plain', '', '#8a8d93'], ['Red', 'red', '#a4463f'], ['Blue', 'blue', '#3d6a9e'], ['Green', 'green', '#4a7a51'], ['Yellow', 'yellow', '#93700f']];
const MODES = [['Light', 'light'], ['Dark', 'dark'], ['Like the system', '']];
const ACCENTS = [["Theme's own", ''], ['Purple', '#8b5cf6'], ['Pink', '#e0457b'], ['Red', '#d64545'], ['Orange', '#e8730c'], ['Gold', '#c99a06'], ['Green', '#2f9e5a'], ['Teal', '#14a3a3']];
function setPalette(p){
  if (p) document.documentElement.dataset.palette = p; else delete document.documentElement.dataset.palette;
  store.set('palette', p || '');
  applyTheme(store.get('theme'));
}
function setAccent(c){
  if (c) document.documentElement.style.setProperty('--accent', c); else document.documentElement.style.removeProperty('--accent');
  store.set('accent', c || '');
}
setPalette(store.get('palette') || '');
setAccent(store.get('accent') || '');
function openThemes(){
  menu.open = false;
  const pal = store.get('palette') || '', mode = store.get('theme') || '', acc = store.get('accent') || '';
  const sw = (kind, v, n, c, on) => `<button class="sw${on ? ' on' : ''}" data-${kind}="${v}" title="${n}" style="--c:${c}"><span></span>${n}</button>`;
  jbDialog('Theme', `<div class="sub">Color</div><div class="swatches" data-group="palette">${PALETTES.map(([n, v, c]) => sw('palette', v, n, c, v === pal)).join('')}</div>
    <div class="sub">Light or dark</div><div class="swatches" data-group="mode">${MODES.map(([n, v]) => sw('mode', v, n, v === 'dark' ? '#25262a' : v === 'light' ? '#f3f2ef' : 'linear-gradient(90deg,#f3f2ef 50%,#25262a 50%)', v === mode)).join('')}</div>
    <div class="sub">Accent (links, buttons)</div><div class="swatches" data-group="accent">${ACCENTS.map(([n, c]) => sw('accent', c, n, c || 'var(--accent)', c === acc)).join('')}
    <label class="sw custom"><input type="color" id="accentPick" value="${acc || '#3b6fd8'}"><span>Custom…</span></label></div>`);
  $('#accentPick').addEventListener('input', e => { setAccent(e.target.value); $('#jbBody').querySelectorAll('[data-group="accent"] button.sw').forEach(b => b.classList.remove('on')); });
}
$('#jbBody').addEventListener('click', e => {
  const s = e.target.closest('button.sw'); if (!s) return;
  if (s.dataset.palette != null){ setPalette(s.dataset.palette); setAccent(''); $('#accentPick').value = '#3b6fd8'; }   // a new color brings its own accent
  else if (s.dataset.mode != null){ applyTheme(s.dataset.mode); store.set('theme', s.dataset.mode); }
  else if (s.dataset.accent != null) setAccent(s.dataset.accent);
  else return;
  s.parentElement.querySelectorAll('button.sw').forEach(b => b.classList.toggle('on', b === s));
  if (s.dataset.palette != null) $('#jbBody').querySelectorAll('[data-accent]').forEach(b => b.classList.toggle('on', b.dataset.accent === ''));
});

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

/* ---------------- A dialog with a title, any content and buttons (note history, error log) ---------------- */
function sheet(title, html, buttons, wide){
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  $('#sheet').classList.toggle('wide', !!wide);
  const btns = $('#sheetBtns'); btns.innerHTML = '';
  for (const b of buttons){
    const el = document.createElement('button');
    el.textContent = b.label; if (b.primary) el.className = 'primary'; if (b.id) el.id = b.id;
    el.onclick = b.fn; btns.appendChild(el);
  }
  $('#sheet').hidden = false;
  return $('#sheetBody');
}
const closeSheet = () => { $('#sheet').hidden = true; };
$('#sheet').addEventListener('click', e => { if (e.target.id === 'sheet') closeSheet(); });

/* ---------------- Note history ---------------- */
// Snapshots of each note, kept on this device (IndexedDB): the text it had when it was opened, then the
// newest save of every 10 minutes, for 30 days (100 at most per note). ▾ > Note history… puts one back.
const HIST_GAP = 10 * 60e3, HIST_KEEP = 30 * 864e5, HIST_MAX = 100;
const histKey = c => c.kind === 'lib' && lib && c.path ? 'hist:' + lib.desc.id + ':' + c.path : c.kind === 'loose' && c.ref ? 'hist:file:' + c.ref : null;
const kvDel = k => idb('readwrite', st => st.delete(k)).catch(() => {});
let histQueue = Promise.resolve();
function snapshot(c, t, opened){
  const k = histKey(c);
  if (!k) return;
  histQueue = histQueue.then(async () => {
    const now = Date.now();
    let list = ((await kvGet(k)) || []).filter(x => now - x.t < HIST_KEEP);
    if (list[0]?.text === t) return;
    if (!opened && list[0] && !list[0].open && now - list[0].t < HIST_GAP) list[0] = { t: now, text: t };
    else list.unshift({ t: now, text: t, ...(opened ? { open: true } : {}) });
    await kvSet(k, list.slice(0, HIST_MAX));
  }).catch(() => {});
}
// a renamed or moved note (or folder) takes its history along
function histMove(from, to){
  if (!lib) return;
  const pre = 'hist:' + lib.desc.id + ':';
  histQueue = histQueue.then(async () => {
    const keys = await idb('readonly', st => st.getAllKeys());
    for (const k of keys){
      const p = typeof k === 'string' && k.startsWith(pre) ? k.slice(pre.length) : null;
      if (p == null || !(p === from || p.startsWith(from + '/'))) continue;
      await kvSet(pre + to + p.slice(from.length), await kvGet(k)); await kvDel(k);
    }
  }).catch(() => {});
}
function when(t){
  const d = new Date(t), today = new Date().toDateString(), yest = new Date(Date.now() - 864e5).toDateString();
  const hm = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === today ? 'Today ' + hm : d.toDateString() === yest ? 'Yesterday ' + hm : d.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' + hm;
}
async function openHistory(){
  const k = histKey(cur);
  if (!k){ toast('History is kept for notes and files, not unsaved pages'); return; }
  await histQueue;
  const list = (await kvGet(k)) || [], now = text();
  if (!list.length){ sheet('Note history', '<p>No history yet. Markpad keeps a copy each time this note opens and every 10 minutes while you save.</p>', [{ label: 'Close', fn: closeSheet, primary: true }]); return; }
  let on = 0;
  const body = sheet('History of ' + cur.name.replace(/\.md$/i, ''), `<div class="hist"><div class="hlist">${list.map((x, i) => {
    const d = x.text.length - now.length;
    return `<button data-i="${i}"${i ? '' : ' class="on"'}>${when(x.t)}<small>${x.open ? 'when opened · ' : ''}${x.text === now ? 'same as now' : (d >= 0 ? '+' : '−') + Math.abs(d).toLocaleString() + ' chars vs now'}</small></button>`;
  }).join('')}</div><pre class="hview"></pre></div><p class="sub">Lines in red aren’t in the note now. Restore can be undone with Ctrl+Z.</p>`, [
    { label: 'Close', fn: closeSheet },
    { label: 'Copy', fn: () => navigator.clipboard.writeText(list[on].text).then(() => toast('Copied'), () => toast("Couldn't copy")) },
    { label: 'Restore this version', primary: true, fn: () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: list[on].text }, userEvent: 'input' });
      closeSheet(); toast('Restored · Ctrl+Z undoes it');
    } },
  ], true);
  const nowLines = new Set(now.split('\n'));
  const show = i => {
    on = i;
    body.querySelectorAll('.hlist button').forEach(b => b.classList.toggle('on', +b.dataset.i === i));
    body.querySelector('.hview').innerHTML = list[i].text.split('\n').map(l => nowLines.has(l) ? esc(l) : `<span class="gone">${esc(l) || ' '}</span>`).join('\n');
  };
  body.querySelector('.hlist').addEventListener('click', e => { const b = e.target.closest('button'); if (b) show(+b.dataset.i); });
  show(0);
}

/* ---------------- Bookmarks ---------------- */
// Pinned notes at the top of the Files tab: per library, kept on this device.
const bookmarks = () => { try { return lib ? JSON.parse(store.get('bm.' + lib.desc.id) || '[]') : []; } catch (_) { return []; } };
function setBookmarks(list){ if (lib){ store.set('bm.' + lib.desc.id, JSON.stringify(list)); renderBookmarks(); } }
const isBookmarked = p => bookmarks().includes(p);
function toggleBookmark(p){
  const list = bookmarks(), had = list.includes(p);
  setBookmarks(had ? list.filter(x => x !== p) : [...list, p]);
  toast(had ? 'Bookmark removed' : 'Bookmarked');
}
// to = null: deleted
function moveBookmarks(from, to){
  const list = bookmarks(), inside = p => p === from || p.startsWith(from + '/');
  if (list.some(inside)) setBookmarks(list.flatMap(p => !inside(p) ? [p] : to == null ? [] : [to + p.slice(from.length)]));
}
function renderBookmarks(){
  const list = bookmarks(), box = $('#bmBox');
  box.hidden = !list.length;
  const have = new Set(allFiles().map(f => f.path));
  box.innerHTML = list.length ? '<div class="bmhead">★ Bookmarks</div>' + list.map(p =>
    `<button class="bm${have.has(p) ? '' : ' missing'}${cur.kind === 'lib' && cur.path === p ? ' on' : ''}" data-path="${esc(p)}" title="${esc(p)}">${esc(basename(p).replace(/\.md$/i, ''))}</button>`).join('') : '';
}
$('#bmBox').addEventListener('click', e => { const b = e.target.closest('.bm'); if (b) openLibFile(b.dataset.path, e.ctrlKey || e.metaKey); });
$('#bmBox').addEventListener('contextmenu', e => {
  const b = e.target.closest('.bm'); if (!b) return;
  e.preventDefault();
  const p = b.dataset.path, list = bookmarks(), i = list.indexOf(p);
  const swap = j => () => { const l = [...list]; [l[i], l[j]] = [l[j], l[i]]; setBookmarks(l); };
  showCtx(e.clientX, e.clientY, [
    ['Open in new tab', () => openLibFile(p, true)],
    ...(i > 0 ? [['Move up', swap(i - 1)]] : []),
    ...(i < list.length - 1 ? [['Move down', swap(i + 1)]] : []),
    ['Remove bookmark', () => toggleBookmark(p)],
  ]);
});

/* ---------------- Commands (F1, Ctrl+Shift+L, or ▾ > Commands…) ---------------- */
// Every toolbar button and menu item by name, so nothing has to be hunted for. Built from the page itself,
// so new buttons show up here without a list to keep.
let cmdHits = [];
const SECTION = { pDaily: 'Daily note', pExport: 'Export', pSettings: 'Settings', pChecklists: 'Checklists', pBackup: 'Backup' };
function commandList(){
  const out = [], seen = new Set();
  const add = (label, run, key = '', state = '') => { label = label.replace(/\s+/g, ' ').trim(); if (label && !seen.has(label)){ seen.add(label); out.push({ label, run, key, state }); } };
  const split = t => { const m = (t || '').match(/^(.*?)\s*\(([^)]*(?:Ctrl|F\d)[^)]*)\)\s*$/); return m ? [m[1], m[2]] : [t || '', '']; };
  const onOff = b => b.classList.contains('tog') && b.hasAttribute('aria-pressed') ? (b.getAttribute('aria-pressed') === 'true' ? 'on' : 'off') : '';
  for (const b of document.querySelectorAll('header > button, header .fmt button')){
    if (b.hidden || b.id === 'bTheme') continue;
    const [l, k] = split(b.title);
    add(l, () => b.click(), k, b.id === 'bFind' ? '' : onOff(b));
  }
  for (const b of document.querySelectorAll('header .seg[aria-label="View"] button')) add('View: ' + b.title.split(':')[0], () => b.click());
  add('Light / dark', () => $('#bTheme').click());
  add('Theme colors…', openThemes);
  for (const b of menu.querySelectorAll('.menu-list button')){
    if (b.hidden || b.classList.contains('has-sub') || b.classList.contains('back') || b.id === 'bCommands' || b.closest('#pRecent')) continue;
    const panel = b.closest('.panel'), key = b.querySelector('.key')?.textContent || '';
    const label = [...b.childNodes].filter(n => !(n.classList && n.classList.contains('key'))).map(n => n.textContent).join('');
    add((panel && SECTION[panel.id] ? SECTION[panel.id] + ': ' : '') + label, () => b.click(), key, onOff(b));
  }
  if (cur.kind === 'lib' && lib) add(isBookmarked(cur.path) ? 'Remove bookmark' : 'Bookmark this note', () => toggleBookmark(cur.path));
  add('New folder', () => lib ? newFolder() : toast('Pick a library first'));
  add('Toggle sidebar', () => toggleSide(), 'Ctrl+\\');
  add('Show Outline', () => { toggleSide(true); showTab('outline'); }, 'Ctrl+Shift+O');
  add('New tab', newTab, 'Ctrl+T');
  add('Close tab', () => closeTab(active), 'Ctrl+W');
  return out;
}
function openCommands(){
  qsMode = 'cmds'; $('#qsInput').placeholder = 'Type a command…';
  cmdAll = commandList();
  $('#qs').hidden = false; $('#qsInput').value = ''; qsFilter(); $('#qsInput').focus();
}
let cmdAll = [];
function cmdFilter(){
  const words = $('#qsInput').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  cmdHits = cmdAll.filter(c => words.every(w => c.label.toLowerCase().includes(w)));
  if (words.length) cmdHits.sort((a, b) => +!a.label.toLowerCase().startsWith(words[0]) - +!b.label.toLowerCase().startsWith(words[0]));
  qsOn = 0;
  $('#qsList').innerHTML = cmdHits.map((c, k) => `<button data-c="${k}"${k ? '' : ' class="on"'}>${esc(c.label)}${c.state ? ` <span class="cstate ${c.state}">${c.state}</span>` : ''}<small>${esc(c.key)}</small></button>`).join('')
    || '<div class="empty">No command by that name</div>';
}

/* ---------------- Share into Markpad (Android's Share menu) ---------------- */
// Text or a web link shared from another app lands in a note: the open one, today's note, or a new one.
function sharedMarkdown({ text = '', subject = '' }){
  text = String(text).trim(); subject = String(subject).trim();
  if (/^https?:\/\/\S+$/.test(text) && subject && subject !== text) return `[${subject.replace(/[[\]]/g, '')}](${text})`;
  return text;
}
async function receiveShare(s){
  const md = sharedMarkdown(s || {});
  if (!md) return;
  const here = cur.kind !== 'scratch' || view.state.doc.length;
  const where = await ask('Add what was shared to a note?\n\n' + (md.length > 240 ? md.slice(0, 240) + '…' : md), { buttons: [
    { label: 'Cancel', value: null },
    ...(here ? [{ label: 'This note', value: 'here' }] : []),
    ...(lib ? [{ label: 'Today’s note', value: 'today' }] : []),
    { label: 'New note', value: 'new', primary: true },
  ] });
  if (!where) return;
  if (where === 'today') await todayNote();
  else if (where === 'new'){
    const name = (s.subject || md.split('\n')[0].replace(/^#+\s*|https?:\/\/|[[\]()*_`>#]/g, '') || 'Shared').trim().slice(0, 60) || 'Shared';
    if (lib){ if (!(await flush())) return; await createNote(selectedDir(), name); }
    else await openInTab('', { kind: 'scratch', name: name + '.md' }, true);
  }
  // at the end, a blank line apart
  const doc = view.state.doc, end = doc.length, tail = doc.sliceString(Math.max(0, end - 2), end);
  const sep = !end ? '' : tail.endsWith('\n\n') ? '' : tail.endsWith('\n') ? '\n' : '\n\n';
  replaceRange(end, end, sep + md + '\n', end + sep.length + md.length + 1);
  toast('Added to ' + cur.name.replace(/\.md$/i, ''));
}

/* ---------------- Error log dialog ---------------- */
function openErrLog(){
  const list = errList();
  const txt = () => list.map(e => `${new Date(e.t).toLocaleString()}  [${e.w}]  ${e.m}`).join('\n\n');
  sheet('Error log', list.length
    ? `<p class="sub">Newest first, kept on this device only. Copy puts it on the clipboard to paste into a message.</p><pre class="errlog">${esc(txt())}</pre>`
    : '<p>No errors so far.</p>', [
    ...(list.length ? [
      { label: 'Clear', fn: () => { store.set('errlog', '[]'); closeSheet(); toast('Error log cleared'); } },
      { label: 'Copy', fn: () => navigator.clipboard.writeText(`Markpad ${VERSION} · ${host.kind} · ${navigator.userAgent}\n\n` + txt()).then(() => toast('Copied'), () => toast('Copy did not work')) },
    ] : []),
    { label: 'Close', fn: closeSheet, primary: true },
  ], true);
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
  fillBlock: (el, measure) => fillHtml(el, 0, measure),
  onUpdate(u){
    if (u.docChanged && !loading){ scrollSrc = 'ed'; if (!dirty) setDirty(true); else { saveSession(); if (autosave && cur.kind === 'lib'){ clearTimeout(saveTimer); saveTimer = setTimeout(() => save(false, true), 1200); } } scheduleRender(); }
    if (u.selectionSet || u.docChanged) updateCursor();
    if ((u.docChanged || u.selectionSet) && searchPanelOpen(u.state)) updateCount();
  },
});
view = cm.view;
if (railsOn){
  document.body.classList.add('rails');
  makeRail(view.scrollDOM, () => heads.map(h => ({ y: lineY(h.line), t: h.t, n: h.n })));
  makeRail(pv, () => [...pv.querySelectorAll('h1,h2,h3,h4,h5,h6')].map(e => ({ y: e.offsetTop, t: e.textContent, n: +e.tagName[1] })));
  addEventListener('resize', railsSoon);
}
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
host.onShare?.(receiveShare);
if (host.onOpenFile) host.onOpenFile(async f => { await openInTab(f.text, { kind: 'loose', name: f.name, ref: f.ref }, true); addRecent({ name: f.name, ref: f.ref }); });

(async () => {
  recent = (await kvGet('recent')) || []; showRecent();
  libs = (await kvGet('libs')) || [];
  const v = store.get('view'); setView(['live', 'editor', 'split', 'preview'].includes(v) ? v : 'live');
  for (const t of Object.keys(TAB_SWITCH)) setTabShown(t, !store.get('hide.' + t));
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
  const crash = await host.lastCrash?.().catch(() => null);
  if (crash) logErr(crash, 'android crash');
  const shared = await host.startupShare?.().catch(() => null);
  if (shared) receiveShare(shared);
  updateCursor();
  view.focus();
})();

// Android's back button: close whatever is open first (returns true if it closed something)
window.__mpBack = () => {
  if (!$('#ask').hidden){ $('#ask').hidden = true; return true; }
  if (!$('#qs').hidden){ $('#qs').hidden = true; return true; }
  if (!$('#jbDlg').hidden){ $('#jbDlg').hidden = true; return true; }
  if (!$('#sheet').hidden){ closeSheet(); return true; }
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
