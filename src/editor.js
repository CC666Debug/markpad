// The editor: CodeMirror 6 with Markdown, plus a Live Preview mode like Obsidian's, where the
// Markdown symbols hide on every line except the one(s) the cursor is on.
import { EditorState, Compartment, StateField, StateEffect } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentMore, indentLess } from '@codemirror/commands';
import { markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, syntaxTree, indentUnit, Language, LanguageSupport } from '@codemirror/language';
import { search } from '@codemirror/search';
import { tags as t, Tag } from '@lezer/highlight';
import { IMG_EXT, markdown as toHtml, tex, CALLOUT_RE } from './md.js';

/* ---------------- Extra syntax: ==highlight== and [[wiki links]] ---------------- */
const markTag = Tag.define(), wikiTag = Tag.define(), hashTag = Tag.define();
const HighlightDelim = { resolve: 'Highlight', mark: 'HighlightMark' };
const HighlightExt = {
  defineNodes: [{ name: 'Highlight', style: { 'Highlight/...': markTag } }, { name: 'HighlightMark', style: t.processingInstruction }],
  parseInline: [{
    name: 'Highlight', after: 'Emphasis',
    parse(cx, next, pos){
      if (next != 61 || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2, !/\s|^$/.test(after), !/\s|^$/.test(before));
    },
  }],
};
const WikiExt = {
  defineNodes: [{ name: 'WikiLink', style: { 'WikiLink/...': wikiTag } }, { name: 'WikiMark', style: t.processingInstruction }],
  parseInline: [{
    name: 'WikiLink', before: 'Link',
    parse(cx, next, pos){
      const bang = next == 33;
      if (bang ? cx.char(pos + 1) != 91 || cx.char(pos + 2) != 91 : next != 91 || cx.char(pos + 1) != 91) return -1;
      const open = pos + (bang ? 3 : 2), m = /^[^[\]\n]+?\]\]/.exec(cx.slice(open, cx.end));
      if (!m) return -1;
      const end = open + m[0].length;
      return cx.addElement(cx.elt('WikiLink', pos, end, [cx.elt('WikiMark', pos, open), cx.elt('WikiMark', end - 2, end)]));
    },
  }],
};
const TagExt = {
  defineNodes: [{ name: 'HashTag', style: hashTag }],
  parseInline: [{
    name: 'HashTag', before: 'Emphasis',
    parse(cx, next, pos){
      if (next != 35 || (pos > cx.offset && !/[\s(]/.test(cx.slice(pos - 1, pos)))) return -1;
      const m = /^#[\p{L}\p{N}_\-\/]*[\p{L}_\-\/][\p{L}\p{N}_\-\/]*/u.exec(cx.slice(pos, cx.end));
      return m ? cx.addElement(cx.elt('HashTag', pos, pos + m[0].length)) : -1;
    },
  }],
};

// frontmatter at the very top (--- … ---): Obsidian's "properties", shown small and grey instead of as headings
const FrontExt = {
  defineNodes: [{ name: 'Frontmatter', block: true, style: t.meta }],
  parseBlock: [{
    name: 'Frontmatter', before: 'HorizontalRule',
    parse(cx, line){
      if (cx.lineStart !== 0 || line.text !== '---') return false;
      let end = -1;
      while (cx.nextLine()){
        if (line.text === '---'){ end = cx.lineStart + 3; cx.nextLine(); break; }
      }
      cx.addElement(cx.elt('Frontmatter', 0, end < 0 ? cx.lineStart : end));
      return true;
    },
  }],
};

const style = HighlightStyle.define([
  { tag: t.heading, fontWeight: '650' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: [t.link, wikiTag], color: 'var(--accent)' },
  { tag: t.url, color: 'var(--muted)' },
  { tag: t.monospace, class: 'cm-mono' },
  { tag: [t.processingInstruction, t.contentSeparator, t.atom, t.meta, t.labelName], color: 'var(--muted)' },
  { tag: t.quote, color: 'var(--muted)' },
  { tag: markTag, backgroundColor: 'var(--mark)' },
  { tag: hashTag, class: 'cm-tag' },
]);

/* ---------------- Live Preview widgets ---------------- */
class ImgWidget extends WidgetType {
  constructor(src, alt, width, opts){ super(); this.src = src; this.alt = alt; this.width = width; this.opts = opts; }
  eq(o){ return o.src === this.src && o.alt === this.alt && o.width === this.width; }
  toDOM(view){
    const box = document.createElement('span'), img = document.createElement('img');
    box.className = 'cm-lp-img'; img.alt = this.alt;
    if (this.width) img.width = this.width;
    img.onload = () => view.requestMeasure();
    img.onerror = () => { box.classList.add('broken'); box.textContent = '🖼 ' + (this.alt || this.src.slice(0, 60)); };
    Promise.resolve(this.opts.resolveImage(this.src)).then(u => { if (u) img.src = u; else img.onerror(); }, () => img.onerror());
    box.appendChild(img);
    return box;
  }
  ignoreEvent(){ return false; }
}
class CheckWidget extends WidgetType {
  constructor(on, opts){ super(); this.on = on; this.opts = opts; }
  eq(o){ return o.on === this.on; }
  toDOM(view){
    const c = document.createElement('input');
    c.type = 'checkbox'; c.checked = this.on; c.className = 'cm-lp-task';
    c.addEventListener('mousedown', e => {
      e.preventDefault();
      const pos = view.posAtDOM(c);
      view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: this.on ? ' ' : 'x' } });
      this.opts.afterTask?.(pos, !this.on);
    });
    return c;
  }
  ignoreEvent(){ return true; }
}
class MathWidget extends WidgetType {
  constructor(src){ super(); this.src = src; }
  eq(o){ return o.src === this.src; }
  toDOM(){ const s = document.createElement('span'); s.className = 'cm-lp-math'; s.innerHTML = tex(this.src, false); return s; }
  ignoreEvent(){ return false; }
}
class TextWidget extends WidgetType {
  constructor(text, cls){ super(); this.text = text; this.cls = cls; }
  eq(o){ return o.text === this.text && o.cls === this.cls; }
  toDOM(){ const s = document.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
}

// Tables, callouts, $$math$$, Mermaid diagrams and ![[note embeds]] span several lines (or become
// blocks), and CodeMirror only lets those be replaced from a state field. They show rendered until
// the cursor goes into them.
class BlockWidget extends WidgetType {
  constructor(src, cls, fill){ super(); this.src = src; this.cls = cls; this.fill = fill; }
  eq(o){ return o.src === this.src; }
  toDOM(view){
    const d = document.createElement('div');
    d.className = 'cm-lp-block ' + this.cls + ' md';
    d.innerHTML = toHtml(this.src).replace(/ data-line="\d+"/g, '');
    this.fill?.(d, () => view.requestMeasure());
    return d;
  }
  ignoreEvent(){ return false; }
}
function blockDecos(state, fill){
  const out = [], doc = state.doc, sel = state.selection.ranges;
  const add = (n, cls) => {
    const from = doc.lineAt(n.from).from, to = doc.lineAt(n.to).to;
    if (sel.some(r => r.to >= from && r.from <= to)) return false;
    out.push(Decoration.replace({ widget: new BlockWidget(doc.sliceString(from, to), cls, fill), block: true }).range(from, to));
    return false;
  };
  syntaxTree(state).iterate({ enter: n => {
    switch (n.name){
      case 'Table': return add(n, 'cm-lp-table');
      case 'Blockquote': {
        // only a callout's first line says so: > [!note]
        const first = doc.lineAt(n.from).text.replace(/^\s*>\s?/, '');
        return CALLOUT_RE.test(first) ? add(n, 'cm-lp-callout') : undefined;
      }
      case 'FencedCode': {
        const info = n.node.getChild('CodeInfo');
        return info && doc.sliceString(info.from, info.to).toLowerCase() === 'mermaid' ? add(n, 'cm-lp-diagram') : false;
      }
      case 'Paragraph': {
        const t = doc.sliceString(n.from, n.to).trim();
        if (/^\$\$[\s\S]*\$\$$/.test(t) && t.length > 4) return add(n, 'cm-lp-mathblock');
        const e = /^!\[\[([^\]|#]+)[^\]]*\]\]$/.exec(t);
        if (e && !IMG_EXT.test(e[1].trim())) return add(n, 'cm-lp-embed');
        return false;
      }
    }
    return n.name === 'Document' || n.name === 'ListItem' || /List$/.test(n.name) ? undefined : false;
  } });
  return Decoration.set(out);
}
const liveBlocks = fill => StateField.define({
  create: state => blockDecos(state, fill),
  update: (v, tr) => tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? blockDecos(tr.state, fill) : v,
  provide: f => EditorView.decorations.from(f),
});

/* ---------------- Keep-style "N checked items" ---------------- */
// With "Move completed items to the bottom" on, the ticked items at the end of a checklist sit under a
// "✓ N checked items" line that folds them away, like Google Keep. Only the look changes: the note stays plain Markdown.
// Lines become block widgets and hidden ranges, which CodeMirror only takes from a state field.
const toggleGroup = StateEffect.define(), regroup = StateEffect.define();
const GTASK = /^(\s*)(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\]/;
class GroupWidget extends WidgetType {
  constructor(n, open, key){ super(); this.n = n; this.open = open; this.key = key; }
  eq(o){ return o.n === this.n && o.open === this.open && o.key === this.key; }
  toDOM(view){
    const d = document.createElement('div');
    d.className = 'cm-lp-group' + (this.open ? ' open' : '');
    d.textContent = `${this.open ? '▾' : '▸'} ${this.n} checked item${this.n > 1 ? 's' : ''}`;
    d.addEventListener('mousedown', e => { e.preventDefault(); view.dispatch({ effects: toggleGroup.of(this.key) }); });
    return d;
  }
  ignoreEvent(){ return true; }
}
function groupDecos(state, closed, on){
  if (!on()) return Decoration.none;
  const doc = state.doc, lines = doc.toString().split('\n'), decos = [];
  const indent = l => l.match(/^\s*/)[0].length;
  let fence = false;
  for (let i = 0; i < lines.length; i++){
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    const m = !fence && lines[i].match(GTASK);
    if (!m) continue;
    // one checklist: items at this indent, plus anything indented under them
    const ind = indent(lines[i]), items = [];
    let j = i;
    while (j < lines.length){
      const t = lines[j].match(GTASK);
      if (!t || indent(lines[j]) !== ind) break;
      let e = j + 1;
      while (e < lines.length && lines[e].trim() && indent(lines[e]) > ind) e++;
      items.push({ start: j, end: e, done: t[2] !== ' ' });
      j = e;
    }
    let k = items.length;
    while (k > 0 && items[k - 1].done) k--;
    const done = items.length - k;
    if (done){
      const first = items[k].start, last = items[items.length - 1].end - 1;
      const key = (k ? lines[items[0].start] : '') + '|' + lines[first];
      const open = !closed.has(key);
      decos.push(Decoration.widget({ widget: new GroupWidget(done, open, key), block: true, side: -1 }).range(doc.line(first + 1).from));
      if (!open) decos.push(Decoration.replace({ block: true }).range(doc.line(first + 1).from, doc.line(last + 1).to));
    }
    i = j - 1;
  }
  return Decoration.set(decos, true);
}
const checkedGroups = on => StateField.define({
  create: state => ({ closed: new Set(), decos: groupDecos(state, new Set(), on) }),
  update(v, tr){
    let closed = v.closed, changed = tr.docChanged;
    for (const e of tr.effects){
      if (e.is(toggleGroup)){ closed = new Set(closed); closed.has(e.value) ? closed.delete(e.value) : closed.add(e.value); changed = true; }
      if (e.is(regroup)) changed = true;
    }
    return changed ? { closed, decos: groupDecos(tr.state, closed, on) } : v;
  },
  provide: f => EditorView.decorations.from(f, v => v.decos),
});

function refsOf(doc){
  const refs = {};
  for (const m of doc.toString().matchAll(/^ {0,3}\[([^\]]+)\]:[ \t]*(\S+)/gm)) refs[m[1].toLowerCase()] = m[2];
  return refs;
}

function buildLive(view, opts, cache){
  const { state } = view, doc = state.doc, decos = [];
  if (cache.doc !== doc){ cache.doc = doc; cache.refs = refsOf(doc); }
  const refs = cache.refs;
  const active = new Set();
  for (const r of state.selection.ranges)
    for (let l = doc.lineAt(r.from).number; l <= doc.lineAt(r.to).number; l++) active.add(l);
  const shown = (from, to) => { for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) if (active.has(l)) return true; return false; };
  const hide = (from, to) => { if (to > from) decos.push(Decoration.replace({}).range(from, to)); };
  const widget = (from, to, w) => decos.push(Decoration.replace({ widget: w }).range(from, to));
  const lineCls = (from, to, cls) => { for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++) decos.push(Decoration.line({ class: cls }).range(doc.line(l).from)); };
  const mark = (from, to, attributes, cls) => { if (to > from) decos.push(Decoration.mark({ class: cls, attributes }).range(from, to)); };
  const kid = (n, name) => { for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === name) return c; return null; };
  const kids = (n, name) => { const out = []; for (let c = n.firstChild; c; c = c.nextSibling) if (c.name === name) out.push(c); return out; };
  const spaceAfter = p => doc.sliceString(p, p + 1) === ' ' ? p + 1 : p;
  // $math$ and [^footnotes] aren't in the Markdown parser, so they are found line by line (not inside code)
  const maths = [];
  const inCode = p => { for (let x = syntaxTree(state).resolveInner(p, 1); x; x = x.parent) if (/^(InlineCode|FencedCode|CodeBlock|CodeText)$/.test(x.name)) return true; return false; };
  for (const { from, to } of view.visibleRanges){
    for (let l = doc.lineAt(from).number; l <= doc.lineAt(to).number; l++){
      const line = doc.line(l);
      if (/^\s*\$\$/.test(line.text)) continue;
      for (const m of line.text.matchAll(/(^|[^\\$\w])\$(?=\S)([^$\n]*?[^\s\\])\$(?![\d$\w])/g)){
        const a = line.from + m.index + m[1].length, b = a + m[2].length + 2;
        if (inCode(a)) continue;
        maths.push([a, b]);
        if (!active.has(l)) widget(a, b, new MathWidget(m[2]));
        else mark(a, b, null, 'cm-lp-mathsrc');
      }
      for (const m of line.text.matchAll(/\^\[[^\]]+\]/g)){ const a = line.from + m.index; if (!inCode(a)) mark(a, a + m[0].length, null, 'cm-lp-fn'); }
      for (const m of line.text.matchAll(/\[\^[^\]\s]+\]/g)){
        const a = line.from + m.index;
        const isDef = /^\s{0,3}$/.test(line.text.slice(0, m.index)) && line.text[m.index + m[0].length] === ':';
        if (!isDef && !inCode(a)) mark(a, a + m[0].length, null, 'cm-lp-fn');
      }
    }
  }
  // a node partly inside some math (an _ inside $a_b$) is left alone; one around the math is fine
  const inMath = (a, b) => maths.some(([x, y]) => a < y && b > x && !(a <= x && b >= y));

  for (const { from, to } of view.visibleRanges){
    syntaxTree(state).iterate({ from, to, enter: ref => {
      const n = ref.node, name = n.name;
      if (maths.length && inMath(n.from, n.to)) return false;
      const h = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
      if (h){
        const setext = name[0] === 'S';
        lineCls(n.from, setext ? doc.lineAt(n.to).from - 1 : n.from, 'cm-lp-h cm-lp-h' + h[1]);
        if (!shown(n.from, n.to)){
          const mk = kid(n, 'HeaderMark');
          if (mk && !setext) hide(mk.from, spaceAfter(mk.to));
          const marks = kids(n, 'HeaderMark');
          if (!setext && marks.length > 1){ const last = marks[marks.length - 1]; hide(last.from, last.to); }
        }
        return;
      }
      switch (name){
        case 'HTMLTag': {
          // <u>underline</u>: hide the tags and underline what's between them
          if (doc.sliceString(n.from, n.to).toLowerCase() !== '<u>') return;
          let end = n.nextSibling;
          while (end && !(end.name === 'HTMLTag' && doc.sliceString(end.from, end.to).toLowerCase() === '</u>')) end = end.nextSibling;
          if (!end) return;
          mark(n.to, end.from, null, 'cm-lp-u');
          if (!shown(n.from, end.to)){ hide(n.from, n.to); hide(end.from, end.to); }
          return;
        }
        case 'EmphasisMark': case 'StrikethroughMark': case 'HighlightMark':
          if (!shown(n.from, n.to)) hide(n.from, n.to);
          return;
        case 'InlineCode':
          mark(n.from, n.to, null, 'cm-lp-icode');
          if (!shown(n.from, n.to)) for (const c of kids(n, 'CodeMark')) hide(c.from, c.to);
          return false;
        case 'FencedCode': case 'CodeBlock':
          lineCls(n.from, n.to, 'cm-lp-code');
          return false;
        case 'Blockquote':
          lineCls(n.from, n.to, 'cm-lp-quote');
          return;
        case 'QuoteMark':
          if (!shown(n.from, n.to)) hide(n.from, spaceAfter(n.to));
          return;
        case 'Frontmatter':
          lineCls(n.from, n.to, 'cm-lp-fm');
          return false;
        case 'HorizontalRule':
          if (!shown(n.from, n.to)) widget(n.from, n.to, new TextWidget('', 'cm-lp-hr'));
          return;
        case 'ListMark': {
          if (shown(n.from, n.to) || n.parent?.parent?.name !== 'BulletList') return;
          if (kid(n.parent, 'Task')) hide(n.from, spaceAfter(n.to));
          else widget(n.from, n.to, new TextWidget('•', 'cm-lp-bullet'));
          return;
        }
        case 'TaskMarker': {
          const done = /x/i.test(doc.sliceString(n.from, n.to));
          if (done && n.parent) mark(n.to, n.parent.to, null, 'cm-lp-done');   // ticked: crossed out (if that option is on)
          if (!shown(n.from, n.to)) widget(n.from, n.to, new CheckWidget(done, opts));
          return;
        }
        case 'Image': {
          if (shown(n.from, n.to)) return false;
          const url = kid(n, 'URL'), label = kid(n, 'LinkLabel'), marks = kids(n, 'LinkMark');
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
          let src = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : refs[(label ? doc.sliceString(label.from + 1, label.to - 1) || alt : alt).toLowerCase()];
          if (src) widget(n.from, n.to, new ImgWidget(src, alt, 0, opts));
          return false;
        }
        case 'Link': case 'Autolink': {
          if (shown(n.from, n.to)){ return false; }
          const url = kid(n, 'URL'), label = kid(n, 'LinkLabel'), marks = kids(n, 'LinkMark');
          if (name === 'Autolink'){
            if (url){ for (const m of marks) hide(m.from, m.to); mark(url.from, url.to, { 'data-href': doc.sliceString(url.from, url.to) }, 'cm-lp-link'); }
            return false;
          }
          if (marks.length < 2) return;
          const text = doc.sliceString(marks[0].to, marks[1].from);
          const href = url ? doc.sliceString(url.from, url.to).replace(/^<|>$/g, '') : refs[(label ? doc.sliceString(label.from + 1, label.to - 1) || text : text).toLowerCase()];
          if (!href) return;
          hide(n.from, marks[0].to);
          hide(marks[1].from, n.to);
          mark(marks[0].to, marks[1].from, { 'data-href': href }, 'cm-lp-link');
          return;
        }
        case 'URL':
          if (n.parent && n.parent.name === 'Paragraph' || n.parent?.name === 'TableCell' || n.parent?.name === 'ListItem')
            mark(n.from, n.to, { 'data-href': doc.sliceString(n.from, n.to) }, 'cm-lp-link');
          return;
        case 'WikiLink': {
          const raw = doc.sliceString(n.from, n.to), embed = raw[0] === '!';
          const inner = raw.slice(embed ? 3 : 2, -2), [target, alias] = inner.split('|');
          if (shown(n.from, n.to)) return false;
          if (embed && IMG_EXT.test(target.trim())){
            widget(n.from, n.to, new ImgWidget('wiki:' + target.trim(), target.trim(), /^\d+$/.test(alias || '') ? +alias : 0, opts));
            return false;
          }
          const open = n.from + (embed ? 3 : 2), close = n.to - 2;
          hide(n.from, open); hide(close, n.to);
          if (alias != null) hide(open, open + target.length + 1);
          mark(alias != null ? open + target.length + 1 : open, close, { 'data-wiki': target.trim() }, 'cm-lp-link');
          return false;
        }
        case 'HashTag':
          if (!shown(n.from, n.to)) mark(n.from, n.to, { 'data-tag': doc.sliceString(n.from + 1, n.to) }, 'cm-lp-tag');
          return false;
        case 'LinkReference': {
          const url = kid(n, 'URL');
          if (url && !shown(n.from, n.to) && doc.sliceString(url.from, url.from + 5) === 'data:')
            widget(url.from, url.to, new TextWidget(`embedded image · ${Math.round((url.to - url.from) * 0.75 / 1024)} KB`, 'cm-lp-data'));
          return false;
        }
      }
    } });
  }
  return Decoration.set(decos, true);
}

