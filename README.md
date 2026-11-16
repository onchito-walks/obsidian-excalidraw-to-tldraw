# Excalidraw to tldraw

An Obsidian plugin that converts Excalidraw drawings into drawings for the
[tldraw plugin](https://github.com/tldraw/obsidian-plugin).

It does not translate shapes itself. It runs tldraw's own Excalidraw importer (the code behind
pasting Excalidraw content into tldraw) on a headless editor and saves the result in the tldraw
plugin's file format, so the output is exactly what tldraw would have written.

## Use

Command palette:

- **Convert all Excalidraw drawings to tldraw**: every `.excalidraw`, `.excalidraw.md` and note
  with `excalidraw-plugin` in its frontmatter.
- **Convert current Excalidraw drawing to tldraw**

`Drawing.excalidraw.md` becomes `Drawing.tldraw.md` next to it. Originals are never changed or
deleted, an existing target is never overwritten (so re-running is safe), and empty drawings are
skipped. Each run writes `Excalidraw to tldraw report.md` in the vault root: one row per drawing
with what was converted and what was left behind.

Requires the tldraw plugin 1.35.1 or newer to open the results.

## What converts

| Excalidraw | tldraw |
|---|---|
| rectangle, ellipse, diamond (with label) | geo shape |
| freedraw | draw |
| line, arrow (with label and bindings) | line, arrow |
| text | text |
| image | image, kept as a vault file and linked the tldraw plugin's way; inline images are saved as attachments |
| groups, rotation, lock, opacity | kept |
| colours | nearest tldraw colour (tldraw has a fixed palette) |

Left behind and listed in the report: frames, embeds/iframes, LaTeX, embedded notes, images that
point at a web URL or a missing file. Links and embeds elsewhere in the vault still point at the
Excalidraw originals.

## Develop

    npm install
    npm test        # converter, checked with tldraw's own file parser
    npm run e2e     # real Obsidian + the real tldraw plugin open the converted files (needs xvfb)
    npm run build   # main.js

Install by copying `main.js` and `manifest.json` to `<vault>/.obsidian/plugins/excalidraw-to-tldraw/`.

## Licence note

`main.js` bundles the tldraw SDK, which is under the [tldraw licence](https://github.com/tldraw/tldraw/blob/main/LICENSE.md),
not an open-source one. The build is for personal use; do not redistribute it. The bundle is not
committed.
