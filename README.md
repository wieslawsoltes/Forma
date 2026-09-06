# Forma

**A local-first, Sketch-style vector design editor in plain HTML, CSS, and JavaScript.**

[**Open the live editor**](https://wieslawsoltes.github.io/Forma/) · [CI and deployment](https://github.com/wieslawsoltes/Forma/actions/workflows/pages.yml) · [Architecture and implementation notes](docs/IMPLEMENTATION.md)

Forma contains an editable design document, a retained WebGPU rendering path, a Canvas 2D fallback, and a familiar three-column design workspace. The included Roam project has 136 editable layers, desktop and mobile frames, symbols, and prototype links. It has no runtime dependencies, accounts, API keys, analytics, or CDN assets.

## Run locally

Requires Node.js 22 or later for building and unit tests, plus Python 3 for the development server.

```bash
git clone https://github.com/wieslawsoltes/Forma.git
cd Forma
npm test
npm run build
npm start
```

Open **http://localhost:8080** for the modular application or **http://localhost:8080/forma.html** for the standalone build. The live Pages site serves the standalone build as its root page. Rebuild and commit `forma.html` alongside changes to the source modules, CSS, or source HTML; CI checks that the generated file is current.

## Editing capabilities

- Frames, shapes, editable text, images, cubic Bezier paths, direct anchor editing, compound paths, and four boolean operations.
- Selection, marquee, move/resize/rotate/flip, grouping, ordering, alignment, distribution, undo/redo, keyboard controls, and inspector editing.
- Fills, gradients, strokes, shadows, opacity, typography, basic stacks and constraints, symbol masters and linked instances.
- Prototype links and preview, native `.forma` save/open, partial `.sketch` import, sanitized SVG import, SVG/PNG export, local autosave, and light/dark themes.

## Source layout

| Path | Purpose |
| --- | --- |
| `index.html`, `style.css` | Modular editor shell and design tokens |
| `src/app.js` | Interaction controller, inspector, commands, and sample project |
| `src/document.js` | Document schema, transactions/history, layout, symbols, and persistence |
| `src/geometry.js` | Geometry, transforms, paths, tessellation, and boolean operations |
| `src/renderer.js` | WebGPU pipeline, render caches, and Canvas fallback |
| `src/io.js` | File import, export, and interchange |
| `src/icons.js` | Original vector interface icons |
| `build.mjs`, `forma.html` | Dependency-free bundler and generated standalone application |
| `examples/roam.forma` | Editable example document |
| `tests/` | Unit tests, browser interaction suite, and historical delivery reports |
| `docs/IMPLEMENTATION.md` | Original detailed implementation and capability boundaries |

## Verification

`npm test` runs 30 geometry/document tests and 5 mocked WebGPU renderer-command tests. These mocks do not execute WGSL or validate hardware GPU behavior.

The browser suite exercises 33 editor assertions. Run it through an HTTP origin:

```bash
python3 -m pip install playwright==1.56.0
python3 -m playwright install chromium
# Start npm start in another terminal, then:
FORMA_TEST_URL='http://localhost:8080/forma.html?renderer=canvas' python3 tests/browser-smoke.py
```

CI runs both suites, builds the standalone application, and records fresh desktop/mobile screenshots and a JSON report in the **browser-verification** Actions artifact. The reports committed under `tests/` describe the original delivery run; current run results are in Actions. The historical screenshots referenced in the original implementation notes are not checked into this repository.

## GitHub Pages

Pushes to `main` run the unit and real-origin browser tests before publishing. Pull requests run the same validation without deploying. Manual deployment is available through **Actions → Deploy Forma to GitHub Pages → Run workflow**.

The workflow publishes only the standalone application, downloadable standalone copy, example document, and build metadata. It verifies that the live HTTPS response exactly matches the built HTML's SHA-256. Tests/build have read-only repository access; only the deployment job receives Pages write and OIDC permissions. No personal access token or deployment secret is required.

## Boundaries

This is a substantial working v0.1, not full Sketch parity. Sketch import is a compatibility subset, not lossless round-tripping. Collaboration, Sketch plugins, rich per-range text styling, arbitrary vector masks, and complete Sketch layout semantics are not implemented. Hardware WebGPU execution, driver interoperability, and large-document performance remain unverified; the browser CI explicitly uses Canvas 2D. The renderer is hybrid: browser-shaped cached text textures and CPU-composited non-normal blend modes coexist with GPU primitives and tessellated paths.

Documents stay in the browser unless explicitly downloaded or exported. Keep `.forma` backups of important work; browser storage can be cleared.

## License

[MIT](LICENSE). Forma is an independent implementation, not affiliated with or endorsed by Sketch. No proprietary Sketch assets or bundled font files are included.
