// JotBird: publish a note as a web page with a shareable link (https://jotbird.com).
// Same service and same note fields (jotbird_link / jotbird_expires) as JotBird's Obsidian plugin, so a note
// published from either app shows up in both. Requests go through host.http, which only the apps have.
import { host } from './host.js';

const API = 'https://api.jotbird.com';
export const KEY_PAGE = 'https://jotbird.com/account/api-key';
const UA = 'markpad-jotbird/1';

async function call(path, { key, body, bodyB64, type = 'application/json', fp, method = 'POST' } = {}){
  const headers = { 'User-Agent': UA };
  if (key) headers.Authorization = 'Bearer ' + key;
  if (fp) headers['X-Device-Fingerprint'] = fp;
  if (body !== undefined || bodyB64) headers['Content-Type'] = type;
  if (method === 'GET') return finish(await host.http({ url: API + path, method, headers }), key);
  return finish(await host.http({ url: API + path, method, headers, ...(bodyB64 ? { bodyB64 } : body !== undefined ? { body: JSON.stringify(body) } : {}) }), key);
}
function finish(r, key){
  let json; try { json = JSON.parse(r.body); } catch (_) { json = { error: r.body || 'no answer' }; }
  if (r.status === 429){
    const m = Math.max(1, Math.ceil((parseInt(r.retryAfter, 10) || 0) / 60));
    throw new Error(parseInt(r.retryAfter, 10) ? `JotBird is busy for you right now. Try again in about ${m} minute${m > 1 ? 's' : ''}.` : 'JotBird is busy for you right now. Try again later.');
  }
  if (r.status === 401) throw new Error(key ? 'JotBird didn’t accept your key. Log in again in JotBird settings.' : (json.error || 'JotBird said no'));
  if (r.status >= 400) throw new Error(json.error || `JotBird answered ${r.status}`);
  return json;
}

// With an account (key) pages last 90 days; without one, 30 days and an edit token proves the page is ours.
export const publish = ({ key, fp, markdown, title, slug, documentId, editToken }) => key
  ? call('/cli/publish', { key, body: { markdown, title, ...(documentId ? { documentId } : {}), ...(slug ? { slug } : {}) } })
  : call('/trial/publish', { fp, body: { markdown, title, ...(slug ? { slug } : {}), ...(editToken ? { editToken } : {}) } });

export const unpublish = ({ key, fp, slug, documentId, editToken }) => key && !editToken
  ? call('/cli/documents/remove', { key, body: { slug, ...(documentId ? { documentId } : {}) } })
  : call('/trial/documents/delete', { fp, body: { slug, editToken: editToken || '' } });

export const listPages = key => call('/cli/documents', { key });   // { documents, isPro }

// Page settings (account pages only). Visibility is free; page styles other than Default, hiding the
// "Published with JotBird" line and passwords need Pro.
export const PAGE_STYLES = { default: 'Default', minimal: 'Minimal', essay: 'Essay', terminal: 'Terminal' };
const settingsPath = (t, ns) => '/cli/settings?' + (t.documentId ? 'documentId=' + encodeURIComponent(t.documentId) : 'slug=' + encodeURIComponent(t.slug) + (ns ? '&namespaced=true' : ''));
export async function getSettings(key, t){
  try { return await call(settingsPath(t), { key, method: 'GET' }); }
  catch (e){ if (t.documentId || !/not found|404/i.test(e.message)) throw e; return { ...(await call(settingsPath(t, true), { key, method: 'GET' })), namespaced: true }; }
}
export const setSettings = (key, t, patch) => call(settingsPath(t, t.namespaced), { key, method: 'PATCH', body: patch });
export const claim = (key, slug, editToken) => call('/cli/claim', { key, body: { slug, editToken } });

