package io.github.cc666debug.markpad

import java.io.BufferedOutputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.RandomAccessFile
import java.io.SequenceInputStream
import java.security.SecureRandom
import java.util.Calendar
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream
import java.util.zip.Inflater
import java.util.zip.InflaterInputStream
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

// Backups on Android are made and unpacked here, one file at a time straight to and from storage, so a
// big vault never has to fit in the phone's memory (the page used to build the whole zip itself).
// Same zip as src/zip.js: deflate, and with a password the WinZip AES-256 format (AE-2) that 7-Zip,
// WinRAR and ZArchiver open. No zip64: over 65,534 files or 4 GB it says so instead of making a bad zip.
object BackupZip {
    private const val MAX = 0xFFFFFFFFL
    private const val BUF = 1 shl 16

    class Keys(val enc: ByteArray, val mac: ByteArray, val check: ByteArray)

    private fun keys(password: String, salt: ByteArray, keyLen: Int): Keys {
        val spec = PBEKeySpec(password.toCharArray(), salt, 1000, (2 * keyLen + 2) * 8)
        val bits = SecretKeyFactory.getInstance("PBKDF2WithHmacSHA1").generateSecret(spec).encoded
        return Keys(bits.copyOfRange(0, keyLen), bits.copyOfRange(keyLen, 2 * keyLen), bits.copyOfRange(2 * keyLen, 2 * keyLen + 2))
    }

    // WinZip AES counter mode: a little-endian block counter starting at 1 (same both ways).
    // legacy: Markpad 2.1.9–2.7.0 never carried the counter past its first byte, so after 4 KB its zips
    // only opened in Markpad. Those zips say "made by 5.1" and are read the old way.
    class Ctr(key: ByteArray, private val legacy: Boolean = false) {
        private val aes = Cipher.getInstance("AES/ECB/NoPadding").apply { init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES")) }
        private val ctr = ByteArray(16)
        private val ks = ByteArray(16)
        private var used = 16
        fun apply(b: ByteArray, off: Int, len: Int) {
            for (i in off until off + len) {
                if (used == 16) {
                    var k = 0
                    while (k < 16) { ctr[k] = (ctr[k] + 1).toByte(); if (legacy || ctr[k].toInt() != 0) break; k++ }
                    aes.doFinal(ctr, 0, 16, ks, 0); used = 0
                }
                b[i] = (b[i].toInt() xor ks[used++].toInt()).toByte()
            }
        }
    }

    private fun hmac(key: ByteArray) = Mac.getInstance("HmacSHA1").apply { init(SecretKeySpec(key, "HmacSHA1")) }

    /* ---------------- Writing ---------------- */
    class Writer(out: File, private val password: String?, private val tmp: File) : AutoCloseable {
        private val os = BufferedOutputStream(FileOutputStream(out), BUF)
        private var pos = 0L
        private val central = ByteArrayOutputStream()
        var count = 0
            private set
        private val time: Int
        private val date: Int
        init {
            val c = Calendar.getInstance()
            time = c.get(Calendar.HOUR_OF_DAY) shl 11 or (c.get(Calendar.MINUTE) shl 5) or (c.get(Calendar.SECOND) shr 1)
            date = (c.get(Calendar.YEAR) - 1980) shl 9 or ((c.get(Calendar.MONTH) + 1) shl 5) or c.get(Calendar.DAY_OF_MONTH)
        }

