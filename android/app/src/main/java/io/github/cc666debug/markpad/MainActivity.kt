package io.github.cc666debug.markpad

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.print.PrintAttributes
import android.print.PrintManager
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.JavascriptInterface
import android.webkit.MimeTypeMap
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.documentfile.provider.DocumentFile
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.util.concurrent.Executors

// Markpad on Android: the same index.html as every other edition, in a WebView, plus a small
// bridge (window.MarkpadAndroid) that reaches files through Android's own pickers.
class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var frame: FrameLayout
    private val io = Executors.newSingleThreadExecutor()
    private val net = Executors.newSingleThreadExecutor()   // JotBird requests, so a slow network never holds up files
    private var pickerDone: ((Intent?) -> Unit)? = null
    private val picker = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { r ->
        val cb = pickerDone
        pickerDone = null
        cb?.invoke(if (r.resultCode == RESULT_OK) r.data else null)
    }
    private var startUri: Uri? = null
    private val host = "appassets.androidplatform.net"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        web = WebView(this)
        // a WebView ignores its own padding, so the page sits in a padded frame instead
        frame = FrameLayout(this).apply { addView(web) }
        setContentView(frame)
        // keep the page clear of the status bar, navigation bar, camera cutout and keyboard
        ViewCompat.setOnApplyWindowInsetsListener(frame) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            WindowInsetsCompat.CONSUMED
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.settings.allowFileAccess = false
        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                val u = request.url
                if (u.host == host && u.path == "/lib/") return libImage(u)
                return assets.shouldInterceptRequest(u)
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == host) return false
                openExternal(request.url.toString())
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "MarkpadAndroid")
        startUri = viewUri(intent)
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                // let the page close a menu or the sidebar first
                web.evaluateJavascript("window.__mpBack ? window.__mpBack() : false") { r ->
                    if (r != "true") { isEnabled = false; onBackPressedDispatcher.onBackPressed(); isEnabled = true }
                }
            }
        })
        web.loadUrl("https://$host/assets/index.html")
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val u = viewUri(intent) ?: return
        io.execute {
            try {
                val o = looseFile(u)
                runOnUiThread { web.evaluateJavascript("window.__mpOpenFile && window.__mpOpenFile($o)", null) }
            } catch (_: Exception) {}
        }
    }

    private fun viewUri(i: Intent?): Uri? =
        if (i?.action == Intent.ACTION_VIEW || i?.action == Intent.ACTION_EDIT) i.data else null

    /* ---------------- the bridge ---------------- */
    inner class Bridge {
        @JavascriptInterface
        fun call(id: Int, method: String, json: String) {
            val a = JSONObject(json)
            when (method) {
                "openFile" -> pick(id, Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
                }) { d -> d.data?.let { keep(it); looseFile(it) } }
                "saveAs" -> pick(id, Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = a.getString("mime"); putExtra(Intent.EXTRA_TITLE, a.getString("name"))
                }) { d ->
                    d.data?.let { u ->
                        keep(u)
                        if (a.has("data")) contentResolver.openOutputStream(u, "wt")!!.use { it.write(Base64.decode(a.getString("data"), Base64.DEFAULT)) }
                        else writeUri(u, a.getString("text"))
                        JSONObject().put("uri", u.toString()).put("name", displayName(u)).toString()
                    }
                }
                "openZip" -> pick(id, Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                    addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
                    putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/octet-stream"))
                }) { d ->
                    d.data?.let { u ->
                        val bytes = contentResolver.openInputStream(u)!!.use { it.readBytes() }
                        JSONObject().put("name", displayName(u)).put("data", Base64.encodeToString(bytes, Base64.NO_WRAP)).toString()
                    }
                }
                "pickFolder" -> pick(id, Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)) { d ->
                    d.data?.let { u ->
                        contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
                        val name = DocumentFile.fromTreeUri(this@MainActivity, u)?.name ?: "Folder"
                        JSONObject().put("uri", u.toString()).put("name", name).toString()
                    }
                }
                "http" -> net.execute {
                    try { done(id, true, http(a)) } catch (e: Exception) { done(id, false, JSONObject.quote(e.message ?: e.toString())) }
                }
                else -> run(id) {
                    when (method) {
                        "startupFile" -> startUri?.let { u -> startUri = null; looseFile(u) }
                        "readUri" -> JSONObject.quote(readUri(Uri.parse(a.getString("uri"))))
                        "writeUri" -> { writeUri(Uri.parse(a.getString("uri")), a.getString("text")); null }
                        "list" -> lib(a).list().toString()
                        "read" -> JSONObject.quote(lib(a).read(a.getString("path")))
                        "readB64" -> JSONObject.quote(lib(a).open(a.getString("path")).use { Base64.encodeToString(it.readBytes(), Base64.NO_WRAP) })
                        "share" -> { share(a.getString("name"), Base64.decode(a.getString("data"), Base64.DEFAULT)); null }
                        "write" -> { lib(a).write(a.getString("path"), a.getString("text").toByteArray()); null }
                        "writeB64" -> { lib(a).write(a.getString("path"), Base64.decode(a.getString("data"), Base64.DEFAULT)); null }
                        "mkdir" -> { lib(a).dir(a.getString("path"), true); null }
                        "rename" -> { lib(a).rename(a.getString("from"), a.getString("to")); null }
                        "trash" -> { lib(a).trash(a.getString("path")); null }
                        "mtime" -> lib(a).mtime(a.getString("path")).toString()
                        "print" -> { runOnUiThread { print() }; null }
                        "openExternal" -> { openExternal(a.getString("url")); null }
                        "bars" -> { runOnUiThread { bars(a.getBoolean("dark")) }; null }
                        else -> throw IllegalArgumentException("unknown call $method")
                    }
                }
            }
        }
    }

    private fun run(id: Int, work: () -> String?) = io.execute {
        try { done(id, true, work()) } catch (e: Exception) { done(id, false, JSONObject.quote(e.message ?: e.toString())) }
    }

    private fun pick(id: Int, intent: Intent, then: (Intent) -> String?) = runOnUiThread {
        pickerDone = { data -> run(id) { data?.let(then) } }
        try { picker.launch(intent) } catch (e: Exception) { pickerDone = null; done(id, false, JSONObject.quote("no app can do that here")) }
    }

    private fun done(id: Int, ok: Boolean, json: String?) = runOnUiThread {
        web.evaluateJavascript("window.__mpDone && window.__mpDone($id, $ok, ${JSONObject.quote(json ?: "")})", null)
    }

    /* ---------------- loose files ---------------- */
    private fun keep(u: Uri) {
        try {
            contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        } catch (_: Exception) {
            try { contentResolver.takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION) } catch (_: Exception) {}
        }
    }

    private fun looseFile(u: Uri): String =
        JSONObject().put("uri", u.toString()).put("name", displayName(u)).put("text", readUri(u)).toString()

    private fun displayName(u: Uri): String {
        contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
            if (c.moveToFirst() && !c.isNull(0)) return c.getString(0)
        }
        return u.lastPathSegment?.substringAfterLast('/') ?: "note.md"
    }

    private fun readUri(u: Uri): String =
        contentResolver.openInputStream(u)!!.use { it.readBytes().toString(Charsets.UTF_8).removePrefix("﻿") }

    private fun writeUri(u: Uri, text: String) {
        contentResolver.openOutputStream(u, "wt")!!.use { it.write(text.toByteArray()) }
    }

    // paint the strips behind the status and navigation bars like the page's own bars
    private fun bars(dark: Boolean) {
        frame.setBackgroundColor(Color.parseColor(if (dark) "#232428" else "#F3F2EF"))
        WindowInsetsControllerCompat(window, frame).apply {
            isAppearanceLightStatusBars = !dark
            isAppearanceLightNavigationBars = !dark
        }
    }

    // a backup zip goes to Android's share menu (Drive, Gmail, Save to Files, …)
    private fun share(name: String, bytes: ByteArray) {
        val dir = File(cacheDir, "share").apply { deleteRecursively(); mkdirs() }
        val f = File(dir, name.replace(Regex("[\\\\/:*?\"<>|]"), "-")).apply { writeBytes(bytes) }
        val uri = FileProvider.getUriForFile(this, "$packageName.files", f)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "application/zip"; putExtra(Intent.EXTRA_STREAM, uri); putExtra(Intent.EXTRA_TITLE, f.name)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        runOnUiThread { startActivity(Intent.createChooser(send, f.name)) }
    }

    private fun print() {
        val pm = getSystemService(PRINT_SERVICE) as PrintManager
        pm.print("Markpad", web.createPrintDocumentAdapter("Markpad"), PrintAttributes.Builder().build())
    }

    // JotBird publishing (api.jotbird.com only): the site blocks requests from web pages, so the page asks the app.
    // Body comes as text or base64 (pictures); 4xx/5xx answers come back as a status, not an error.
    private fun http(a: JSONObject): String {
        val url = a.getString("url")
        require(url.startsWith("https://api.jotbird.com/")) { "only JotBird can be reached" }
        val c = java.net.URL(url).openConnection() as java.net.HttpURLConnection
        setMethod(c, a.getString("method"))
        c.connectTimeout = 20000; c.readTimeout = 60000
        val h = a.optJSONObject("headers") ?: JSONObject()
        for (k in h.keys()) c.setRequestProperty(k, h.getString(k))
        val bytes = when {
            a.has("bodyB64") -> Base64.decode(a.getString("bodyB64"), Base64.DEFAULT)
            a.has("body") -> a.getString("body").toByteArray()
            else -> null
        }
        if (bytes != null) { c.doOutput = true; c.outputStream.use { it.write(bytes) } }
        val status = c.responseCode
        val body = (if (status >= 400) c.errorStream else c.inputStream)?.use { it.readBytes().toString(Charsets.UTF_8) } ?: ""
        val reply = JSONObject().put("status", status).put("body", body).put("retryAfter", c.getHeaderField("Retry-After") ?: "")
        c.disconnect()
        return reply.toString()
    }

    // Some Android versions refuse PATCH (JotBird's page settings use it), so set it underneath when they do.
    private fun setMethod(c: java.net.HttpURLConnection, m: String) {
        try { c.requestMethod = m; return } catch (_: java.net.ProtocolException) {}
        val field = java.net.HttpURLConnection::class.java.getDeclaredField("method").apply { isAccessible = true }
        field.set(c, m)
        // https connections pass the work to an inner connection: set it there too
        var k: Class<*>? = c.javaClass
        while (k != null) {
            try {
                val d = k.getDeclaredField("delegate").apply { isAccessible = true }.get(c)
                if (d is java.net.HttpURLConnection) field.set(d, m)
                break
            } catch (_: NoSuchFieldException) { k = k.superclass }
        }
    }

    private fun openExternal(url: String) {
        try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } catch (_: Exception) {}
    }

    // pictures inside a library note: /lib/?root=…&path=…
    private fun libImage(u: Uri): WebResourceResponse? = try {
        val path = u.getQueryParameter("path")!!
        val ext = path.substringAfterLast('.', "").lowercase()
        val mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: if (ext == "svg") "image/svg+xml" else "application/octet-stream"
        WebResourceResponse(mime, null, lib(JSONObject().put("root", u.getQueryParameter("root"))).open(path))
    } catch (_: Exception) {
        WebResourceResponse("text/plain", null, 404, "Not found", null, null)
    }

    /* ---------------- libraries ---------------- */
    private val shown = Regex("\\.(md|markdown|mdown|mkd|txt|png|jpe?g|gif|webp|svg|bmp|avif)$", RegexOption.IGNORE_CASE)

    interface Lib {
        fun list(): JSONArray
        fun read(path: String): String
        fun write(path: String, bytes: ByteArray)
        fun dir(path: String, create: Boolean)
        fun rename(from: String, to: String)
        fun trash(path: String)
        fun mtime(path: String): Long
        fun open(path: String): InputStream
    }

    private fun lib(a: JSONObject): Lib {
        val root = a.getString("root")
        return if (root == "app") FileLib(File(getExternalFilesDir(null) ?: filesDir, "Notes").apply { mkdirs() })
        else SafLib(Uri.parse(root))
    }

    private fun parts(p: String) = p.split('/').filter { it.isNotEmpty() && it != "." }.also {
        if (it.contains("..")) throw IllegalArgumentException("that path leaves the library")
    }

    // "Markpad notes": a plain folder inside the app's own storage
    inner class FileLib(private val root: File) : Lib {
        private fun f(p: String) = parts(p).fold(root) { d, n -> File(d, n) }
        private fun walk(d: File, pre: String): JSONArray {
            val out = JSONArray()
            val kids = (d.listFiles() ?: arrayOf()).filter { !it.name.startsWith(".") }
                .sortedWith(compareBy<File>({ !it.isDirectory }, { it.name.lowercase() }))
            for (k in kids) {
                if (k.isDirectory) out.put(JSONObject().put("name", k.name).put("path", pre + k.name).put("dir", true).put("children", walk(k, pre + k.name + "/")))
                else if (shown.containsMatchIn(k.name)) out.put(JSONObject().put("name", k.name).put("path", pre + k.name).put("dir", false))
            }
            return out
        }
        override fun list() = walk(root, "")
        override fun read(path: String) = f(path).readText().removePrefix("﻿")
        override fun write(path: String, bytes: ByteArray) {
            val t = f(path); t.parentFile?.mkdirs()
            val tmp = File(t.parentFile, ".${t.name}.markpad-tmp")
            tmp.writeBytes(bytes)
            if (!tmp.renameTo(t)) { t.writeBytes(bytes); tmp.delete() }
        }
        override fun dir(path: String, create: Boolean) { f(path).mkdirs() }
        override fun rename(from: String, to: String) {
            val b = f(to); b.parentFile?.mkdirs()
            if (!f(from).renameTo(b)) throw Exception("couldn't rename")
        }
        override fun trash(path: String) {
            val src = f(path); val bin = File(root, ".trash").apply { mkdirs() }
            var dst = File(bin, src.name); var n = 2
            while (dst.exists()) dst = File(bin, "${n++} ${src.name}")
            if (!src.renameTo(dst)) throw Exception("couldn't move to .trash")
        }
        override fun mtime(path: String) = f(path).lastModified()
        override fun open(path: String): InputStream = f(path).inputStream()
    }

    // any folder the user picked (an Obsidian vault, Documents/Notes, …) through Android's folder picker.
    // Talks to DocumentsContract directly: one query per folder (DocumentFile asks again for every file's
    // name and type, which took minutes on a vault with thousands of files). Paths → document ids are
    // remembered per library, so opening and saving a note doesn't list its folder again.
    private val docIds = java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.ConcurrentHashMap<String, String>>()

    class Kid(val id: String, val name: String, val dir: Boolean)
    inner class SafLib(private val tree: Uri) : Lib {
        private val cr = contentResolver
        private val rootId = DocumentsContract.getTreeDocumentId(tree)
        private val ids = docIds.getOrPut(tree.toString()) { java.util.concurrent.ConcurrentHashMap() }
        private fun uri(id: String) = DocumentsContract.buildDocumentUriUsingTree(tree, id)
        private val DIR = DocumentsContract.Document.MIME_TYPE_DIR

        private fun kids(id: String): List<Kid> {
            val out = ArrayList<Kid>()
            cr.query(DocumentsContract.buildChildDocumentsUriUsingTree(tree, id), arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID, DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE), null, null, null)?.use { c ->
                while (c.moveToNext()) {
                    val name = c.getString(1) ?: continue
                    out.add(Kid(c.getString(0), name, c.getString(2) == DIR))
                }
            }
            return out
        }
        // forget remembered ids under a path (after a rename, move or delete)
        private fun forget(path: String) { ids.keys.removeAll { it == path || it.startsWith("$path/") } }

        // document id of a path, or null; looks up only the folders it hasn't seen yet
        private fun idOf(path: String): String? {
            val ps = parts(path)
            if (ps.isEmpty()) return rootId
            ids[ps.joinToString("/")]?.let { return it }
            var id = rootId; var pre = ""
            for (n in ps) {
                val p = pre + n
                id = ids[p] ?: run {
                    for (k in kids(id)) ids[pre + k.name] = k.id
                    ids[p]
                } ?: return null
                pre = "$p/"
            }
            return id
        }
        private fun need(path: String) = idOf(path) ?: throw java.io.FileNotFoundException(path)
        // the folder a path lives in (made when create is on) and the path's last part
        private fun parentOf(path: String, create: Boolean): Pair<String, String> {
            val ps = parts(path)
            var id = rootId; var pre = ""
            for (n in ps.dropLast(1)) {
                val p = pre + n
                id = idOf(p) ?: if (create) mkdir(id, p, n) else throw java.io.FileNotFoundException(path)
                pre = "$p/"
            }
            return id to ps.last()
        }
        private fun mkdir(parent: String, path: String, name: String): String {
            val u = DocumentsContract.createDocument(cr, uri(parent), DIR, name) ?: throw Exception("couldn't create $name")
            return DocumentsContract.getDocumentId(u).also { ids[path] = it }
        }

        private fun walk(id: String, pre: String): JSONArray {
            val out = JSONArray()
            val ks = kids(id).filter { !it.name.startsWith(".") }
                .sortedWith(compareBy<Kid>({ !it.dir }, { it.name.lowercase() }))
            for (k in ks) {
                val p = pre + k.name
                ids[p] = k.id
                if (k.dir) out.put(JSONObject().put("name", k.name).put("path", p).put("dir", true).put("children", walk(k.id, "$p/")))
                else if (shown.containsMatchIn(k.name)) out.put(JSONObject().put("name", k.name).put("path", p).put("dir", false))
            }
            return out
        }
        override fun list(): JSONArray { ids.clear(); return walk(rootId, "") }
        override fun read(path: String) = readUri(uri(need(path)))
        override fun write(path: String, bytes: ByteArray) {
            val (d, n) = parentOf(path, true)
            val key = parts(path).joinToString("/")
            val u = idOf(path)?.let { uri(it) }
                // octet-stream so Android keeps the name exactly as given (no extra ".txt")
                ?: DocumentsContract.createDocument(cr, uri(d), "application/octet-stream", n)?.also { ids[key] = DocumentsContract.getDocumentId(it) }
                ?: throw Exception("couldn't create $n")
            cr.openOutputStream(u, "wt")!!.use { it.write(bytes) }
        }
        override fun dir(path: String, create: Boolean) {
            var id = rootId; var pre = ""
            for (n in parts(path)) { val p = pre + n; id = idOf(p) ?: mkdir(id, p, n); pre = "$p/" }
        }
        override fun rename(from: String, to: String) {
            val src = need(from)
            val (fromDir, fromName) = parentOf(from, false)
            val (toDir, toName) = parentOf(to, true)
            var u = uri(src)
            if (fromDir != toDir) u = DocumentsContract.moveDocument(cr, u, uri(fromDir), uri(toDir)) ?: throw Exception("couldn't move")
            if (fromName != toName) DocumentsContract.renameDocument(cr, u, toName) ?: throw Exception("couldn't rename")
            forget(parts(from).joinToString("/")); forget(parts(to).joinToString("/"))
        }
        override fun trash(path: String) {
            val key = parts(path).joinToString("/")
            val src = need(path)
            val (from, name) = parentOf(path, false)
            val bin = idOf(".trash") ?: mkdir(rootId, ".trash", ".trash")
            val moved = try { DocumentsContract.moveDocument(cr, uri(src), uri(from), uri(bin)) } catch (_: Exception) { null }
            forget(key)
            if (moved != null) return
            if (cr.getType(uri(src)) == DIR) throw Exception("this folder can't be moved to .trash here")
            // the provider can't move: copy, then delete the original
            val copy = DocumentsContract.createDocument(cr, uri(bin), "application/octet-stream", "${System.currentTimeMillis()} $name") ?: throw Exception("couldn't copy")
            cr.openInputStream(uri(src))!!.use { i -> cr.openOutputStream(copy, "wt")!!.use { o -> i.copyTo(o) } }
            if (!DocumentsContract.deleteDocument(cr, uri(src))) throw Exception("couldn't delete")
        }
        override fun mtime(path: String): Long =
            cr.query(uri(need(path)), arrayOf(DocumentsContract.Document.COLUMN_LAST_MODIFIED), null, null, null)?.use { c ->
                if (c.moveToFirst() && !c.isNull(0)) c.getLong(0) else 0L
            } ?: 0L
        override fun open(path: String): InputStream = cr.openInputStream(uri(need(path)))!!
    }
}