// pictures need an account; returns the picture's web address
export async function uploadImage(key, bytes, name){
  const ext = name.split('.').pop().toLowerCase(), mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
  const boundary = '----MarkpadJotBird' + Date.now().toString(36), enc = new TextEncoder();
  const pre = enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name.replace(/"/g, '')}"\r\nContent-Type: ${mime}\r\n\r\n`);
  const post = enc.encode(`\r\n--${boundary}--\r\n`);
  const all = new Uint8Array(pre.length + bytes.length + post.length);
  all.set(pre); all.set(bytes, pre.length); all.set(post, pre.length + bytes.length);
  let s = ''; for (let i = 0; i < all.length; i += 0x8000) s += String.fromCharCode(...all.subarray(i, i + 0x8000));
  return (await call('/preview/upload-image', { key, bodyB64: btoa(s), type: 'multipart/form-data; boundary=' + boundary })).url;
}

/* ---------------- the note side ---------------- */
const FM = /^---\n([\s\S]*?)\n---(?:\n|$)/;
const unquote = v => v.trim().replace(/^["']|["']$/g, '');
// { link, expires, slug } when the note has been published (from Markpad or Obsidian), else null
export function pageOf(t){
  const fm = (t.match(FM) || [])[1];
  if (!fm) return null;
  const link = unquote((fm.match(/^jotbird_(?:link|url):(.*)$/m) || [])[1] || '');
  if (!/^https?:\/\//.test(link)) return null;
  return { link, expires: unquote((fm.match(/^jotbird_expires:(.*)$/m) || [])[1] || ''), slug: link.replace(/[?#].*$/, '').split('/').filter(Boolean).pop() };
}
// days left (negative once expired), or null for pages that never expire
export function daysLeft(expires){
  if (!/^\d{4}-\d{2}-\d{2}/.test(expires || '')) return null;
  const [y, m, d] = expires.slice(0, 10).split('-').map(Number), now = new Date();
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);   // whole calendar days
}
export const leftText = d => d == null ? 'never expires' : d < 0 ? 'expired' : d === 0 ? 'expires today' : d === 1 ? '1 day left' : d + ' days left';

const JB_LINE = /^jotbird_(?:link|url|expires|slug|published):.*\n?/gm;
// the note's text with the link and expiry written into (or, with page = null, removed from) its frontmatter
export function withPage(t, page){
  const m = t.match(FM);
  const lines = page ? `jotbird_link: ${page.link}\njotbird_expires: ${page.expires || 'never'}\n` : '';
  if (!m) return page ? `---\n${lines}---\n` + t : t;
  const kept = (m[1] + '\n').replace(JB_LINE, '');
  const body = t.slice(m[0].length);
  const inner = (kept + lines).replace(/\n+$/, '');
  return inner.trim() ? `---\n${inner}\n---\n` + body : body.replace(/^\n/, '');
}

// what the page shows: no frontmatter, no %%comments%%, [[links]] as plain text, #tags dropped (like the Obsidian plugin)
// A page with no # heading gets the title as one (also like the plugin).
export function pageText(t, title){
  let md = t.replace(FM, '').replace(/%%[\s\S]*?%%/g, '');
  md = md.replace(/(?<!!)\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2').replace(/(?<!!)\[\[([^\]]+)\]\]/g, '$1');
  md = md.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`)/)   // code stays as it is
    .map((part, i) => i % 2 ? part : part.replace(/(^|[ \t])#(?![#\s])[\p{L}\p{N}_/-]+/gmu, '$1')).join('').trim();
  return /^#\s/m.test(md) ? md : `# ${title}\n\n${md}`;
}
// the page title: frontmatter title, else the first # heading, else the file name
export function titleOf(t, fileName){
  const fm = (t.match(FM) || [])[1];
  const ft = fm && (fm.match(/^title:(.*)$/m) || [])[1];
  if (ft && unquote(ft)) return unquote(ft);
  const h = (t.replace(FM, '').match(/^#\s+(.+)$/m) || [])[1];
  return (h || fileName.replace(/\.(md|markdown|mdown|mkd|txt)$/i, '')).trim();
}
