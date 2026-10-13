// Markdown → HTML for the Read and Split views. Small on purpose: CommonMark-ish plus tables,
// task lists, ==highlight==, reference links and Obsidian [[wiki links]].
const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|$)/;
const HR_RE = /^ {0,3}([-*_])( *\1){2,} *$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)/;
const H_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const QUOTE_RE = /^ {0,3}> ?/;
const SEP_RE = /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/;
const SETEXT_RE = /^ {0,3}(=+|-+) *$/;
const DEF_RE = /^ {0,3}\[([^\]]+)\]:[ \t]*(\S+)(?:[ \t]+"(.*)")?[ \t]*$/;
let refs = {};

const isTableStart = (lines,i) => lines[i].includes('|') && i+1 < lines.length && SEP_RE.test(lines[i+1]) && lines[i+1].includes('|');
const startsBlock = l => FENCE_RE.test(l) || H_RE.test(l) || HR_RE.test(l) || QUOTE_RE.test(l) || /^ {0,3}([-*+]|1[.)])[ \t]+\S/.test(l);
const slug = t => t.toLowerCase().replace(/[`*_~=\[\]()]/g,'').replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-');
function cells(l){
  l = l.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0,-1);
  return l.split(/(?<!\\)\|/).map(c => c.trim());
}
function safeUrl(u, img){
  const t = u.replace(/[\s\x00-\x1f]/g,'').toLowerCase();
  if (/^(javascript|vbscript):/.test(t)) return '#';
  if (!img && t.startsWith('data:')) return '#';
  return u;
}

const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;
// Web and embedded images load as-is; a relative path (images/cat.png) is filled in later by the
// app, which knows which folder the note lives in.
function img(u, a, t){
  const abs = /^(https?:|data:|blob:)/i.test(u);
  return `<img ${abs ? `src="${safeUrl(u,true)}"` : `data-rel="${u}"`} alt="${a}"${t ? ` title="${t}"` : ''} loading="lazy">`;
}
function inline(s){
  const st = [];
  const put = h => '\u0000' + (st.push(h)-1) + '\u0000';
  s = s.replace(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (m,t,c) => put('<code>'+esc(c.replace(/^ ([\s\S]*) $/,'$1'))+'</code>'));
  s = s.replace(/\\([\\`*_{}\[\]()#+\-.!~|<>=])/g, (m,c) => put(esc(c)));
  s = esc(s);
  s = s.replace(/(!?)\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (m,bang,target,hash,alias) => {
    target = target.trim();
    if (bang && IMG_EXT.test(target)){
      const w = /^\d+$/.test(alias || '') ? ` width="${alias}"` : '';
      return put(`<img data-wiki="${target}" alt="${target}"${w} loading="lazy">`);
    }
    const label = alias || (target ? target.replace(/^.*\//, '') + (hash || '').replace('#', ' › ') : (hash || '').slice(1));
    return put(`<a href="#" class="wikilink" data-wiki="${target}" data-hash="${hash ? slug(hash.slice(1).replace(/&amp;/g,'&')) : ''}">`) + label + put('</a>');
  });
  s = s.replace(/!\[([^\]]*)\]\(\s*(?:&lt;(.+?)&gt;|([^)\s]+))(?:\s+&quot;(.*?)&quot;)?\s*\)/g, (m,a,u1,u2,t) => put(img(u1 || u2, a, t)));
  s = s.replace(/\[([^\]]+)\]\(\s*([^)\s]*)(?:\s+&quot;(.*?)&quot;)?\s*\)/g,
    (m,x,u,t) => put(`<a href="${safeUrl(u)}"${t?` title="${t}"`:''}>`) + x + put('</a>'));
  s = s.replace(/!\[([^\]]*)\]\[([^\]]*)\]/g, (m,a,id) => {
    const u = refs[(id || a).toLowerCase()];
    return u ? put(img(u, a)) : m;
  });
  s = s.replace(/\[([^\]]+)\]\[([^\]]*)\]/g, (m,x,id) => {
    const u = refs[(id || x).toLowerCase()];
    return u ? put(`<a href="${safeUrl(u)}">`) + x + put('</a>') : m;
  });
  s = s.replace(/&lt;((?:https?|mailto):[^\s]+?)&gt;/g, (m,u) => put(`<a href="${u}">${u}</a>`));
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<]*[^\s<.,;:!?)\]'"])/g, (m,p,u) => p + put(`<a href="${u}">${u}</a>`));
  s = s.replace(/&lt;u&gt;([\s\S]*?)&lt;\/u&gt;/g, '<u>$1</u>');   // underline, written as <u>…</u> like in Obsidian
  s = s.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, '$1<strong>$2</strong>');
  s = s.replace(/\*(?=\S)([\s\S]*?\S)\*/g, '<em>$1</em>');
  s = s.replace(/(^|[^\w])_(?=\S)([\s\S]*?\S)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
  s = s.replace(/==(?=\S)([\s\S]*?\S)==/g, '<mark>$1</mark>');
  s = s.replace(/ {2,}\n/g, '<br>\n');
  for (let n = 0; n < 4 && s.includes('\u0000'); n++) s = s.replace(/\u0000(\d+)\u0000/g, (m,k) => st[k]);
  return s;
}

