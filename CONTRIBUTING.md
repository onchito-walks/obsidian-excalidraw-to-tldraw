# Contributing

Bug reports and pull requests are welcome.

- **Something converted badly?** Open an issue with the row for that drawing from `Excalidraw to tldraw report.md`, and the drawing if you can share it.
- **Code changes:** `npm install`, then `npm test` (converter, checked with tldraw's own file parser), `npm run build`, and `npm run e2e` (real Obsidian and the real tldraw plugin; needs xvfb). CI runs the tests and build on every pull request.
- **Style:** the source is typed with no `any`; the Obsidian directory scans every release for that.
- **Scope:** conversion itself is tldraw's own importer. Fixes that belong there should go to tldraw; this plugin only restores what the importer drops.
