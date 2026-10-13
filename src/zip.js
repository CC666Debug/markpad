// Zip files for "Back up notes" and "Restore from backup". A password makes it a standard
// AES-256 encrypted zip (the WinZip AES format), which 7-Zip, WinRAR, Linux archive managers and
// ZArchiver on Android open too. Small on purpose: no zip64, no old ZipCrypto passwords.
const te = new TextEncoder();

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c; });
function crc32(b){ let c = ~0; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return ~c >>> 0; }

const can = kind => { try { new CompressionStream(kind); new DecompressionStream(kind); return true; } catch (_){ return false; } };
const DEFLATE = typeof CompressionStream !== 'undefined' && can('deflate-raw');
const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());

/* ---------------- AES (encrypt direction only: CTR mode needs nothing else) ---------------- */
const T = [[], [], [], []], SBOX = [];
(() => {
  const d = [], th = [];
  for (let i = 0; i < 256; i++) th[(d[i] = i << 1 ^ (i >> 7) * 283) ^ i] = i;
  for (let x = 0, xi = 0, x2; !SBOX[x]; x ^= x2 || 1, xi = th[xi] || 1){
    let s = xi ^ xi << 1 ^ xi << 2 ^ xi << 3 ^ xi << 4;
    s = s >> 8 ^ s & 255 ^ 99;
    SBOX[x] = s;
    x2 = d[x];
    let e = d[s] * 0x101 ^ s * 0x1010100;
    for (let i = 0; i < 4; i++) T[i][x] = e = e << 24 ^ e >>> 8;
  }
})();
function aesKey(key){
  const n = key.length / 4, w = [];
  for (let i = 0; i < n; i++) w[i] = key[4 * i] << 24 | key[4 * i + 1] << 16 | key[4 * i + 2] << 8 | key[4 * i + 3];
  for (let i = n, rcon = 1; i < 4 * n + 28; i++){
    let t = w[i - 1];
    if (i % n === 0 || (n === 8 && i % n === 4)){
      t = SBOX[t >>> 24] << 24 ^ SBOX[t >> 16 & 255] << 16 ^ SBOX[t >> 8 & 255] << 8 ^ SBOX[t & 255];
      if (i % n === 0){ t = t << 8 ^ t >>> 24 ^ rcon << 24; rcon = rcon << 1 ^ (rcon >> 7) * 283; }
    }
    w[i] = w[i - n] ^ t;
  }
  return w;
}
function aesBlock(k, inp, out){
  const [t0, t1, t2, t3] = T;
  let a = (inp[0] << 24 | inp[1] << 16 | inp[2] << 8 | inp[3]) ^ k[0], b = (inp[4] << 24 | inp[5] << 16 | inp[6] << 8 | inp[7]) ^ k[1],
      c = (inp[8] << 24 | inp[9] << 16 | inp[10] << 8 | inp[11]) ^ k[2], d = (inp[12] << 24 | inp[13] << 16 | inp[14] << 8 | inp[15]) ^ k[3], ki = 4;
  for (let r = k.length / 4 - 2; r > 0; r--){
    const a2 = t0[a >>> 24] ^ t1[b >> 16 & 255] ^ t2[c >> 8 & 255] ^ t3[d & 255] ^ k[ki];
    const b2 = t0[b >>> 24] ^ t1[c >> 16 & 255] ^ t2[d >> 8 & 255] ^ t3[a & 255] ^ k[ki + 1];
    const c2 = t0[c >>> 24] ^ t1[d >> 16 & 255] ^ t2[a >> 8 & 255] ^ t3[b & 255] ^ k[ki + 2];
    d = t0[d >>> 24] ^ t1[a >> 16 & 255] ^ t2[b >> 8 & 255] ^ t3[c & 255] ^ k[ki + 3];
    a = a2; b = b2; c = c2; ki += 4;
  }
  for (let i = 0; i < 4; i++){
    const v = SBOX[a >>> 24] << 24 ^ SBOX[b >> 16 & 255] << 16 ^ SBOX[c >> 8 & 255] << 8 ^ SBOX[d & 255] ^ k[ki++];
    out[4 * i] = v >>> 24; out[4 * i + 1] = v >> 16 & 255; out[4 * i + 2] = v >> 8 & 255; out[4 * i + 3] = v & 255;
    const t = a; a = b; b = c; c = d; d = t;
  }
}
// WinZip AES counter mode: a little-endian block counter starting at 1 (same both ways)
function aesCtr(key, data){
  const k = aesKey(key), out = new Uint8Array(data.length), ctr = new Uint8Array(16), ks = new Uint8Array(16);
  for (let pos = 0; pos < data.length; pos += 16){
    for (let i = 0; i < 16 && ++ctr[i] === 0; i++);
    aesBlock(k, ctr, ks);
    for (let i = 0; i < 16 && pos + i < data.length; i++) out[pos + i] = data[pos + i] ^ ks[i];
  }
  return out;
}
export const aesTest = (key, block) => { const o = new Uint8Array(16); aesBlock(aesKey(key), block, o); return o; };

