# Forma

**A little more possible.**

Forma is a local-first, framework-free vector design editor with a Sketch-inspired
workspace, a retained WebGPU rendering path and a functional Canvas 2D fallback.
The included **Roam** design has 136 editable layers, two linked prototype screens,
a brand-foundations board, local symbol instances and an additional empty page.
Its illustrations are editable vector layers—not background screenshots.

This is a working **0.1.0** implementation, not a claim of complete Sketch parity
or lossless `.sketch` compatibility. There are no runtime packages, CDN requests,
external fonts, API keys, analytics, accounts or server-side components.

## Run

```sh
cd forma
python3 -m http.server 8080
```

Open **http://localhost:8080**. A static HTTPS host also works. The editor checks
for a WebGPU adapter and falls back automatically when one is unavailable.
The backend is always visible in the bottom status bar; clicking it opens
renderer diagnostics. Add `?renderer=canvas` to explicitly select the fallback.

There are two equivalent distributions:

* `index.html`, `style.css` and `src/`: the editable ES-module source tree.
* `forma.html`: the generated, self-contained editor. No adjacent assets are
  needed. Serve it over localhost/HTTPS for the browser's GPU and storage APIs.

The standalone HTML can also be opened directly where the browser permits it;
file-origin storage and GPU availability depend on that browser. An unavailable
storage origin is clearly labeled **Temporary session**. Save a `.forma` copy
before leaving a temporary session. An HTML preview in a chat or file viewer is
not equivalent to running the application in a browser tab.

No install or build is needed to run the checked-in files. Regenerate the
standalone distribution after changing the source:

```sh
node build.mjs
```

## What works

| Area | Implemented behavior |
| --- | --- |
| Workspace | Sketch-style toolbar, pages/layer tree, contextual inspector, rulers, floating tool palette, menus, searchable command palette, light/dark themes and narrow-screen sidebar drawers. |
| Documents | Multiple pages, rename/add/delete, arbitrary nested groups, visibility, locking, drag layer reordering, Alt-drop nesting, selection roots, duplicate, copy/cut/paste and local autosave. |
| Creation | Frames and frame presets; rectangles, rounded rectangles, ellipses, lines, stars, polygons, cubic Bézier paths, text and embedded raster images. |
| Selection | Nested hit testing, Shift multi-selection, drag marquee, move, eight resize handles, rotation handle, constrained proportions, flips, keyboard nudging and selection bounds. |
| Vector editing | Click/drag pen construction, open/closed paths, direct anchor and tangent-handle editing, point deletion/insertion and corner/curve toggling. |
| Geometry | Union, subtract, intersect and XOR; concave fills and even-odd compound paths; groups and rounded-rectangle clipping. Boolean results become editable compound contours. |
| Appearance | Solid colors, two-stop linear gradients, rounded corners, centered strokes, opacity, primitive/text drop shadows and six blend choices. |
| Typography | System font-family selection, size, weight, italic style, multiline editing, wrapping, left/center/right alignment, line height and tracking. Text remains text in the document. |
| Layout | Align edges/centers, distribute, horizontal/vertical stacks, gap, padding, alignment, primary-axis hug and basic horizontal parent-resize constraints. |
| Symbols | Create local masters, insert linked instances, synchronize master edits automatically, retain supported per-instance style/text overrides and detach instances. |
| Prototypes | Link layers to frames, play the actual document, click through hotspots, navigate back and use simple dissolve transitions. |
| Interchange | Native `.forma` save/open, sanitized editable SVG import, SVG export, PNG export at selectable scale, PNG/JPEG/WebP/GIF image import and a bounded `.sketch` importer. |
| Handoff | CSS property snippets for selected layers and vector/raster export of selections or a whole page. |
| History | Atomic gesture/property transactions, cancel, undo and redo, including boolean operations and master/instance synchronization. |

A command changes document state or invokes a real action. Buttons such as Export,
Preview, Create Symbol and the inspector fields are not static visual placeholders.
The macOS-style traffic-light dots are decorative browser chrome, not native window
controls. There is no fake cloud collaboration, account system or published-share UI.

### Useful interactions

`V` selects; `H` chooses the hand tool; holding Space temporarily pans. `A`, `R`,
`O`, `L`, `P` and `T` create frames, rectangles, ovals, lines, paths and text.
Ctrl/Cmd-wheel zooms about the pointer. `1` fits the page, `2` fits the selection,
and `0` returns to 100%. `+` / `-` also zoom.