        fun add(name: String, src: InputStream) {
            if (count >= 65534) throw Exception("more than 65,534 files: too many for one backup zip")
            // deflate into a temp file first, so the sizes are known before the header is written
            val crc = CRC32(); var size = 0L
            val d = Deflater(Deflater.DEFAULT_COMPRESSION, true)
            try {
                DeflaterOutputStream(FileOutputStream(tmp), d, BUF).use { z ->
                    val buf = ByteArray(BUF)
                    while (true) { val n = src.read(buf); if (n < 0) break; crc.update(buf, 0, n); size += n; z.write(buf, 0, n) }
                }
            } finally { d.end() }
            val packed = tmp.length()
            val nameB = name.toByteArray(Charsets.UTF_8)
            val enc = !password.isNullOrEmpty()
            val csize = if (enc) packed + 28 else packed
            if (size > MAX || csize > MAX || pos > MAX) throw Exception("the backup would be over 4 GB: too big for one zip")
            // AE-2 (CRC left out, the HMAC protects the data), AES-256, deflate inside
            val extra = if (enc) byteArrayOf(0x01, 0x99.toByte(), 7, 0, 2, 0, 0x41, 0x45, 3, 8, 0) else ByteArray(0)
            val method = if (enc) 99 else 8
            val flags = if (enc) 0x801 else 0x800
            val ver = if (enc) 51 else 20
            val crcField = if (enc) 0L else crc.value
            val local = header(false, ver, flags, method, crcField, csize, size, nameB.size, extra.size, 0)
            central.write(header(true, ver, flags, method, crcField, csize, size, nameB.size, extra.size, pos)); central.write(nameB); central.write(extra)
            os.write(local); os.write(nameB); os.write(extra)
            if (enc) {
                val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
                val k = keys(password!!, salt, 32)
                val ctr = Ctr(k.enc); val mac = hmac(k.mac)
                os.write(salt); os.write(k.check)
                tmp.inputStream().use { i ->
                    val buf = ByteArray(BUF)
                    while (true) { val n = i.read(buf); if (n < 0) break; ctr.apply(buf, 0, n); mac.update(buf, 0, n); os.write(buf, 0, n) }
                }
                os.write(mac.doFinal(), 0, 10)
            } else tmp.inputStream().use { it.copyTo(os, BUF) }
            pos += local.size + nameB.size + extra.size + csize
            count++
        }

        private fun header(isCentral: Boolean, ver: Int, flags: Int, method: Int, crc: Long, csize: Long, size: Long, nl: Int, xl: Int, offset: Long): ByteArray {
            val b = ByteArrayOutputStream()
            fun u16(v: Int) { b.write(v and 255); b.write(v shr 8 and 255) }
            fun u32(v: Long) { u16((v and 0xFFFF).toInt()); u16((v shr 16 and 0xFFFF).toInt()) }
            u32(if (isCentral) 0x02014b50L else 0x04034b50L)
            if (isCentral) u16(if (method == 99) 63 else ver)   // made by 6.3, so fixed zips aren't taken for old ones
            u16(ver); u16(flags); u16(method); u16(time); u16(date)
            u32(crc); u32(csize); u32(size); u16(nl); u16(xl)
            if (isCentral) { u16(0); u16(0); u16(0); u32(0); u32(offset) }
            return b.toByteArray()
        }

        override fun close() {
            val cd = central.toByteArray()
            os.write(cd)
            val e = ByteArrayOutputStream()
            fun u16(v: Int) { e.write(v and 255); e.write(v shr 8 and 255) }
            fun u32(v: Long) { u16((v and 0xFFFF).toInt()); u16((v shr 16 and 0xFFFF).toInt()) }
            u32(0x06054b50L); u16(0); u16(0); u16(count); u16(count); u32(cd.size.toLong()); u32(pos); u16(0)
            os.write(e.toByteArray())
            os.close()
            tmp.delete()
        }
    }

    /* ---------------- Reading ---------------- */
    class Entry(val name: String, val flags: Int, val method: Int, val crc: Long, val csize: Long, val strength: Int, val local: Long, val legacy: Boolean)

    // part of the zip file as a stream, read from disk as it's used
    private class Range(private val f: RandomAccessFile, private var at: Long, private var left: Long) : InputStream() {
        override fun read(): Int { val b = ByteArray(1); return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 255 }
        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (left <= 0) return -1
            f.seek(at)
            val n = f.read(b, off, minOf(len.toLong(), left).toInt())
            if (n > 0) { at += n; left -= n }
            return n
        }
    }

    private fun u16(b: ByteArray, p: Int) = (b[p].toInt() and 255) or ((b[p + 1].toInt() and 255) shl 8)
    private fun u32(b: ByteArray, p: Int) = u16(b, p).toLong() or (u16(b, p + 2).toLong() shl 16)

