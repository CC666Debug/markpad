// Every edition (browser, Windows/Linux app, Android app) reaches files through one of these hosts,
// so the editor and library code is the same everywhere.
//
// Loose files are identified by a `ref` (a file handle in the browser, a path on desktop, a
// content:// uri on Android). A library is a folder; inside it every path is relative and uses '/'.
//
// Library filesystem (host.lib(desc)):
//   list() → [{name, path, dir, children?}]   read(p) → text   write(p, text)   writeBin(p, Uint8Array)
//   mkdir(p)   rename(from, to)   trash(p) (moves into .trash/, like Obsidian)   mtime(p) → ms   url(p) → src for <img>

const MD_TYPES = [{ description: 'Markdown', accept: { 'text/markdown': ['.md', '.markdown', '.mdown', '.mkd', '.txt'] } }];
const SHOWN = /\.(md|markdown|mdown|mkd|txt|png|jpe?g|gif|webp|svg|bmp|avif)$/i;
const sortTree = list => list.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };

function download(name, content, type){
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([content], { type: type + ';charset=utf-8' }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

/* ---------------- Browser (Chrome/Edge get real files; others fall back to upload/download) ---------------- */
function browserHost(){
  const canFS = 'showOpenFilePicker' in window;
  async function writeHandle(h, data){
    if (h.queryPermission && (await h.queryPermission({ mode: 'readwrite' })) !== 'granted'){
      if ((await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('permission denied');
    }
    const w = await h.createWritable(); await w.write(data); await w.close();
  }
  function pickViaInput(){
    return new Promise(res => {
      const i = document.createElement('input');
      i.type = 'file'; i.accept = '.md,.markdown,.mdown,.mkd,.txt,text/markdown,text/plain';
      i.onchange = async () => { const f = i.files[0]; res(f ? { name: f.name, ref: null, text: await f.text() } : null); };
      i.click();
    });
  }
  function lib(desc){
    const root = desc.handle;
    async function dirOf(path, create){
      let d = root;
      for (const part of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(part, { create });
      return d;
    }
    const split = p => { const i = p.lastIndexOf('/'); return [p.slice(0, i + 1), p.slice(i + 1)]; };
    const fileOf = async (p, create) => { const [d, n] = split(p); return (await dirOf(d, create)).getFileHandle(n, { create }); };
    async function walk(d, pre){
      const out = [];
      for await (const [name, h] of d.entries()){
        if (name.startsWith('.')) continue;
        if (h.kind === 'directory') out.push({ name, path: pre + name, dir: true, children: await walk(h, pre + name + '/') });
        else if (SHOWN.test(name)) out.push({ name, path: pre + name, dir: false });
      }
      return sortTree(out);
    }
    async function copy(from, to){   // the browser can't move files, so moves are copy + delete
      const [fd, fn] = split(from), src = await dirOf(fd);
      let h;
      try { h = await src.getFileHandle(fn); } catch (_) { h = null; }
      if (h){ await writeHandle(await fileOf(to, true), await h.getFile()); return; }
      const d = await src.getDirectoryHandle(fn);
      await dirOf(to, true);
      for await (const [name] of d.entries()) await copy(from + '/' + name, to + '/' + name);
    }
    const remove = async p => { const [d, n] = split(p); await (await dirOf(d)).removeEntry(n, { recursive: true }); };
    const urls = {};
    return {
      list: () => walk(root, ''),
      read: async p => (await (await fileOf(p)).getFile()).text(),
      write: async (p, t) => writeHandle(await fileOf(p, true), t),
      writeBin: async (p, bytes) => writeHandle(await fileOf(p, true), bytes),
      mkdir: p => dirOf(p, true),
      rename: async (a, b) => { await copy(a, b); await remove(a); },
      trash: async p => { const n = p.split('/').pop(); await copy(p, '.trash/' + Date.now() + ' ' + n); await remove(p); },
      mtime: async p => (await (await fileOf(p)).getFile()).lastModified,
      url: async p => {
        const f = await (await fileOf(p)).getFile(), k = p + '|' + f.lastModified;
        return urls[k] || (urls[k] = URL.createObjectURL(f));
      },
    };
  }
  return {
    kind: 'browser', canLibrary: 'showDirectoryPicker' in window, canPortable: false,
    async openFile(){
      if (!canFS) return pickViaInput();
      const [h] = await window.showOpenFilePicker({ types: MD_TYPES, multiple: false });
      return { name: h.name, ref: h, text: await (await h.getFile()).text() };
    },
    readRef: async h => {
      if ((await h.queryPermission({ mode: 'readwrite' })) !== 'granted' && (await h.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('permission denied');
      return (await h.getFile()).text();
    },
    writeRef: (h, text) => writeHandle(h, text),
    async saveAs(name, text){
      if ('showSaveFilePicker' in window){
        const h = await window.showSaveFilePicker({ suggestedName: name, types: MD_TYPES });
        await writeHandle(h, text); return { name: h.name, ref: h };
      }
      download(name, text, 'text/markdown'); return { name, ref: null };
    },
    sameRef: (a, b) => a && b && a.isSameEntry ? a.isSameEntry(b) : false,
    download: async (name, content, type) => download(name, content, type),
    print: () => window.print(),
    startupFile: async () => null,
    async pickLibrary(){
      const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
      return { id: 'b:' + handle.name + ':' + Date.now(), name: handle.name, handle };
    },
    // after a reload the browser forgets folder permission until the user clicks something
    async ready(desc, ask){
      const q = await desc.handle.queryPermission({ mode: 'readwrite' });
      if (q === 'granted') return true;
      return ask && (await desc.handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    },
    lib,
    dropHandle: item => item.getAsFileSystemHandle ? item.getAsFileSystemHandle() : null,
    setTitle: t => { document.title = t; },
    onClose(){ /* beforeunload is wired up by the app */ },
    openExternal: url => window.open(url, '_blank', 'noopener'),
  };
}

/* ---------------- Desktop (Tauri: Windows + Linux) ---------------- */
function desktopHost(){
  const T = window.__TAURI__, invoke = T.core.invoke, dialog = T.dialog;
  const name = p => p.split(/[\\/]/).pop();
  const MD = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }];
  function lib(desc){
    const root = desc.path;
    return {
      list: () => invoke('list_tree', { root }),
      read: path => invoke('read_text', { root, path }),
      write: (path, text) => invoke('write_text', { root, path, text }),
      writeBin: (path, bytes) => invoke('write_b64', { root, path, data: b64(bytes) }),
      mkdir: path => invoke('make_dir', { root, path }),
      rename: (from, to) => invoke('rename_path', { root, from, to }),
      trash: path => invoke('trash_path', { root, path }),
      mtime: path => invoke('mtime', { root, path }),
      url: async path => T.core.convertFileSrc(root.replace(/[\\/]$/, '') + '/' + path),
    };
  }
  return {
    kind: 'desktop', canLibrary: true, canPortable: true,
    async openFile(){
      const p = await dialog.open({ multiple: false, directory: false, filters: MD });
      if (!p) return null;
      return { name: name(p), ref: p, text: await invoke('read_text', { root: '', path: p }) };
    },
    readRef: p => invoke('read_text', { root: '', path: p }),
    writeRef: (p, text) => invoke('write_text', { root: '', path: p, text }),
    async saveAs(n, text){
      const p = await dialog.save({ defaultPath: n, filters: MD });
      if (!p) return null;
      await invoke('write_text', { root: '', path: p, text }); return { name: name(p), ref: p };
    },
    sameRef: async (a, b) => a === b,
    looseUrl: (ref, rel) => T.core.convertFileSrc(ref.replace(/[\\/][^\\/]*$/, '') + '/' + rel),
    async download(n, content){
      const ext = n.split('.').pop();
      const p = await dialog.save({ defaultPath: n, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (p) await invoke('write_text', { root: '', path: p, text: content });
      return !!p;
    },
    print: () => window.print(),
    async startupFile(){
      const p = await invoke('startup_file');
      return p ? { name: name(p), ref: p, text: await invoke('read_text', { root: '', path: p }) } : null;
    },
    async pickLibrary(){
      const p = await dialog.open({ directory: true, multiple: false });
      return p ? { id: 'p:' + p, name: name(p), path: p } : null;
    },
    async portableLibrary(){
      const p = await invoke('portable_dir');
      return { id: 'p:' + p, name: 'Portable notes', path: p, portable: true };
    },
    ready: async () => true,
    lib,
    dropHandle: () => null,
    setTitle: t => { document.title = t; T.window.getCurrentWindow().setTitle(t).catch(() => {}); },
    onClose(fn){
      const w = T.window.getCurrentWindow();
      w.onCloseRequested(async e => { if (!(await fn())) e.preventDefault(); });
    },
    openExternal: url => invoke('open_external', { url }),
  };
}

/* ---------------- Android (WebView + Kotlin bridge, files through Android's own pickers) ---------------- */
function androidHost(){
  const A = window.MarkpadAndroid, waiting = {};
  let seq = 0;
  window.__mpDone = (id, ok, json) => {
    const w = waiting[id]; if (!w) return;
    delete waiting[id];
    const v = json === '' ? null : JSON.parse(json);
    ok ? w.res(v) : w.rej(new Error(v || 'failed'));
  };
  const call = (method, args = {}) => new Promise((res, rej) => {
    const id = ++seq; waiting[id] = { res, rej };
    A.call(id, method, JSON.stringify(args));
  });
  function lib(desc){
    const root = desc.uri;
    return {
      list: () => call('list', { root }),
      read: path => call('read', { root, path }),
      write: (path, text) => call('write', { root, path, text }),
      writeBin: (path, bytes) => call('writeB64', { root, path, data: b64(bytes) }),
      mkdir: path => call('mkdir', { root, path }),
      rename: (from, to) => call('rename', { root, from, to }),
      trash: path => call('trash', { root, path }),
      mtime: path => call('mtime', { root, path }),
      url: async path => 'https://appassets.androidplatform.net/lib/?root=' + encodeURIComponent(root) + '&path=' + encodeURIComponent(path),
    };
  }
  return {
    kind: 'android', canLibrary: true, canPortable: true,
    async openFile(){ const r = await call('openFile'); return r && { name: r.name, ref: r.uri, text: r.text }; },
    readRef: uri => call('readUri', { uri }),
    writeRef: (uri, text) => call('writeUri', { uri, text }),
    async saveAs(name, text){ const r = await call('saveAs', { name, text, mime: 'text/markdown' }); return r && { name: r.name, ref: r.uri }; },
    sameRef: async (a, b) => a === b,
    download: async (name, content, type) => !!(await call('saveAs', { name, text: content, mime: type })),
    print: () => call('print'),
    async startupFile(){ const r = await call('startupFile'); return r && { name: r.name, ref: r.uri, text: r.text }; },
    async pickLibrary(){ const r = await call('pickFolder'); return r && { id: 'u:' + r.uri, name: r.name, uri: r.uri }; },
    portableLibrary: async () => ({ id: 'u:app', name: 'Markpad notes', uri: 'app', portable: true }),
    ready: async () => true,
    lib,
    dropHandle: () => null,
    setTitle: t => { document.title = t; },
    onClose(){},
    openExternal: url => call('openExternal', { url }),
    onOpenFile(fn){ window.__mpOpenFile = r => fn({ name: r.name, ref: r.uri, text: r.text }); },
  };
}

export const host = window.__TAURI__ ? desktopHost() : window.MarkpadAndroid ? androidHost() : browserHost();