Double-click text to edit it. Ctrl/Cmd+Enter commits text; Escape cancels. Double-click
a path, or select it and press Enter, to edit vector anchors. Drag while placing a
pen point to create tangent handles; click the first point to close the path, or
press Enter to finish an open path. Press Enter again to leave direct-edit mode.

Ctrl/Cmd+Z undoes; Shift+Ctrl/Cmd+Z redoes. Ctrl/Cmd+D duplicates; Ctrl/Cmd+G groups;
Shift+Ctrl/Cmd+G ungroups. Ctrl/Cmd+K opens the command palette. Arrow keys nudge by
one document unit; Shift+Arrow nudges by ten. Drag out from a ruler to create a guide.
The help dialog contains the full shortcut list.

On a narrow screen, the Layers and Properties buttons in the canvas heading open
side drawers. Use the hand tool and zoom controls for navigation. This build is
optimized for desktop pointer/keyboard editing; it does not implement native-style
multi-touch pinch/rotate gestures.

## Rendering architecture

### Separation of responsibilities

```
src/geometry.js   affine math, paths, hit tests, tessellation, booleans
src/document.js   document graph, index, transactions, layout, symbols, storage
src/renderer.js   WGSL pipelines, GPU resources and shared Canvas painter
src/io.js         Forma, SVG, PNG, embedded images and Sketch ZIP/JSON
src/icons.js      original inline SVG toolbar icons
src/app.js        DOM chrome, inspector, commands and canvas interactions
```

The editor is plain JavaScript ES modules. There is no React, canvas scene library,
WebGL compatibility wrapper or WASM renderer hidden underneath it. The lightweight
build script concatenates the modules and inlines the stylesheet into one HTML file.

### WebGPU path

The renderer requests a high-performance adapter and creates separate quad and
triangle-mesh pipelines with 4× multisampling and premultiplied-alpha compositing.
Rounded rectangles, ellipses, fills, borders and primitive shadows use analytic
WGSL distance functions. Paths are tessellated into cached local-space vertex buffers.
Consecutive compatible quads are instanced without changing painter's order.

Each draw item occupies **144 bytes** in a read-only storage buffer: affine
transform, dimensions, two fill colors, stroke, shape configuration, opacity,
gradient parameters, clip range and padded draw bounds. Ancestor clip records
occupy **48 bytes** and contain inverse transforms, bounds and corner radius.
The camera is a separate **32-byte** uniform block. Capacity grows geometrically;
bind groups are invalidated when their backing storage buffer changes.

Text is shaped and rasterized by the browser into per-layer textures. Images use
cached textures as well. This preserves real editable text without claiming a
custom font-shaping engine or GPU glyph atlas. Raster cache resolution uses zoom
buckets and a texture-size ceiling. Textures and meshes for inactive layers are
eventually evicted. There is no global VRAM-budget manager in this version.

Scene traversal culls against the viewport and clips descendants. Cached geometry
is reused until its geometry key changes. Pointer changes invalidate the scene;
when the editor is idle, it does not continuously submit GPU frames. The animation
loop still checks whether work is necessary.

The overlay (selection, rulers, guides and handles) is a separate Canvas 2D surface.
Non-normal artistic blend modes deliberately composite the viewport with the shared
Canvas painter and upload that result. This is a hybrid renderer, not a claim that
every effect executes entirely in WGSL.

A lost or unavailable WebGPU device switches the document surface to Canvas 2D.
PNG export and prototype playback use the same CPU painter. SVG export retains
vector primitives and native Bézier control points where possible.

**Performance numbers are not fabricated.** The diagnostics show CPU scene
preparation/submission duration, submitted draw-call counts and retained texture
bytes. They do not measure GPU execution time and are not an FPS benchmark.

### Editing model

Nodes live in local coordinates. The document index derives each node's parent,
ancestor chain and world transform. Selection transformations operate on selected
roots, preventing both a selected group and its selected child from moving twice.
Each gesture begins a snapshot transaction, emits interactive changes, and commits
once on release. History is bounded by 80 snapshots and approximately 24 million
serialized characters, while retaining at least one undo step.

Symbol children keep source IDs separate from their instance IDs. Commit-time
synchronization detects master edits, preserves instance dimensions and reapplies
supported overrides. Duplicate identities do not erase those source references.
Complex nested-library symbol override semantics are not implemented.

## File compatibility and limits