    fun entries(f: RandomAccessFile): List<Entry> {
        val tail = minOf(f.length(), 65557L).toInt()
        val t = ByteArray(tail); f.seek(f.length() - tail); f.readFully(t)
        var e = tail - 22
        while (e >= 0 && u32(t, e) != 0x06054b50L) e--
        if (e < 0) throw Exception("that isn't a zip file")
        val count = u16(t, e + 10)
        val cd = ByteArray(u32(t, e + 12).toInt()); f.seek(u32(t, e + 16)); f.readFully(cd)
        val out = ArrayList<Entry>(); var p = 0
        repeat(count) {
            if (u32(cd, p) != 0x02014b50L) throw Exception("the zip is damaged")
            val nl = u16(cd, p + 28); val xl = u16(cd, p + 30); val cl = u16(cd, p + 32)
            var method = u16(cd, p + 10); var crc = u32(cd, p + 16); var strength = 0
            val name = String(cd, p + 46, nl, Charsets.UTF_8)
            var x = p + 46 + nl
            while (x < p + 46 + nl + xl) {
                val id = u16(cd, x); val len = u16(cd, x + 2)
                if (id == 0x9901) { strength = cd[x + 8].toInt() and 255; method = u16(cd, x + 9); if (u16(cd, x + 4) == 2) crc = 0 }
                x += 4 + len
            }
            out.add(Entry(name, u16(cd, p + 8), method, crc, u32(cd, p + 20), strength, u32(cd, p + 42), (cd[p + 4].toInt() and 255) == 51))
            p += 46 + nl + xl + cl
        }
        return out
    }

    private fun dataStart(f: RandomAccessFile, e: Entry): Long {
        val h = ByteArray(30); f.seek(e.local); f.readFully(h)
        return e.local + 30 + u16(h, 26) + u16(h, 28)
    }

    // throws Exception("password") when one is needed or it's wrong, before anything is written
    fun checkPassword(f: RandomAccessFile, list: List<Entry>, password: String?) {
        for (e in list) {
            if (e.flags and 1 == 0) continue
            if (e.strength == 0) throw Exception("this zip uses an old kind of password Markpad can’t open (make it with 7-Zip as AES-256)")
            if (password.isNullOrEmpty()) throw Exception("password")
            val sl = 4 + 4 * e.strength
            val head = ByteArray(sl + 2); f.seek(dataStart(f, e)); f.readFully(head)
            val k = keys(password, head.copyOfRange(0, sl), 8 + 8 * e.strength)
            if (head[sl] != k.check[0] || head[sl + 1] != k.check[1]) throw Exception("password")
            return   // one entry is enough: every entry of a backup has the same password
        }
    }

    // the entry's contents, unpacked as they're read
    fun open(f: RandomAccessFile, e: Entry, password: String?): InputStream {
        var at = dataStart(f, e)
        var len = e.csize
        var raw: InputStream
        if (e.flags and 1 != 0) {
            val sl = 4 + 4 * e.strength
            val salt = ByteArray(sl); f.seek(at); f.readFully(salt)
            val k = keys(password ?: "", salt, 8 + 8 * e.strength)
            at += sl + 2; len -= sl + 2 + 10
            // check the HMAC over the whole entry first, so a damaged file is never written
            val mac = hmac(k.mac)
            Range(f, at, len).use { i -> val buf = ByteArray(BUF); while (true) { val n = i.read(buf); if (n < 0) break; mac.update(buf, 0, n) } }
            val want = ByteArray(10); f.seek(at + len); f.readFully(want)
            if (!mac.doFinal().copyOf(10).contentEquals(want)) throw Exception("${e.name} is damaged")
            val ctr = Ctr(k.enc, e.legacy)
            val src = Range(f, at, len)
            raw = object : InputStream() {
                override fun read(): Int { val b = ByteArray(1); return if (read(b, 0, 1) < 0) -1 else b[0].toInt() and 255 }
                override fun read(b: ByteArray, off: Int, n: Int): Int { val r = src.read(b, off, n); if (r > 0) ctr.apply(b, off, r); return r }
            }
        } else raw = Range(f, at, len)
        return when (e.method) {
            // nowrap inflate wants one spare byte after the data
            8 -> InflaterInputStream(SequenceInputStream(raw, ByteArrayInputStream(ByteArray(1))), Inflater(true), BUF)
            0 -> raw
            else -> throw Exception("${e.name} is packed in a way Markpad can’t open")
        }
    }

    // copies while checking the CRC (when the zip has one)
    fun copy(src: InputStream, out: OutputStream, e: Entry) {
        val crc = CRC32(); val buf = ByteArray(BUF)
        while (true) { val n = src.read(buf); if (n < 0) break; crc.update(buf, 0, n); out.write(buf, 0, n) }
        if (e.crc != 0L && crc.value != e.crc) throw Exception("${e.name} is damaged")
    }
}
