# ShotKit

A CleanShot X–style screenshot tool for Windows, built with Electron + TypeScript.

## Features

- **Capture area / window / fullscreen:** a frozen-screen overlay with a crosshair, a pixel magnifier and size labels. Press Space to switch between area and window picking, hold Shift for a square selection, and press Esc or right-click to cancel.
- **Quick Access overlay:** after each capture a thumbnail appears in the corner. You can Copy, Save, Annotate, Pin or OCR it, or drag it straight into another app.
- **Annotation editor:** arrow, line, rectangle, ellipse (outline or filled), text, pen, highlighter, blur, pixelate, numbered steps and crop, with undo/redo. It also has a "Background" beautifier (gradient backdrop, padding, rounded corners, shadow).
- **Scrolling capture:** select a region and ShotKit scrolls it and stitches the frames together. Click Done or press Esc.
- **Capture text (OCR):** uses the OCR engine built into Windows and copies the text to the clipboard.
- **Pin to screen:** a floating always-on-top image. Drag to move, scroll to zoom, Ctrl+scroll for opacity, Esc to close.
- **Capture history:** browse, re-edit, copy, pin or delete past captures.
- **Hide desktop icons:** toggle from the tray menu. Icons are restored when you quit.

## Default shortcuts

| Action             | Shortcut         |
| ------------------ | ---------------- |
| Capture text (OCR) | Ctrl + Shift + 2 |
| Capture fullscreen | Ctrl + Shift + 3 |
| Capture area       | Ctrl + Shift + 4 |
| Capture window     | Ctrl + Shift + 5 |
| Scrolling capture  | Ctrl + Shift + 6 |

All of them can be changed in Settings (tray icon → Settings…). To use **Print Screen**, first turn off
*Windows Settings → Accessibility → Keyboard → "Use the Print screen key to open screen capture"*.

Editor shortcuts: V select, A arrow, L line, R rectangle, O ellipse, T text, P pen, H highlighter,
B blur, X pixelate, N counter, C crop, F fill, 1/2/3 size, Ctrl+Z/Y undo/redo, Ctrl+C copy, Ctrl+S save.

## Development

Requires Node.js 20+.

```
npm install
npm start          # build + run
npm run typecheck  # TypeScript checks
npm run dist       # build installer + portable exe into ./release
```

Captures are kept in `%APPDATA%\ShotKit\history` and auto-saved to `Pictures\ShotKit` by default.

## Releasing updates

Installed copies of ShotKit check GitHub Releases on startup and every 4 hours. When a newer
version exists they ask to download it, then ask to restart to install it. You can also use
tray → *Check for Updates…*.

To publish a new version:

```
npm version patch        # or: minor / major — bumps package.json, commits, and tags vX.Y.Z
git push --follow-tags   # the tag triggers .github/workflows/release.yml
```

GitHub Actions builds the installer and publishes it as a Release, including the `latest.yml`
file the updater reads. Within a few hours every installed copy is offered the update.

The installer isn't code-signed, so Windows SmartScreen warns on first install
(*More info → Run anyway*). Updates install silently after that.
