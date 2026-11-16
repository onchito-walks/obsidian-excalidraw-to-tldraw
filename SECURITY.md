# Security

## What Tracing Paper does and does not do

- It reads Excalidraw drawings in your vault and writes new tldraw files next to them. It never changes, moves or deletes an original, and never overwrites an existing file.
- It makes no network requests and collects nothing.
- It ships no copy of tldraw: it uses the tldraw plugin you already have installed.
- Drawings are treated as untrusted input. Links other than web and mail addresses are dropped, and names taken from a drawing cannot steer where a file is written.

## Reporting a problem

Please report a vulnerability privately through
[GitHub's private reporting](https://github.com/onchito-walks/tracing-paper/security/advisories/new),
not in a public issue. Include the drawing that triggers it if you can.

Only the latest release is supported.
