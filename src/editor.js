// The editor: CodeMirror 6 with Markdown, plus a Live Preview mode like Obsidian's, where the
// Markdown symbols hide on every line except the one(s) the cursor is on.
import { EditorState, Compartment, StateField } from '@codemirror/state';
import { EditorView, keymap, drawSelection, dropCursor, Decoration, ViewPlugin, WidgetType } from '@codemirror/view';
import { history, historyKeymap, defaultKeymap, indentMore, indentLess } from '@codemirror/commands';
import { markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { syntaxHighlighting, HighlightStyle, syntaxTree, indentUnit, Language, LanguageSupport } from '@codemirror/language';
import { search } from '@codemirror/search';
import { tags as t, Tag } from '@lezer/highlight';
import { IMG_EXT, markdown as toHtml } from './md.js';

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
class TextWidget extends WidgetType {
  constructor(text, cls){ super(); this.text = text; this.cls = cls; }
  eq(o){ return o.text === this.text && o.cls === this.cls; }
  toDOM(){ const s = document.createElement('span'); s.className = this.cls; s.textContent = this.text; return s; }
}

// Tables span several lines, and CodeMirror only lets those be replaced from a state field.
class TableWidget extends WidgetType {
  constructor(src){ super(); this.src = src; }
  eq(o){ return o.src === this.src; }
  toDOM(){
    const d = document.createElement('div');
    d.className = 'cm-lp-table md';
    d.innerHTML = toHtml(this.src);
    return d;
  }
  ignoreEvent(){ return false; }
}
function tableDecos(state){
  const out = [], doc = state.doc, sel = state.selection.ranges;
  syntaxTree(state).iterate({ enter: n => {
    if (n.name !== 'Table') return n.name === 'Document' || n.name === 'Blockquote' || n.name === 'ListItem' || /List$/.test(n.name) ? undefined : false;
    const from = doc.lineAt(n.from).from, to = doc.lineAt(n.to).to;
    if (sel.some(r => r.to >= from && r.from <= to)) return false;
    out.push(Decoration.replace({ widget: new TableWidget(doc.sliceString(from, to)), block: true }).range(from, to));
    return false;
  } });
  return Decoration.set(out);
}
const liveTables = StateField.define({
  create: tableDecos,
  update: (v, tr) => tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state) ? tableDecos(tr.state) : v,
  provide: f => EditorView.decorations.from(f),
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

  for (const { from, to } of view.visibleRanges){
    syntaxTree(state).iterate({ from, to, enter: ref => {
      const n = ref.node, name = n.name;
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
        const a = e.target.closest && e.target.closest('.cm-lp-link, .cm-lp-tag');
        if (!a || e.button !== 0 || e.shiftKey) return false;
        e.preventDefault();
        if (a.dataset.tag != null) opts.openTag(a.dataset.tag);
        else if (a.dataset.wiki != null) opts.openWiki(a.dataset.wiki, e.ctrlKey || e.metaKey);
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
      new LanguageSupport(new Language(markdownLanguage.data, markdownLanguage.parser.configure([HighlightExt, WikiExt, TagExt]), [], 'markdown')),
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
  const ed = {
    view,
    setLive(on){
      liveOn = on;
      // the cm-live class (reading font, heading sizes) must come through CodeMirror, which owns the editor's classes
      view.dispatch({ effects: live.reconfigure(on ? [livePreview(opts), liveTables, EditorView.editorAttributes.of({ class: 'cm-live' })] : []) });
    },
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
