// Markpad desktop (Windows + Linux): a window around dist/index.html plus a few file commands.
// Library paths from the page are relative to a root folder and use '/'; root "" means `path` is absolute.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

#[derive(Serialize)]
struct Entry {
    name: String,
    path: String,
    dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<Entry>>,
}

const SHOWN: &[&str] = &["md", "markdown", "mdown", "mkd", "txt", "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

fn err<E: ToString>(e: E) -> String {
    e.to_string()
}

fn resolve(root: &str, rel: &str) -> Result<PathBuf, String> {
    if root.is_empty() {
        return Ok(PathBuf::from(rel));
    }
    let mut p = PathBuf::from(root);
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err("that path leaves the library".into()),
            x => p.push(x),
        }
    }
    Ok(p)
}

fn walk(dir: &Path, prefix: &str, depth: u32) -> Vec<Entry> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let path = format!("{prefix}{name}");
        if e.path().is_dir() {
            if depth < 32 {
                let children = walk(&e.path(), &format!("{path}/"), depth + 1);
                out.push(Entry { name, path, dir: true, children: Some(children) });
            }
        } else {
            let ext = Path::new(&name).extension().map(|x| x.to_string_lossy().to_lowercase()).unwrap_or_default();
            if SHOWN.contains(&ext.as_str()) {
                out.push(Entry { name, path, dir: false, children: None });
            }
        }
    }
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    out
}

fn ensure_parent(p: &Path) -> Result<(), String> {
    if let Some(d) = p.parent() {
        fs::create_dir_all(d).map_err(err)?;
    }
    Ok(())
}

// Write to a hidden temp file first, then swap it in, so a crash never leaves half a note.
fn write_atomic(p: &Path, bytes: &[u8]) -> Result<(), String> {
    ensure_parent(p)?;
    let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let tmp = p.with_file_name(format!(".{name}.markpad-tmp"));
    fs::write(&tmp, bytes).map_err(err)?;
    fs::rename(&tmp, p).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        e.to_string()
    })
}

#[tauri::command]
fn list_tree(root: String) -> Result<Vec<Entry>, String> {
    let p = PathBuf::from(&root);
    if !p.is_dir() {
        return Err(format!("{root} is not a folder"));
    }
    Ok(walk(&p, "", 0))
}

#[tauri::command]
fn read_text(root: String, path: String) -> Result<String, String> {
    let bytes = fs::read(resolve(&root, &path)?).map_err(err)?;
    let text = String::from_utf8_lossy(&bytes);
    Ok(text.strip_prefix('\u{feff}').unwrap_or(&text).to_string())
}

#[tauri::command]
fn read_b64(path: String) -> Result<String, String> {
    Ok(base64::engine::general_purpose::STANDARD.encode(fs::read(path).map_err(err)?))
}

#[tauri::command]
fn write_text(root: String, path: String, text: String) -> Result<(), String> {
    write_atomic(&resolve(&root, &path)?, text.as_bytes())
}

#[tauri::command]
fn write_b64(root: String, path: String, data: String) -> Result<(), String> {
    let bytes = base64::engine::general_purpose::STANDARD.decode(data).map_err(err)?;
    write_atomic(&resolve(&root, &path)?, &bytes)
}

#[tauri::command]
fn make_dir(root: String, path: String) -> Result<(), String> {
    fs::create_dir_all(resolve(&root, &path)?).map_err(err)
}

#[tauri::command]
fn rename_path(root: String, from: String, to: String) -> Result<(), String> {
    let (a, b) = (resolve(&root, &from)?, resolve(&root, &to)?);
    if b.exists() && from.to_lowercase() != to.to_lowercase() {
        return Err(format!("{to} already exists"));
    }
    ensure_parent(&b)?;
    fs::rename(a, b).map_err(err)
}

// Like Obsidian's "move to .trash": nothing is really deleted.
#[tauri::command]
fn trash_path(root: String, path: String) -> Result<(), String> {
    let src = resolve(&root, &path)?;
    let trash = PathBuf::from(&root).join(".trash");
    fs::create_dir_all(&trash).map_err(err)?;
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| "item".into());
    let mut dst = trash.join(&name);
    let mut n = 2;
    while dst.exists() {
        dst = trash.join(format!("{n} {name}"));
        n += 1;
    }
    fs::rename(src, dst).map_err(err)
}

#[tauri::command]
fn mtime(root: String, path: String) -> Result<u64, String> {
    let m = fs::metadata(resolve(&root, &path)?).and_then(|m| m.modified()).map_err(err)?;
    Ok(m.duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
}

// Where Markpad itself lives (the AppImage file on Linux, the .exe on Windows).
fn base_dir() -> Option<PathBuf> {
    if let Ok(a) = std::env::var("APPIMAGE") {
        return PathBuf::from(a).parent().map(Path::to_path_buf);
    }
    std::env::current_exe().ok()?.parent().map(Path::to_path_buf)
}

// The portable edition has a file called "portable" next to it: then notes and settings stay in that folder.
fn portable_base() -> Option<PathBuf> {
    let b = base_dir()?;
    (b.join("portable").exists() || b.join("portable.txt").exists()).then_some(b)
}

#[tauri::command]
fn portable_dir(app: tauri::AppHandle) -> Result<String, String> {
    let dir = match portable_base() {
        Some(b) => b.join("Notes"),
        None => app.path().document_dir().map_err(err)?.join("Markpad Notes"),
    };
    fs::create_dir_all(&dir).map_err(err)?;
    Ok(dir.to_string_lossy().to_string())
}

// A file passed on the command line (double-clicking a .md file once Markpad is the default app).
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args()
        .skip(1)
        .find(|a| !a.starts_with('-') && Path::new(a).is_file())
        .and_then(|a| std::path::absolute(a).ok())
        .map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("mailto:")) {
        return Err("only web links can be opened".into());
    }
    open::that_detached(url).map_err(err)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            list_tree, read_text, read_b64, write_text, write_b64, make_dir, rename_path, trash_path, mtime,
            portable_dir, startup_file, open_external
        ])
        .setup(|app| {
            let mut w = tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("Markpad")
                .inner_size(1200.0, 800.0)
                .min_inner_size(420.0, 320.0);
            if let Some(b) = portable_base() {
                w = w.data_directory(b.join("Data"));
            }
            w.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Markpad");
}