async function aesKeys(password, salt, keyLen){
  const base = await crypto.subtle.importKey('raw', te.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-1', salt, iterations: 1000 }, base, (2 * keyLen + 2) * 8));
  const mac = await crypto.subtle.importKey('raw', bits.slice(keyLen, 2 * keyLen), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return { enc: bits.slice(0, keyLen), mac, check: bits.slice(2 * keyLen) };
}
const hmac10 = async (key, data) => new Uint8Array(await crypto.subtle.sign('HMAC', key, data)).slice(0, 10);

/* ---------------- Writing ---------------- */
// files: [{ name: 'folder/note.md', data: Uint8Array }]; password '' or null = no password
export async function makeZip(files, password){
  const parts = [], central = [];
  let offset = 0;
  const now = new Date();
  const time = now.getHours() << 11 | now.getMinutes() << 5 | now.getSeconds() >> 1;
  const date = (now.getFullYear() - 1980) << 9 | (now.getMonth() + 1) << 5 | now.getDate();
  for (const f of files){
    const name = te.encode(f.name), crc = crc32(f.data);
    let body = f.data, method = 0;
    if (DEFLATE && f.data.length > 64){
      const z = await pipe(f.data, new CompressionStream('deflate-raw'));
      if (z.length < f.data.length){ body = z; method = 8; }
    }
    let extra = new Uint8Array(0), flags = 0x800, ver = 20, crcField = crc;
    if (password){
      const salt = crypto.getRandomValues(new Uint8Array(16)), k = await aesKeys(password, salt, 32);
      const ct = aesCtr(k.enc, body), mac = await hmac10(k.mac, ct);
      const enc = new Uint8Array(16 + 2 + ct.length + 10);
      enc.set(salt); enc.set(k.check, 16); enc.set(ct, 18); enc.set(mac, 18 + ct.length);
      // AE-2 (CRC left out, the HMAC protects the data), AES-256, real method inside
      extra = new Uint8Array([0x01, 0x99, 7, 0, 2, 0, 0x41, 0x45, 3, method, 0]);
      body = enc; method = 99; flags |= 1; ver = 51; crcField = 0;
    }
    const head = (sig, central) => {
      const h = new DataView(new ArrayBuffer(central ? 46 : 30));
      let o = 0;
      const u32 = v => { h.setUint32(o, v, true); o += 4; }, u16 = v => { h.setUint16(o, v, true); o += 2; };
      u32(sig); if (central) u16(ver); u16(ver); u16(flags); u16(method); u16(time); u16(date);
      u32(crcField); u32(body.length); u32(f.data.length); u16(name.length); u16(extra.length);
      if (central){ u16(0); u16(0); u16(0); u32(0); u32(offset); }
      return new Uint8Array(h.buffer);
    };
    const local = head(0x04034b50, false);
    central.push(head(0x02014b50, true), name, extra);
    parts.push(local, name, extra, body);
    offset += local.length + name.length + extra.length + body.length;
  }
  const cdSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Uint8Array(await new Blob([...parts, ...central, end.buffer]).arrayBuffer());
}

/* ---------------- Reading ---------------- */
// → [{ name, data }]; throws Error('password') when one is needed or it's wrong
export async function readZip(bytes, password){
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let e = bytes.length - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error("that isn't a zip file");
  const count = v.getUint16(e + 10, true), td = new TextDecoder();
  let p = v.getUint32(e + 16, true);
  const out = [];
  for (let n = 0; n < count; n++){
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('the zip is damaged');
    const flags = v.getUint16(p + 8, true), csize = v.getUint32(p + 20, true);
    const nl = v.getUint16(p + 28, true), xl = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), lo = v.getUint32(p + 42, true);
    let method = v.getUint16(p + 10, true), crc = v.getUint32(p + 16, true), strength = 0;
    const name = td.decode(bytes.subarray(p + 46, p + 46 + nl));
    for (let x = p + 46 + nl; x < p + 46 + nl + xl; ){
      const id = v.getUint16(x, true), len = v.getUint16(x + 2, true);
      if (id === 0x9901){ strength = v.getUint8(x + 8); method = v.getUint16(x + 9, true); if (v.getUint16(x + 4, true) === 2) crc = 0; }
      x += 4 + len;
    }
    p += 46 + nl + xl + cl;
    if (name.endsWith('/')) continue;
    const start = lo + 30 + v.getUint16(lo + 26, true) + v.getUint16(lo + 28, true);
    let data = bytes.slice(start, start + csize);
    if (flags & 1){
      if (!strength) throw new Error('this zip uses an old kind of password Markpad can’t open (make it with 7-Zip as AES-256)');
      if (!password) throw new Error('password');
      const keyLen = 8 + 8 * strength, sl = keyLen / 2;
      const k = await aesKeys(password, data.subarray(0, sl), keyLen);
      if (data[sl] !== k.check[0] || data[sl + 1] !== k.check[1]) throw new Error('password');
      const ct = data.subarray(sl + 2, data.length - 10), mac = await hmac10(k.mac, ct);
      if (mac.some((b, i) => b !== data[data.length - 10 + i])) throw new Error(name + ' is damaged');
      data = aesCtr(k.enc, ct);
    }
    if (method === 8){
      if (!DEFLATE) throw new Error("this device can't unpack compressed zips");
      data = await pipe(data, new DecompressionStream('deflate-raw'));
    } else if (method !== 0) throw new Error(name + ' is packed in a way Markpad can’t open');
    if (crc && crc32(data) !== crc) throw new Error(name + ' is damaged');
    out.push({ name, data });
  }
  return out;
}
