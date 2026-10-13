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
                        keep(u); writeUri(u, a.getString("text"))
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

    // any folder the user picked (an Obsidian vault, Documents/Notes, …) through Android's folder picker
    inner class SafLib(tree: Uri) : Lib {
        private val root = DocumentFile.fromTreeUri(this@MainActivity, tree) ?: throw Exception("can't open that folder")
        private fun find(path: String): DocumentFile =
            parts(path).fold(root) { d, n -> d.findFile(n) ?: throw java.io.FileNotFoundException(path) }
        private fun parentOf(path: String, create: Boolean): Pair<DocumentFile, String> {
            val ps = parts(path)
            var d = root
            for (n in ps.dropLast(1)) d = d.findFile(n) ?: if (create) d.createDirectory(n)!! else throw java.io.FileNotFoundException(path)
            return d to ps.last()
        }
        private fun walk(d: DocumentFile, pre: String): JSONArray {
            val out = JSONArray()
            val kids = d.listFiles().filter { !(it.name ?: ".").startsWith(".") }
                .sortedWith(compareBy<DocumentFile>({ !it.isDirectory }, { (it.name ?: "").lowercase() }))
            for (k in kids) {
                val n = k.name ?: continue
                if (k.isDirectory) out.put(JSONObject().put("name", n).put("path", pre + n).put("dir", true).put("children", walk(k, "$pre$n/")))
                else if (shown.containsMatchIn(n)) out.put(JSONObject().put("name", n).put("path", pre + n).put("dir", false))
            }
            return out
        }
        override fun list() = walk(root, "")
        override fun read(path: String) = readUri(find(path).uri)
        override fun write(path: String, bytes: ByteArray) {
            val (d, n) = parentOf(path, true)
            // octet-stream so Android keeps the name exactly as given (no extra ".txt")
            val f = d.findFile(n) ?: d.createFile("application/octet-stream", n) ?: throw Exception("couldn't create $n")
            contentResolver.openOutputStream(f.uri, "wt")!!.use { it.write(bytes) }
        }
        override fun dir(path: String, create: Boolean) {
            var d = root
            for (n in parts(path)) d = d.findFile(n) ?: d.createDirectory(n) ?: throw Exception("couldn't create $n")
        }
        override fun rename(from: String, to: String) {
            val src = find(from)
            val (toDir, toName) = parentOf(to, true)
            val fromDir = parentOf(from, false).first
            if (fromDir.uri == toDir.uri) { if (!src.renameTo(toName)) throw Exception("couldn't rename"); return }
            DocumentsContract.moveDocument(contentResolver, src.uri, fromDir.uri, toDir.uri) ?: throw Exception("couldn't move")
        }
        override fun trash(path: String) {
            val src = find(path)
            val from = parentOf(path, false).first
            val bin = root.findFile(".trash") ?: root.createDirectory(".trash") ?: throw Exception("no .trash")
            val moved = try { DocumentsContract.moveDocument(contentResolver, src.uri, from.uri, bin.uri) } catch (_: Exception) { null }
            if (moved != null) return
            if (src.isDirectory) throw Exception("this folder can't be moved to .trash here")
            // the provider can't move: copy, then delete the original
            val copy = bin.createFile("application/octet-stream", "${System.currentTimeMillis()} ${src.name}") ?: throw Exception("couldn't copy")
            contentResolver.openInputStream(src.uri)!!.use { i -> contentResolver.openOutputStream(copy.uri, "wt")!!.use { o -> i.copyTo(o) } }
            if (!src.delete()) throw Exception("couldn't delete")
        }
        override fun mtime(path: String) = find(path).lastModified()
        override fun open(path: String): InputStream = contentResolver.openInputStream(find(path).uri)!!
    }
}
