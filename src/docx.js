// Export as Word (.docx): the note's rendered HTML walked into a small WordprocessingML document.
// Headings, paragraphs, bold/italic/underline/strike/code, links, lists, checklists, quotes, code blocks,
// tables and dividers. Pictures become their alt text. Word, Google Docs, LibreOffice and phones open it.
import { makeZip } from './zip.js';

const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function toDocx(html, title){
  const box = document.createElement('div');
  box.innerHTML = html;
  const links = [];   // hyperlink relationships
  const body = [];

  // inline content → runs
  function runs(node, fmt = {}){
    let out = '';
    for (const n of node.childNodes){
      if (n.nodeType === 3){
        const t = n.textContent.replace(/\n/g, ' ');
        if (!t) continue;
        const rpr = (fmt.b ? '<w:b/>' : '') + (fmt.i ? '<w:i/>' : '') + (fmt.u ? '<w:u w:val="single"/>' : '') + (fmt.s ? '<w:strike/>' : '') +
          (fmt.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:fill="EFEDE8"/>' : '') +
          (fmt.mark ? '<w:highlight w:val="yellow"/>' : '') + (fmt.link ? '<w:rStyle w:val="Hyperlink"/>' : '');
        out += `<w:r>${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}<w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
        continue;
      }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase();
      if (tag === 'br'){ out += '<w:r><w:br/></w:r>'; continue; }
      if (tag === 'img'){ out += runs({ childNodes: [document.createTextNode(n.alt ? `[${n.alt}]` : '[picture]')] }, fmt); continue; }
      if (tag === 'input'){ out += `<w:r><w:t xml:space="preserve">${n.checked ? '☑ ' : '☐ '}</w:t></w:r>`; continue; }
      if (tag === 'ul' || tag === 'ol' || tag === 'pre' || tag === 'table') continue;   // handled as blocks
      const f = { ...fmt };
      if (tag === 'strong' || tag === 'b') f.b = true;
      if (tag === 'em' || tag === 'i') f.i = true;
      if (tag === 'u' || tag === 'ins') f.u = true;
      if (tag === 's' || tag === 'del') f.s = true;
      if (tag === 'code') f.code = true;
      if (tag === 'mark') f.mark = true;
      if (tag === 'a' && /^https?:|^mailto:/.test(n.getAttribute('href') || '')){
        links.push(n.getAttribute('href'));
        out += `<w:hyperlink r:id="rIdL${links.length}">${runs(n, { ...f, link: true })}</w:hyperlink>`;
        continue;
      }
      out += runs(n, f);
    }
    return out;
  }
  const para = (inner, ppr = '') => body.push(`<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`);

  function block(node, depth = 0, quote = false){
    for (const n of node.childNodes){
      if (n.nodeType === 3){ if (n.textContent.trim()) para(runs({ childNodes: [n] })); continue; }
      if (n.nodeType !== 1) continue;
      const tag = n.tagName.toLowerCase(), q = quote ? '<w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="BBBBBB"/></w:pBdr>' : '';
      if (/^h[1-6]$/.test(tag)) para(runs(n), `<w:pStyle w:val="Heading${tag[1]}"/>`);
      else if (tag === 'p') para(runs(n), q);
      else if (tag === 'blockquote') block(n, depth, true);
      else if (tag === 'hr') para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BBBBBB"/></w:pBdr>');
      else if (tag === 'pre'){
        for (const line of n.textContent.replace(/\n$/, '').split('\n'))
          para(`<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">${x(line)}</w:t></w:r>`, '<w:spacing w:after="0"/><w:shd w:val="clear" w:fill="EFEDE8"/>');
      } else if (tag === 'ul' || tag === 'ol'){
        let k = Number(n.getAttribute('start') || 1);
        for (const li of n.children){
          if (li.tagName.toLowerCase() !== 'li') continue;
          const task = li.querySelector(':scope > input[type=checkbox]');
          const mark = task ? '' : tag === 'ol' ? `${k++}. ` : '• ';
          // the item's own text: everything but nested lists / blocks
          const own = document.createElement('div');
          for (const c of li.childNodes) if (!(c.nodeType === 1 && /^(ul|ol|pre|table|blockquote)$/i.test(c.tagName))) own.appendChild(c.cloneNode(true));
          if (own.querySelector('p')){ const p = own.querySelector('p'); p.replaceWith(...p.childNodes); }
          para(`<w:r><w:t xml:space="preserve">${mark}</w:t></w:r>` + runs(own), `<w:spacing w:after="40"/><w:ind w:left="${360 + depth * 360}" w:hanging="260"/>` + q);
          for (const c of li.children) if (/^(ul|ol)$/i.test(c.tagName)) block({ childNodes: [c] }, depth + 1, quote);
          else if (/^(pre|table|blockquote)$/i.test(c.tagName)) block({ childNodes: [c] }, depth, quote);
        }
      } else if (tag === 'table'){
        // columns share the page width (Word and LibreOffice need the column grid spelled out)
        const trs = [...n.querySelectorAll('tr')], cols = Math.max(1, ...trs.map(tr => tr.children.length)), cw = Math.floor(9638 / cols);
        const rows = trs.map((tr, r) => `<w:tr>${[...tr.children].map(td =>
          `<w:tc><w:tcPr><w:tcW w:w="${cw}" w:type="dxa"/></w:tcPr><w:p>${r === 0 || td.tagName === 'TH' ? runs(td, { b: true }) : runs(td)}</w:p></w:tc>`).join('')}</w:tr>`).join('');
        body.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="${cw * cols}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(s => `<w:${s} w:val="single" w:sz="4" w:color="BBBBBB"/>`).join('')}</w:tblBorders></w:tblPr><w:tblGrid>${`<w:gridCol w:w="${cw}"/>`.repeat(cols)}</w:tblGrid>${rows}</w:tbl>`);
        para('');
      } else if (tag === 'div' || tag === 'details' || tag === 'section' || tag === 'figure') block(n, depth, quote);
      else if (n.textContent.trim()) para(runs({ childNodes: [n] }), q);
    }
  }
  block(box);

  const doc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const sizes = [0, 36, 30, 26, 24, 22, 22];
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri" w:eastAsia="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
${[1, 2, 3, 4, 5, 6].map(h => `<w:style w:type="paragraph" w:styleId="Heading${h}"><w:name w:val="heading ${h}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${h < 3 ? 320 : 220}" w:after="100"/><w:outlineLvl w:val="${h - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${sizes[h]}"/></w:rPr></w:style>`).join('\n')}
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F5FBF"/><w:u w:val="single"/></w:rPr></w:style>
<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style>
</w:styles>`;
  const te = new TextEncoder();
  const files = [
    ['[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ['_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ['docProps/core.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(title)}</dc:title><dc:creator>Markpad</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</dcterms:created></cp:coreProperties>`],
    ['word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links.map((u, i) => `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${x(u)}" TargetMode="External"/>`).join('')}</Relationships>`],
    ['word/document.xml', doc],
    ['word/styles.xml', styles],
  ];
  return makeZip(files.map(([name, t]) => ({ name, data: te.encode(t) })));
}