`.forma` is the native editable JSON document format. It includes pages, layers,
styles, prototype links and embedded images. Use it to preserve this editor's
state; PNG is a raster export, and SVG is an interchange/export format.

The `.sketch` importer reads ZIP central directories and stored/deflated entries,
then maps supported page/layer JSON into the native model. Supported mappings
include common artboards, groups, basic geometry, first fill/border, a two-stop
gradient, ordinary text, basic symbols and embedded bitmap layers. Import warnings
are shown for unsupported constructs. This was tested with a **synthetic compressed
Sketch fixture**, not a representative corpus of production Sketch files.

It is **not** a lossless Sketch round-trip implementation. Missing areas include
multiple paints, arbitrary masking chains, complex boolean shape groups,
external-library symbols, rich per-range text attributes and many advanced effects.
There is no `.sketch` export. SVG import samples geometry into editable paths;
complex subpaths, original hierarchy, masks, filters and rich text are not fully
preserved. System font availability can change text measurements.

Other intentional boundaries: no real-time collaboration, plugins, version server,
full shared-style/variable system, native Sketch constraint solver, automatic layout
reflow after every possible child mutation, isolated-opacity group compositing,
arbitrary vector masks or comprehensive accessibility semantics for canvas content.
Clipping in the GPU path is rectangular/rounded-rectangular. Shadows are approximate
and may differ between raster, SVG and GPU paths. The DOM controls have labels and
keyboard access, but the canvas is not a screen-reader-equivalent document editor.

The geometry implementation uses bounded, quadratic segment preprocessing rather
than claiming industrial CAD-grade topology. It is intended for ordinary UI/vector
artwork, not huge imported technical drawings. Nearly coincident edges and extremely
small details can require additional numerical robustness work. Boolean paths use
an even-odd fill rule and produce contour geometry, not live nondestructive operators.

The importer bounds documents to 100 pages, 30,000 nodes and nesting depth 50. Sketch
archives are limited to 32 MB compressed, 128 MB expanded and 32 MB per entry; SVG
source is limited to 8 MB. PNG export is bounded to 64 megapixels and 16,384 pixels
per side. Native image references must be embedded raster data URLs. Sanitization
and bounds reduce attack surface but are not a formal security audit of untrusted
artwork. Make a backup before relying on any new editor for important work.

## Verification

```sh
# No Node dependencies are required.
node --test tests/*.test.js

# Browser tests use Python Playwright as a development-only dependency.
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/browser-smoke.py
```

Use `CHROMIUM_PATH` to select an installed Chromium. Set
`FORMA_TEST_URL=http://localhost:8080` to test a real origin instead of loading the
standalone artifact with Playwright's `set_content`. For a real adapter test, remove
the software-renderer launch arguments in the test and select an appropriate
headful/hardware environment. The test report records which backend actually ran.

The delivered verification run passed:

* **30 geometry/document tests:** affine transforms, concave/hole/self-intersecting
  fills, four boolean operations, Bezier subdivision, hit testing, history, grouping,
  stacks, validation, symbol synchronization and retained overrides.
* **5 renderer command tests with a mock device:** storage packing, batching,
  culling, clip inverse transforms, mesh invalidation, buffer growth and device loss.
  These do **not** execute or validate WGSL on a GPU.
* **33 real-browser assertions:** drawing and moving, inspector changes, undo/redo,
  booleans, text, pen handles, sanitized SVG, PNG decoding, native and compressed
  Sketch fixtures, symbol changes, prototype navigation, command search, themes,
  mobile canvas dimensions and responsive sidebar access.

The browser environment used for delivery blocked navigation to a secure test
origin. Therefore its real-browser run used **Canvas 2D fallback**. Hardware WebGPU
execution, driver shader validation, real-origin IndexedDB persistence, browser
interoperability and large-document performance remain **unverified**. No passing
mock or fallback test is presented as proof of those behaviors.

Reports are in `tests/unit-results.tap` and `tests/browser-results.json`. Screenshots
in `tests/` are from the actual running editor, not design mockups.

## Reference and licensing

Interface and compatibility references:

- Sketch documentation: https://www.sketch.com/docs/
- Sketch file format: https://developer.sketch.com/file-format/
- WebGPU specification: https://www.w3.org/TR/webgpu/
- WGSL specification: https://www.w3.org/TR/WGSL/

The implementation, icons and Roam example are provided under the included MIT
license. No proprietary Sketch assets or bundled font files are included. Forma is
an independent project; it is not affiliated with or endorsed by Sketch.