function livePreview(opts){
  return ViewPlugin.fromClass(class {
    constructor(view){ this.cache = {}; this.decorations = buildLive(view, opts, this.cache); }
    update(u){
      if (u.docChanged || u.viewportChanged || u.selectionSet || syntaxTree(u.startState) !== syntaxTree(u.state))
        this.decorations = buildLive(u.view, opts, this.cache);
    }
  }, {
    decorations: v => v.decorations,
    eventHandlers: {
      mousedown(e){
        const a = e.target.closest && e.target.closest('.cm-lp-link, .cm-lp-tag, .cm-lp-block a.wikilink');
        if (!a || e.button !== 0 || e.shiftKey) return false;
        e.preventDefault();
        if (a.dataset.tag != null) opts.openTag(a.dataset.tag);
        else if (a.dataset.wiki != null) opts.openWiki(a.dataset.wiki + (a.dataset.hash ? '#' + a.dataset.hash : ''), e.ctrlKey || e.metaKey);
        else opts.openLink(a.dataset.href);
        return true;
      },
    },
  });
}

/* ---------------- Editor ---------------- */
export function createEditor(parent, opts){
  const live = new Compartment();
  const tab = view => {
    const r = view.state.selection.main, line = view.state.doc.lineAt(r.head);
    if (!r.empty || /^\s*([-*+]|\d+[.)])\s/.test(line.text)) return indentMore(view);
    view.dispatch(view.state.replaceSelection('  '), { scrollIntoView: true });
    return true;
  };
  const cmd = name => () => { opts.command(name); return true; };
  const extensions = [
      history(),
      drawSelection(),
      dropCursor(),
      EditorView.lineWrapping,
      indentUnit.of('  '),
      // Markdown without the HTML/CSS/JS sub-languages (saves ~170 KB); same language data, so
      // the list-continuation keys still recognise it.
      new LanguageSupport(new Language(markdownLanguage.data, markdownLanguage.parser.configure([FrontExt, HighlightExt, WikiExt, TagExt]), [], 'markdown')),
      syntaxHighlighting(style),
      search({ top: true, createPanel: opts.createFindPanel }),
      keymap.of([
        { key: 'Mod-b', run: cmd('bold') }, { key: 'Mod-i', run: cmd('italic') }, { key: 'Mod-u', run: cmd('underline') }, { key: 'Mod-k', run: cmd('link') },
        { key: 'Tab', run: tab, shift: indentLess },
        ...markdownKeymap, ...historyKeymap, ...defaultKeymap,
      ]),
      live.of([]),
      // phone keyboards (Gboard) only auto-capitalise, auto-correct and do double-space-period when the field asks for it
      EditorView.contentAttributes.of(window.MarkpadAndroid
        ? { spellcheck: 'true', autocapitalize: 'sentences', autocorrect: 'on', 'aria-label': 'Markdown editor' }
        : { spellcheck: 'false', autocapitalize: 'off', 'aria-label': 'Markdown editor' }),
      EditorView.updateListener.of(u => opts.onUpdate(u)),
      EditorView.domEventHandlers({ paste: (e, v) => opts.onPaste(e, v), drop: (e, v) => opts.onDrop(e, v) }),
  ];
  const view = new EditorView({ state: EditorState.create({ doc: '', extensions }), parent });
  let liveOn = false;
  const groups = checkedGroups(() => !!opts.keepGroups?.());
  const blocks = liveBlocks(opts.fillBlock);
  const ed = {
    view,
    setLive(on){
      liveOn = on;
      // the cm-live class (reading font, heading sizes) must come through CodeMirror, which owns the editor's classes
      view.dispatch({ effects: live.reconfigure(on ? [livePreview(opts), blocks, groups, EditorView.editorAttributes.of({ class: 'cm-live' })] : []) });
    },
    // redraw the "N checked items" folds (after the Keep option changes)
    regroup(){ view.dispatch({ effects: regroup.of(null) }); },
    // a new document gets a fresh undo history
    reset(text){ ed.swap(ed.newState(text)); },
    // tabs: each tab keeps its own state (text, undo history, selection) and swaps it in
    newState: text => EditorState.create({ doc: text, extensions }),
    swap(state){
      view.setState(state);
      ed.setLive(liveOn);
    },
  };
  return ed;
}
