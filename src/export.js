// Extra export formats: plain text, ebook (.epub) and "copy as rich text".
// Notes come in as [{ name, text }] (Markdown) or rendered HTML; the app does the saving.
import { makeZip } from './zip.js';

const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const noFront = t => t.replace(/^---\n[\s\S]*?\n---\n?/, '');

// Markdown → plain text: the symbols go, lists keep a bullet, checklists keep a box
export function toPlain(md){
  let fence = false;
  return noFront(md).replace(/%%[\s\S]*?%%/g, '').split('\n').map(l => {
    if (/^\s*(```|~~~)/.test(l)){ fence = !fence; return null; }
    if (fence) return l;
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(l)) return '────────';
    if (l.includes('|') && /^\s*\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?)?\s*$/.test(l)) return null;   // table header line
    return l
      .replace(/^(\s*)#{1,6}\s+/, '$1')
      .replace(/^(\s*)>\s?/, '$1')
      .replace(/^(\s*)[-*+]\s+\[[xX]\]\s+/, '$1☑ ')
      .replace(/^(\s*)[-*+]\s+\[ \]\s+/, '$1☐ ')
      .replace(/^(\s*)[-*+]\s+/, '$1• ')
      .replace(/!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, '[$1]')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, a) => a ? `[${a}]` : '')
      .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2')
      .replace(/\[\[([^\]#]+)(?:#[^\]]*)?\]\]/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) => t === u ? u : `${t} (${u})`)
      .replace(/(\*\*|__|~~|==)(.+?)\1/g, '$2')
      .replace(/(^|[^\w*])[*_](?!\s)(.+?)(?<!\s)[*_](?![\w*])/g, '$1$2')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<br\s*\/?>/gi, '')
      .replace(/^\s*\|(.*)\|\s*$/, (_, r) => r.split('|').map(c => c.trim()).join('   '));
  }).filter(l => l != null).join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

// rendered HTML → XHTML for an ebook page (pictures become their alt text, like the Word export)
function xhtml(html){
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const img of box.querySelectorAll('img')) img.replaceWith(img.alt ? `[${img.alt}]` : '');
  for (const el of box.querySelectorAll('input')) el.replaceWith(el.checked ? '☑ ' : '☐ ');
  for (const el of box.querySelectorAll('[data-line],[data-wiki],[contenteditable]')){ el.removeAttribute('data-line'); el.removeAttribute('contenteditable'); }
  const s = new XMLSerializer();
  return [...box.childNodes].map(n => s.serializeToString(n)).join('\n').replace(/ xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g, '');
}

const EPUB_CSS = `body{font-family:serif;line-height:1.5;margin:0 4%}
h1,h2,h3,h4{font-family:sans-serif;line-height:1.25}
pre,code{font-family:monospace;font-size:.9em}
pre{white-space:pre-wrap;background:#f2f0eb;padding:.6em}
blockquote{border-left:3px solid #bbb;margin-left:0;padding-left:1em;color:#555}
table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:.2em .5em}
ul.contains-task-list,ul:has(> li > input){list-style:none}
.props,.fold{display:none}`;

// chapters: [{ title, html }] → .epub bytes (works in Google Play Books, Apple Books, Calibre, Kobo, Kindle via Send to Kindle)
export async function toEpub(chapters, title){
  const id = 'urn:uuid:' + crypto.randomUUID(), now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const page = (t, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en"><head><meta charset="utf-8"/><title>${x(t)}</title><link rel="stylesheet" href="style.css"/></head><body>
${body}
</body></html>`;
  const te = new TextEncoder(), f = (name, t) => ({ name, data: te.encode(t) });
  const files = [
    f('mimetype', 'application/epub+zip'),   // must come first, uncompressed (it's too short for the zip to squeeze)
    f('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    f('OEBPS/style.css', EPUB_CSS),
    f('OEBPS/nav.xhtml', page(title, `<nav epub:type="toc" id="toc"><h1>${x(title)}</h1><ol>${chapters.map((c, i) => `<li><a href="ch${i + 1}.xhtml">${x(c.title)}</a></li>`).join('')}</ol></nav>`)),
    f('OEBPS/toc.ncx', `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="${id}"/></head><docTitle><text>${x(title)}</text></docTitle><navMap>${chapters.map((c, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${x(c.title)}</text></navLabel><content src="ch${i + 1}.xhtml"/></navPoint>`).join('')}</navMap></ncx>`),
    f('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bookid">${id}</dc:identifier><dc:title>${x(title)}</dc:title><dc:language>en</dc:language><dc:creator>Markpad</dc:creator><meta property="dcterms:modified">${now}</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/><item id="css" href="style.css" media-type="text/css"/>${chapters.map((c, i) => `<item id="ch${i + 1}" href="ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('')}</manifest>
<spine toc="ncx">${chapters.map((c, i) => `<itemref idref="ch${i + 1}"/>`).join('')}</spine></package>`),
    ...chapters.map((c, i) => f(`OEBPS/ch${i + 1}.xhtml`, page(c.title, xhtml(c.html)))),
  ];
  return makeZip(files);
}

// puts formatted text on the clipboard (pastes with headings, bold, lists… into Gmail, Docs, Word)
export async function copyRich(html, plain){
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
    return true;
  } catch (_){}
  // older way, also works where the clipboard API is locked (some phones)
  const box = document.createElement('div');
  box.contentEditable = 'true';
  box.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:normal;color:#000;background:#fff';
  box.innerHTML = html;
  document.body.appendChild(box);
  const r = document.createRange(); r.selectNodeContents(box);
  const sel = getSelection(), saved = sel.rangeCount ? sel.getRangeAt(0) : null;
  sel.removeAllRanges(); sel.addRange(r);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (_){}
  sel.removeAllRanges(); if (saved) sel.addRange(saved);
  box.remove();
  return ok;
}
