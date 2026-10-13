#!/usr/bin/env bash
# Brings this PC up to date with the newest Markpad release on GitHub (run after every release):
#   - X:\TeCH\CC666DeBuG\Markpad Apps\  all 6 files + README (the user wants this always current; nothing on the Desktop)
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
cp "$TMP"/* "$DIR/"
printf 'Markpad %s (updated %s)\n\nWindows: Markpad-Setup.exe (installer) or Markpad-Portable-Windows.zip (no install)\nLinux Mint: Markpad.deb (installer) or Markpad.AppImage (no install)\nAndroid: Markpad.apk\nBrowser: Markpad.html\n\nNewest versions: https://github.com/CC666Debug/markpad/releases/latest\n' "$VER" "$(date +%F)" > "$DIR/README.txt"
if tasklist //FI "IMAGENAME eq markpad.exe" | grep -qi markpad; then
  echo "Markpad is open: installed app NOT updated (run again after closing it)"
else
  "$TMP/Markpad-Setup.exe" //S && sleep 6
  echo "installed app: $(powershell -NoProfile -Command "(Get-Item \"$LOCALAPPDATA\Markpad\markpad.exe\").VersionInfo.ProductVersion")"
fi
rm -rf "$TMP"
echo "Markpad $VER copied to $DIR"