function blocks(lines, tight, top){
  const out = []; let i = 0, m, mark = -1, markLine = 0;
  // top-level blocks get data-line="N" so scroll sync and the outline can find them
  const tag = () => { if (top && mark >= 0 && out[mark]) out[mark] = out[mark].replace(/^<(\w+)/, `<$1 data-line="${markLine}"`); };
  while (i < lines.length){
    const line = lines[i];
    if (!line.trim() || (top && DEF_RE.test(line))){ i++; continue; }
    tag(); mark = out.length; markLine = i;

    if ((m = line.match(FENCE_RE))){
      const f = m[1], lang = m[2];
      const close = new RegExp('^ {0,3}' + (f[0]==='`' ? '`' : '~') + '{' + f.length + ',}\\s*$');
      const buf = []; i++;
      while (i < lines.length && !close.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre><code' + (lang ? ' class="language-'+esc(lang)+'"' : '') + '>' + esc(buf.join('\n')) + '</code></pre>');
      continue;
    }
    if ((m = line.match(H_RE))){
      const n = m[1].length, t = m[2] || '';
      out.push(`<h${n} id="${slug(t)}">${inline(t)}</h${n}>`); i++; continue;
    }
    if (HR_RE.test(line)){ out.push('<hr>'); i++; continue; }
    if (QUOTE_RE.test(line)){
      const buf = [];
      while (i < lines.length && lines[i].trim() && (QUOTE_RE.test(lines[i]) || !startsBlock(lines[i]))) buf.push(lines[i++].replace(QUOTE_RE,''));
      out.push('<blockquote>' + blocks(buf,false) + '</blockquote>');
      continue;
    }
    if (isTableStart(lines,i)){
      const head = cells(line);
      const aligns = cells(lines[i+1]).map(c => /^:-+:$/.test(c) ? 'center' : /-:$/.test(c) ? 'right' : /^:-/.test(c) ? 'left' : '');
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(cells(lines[i++]));
      const cell = (tag,c,k) => `<${tag}${aligns[k] ? ` style="text-align:${aligns[k]}"` : ''}>${inline(c)}</${tag}>`;
      out.push('<div class="table-wrap"><table><thead><tr>' + head.map((c,k) => cell('th',c,k)).join('') +
        '</tr></thead><tbody>' + rows.map(r => '<tr>' + head.map((_,k) => cell('td',r[k]||'',k)).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }
    if ((m = line.match(LIST_RE))){
      const base = m[1].length, ordered = /\d/.test(m[2]), start = ordered ? parseInt(m[2],10) : 1;
      const items = []; let cur = null, loose = false, blank = false;
      while (i < lines.length){
        const l = lines[i], mm = l.match(LIST_RE);
        if (!l.trim()){ blank = true; i++; continue; }
        const ind = l.match(/^ */)[0].length;
        if (mm && ind < base + 2){
          if (ind < base || /\d/.test(mm[2]) !== ordered) break;
          if (blank && cur) loose = true;
          const ci = mm[3] !== undefined ? l.indexOf(mm[3], ind + mm[2].length) : ind + mm[2].length + 1;
          cur = { lines: [mm[3] || ''], ci };
          items.push(cur); blank = false; i++; continue;
        }
        if (ind >= base + 2){
          if (blank){ cur.lines.push(''); loose = true; }
          cur.lines.push(l.slice(Math.min(ind, cur.ci)));
          blank = false; i++; continue;
        }
        if (!blank && !startsBlock(l) && !isTableStart(lines,i)){ cur.lines.push(l.trim()); i++; continue; }
        break;
      }
      let hasTask = false;
      const lis = items.map(it => {
        let txt = it.lines, pre = '';
        const t = txt[0].match(/^\[([ xX])\](?:\s+|$)/);
        if (t){
          hasTask = true;
          pre = `<input type="checkbox" class="task"${t[1] !== ' ' ? ' checked' : ''} title="Click to toggle">`;
          txt = [txt[0].slice(t[0].length), ...txt.slice(1)];
        }
        return `<li${t ? ' class="task-item"' : ''}>${pre}${blocks(txt, !loose)}</li>`;
      });
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}${hasTask ? ' class="contains-task"' : ''}>` + lis.join('') + `</${tag}>`);
      continue;
    }
    // paragraph (with setext headings)
    const buf = [line]; i++; let setext = 0;
    while (i < lines.length && lines[i].trim()){
      const sm = lines[i].match(SETEXT_RE);
      if (sm){ setext = sm[1][0] === '=' ? 1 : 2; i++; break; }
      if (startsBlock(lines[i]) || isTableStart(lines,i) || (top && DEF_RE.test(lines[i]))) break;
      buf.push(lines[i++]);
    }
    const html = inline(buf.map(s => s.replace(/^ +/,'')).join('\n').replace(/[ \t]+$/,''));
    if (setext) out.push(`<h${setext} id="${slug(buf.join(' '))}">${html}</h${setext}>`);
    else out.push(tight ? html : '<p>' + html + '</p>');
  }
  tag();
  return out.join('\n');
}
function markdown(src){
  const lines = src.replace(/\r\n?/g,'\n').split('\n').map(l => l.replace(/^\t+/, t => '    '.repeat(t.length)));
  refs = {}; let inFence = false;
  for (const l of lines){
    if (FENCE_RE.test(l)) inFence = !inFence;
    const m = !inFence && l.match(DEF_RE);
    if (m) refs[esc(m[1]).toLowerCase()] = esc(m[2]);
  }
  return blocks(lines, false, true);
}

export { markdown, esc, slug, startsBlock, FENCE_RE, H_RE, DEF_RE, LIST_RE, IMG_EXT };
