# ShotKit

A CleanShot X–style screenshot tool for Windows, built with Electron + TypeScript.

## Features

- **Capture area / window / fullscreen:** an overlay with a crosshair, a pixel magnifier and size labels. Press Space to switch between area and window picking, hold Shift for a square selection, and press Esc or right-click to cancel. The screen is frozen while you select; turn that off in Settings to keep animations playing.
- **Capture previous area:** repeats the last area or window capture without selecting again.
- **Self-timer:** counts down (3, 5 or 10 seconds) before capturing, so you can open a menu or hover a tooltip first. Esc cancels.
- **Screen recording:** record an area, a window or the whole screen (click without dragging) as MP4 or an animated GIF. Stop from the control bar or press the record shortcut again. Recordings go to the save folder.
- **Colour picker and ruler:** click any pixel on screen to copy its hex colour, or drag to measure distances in pixels.
- **Capture options:** include the mouse pointer, and give window captures rounded corners and a drop shadow on a transparent background.
- **Quick Access overlay:** after each capture a thumbnail appears in the corner. Copy, Save, Annotate, Pin, OCR, Upload or show it in its folder, or drag it into another app (as PNG or JPEG). "Close all" clears the stack.
- **Annotation editor:**
  - Tools: arrow, line, rectangle, ellipse, text, callout, pen, highlighter, blur, pixelate, solid redaction, spotlight, magnifier, numbered steps, stamps and crop.
  - **Arrows**: standard, tapered, open, double-headed, dashed and elbow (right-angle). Drag the round middle handle to curve an arrow or line. **Lines** can be dashed, have dot ends, or be a measurement line that shows its length.
  - **Text** can be outlined, plain or on a coloured pill, aligned left, centre or right. **Callouts** are speech bubbles: drag from what you point at to where the bubble goes, then type.
  - **Numbered steps** count 1-2-3, A-B-C or i-ii-iii and renumber when one is deleted. **Stamps**: ✅ ❌ ⚠️ ⭐ ❤️ ❓ 👍 and a mouse pointer. The **magnifier** enlarges any spot; drag its round handle to choose what it shows.
  - Colours: eight presets, your own (+), and an eyedropper that picks from anywhere on screen. Opacity slider and four sizes.
  - Select several shapes (drag a box or Shift+click), move them together, copy/paste/duplicate, bring to front or send to back (right-click for a menu), and nudge with the arrow keys. Shapes snap to each other's edges and centres (hold Alt to place freely).
  - Zoom with Ctrl+scroll, Ctrl+plus/minus, Ctrl+0 (fit) and Ctrl+1 (100%). Hold Space and drag to pan.
  - **Redact** finds emails, phone numbers, card numbers, IBANs, IP addresses and API keys with OCR and blacks them out in one step.
  - **Background**: gradients, your own colour or picture, or a blurred copy of the screenshot; padding, rounded corners, shadow and a fixed size (16:9, 1:1, …). Add a macOS, Windows or browser window frame with a title or address.
  - The editor remembers your last tool, colour, size and styles. Reopening a capture from history brings back its annotations, not a flattened image.
- **Saving:** PNG, JPEG (with a quality setting) or WebP, at full resolution or at normal (1×) size on high-DPI screens. File names come from a template such as `{year}-{month}/{app} {date} at {time}`; "/" makes folders.
- **Uploading:** to Imgur (with your own Client ID) or your own server; the link is copied to the clipboard.
- **Scrolling capture:** select a region and ShotKit scrolls it and stitches the frames together. Click Done or press Esc.
- **Capture text (OCR):** uses the OCR engine built into Windows and copies the text to the clipboard.
- **Pin to screen:** a floating always-on-top image. Drag to move, scroll to zoom, Ctrl+scroll for opacity, Esc to close.
- **Capture history:** browse, search (by name, app, window title or text in the capture), re-edit, copy, pin, upload or delete past captures.
- **Hide desktop icons:** toggle from the tray menu. Icons are restored when you quit.

## Default shortcuts

| Action             | Shortcut         |
| ------------------ | ---------------- |
| Capture text (OCR) | Ctrl + Shift + 2 |
| Capture fullscreen | Ctrl + Shift + 3 |
| Capture area       | Ctrl + Shift + 4 |
| Capture window     | Ctrl + Shift + 5 |
| Scrolling capture  | Ctrl + Shift + 6 |
| Self-timer capture | Ctrl + Shift + 7 |
| Record screen      | Ctrl + Shift + 8 |

Capture previous area, the colour picker, the ruler and capture history have no shortcut by default. All
shortcuts can be changed in Settings (tray icon → Settings…). To use **Print Screen**, first turn off
*Windows Settings → Accessibility → Keyboard → "Use the Print screen key to open screen capture"*.

Editor shortcuts: V select, A arrow, L line, R rectangle, O ellipse, T text, M callout, P pen,
H highlighter, B blur, X pixelate, K redact, S spotlight, G magnifier, N steps, E stamp, C crop,
F fill, I eyedropper, 1–4 size. Press a tool's key again for its next style. Ctrl+Z/Y undo/redo,
Ctrl+C copy the image (or the selected shapes), Ctrl+V paste shapes, Ctrl+D duplicate, Ctrl+A select all,
Delete, [ and ] to reorder, Ctrl+S save. Double-click text or a callout with the select tool to edit it.

## Development

Requires Node.js 20+.

```
npm install
npm start          # build + run
npm run typecheck  # TypeScript checks
npm test           # unit tests
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

The installer isn't code-signed yet, so Windows SmartScreen warns on first install
(*More info → Run anyway*). Updates install silently after that. To sign it, buy a code signing
certificate and add it to the repository's secrets as `WIN_CSC_LINK` (the .pfx file, base64-encoded)
and `WIN_CSC_KEY_PASSWORD`; the release workflow then signs every installer.
