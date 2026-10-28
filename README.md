# Markpad

A slim Markdown editor: one pane that formats as you type (like Obsidian's Live Preview), plus Write, Split and Read views.
Keep notes in a folder, or point it at an existing Obsidian vault.

**Download** (latest build): [Releases page](https://github.com/CC666Debug/markpad/releases/latest)

| Edition | File |
| --- | --- |
| Windows | `Markpad-Setup.exe`, or `Markpad-Portable-Windows.zip` (runs from any folder or USB stick) |
| Linux Mint | `Markpad.deb`, or `Markpad.AppImage` |
| Android | `Markpad.apk` |
| Browser | `Markpad.html` (Chrome or Edge for real file saving and libraries) |

## Features

- Live / Write / Split / Read views, light and dark
- Library sidebar: folder tree, new notes and folders, rename, delete to `.trash`, `[[wiki links]]`, `![[image]]` embeds, Ctrl+P quick open, outline
- Find and replace (match case, regex), focus mode, recent files
- Paste or drop images: saved into the library (following Obsidian's attachment setting), or kept inside the note when there's no library
- Auto-save in a library, and it notices when Obsidian or sync changed a note
- Export to HTML, print / PDF
- Obsidian callouts (`> [!note]`), note embeds (`![[Note]]`, `![[Note#Heading]]`), footnotes, `$math$` (MathML, built in) and Mermaid diagrams (loaded from the web the first time)
- Note history: earlier versions of each note, kept on the device for 30 days, with Restore
- Bookmarks at the top of the file list; every command by name with F1 / Ctrl+Shift+L
- Android: Share ▸ Markpad sends text or a link from any app into a note
- Error log (▾ > Settings) to copy and send when something goes wrong

## Building

`npm ci && npm run build` makes `dist/index.html`, one self-contained file. Every push to `main` builds all editions on GitHub
(`.github/workflows/build.yml`): Tauri for Windows/Linux (`desktop/`), a WebView app for Android (`android/`).
