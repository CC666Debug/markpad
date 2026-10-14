#!/usr/bin/env bash
# Brings this PC up to date with the newest Markpad release on GitHub (run after every release):
#   - X:\TeCH\CC666DeBuG\Markpad Apps\  all 6 files named with their version + README (always current; nothing on the Desktop)
#   - the installed Windows app (%LOCALAPPDATA%\Markpad), only if Markpad isn't open
set -e
URL=https://github.com/CC666Debug/markpad/releases/latest/download
DIR="/x/TeCH/CC666DeBuG/Markpad Apps"
TMP=$(mktemp -d)
for f in Markpad-Setup.exe Markpad-Portable-Windows.zip Markpad.deb Markpad.AppImage Markpad.apk Markpad.html; do
  curl -sfL -o "$TMP/$f" "$URL/$f"
done
VER=$(curl -sf https://api.github.com/repos/CC666Debug/markpad/releases/latest | sed -n 's/.*"name": *"Markpad \([0-9.]*\)".*/\1/p' | head -1 || true)
mkdir -p "$DIR"
# On this PC every file carries its version (Markpad_v2.6.2.apk ...) and older copies are removed, so the folder stays
# current. The GitHub links keep the plain names so they always point at the newest version.
[ -n "$VER" ] || { echo "couldn't read the version; nothing copied"; exit 1; }
for f in "$TMP"/*; do
  b=$(basename "$f"); name="${b%.*}"; ext="${b##*.}"
  rm -f "$DIR/$b" "$DIR/${name}"_v*."$ext"
  cp "$f" "$DIR/${name}_v$VER.$ext"
done
V=$VER
printf 'Markpad %s (updated %s)\n\nWindows: Markpad-Setup_v%s.exe (installer) or Markpad-Portable-Windows_v%s.zip (no install)\nLinux Mint: Markpad_v%s.deb (installer) or Markpad_v%s.AppImage (no install)\nAndroid: Markpad_v%s.apk\nBrowser: Markpad_v%s.html\n\nNewest versions: https://github.com/CC666Debug/markpad/releases/latest\n' "$V" "$(date +%F)" "$V" "$V" "$V" "$V" "$V" "$V" > "$DIR/README.txt"
if tasklist //FI "IMAGENAME eq markpad.exe" | grep -qi markpad; then
  echo "Markpad is open: installed app NOT updated (run again after closing it)"
else
  "$TMP/Markpad-Setup.exe" //S && sleep 6
  echo "installed app: $(powershell -NoProfile -Command "(Get-Item \"$LOCALAPPDATA\Markpad\markpad.exe\").VersionInfo.ProductVersion")"
fi
rm -rf "$TMP"
echo "Markpad $VER copied to $DIR"
