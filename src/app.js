/**
 * Framework-free editor controller. DOM chrome is separate from the document
 * canvas and its selection/guides overlay. Pointer gestures begin one document
 * transaction, emit interactive invalidations, then commit or cancel. Native
 * Canvas text shaping is shared by rendering, inspector previews and exports.
 */
import { I, clamp, mul, matrix, inverse, point, corners, bounds, unionBounds, intersects, contains, flatten, hitNode, booleanRings, path2D } from './geometry.js';
import { node, text, uid, clone, resetIds, DocumentStore, Persistence, demoDocument, validateDocument } from './document.js';
import { Renderer, paintTree, font } from './renderer.js';
import { icon } from './icons.js';
import { escapeXML as esc, download, readDataURL, exportSVG, exportPNG, exportNodes, importSVG, importSketch } from './io.js';
function readPreference(k) {
    try {
        return localStorage.getItem(k);
    }
    catch {
        return null;
    }
}
function writePreference(k, v) {
    try {
        localStorage.setItem(k, v);
    }
    catch {
    }
}
const $ = (s, root = document) => root.querySelector(s), $$ = (s, root = document) => [...root.querySelectorAll(s)];
const stage = $('#stage'), overlay = $('#overlay-canvas'), oc = overlay.getContext('2d'), inspector = $('#inspector');
const camera = { x: 60, y: 70, zoom: .7 };
let store, renderer, persistence, dirty = true, uiDirty = true, tool = 'select', space = false, drag = null, hover = null, vectorId = null, activePoint = -1, penId = null, clipboard = null, inspectorTab = 'design', leftTab = 'layers', showRulers = true, showGrid = false, snapping = true, showGuides = true, guides = [], marquee = null, toastTimer, saveTimer, dragLayerId = null, previewId = null, previewStack = [], lastSaveRevision = -1, saveRunning = false, saveAgain = false;
let expanded = new Set(), userGuides = [], width = 1, height = 1, theme = readPreference('forma-theme') || 'light', textEditing = null, selectionSignature = '', commandIndex = 0, tipTimer;
const pointers = new Map();
document.documentElement.dataset.theme = theme;
function icons(root = document) {
    $$('[data-icon]', root).forEach(e => {
        e.innerHTML = icon(e.dataset.icon);
        e.removeAttribute('data-icon');
    });
}
function toast(message) {
    $('#toast').textContent = message;
    $('#toast').classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 3500);
}
function fail(e) {
    console.error(e);
    toast(e?.message || String(e));
}
function invalidate() {
    dirty = true;
}
function allUI() {
    uiDirty = true;
    dirty = true;
}
function world(p) {
    return { x: (p.x - camera.x) / camera.zoom, y: (p.y - camera.y) / camera.zoom };
}
function screen(p) {
    return { x: p.x * camera.zoom + camera.x, y: p.y * camera.zoom + camera.y };
}
function eventPoint(e) {
    const r = stage.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
}
function expandTo(id) {
    for (const a of store.info(id)?.ancestry || [])
        expanded.add(a.id);
}
function select(ids) {
    $('.workspace').classList.remove('show-layers');
    store.select(ids);
    ids.forEach(expandTo);
    uiDirty = true;
    dirty = true;
}
function setTool(next) {
    if (penId && next !== 'pen')
        finishPen(false);
    if (textEditing)
        finishText();
    vectorId = null;
    activePoint = -1;
    tool = next;
    $$('[data-tool]').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    stage.style.cursor = tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';
    const hints = { select: 'V  Select  ·  Space  Pan  ·  ⌘ / Ctrl + wheel  Zoom', hand: 'Drag to pan  ·  Scroll to move around', frame: 'Drag to create a frame  ·  A', rect: 'Drag to draw  ·  Shift for square  ·  Alt from center', ellipse: 'Drag to draw  ·  Shift for circle', line: 'Drag to draw a line  ·  Shift snaps to 45°', pen: 'Click for corners · Drag for curves · Click first point to close · Enter to finish', text: 'Click to add text  ·  Double-click existing text to edit', star: 'Drag to draw a star', polygon: 'Drag to draw a polygon' };
    $('#tool-hint').textContent = hints[tool] || '';
    dirty = true;
    renderInspector();
}
function zoomAt(factor, p = { x: width / 2, y: height / 2 }) {
    const w = world(p);
    camera.zoom = clamp(camera.zoom * factor, .02, 32);
    camera.x = p.x - w.x * camera.zoom;
    camera.y = p.y - w.y * camera.zoom;
    dirty = true;
}
function fitBox(b, padding = 66) {
    if (!b || !Number.isFinite(b.x) || !b.w && !b.h)
        return;
    camera.zoom = clamp(Math.min((width - padding * 2) / Math.max(b.w, 1), (height - padding * 2 - 35) / Math.max(b.h, 1)), .02, 4);
    camera.x = (width - b.w * camera.zoom) / 2 - b.x * camera.zoom;
    camera.y = (height - b.h * camera.zoom) / 2 - b.y * camera.zoom - 10;
    dirty = true;
}
function fitAll() {
    fitBox(store.bounds(store.page.nodes.map(n => n.id)), 65);
}
function fitInitial() {
    const frames = store.page.nodes.filter(n => n.type === 'frame');
    fitBox(store.bounds((frames.length ? frames.slice(0, 2) : store.page.nodes).map(n => n.id)), 53);
}
function findHit(p, { deep = true, skipFrames = false } = {}) {
    function visit(ns, parent = I, locked = false) {
        for (let i = ns.length - 1; i >= 0; i--) {
            const n = ns[i];
            if (n.visible === false || n.locked || locked)
                continue;
            const m = mul(parent, matrix(n)), q = point(inverse(m), p), insideClip = contains({ x: 0, y: 0, w: n.w, h: n.h }, q);
            if (n.children && (!n.clip || insideClip)) {
                let child = visit(n.children, m);
                if (child)
                    return deep ? child : n;
            }
            if (n.type === 'frame' && skipFrames)
                continue;
            if (hitNode(n, q, 4 / camera.zoom))
                return n;
        }
        return null;
    }
    return visit(store.page.nodes);
}
function resizeCanvas() {
    const r = stage.getBoundingClientRect();
    width = Math.max(1, r.width);
    height = Math.max(1, r.height);
    renderer.resize(width, height);
    let dpr = Math.min(devicePixelRatio || 1, 2);
    overlay.width = Math.round(width * dpr);
    overlay.height = Math.round(height * dpr);
    dirty = true;
}
function roundedRect(c, x, y, w, h, r) {
    c.beginPath();
    c.roundRect(x, y, w, h, r);
}
function selectionPoints() {
    const ns = store.roots();
    if (ns.length === 1) {
        const n = ns[0];
        return corners(n, store.info(n.id).world).map(screen);
    }
    if (ns.length > 1) {
        const b = store.bounds(ns.map(n => n.id));
        return [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y }, { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h }].map(screen);
    }
    return [];
}
function handles() {
    const p = selectionPoints();
    if (!p.length)
        return [];
    const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
    let h = [{ ...p[0], name: 'nw' }, { ...mid(p[0], p[1]), name: 'n' }, { ...p[1], name: 'ne' }, { ...mid(p[1], p[2]), name: 'e' }, { ...p[2], name: 'se' }, { ...mid(p[2], p[3]), name: 's' }, { ...p[3], name: 'sw' }, { ...mid(p[3], p[0]), name: 'w' }];
    let top = h[1], center = mid(p[0], p[2]), l = Math.hypot(top.x - center.x, top.y - center.y) || 1;
    h.push({ x: top.x + (top.x - center.x) / l * 24, y: top.y + (top.y - center.y) / l * 24, name: 'rotate' });
    return h;
}
function handleHit(p) {
    if (vectorId || store.roots().some(n => n.locked))
        return null;
    return handles().find(h => Math.hypot(h.x - p.x, h.y - p.y) < 7);
}
function drawPolygon(ps, color, lineWidth = 1) {
    if (!ps.length)
        return;
    oc.beginPath();
    ps.forEach((p, i) => i ? oc.lineTo(p.x, p.y) : oc.moveTo(p.x, p.y));
    oc.closePath();
    oc.strokeStyle = color;
    oc.lineWidth = lineWidth;
    oc.stroke();
}
function drawOverlay() {
    let dpr = Math.min(devicePixelRatio || 1, 2);
    oc.setTransform(dpr, 0, 0, dpr, 0, 0);
    oc.clearRect(0, 0, width, height);
    const dark = theme === 'dark';
    if (showGrid && camera.zoom > .15) {
        let step = 8 * camera.zoom;
        if (step < 5)
            step *= 4;
        oc.fillStyle = dark ? '#62667755' : '#77809344';
        for (let x = ((camera.x % step) + step) % step; x < width; x += step)
            for (let y = ((camera.y % step) + step) % step; y < height; y += step)
                oc.fillRect(x, y, 1, 1);
    }
    oc.font = '10px -apple-system,Arial';
    oc.fillStyle = dark ? '#9095A5' : '#858996';
    for (const n of store.page.nodes) {
        if (n.type === 'frame' && n.visible !== false) {
            let p = screen(point(store.info(n.id).world, { x: 0, y: 0 }));
            if (p.x < width && p.y > -30 && p.y < height + 30)
                oc.fillText(n.name, p.x, p.y - 12);
        }
    }
    if (showGuides) {
        for (const g of store.page.guides || []) {
            const s = screen({ x: g.value, y: g.value });
            oc.beginPath();
            oc.strokeStyle = '#AC80D0';
            oc.lineWidth = .75;
            if (g.axis === 'x') {
                oc.moveTo(s.x, 0);
                oc.lineTo(s.x, height);
            }
            else {
                oc.moveTo(0, s.y);
                oc.lineTo(width, s.y);
            }
            oc.stroke();
        }
    }
    if (hover && !store.selected.has(hover.id) && !drag && tool === 'select' && !vectorId) {
        const info = store.info(hover.id);
        if (info)
            drawPolygon(corners(hover, info.world).map(screen), '#4387F5A0', 1);
    }
    const p = selectionPoints();
    if (p.length && !textEditing && !vectorId) {
        drawPolygon(p, '#4387F5', 1);
        let hs = handles();
        if (store.roots().length === 1) {
            oc.beginPath();
            oc.moveTo(hs[1].x, hs[1].y);
            oc.lineTo(hs[8].x, hs[8].y);
            oc.strokeStyle = '#4387F5';
            oc.stroke();
        }
        for (const h of hs) {
            if (h.name === 'rotate' && store.roots().length > 1)
                continue;
            oc.fillStyle = '#FFFFFF';
            oc.strokeStyle = '#4387F5';
            if (h.name === 'rotate') {
                oc.beginPath();
                oc.arc(h.x, h.y, 3, 0, Math.PI * 2);
            }
            else {
                oc.beginPath();
                oc.rect(h.x - 3, h.y - 3, 6, 6);
            }
            oc.fill();
            oc.stroke();
        }
        const b = store.bounds();
        if (b.w > 0) {
            let mid = { x: (p[2].x + p[3].x) / 2, y: Math.max(p[2].y, p[3].y) + 15 }, label = `${Math.round(b.w)} × ${Math.round(b.h)}`;
            oc.font = '9px Arial';
            let tw = oc.measureText(label).width;
            oc.fillStyle = '#4387F5';
            roundedRect(oc, mid.x - tw / 2 - 6, mid.y - 3, tw + 12, 17, 3);
            oc.fill();
            oc.fillStyle = 'white';
            oc.fillText(label, mid.x - tw / 2, mid.y + 9);
        }
    }
    if (vectorId || penId) {
        const id = vectorId || penId, n = store.get(id), info = store.info(id);
        if (n && info) {
            oc.save();
            oc.translate(camera.x, camera.y);
            oc.scale(camera.zoom, camera.zoom);
            oc.transform(...info.world);
            oc.strokeStyle = '#4387F5';
            oc.lineWidth = 1 / camera.zoom;
            oc.stroke(path2D(n));
            oc.restore();
            (n.points || []).forEach((p, i) => {
                const s = screen(point(info.world, p));
                for (const k of ['in', 'out'])
                    if (p[k]) {
                        const h = screen(point(info.world, p[k]));
                        oc.beginPath();
                        oc.moveTo(s.x, s.y);
                        oc.lineTo(h.x, h.y);
                        oc.strokeStyle = '#4387F5';
                        oc.stroke();
                        oc.beginPath();
                        oc.arc(h.x, h.y, 3, 0, Math.PI * 2);
                        oc.fillStyle = 'white';
                        oc.fill();
                        oc.stroke();
                    }
                oc.beginPath();
                oc.rect(s.x - 3, s.y - 3, 6, 6);
                oc.fillStyle = i === activePoint ? '#4387F5' : '#FFFFFF';
                oc.fill();
                oc.strokeStyle = '#4387F5';
                oc.stroke();
            });
        }
    }
    for (const g of guides) {
        oc.beginPath();
        oc.strokeStyle = '#E16FB2';
        oc.lineWidth = .8;
        if (g.axis === 'x') {
            let x = screen({ x: g.value, y: 0 }).x;
            oc.moveTo(x, 0);
            oc.lineTo(x, height);
        }
        else {
            let y = screen({ x: 0, y: g.value }).y;
            oc.moveTo(0, y);
            oc.lineTo(width, y);
        }
        oc.stroke();
    }
    if (marquee) {
        oc.fillStyle = '#4387F517';
        oc.strokeStyle = '#4387F5';
        oc.lineWidth = 1;
        oc.fillRect(marquee.x, marquee.y, marquee.w, marquee.h);
        oc.strokeRect(marquee.x, marquee.y, marquee.w, marquee.h);
    }
    if (showRulers) {
        oc.fillStyle = dark ? '#282B31' : '#F1F1F4';
        oc.fillRect(0, 0, width, 19);
        oc.fillRect(0, 0, 19, height);
        oc.strokeStyle = dark ? '#3C3F48' : '#D2D4DB';
        oc.lineWidth = .7;
        oc.beginPath();
        oc.moveTo(0, 19);
        oc.lineTo(width, 19);
        oc.moveTo(19, 0);
        oc.lineTo(19, height);
        oc.stroke();
        oc.font = '8px Arial';
        oc.fillStyle = dark ? '#A1A6B5' : '#8A8F9D';
        let step = 100;
        while (step * camera.zoom < 60)
            step *= 2;
        while (step * camera.zoom > 180)
            step /= 2;
        for (let axis of ['x', 'y']) {
            let max = axis === 'x' ? width : height, start = Math.floor((-camera[axis] / camera.zoom) / step) * step;
            for (let v = start; v * camera.zoom + camera[axis] < max; v += step) {
                let pos = v * camera.zoom + camera[axis];
                if (pos < 19)
                    continue;
                oc.beginPath();
                if (axis === 'x') {
                    oc.moveTo(pos, 14);
                    oc.lineTo(pos, 19);
                    oc.fillText(String(Math.round(v)), pos + 3, 11);
                    for (let k = 1; k < 5; k++) {
                        let p = pos + step * camera.zoom * k / 5;
                        oc.moveTo(p, 17);
                        oc.lineTo(p, 19);
                    }
                }
                else {
                    oc.moveTo(14, pos);
                    oc.lineTo(19, pos);
                    oc.save();
                    oc.translate(10, pos + 3);
                    oc.rotate(-Math.PI / 2);
                    oc.fillText(String(Math.round(v)), 0, 0);
                    oc.restore();
                }
                oc.stroke();
            }
        }
        oc.fillStyle = dark ? '#282B31' : '#F1F1F4';
        oc.fillRect(0, 0, 18, 18);
        oc.fillStyle = '#9CA1AC';
        oc.fillText('↗', 4, 12);
    }
}
function renderLayers() {
    const current = store.page;
    $('#pages').innerHTML = store.doc.pages.map(p => `<button class="page-row ${p.id === current.id ? 'active' : ''}" data-page="${esc(p.id)}" title="Double-click to rename">${icon('page')}<span>${esc(p.name)}</span><span class="page-count">${p.nodes.length}</span></button>`).join('');
    const filter = $('#layer-search').value.toLowerCase();
    const tree = (nodes, depth = 0) => [...nodes].reverse().map(n => {
        const match = !filter || n.name.toLowerCase().includes(filter), has = n.children?.length, desc = has && n.children.some(c => JSON.stringify(c).toLowerCase().includes(filter));
        if (filter && !match && !desc)
            return '';
        const open = expanded.has(n.id) || !!filter;
        return `<div class="layer-row ${store.selected.has(n.id) ? 'selected' : ''} ${n.visible === false ? 'layer-hidden' : ''}" role="treeitem" aria-selected="${store.selected.has(n.id)}" ${has ? `aria-expanded="${open}"` : ''} data-layer="${esc(n.id)}" draggable="true" style="padding-left:${7 + depth * 14}px"><button class="tree-toggle ${open ? 'open' : ''}" data-toggle="${esc(n.id)}" title="Expand layer">${has ? icon('chevron') : ''}</button><span class="layer-icon ${['symbol', 'instance'].includes(n.type) ? 'symbol' : ''}">${icon(layerIcon(n))}</span><span class="layer-name">${esc(n.name)}</span><button class="layer-action ${n.locked ? 'on' : ''}" data-lock="${esc(n.id)}" title="${n.locked ? 'Unlock' : 'Lock'} layer">${icon(n.locked ? 'lock' : 'unlock')}</button><button class="layer-action ${n.visible === false ? 'on' : ''}" data-visible="${esc(n.id)}" title="${n.visible === false ? 'Show' : 'Hide'} layer">${icon(n.visible === false ? 'eyeOff' : 'eye')}</button></div>${has && open ? tree(n.children, depth + 1) : ''}`;
    }).join('');
    $('#layer-tree').innerHTML = tree(current.nodes) || '<div class="empty-panel">Your next idea starts here.<br>Press A to add a frame.</div>';
}
const layerIcon = n => ({ frame: 'frame', text: 'text', path: 'pen', line: 'line', rect: 'rect', ellipse: 'ellipse', star: 'star', polygon: 'polygon', group: 'group', symbol: 'component', instance: 'diamond', image: 'image' }[n.type] || 'rect');
function prop(label, key, value, unit = '', type = 'number') {
    return `<label class="property"><span>${label}</span><input data-prop="${key}" type="${type}" value="${type === 'number' ? Math.round((value || 0) * 100) / 100 : esc(value || '')}" aria-label="${key}" ${type === 'number' ? 'step="any"' : ''}>${unit ? `<span class="unit">${unit}</span>` : ''}</label>`;
}
function selectProp(key, value, options) {
    return `<select class="inspector-select" data-prop="${key}" aria-label="${key}">${options.map(o => {
        let [v, l] = Array.isArray(o) ? o : [o, o];
        return `<option value="${esc(v)}" ${String(value) === String(v) ? 'selected' : ''}>${esc(l)}</option>`;
    }).join('')}</select>`;
}
const section = (title, body, actions = '') => `<section class="inspector-section"><h3>${title}${actions}</h3>${body}</section>`;
function colorControls(n, key) {
    return `<div class="fill-row"><label class="color-well"><input type="color" data-color="${key}" value="${/^#[0-9a-f]{6}/i.test(n[key] || '') ? n[key].slice(0, 7) : '#FFFFFF'}" aria-label="${key} color"></label><input class="hex-input" data-prop="${key}" value="${esc(n[key] || 'none')}" aria-label="${key} hex color"><button class="icon-button small" data-action="${key === 'fill' ? 'toggleFill' : 'toggleStroke'}" title="Toggle ${key}">${icon(n[key] === 'none' ? 'eyeOff' : 'eye')}</button></div>`;
}
function renderInspector(force = false) {
    if (!store)
        return;
    if (!force && inspector.contains(document.activeElement) && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName))
        return;
    const selected = store.selection(), n = selected[0];
    $('#selection-count').textContent = selected.length ? `${selected.length} layer${selected.length === 1 ? '' : 's'} selected` : 'No selection';
    $$('[data-inspector]').forEach(b => b.classList.toggle('active', b.dataset.inspector === inspectorTab));
    if (inspectorTab === 'export') {
        const b = store.selected.size ? store.bounds() : store.bounds(store.page.nodes.map(n => n.id));
        inspector.innerHTML = section('Export your design', `<p class="description">${store.selected.size ? 'Selected layers' : 'Current page'} · ${Math.round(b.w)} × ${Math.round(b.h)} px</p><div class="input-row"><label>Format</label><select id="inspector-export-format" class="inspector-select"><option>PNG</option><option>SVG</option><option>Forma</option></select></div><div class="input-row"><label>Scale</label><select id="inspector-export-scale" class="inspector-select"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></div><button class="primary-button full-width" data-action="exportNow">${icon('download', 15)} Export ${store.selected.size ? 'selection' : 'page'}</button><div class="help-card"><b>Your work stays yours.</b>PNG and SVG exports are generated locally. Forma documents preserve editable layers, pages, symbols, and prototype links.</div>`);
        return;
    }
    if (inspectorTab === 'prototype') {
        const frames = store.page.nodes.filter(n => n.type === 'frame');
        inspector.innerHTML = section('Interaction', n ? `<p class="description">Make this layer a clickable hotspot.</p><div class="property-label">On click → Navigate to</div>${selectProp('link', n.link || '', [['', 'No destination'], ...frames.map(f => [f.id, f.name])])}<div class="property-label">Transition</div>${selectProp('transition', n.transition || 'instant', [['instant', 'Instant'], ['dissolve', 'Dissolve']])}<button class="primary-button full-width" data-action="preview">${icon('play', 15)} Play prototype</button><p class="section-note">Prototype interactions are saved in the document. Click linked layers in Preview to navigate.</p>` : `<p class="description">Select a layer to add a navigation interaction. Create two or more frames to build a flow.</p><button class="primary-button full-width" data-action="preview">Play prototype</button>`) + section('Frames', frames.map(f => `<button class="frame-preset" data-preview-frame="${esc(f.id)}"><span>${esc(f.name)}</span>${icon('play', 14)}</button>`).join('') || '<p class="description">No frames on this page.</p>');
        return;
    }
    if (!n) {
        let frameBody = [['Desktop', 1440, 1024], ['Laptop', 1280, 832], ['Mobile', 393, 852], ['Tablet', 834, 1194], ['Square', 1080, 1080]].map(([s, w, h]) => `<button class="frame-preset" data-preset="${w},${h},${s}"><span>${s}</span><span>${w} × ${h}</span></button>`).join('');
        inspector.innerHTML = section('Canvas', `<p class="description">A little space for your next big idea.</p><div class="row-between"><label class="check-label"><input type="checkbox" data-setting="grid" ${showGrid ? 'checked' : ''}> Pixel grid</label><label class="check-label"><input type="checkbox" data-setting="snap" ${snapping ? 'checked' : ''}> Smart guides</label></div><div class="row-between"><label class="check-label"><input type="checkbox" data-setting="rulers" ${showRulers ? 'checked' : ''}> Rulers</label><label class="check-label"><input type="checkbox" data-setting="guides" ${showGuides ? 'checked' : ''}> Guides</label></div>`) + section('Frame presets', frameBody) + section('Document colors', `<div class="swatch-row">${store.doc.colors.map(c => `<button class="swatch" style="background:${esc(c)}" data-swatch="${esc(c)}" title="${esc(c)}"></button>`).join('')}</div>`) + section('Make yourself at home', `<div class="help-card"><b>Start with a shortcut</b>R Rectangle · O Oval · T Text<br>P Vector · A Frame · V Select<br>Space Pan · ⌘K Commands</div><button class="secondary-button full-width" data-action="open">${icon('upload', 14)} Open a design</button>`);
        return;
    }
    const multi = selected.length > 1, align = ['alignLeft', 'alignCenter', 'alignRight', 'alignTop', 'alignMiddle', 'alignBottom'];
    let html = `<div class="align-row">${align.map(a => `<button data-action="${a}" title="${a.replace('align', 'Align ')}">${icon(a)}</button>`).join('')}</div>`;
    html += section('', `<div class="selection-title">${icon(layerIcon(n))}<input data-prop="name" value="${esc(multi ? `${selected.length} layers selected` : n.name)}" aria-label="Layer name" ${multi ? 'disabled' : ''}></div><div class="property-grid">${prop('X', 'x', n.x)}${prop('Y', 'y', n.y)}${prop('W', 'w', n.w)}${prop('H', 'h', n.h)}${prop('↻', 'rotation', n.rotation, '°')}${prop('◩', 'radius', n.radius || 0)}</div><div class="row-between"><label class="check-label"><input type="checkbox" data-prop="constrain" ${n.constrain ? 'checked' : ''}> Constrain proportions</label><div><button class="icon-button small" data-action="flipH" title="Flip horizontal">${icon('flipH')}</button><button class="icon-button small" data-action="flipV" title="Flip vertical">${icon('flipV')}</button></div></div>`);
    if (vectorId === n.id) {
        html += section('Vector editing', `<p class="description">${n.points?.length || 0} anchors · ${n.closed ? 'Closed' : 'Open'} path</p><div class="segmented"><button data-action="pointStraight">Straight</button><button data-action="pointCurve">Mirrored</button><button data-action="toggleClosed">${n.closed ? 'Open path' : 'Close path'}</button></div><button class="secondary-button full-width" data-action="donePath">Done editing</button><p class="section-note">Drag points or handles. Double-click an anchor to curve it. Delete removes the selected anchor.</p>`);
    }
    if (n.type === 'text') {
        html += section('Typography', `${selectProp('fontFamily', n.fontFamily || 'Arial', ['Arial', 'Georgia', 'Helvetica', 'Verdana', 'Times New Roman', 'Courier New', 'Trebuchet MS', 'system-ui'])}<div class="input-row">${selectProp('fontWeight', n.fontWeight || 400, [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra bold']])}${prop('', 'fontSize', n.fontSize || 16, 'px')}</div><div class="input-row">${prop('↕', 'lineHeight', n.lineHeight || 1.25)}${prop('↔', 'letterSpacing', n.letterSpacing || 0)}</div><div class="input-row segmented">${['left', 'center', 'right'].map(a => `<button data-text-align="${a}" class="${n.textAlign === a ? 'active' : ''}" title="Align ${a}">${icon(a === 'left' ? 'alignLeft' : a === 'center' ? 'alignCenter' : 'alignRight')}</button>`).join('')}<button data-action="italic" class="${n.fontStyle === 'italic' ? 'active' : ''}"><i>I</i></button></div><div class="property-label">Text content</div><textarea data-prop="text" class="inspector-textarea" aria-label="Text content">${esc(n.text || '')}</textarea>`);
    }
    html += section('Appearance', `<div class="input-row">${selectProp('blend', n.blend || 'normal', [['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'], ['darken', 'Darken'], ['lighten', 'Lighten']])}${prop('', 'opacityPercent', (n.opacity ?? 1) * 100, '%')}</div>`);
    if (n.type !== 'image')
        html += section(n.type === 'text' ? 'Text color' : 'Fills', colorControls(n, 'fill') + (n.type !== 'text' ? `<div class="row-between"><label class="check-label"><input type="checkbox" data-prop="gradient" ${n.gradient ? 'checked' : ''}> Linear gradient</label>${n.gradient ? `<label class="color-well"><input type="color" data-color="fill2" value="${n.fill2?.slice(0, 7) || '#FFFFFF'}" aria-label="Gradient end color"></label>` : ''}</div>${n.gradient ? `<div class="input-row">${prop('∠', 'gradientAngle', n.gradientAngle || 0, '°')}</div>` : ''}` : '') + `<div class="swatch-row">${store.doc.colors.map(c => `<button class="swatch" style="background:${esc(c)}" data-swatch="${esc(c)}" title="Apply ${esc(c)}"></button>`).join('')}<button class="icon-button small" data-action="saveColor" title="Save fill to document colors">${icon('plus', 14)}</button></div>`);
    if (!['text', 'image'].includes(n.type))
        html += section('Borders', colorControls(n, 'stroke') + `<div class="input-row"><label>Width</label>${prop('', 'strokeWidth', n.strokeWidth || 0, 'px')}</div>`);
    if (['rect', 'ellipse', 'frame', 'text'].includes(n.type))
        html += section('Shadows', `<label class="check-label"><input type="checkbox" data-prop="shadowEnabled" ${n.shadowEnabled ? 'checked' : ''}> Drop shadow</label>${n.shadowEnabled ? `<div class="property-grid" style="margin-top:11px">${prop('X', 'shadowX', n.shadowX || 0)}${prop('Y', 'shadowY', n.shadowY || 4)}${prop('B', 'shadowBlur', n.shadowBlur || 12)}${prop('α', 'shadowOpacity', n.shadowOpacity ?? .18)}</div>` : ''}`);
    if (n.children) {
        html += section('Layout', `${selectProp('layout', n.layout || 'none', [['none', 'Freeform'], ['horizontal', 'Horizontal stack'], ['vertical', 'Vertical stack']])}${n.layout && n.layout !== 'none' ? `<div class="property-grid" style="margin-top:9px">${prop('↔', 'gap', n.gap ?? 12)}${prop('□', 'padding', n.padding ?? 16)}</div><div class="input-row">${selectProp('align', n.align || 'start', [['start', 'Start'], ['center', 'Center'], ['end', 'End']])}</div><div class="row-between"><label class="check-label"><input type="checkbox" data-prop="hug" ${n.hug ? 'checked' : ''}> Hug contents</label></div>` : ''}<div class="row-between"><label class="check-label"><input type="checkbox" data-prop="clip" ${n.clip ? 'checked' : ''}> Clip contents</label></div>`);
    }
    if (store.info(n.id).parent)
        html += section('Resizing', selectProp('constraints', n.constraints || 'scale', [['scale', 'Scale with parent'], ['right', 'Pin to right'], ['center', 'Center horizontally'], ['stretch', 'Stretch horizontally']]));
    if (n.type === 'star' || n.type === 'polygon')
        html += section('Shape', `<div class="property-grid">${prop('N', 'sides', n.sides || 5)}${n.type === 'star' ? prop('↘', 'innerRadius', n.innerRadius || .45) : ''}</div>`);
    if (n.type === 'symbol')
        html += section('Symbol source', `<p class="description">Reusable symbol with linked instances.</p><button class="secondary-button full-width" data-action="insertInstance">Insert instance</button><button class="secondary-button full-width" data-action="syncSymbol">Update all instances</button>`);
    if (n.type === 'instance')
        html += section('Symbol instance', `<p class="description">Linked to ${esc(store.get(n.masterId)?.name || 'an unavailable source')}.</p><button class="secondary-button full-width" data-action="detachInstance">Detach from symbol</button>`);
    html += section('Export', `<button class="secondary-button full-width" data-action="export">${icon('download', 14)} Make exportable</button>`);
    inspector.innerHTML = html;
}
function renderAssets() {
    const symbols = [...store.index.values()].map(i => i.node).filter(n => n.type === 'symbol');
    $('#assets-panel').innerHTML = `<div class="section-label"><span>Local symbols</span><span>${symbols.length}</span></div>` + symbols.map(n => {
        let c = clone(n);
        c.x = 0;
        c.y = 0;
        return `<div class="asset-card" data-insert-symbol="${esc(n.id)}"><div class="asset-preview">${exportSVG([c], { x: 0, y: 0, w: n.w, h: n.h })}</div><div class="asset-name">${esc(n.name)}</div><p>Click to insert a linked instance</p></div>`;
    }).join('') + section('Document colors', `<div class="swatch-row">${store.doc.colors.map(c => `<button class="swatch" style="background:${esc(c)}" data-swatch="${esc(c)}" title="${esc(c)}"></button>`).join('')}</div>`) + section('Text styles', store.doc.textStyles.map((s, i) => `<button class="frame-preset" data-text-style="${i}"><span>${esc(s.name)}</span><span>Aa</span></button>`).join(''));
}
function renderUI() {
    renderLayers();
    renderInspector();
    if (leftTab === 'assets')
        renderAssets();
    $('#doc-name').textContent = store.doc.name;
    $('#page-name').textContent = store.page.name;
    $('#selection-crumb').textContent = store.selection().length === 1 ? store.selection()[0].name : store.selection().length ? `${store.selection().length} layers` : 'Canvas';
    $('#empty-state').hidden = store.page.nodes.length > 0;
    $$('[data-action="undo"]').forEach(b => b.disabled = !store.undoStack.length);
    $$('[data-action="redo"]').forEach(b => b.disabled = !store.redoStack.length);
}
function frame() {
    requestAnimationFrame(frame);
    if (uiDirty) {
        renderUI();
        uiDirty = false;
    }
    if (!dirty)
        return;
    dirty = false;
    try {
        const editing = store.get(textEditing), wasVisible = editing?.visible;
        if (editing)
            editing.visible = false;
        try {
            renderer.render(store.page.nodes, camera, theme === 'dark' ? '#1C1E23' : '#E7E8EB');
        }
        finally {
            if (editing)
                editing.visible = wasVisible;
        }
        drawOverlay();
        $('#zoom-value').textContent = Math.round(camera.zoom * 100) + '%';
        if (textEditing)
            positionTextEditor();
    }
    catch (e) {
        fail(e);
    }
}
function syncFields() {
    for (const input of $$('input[data-prop]', inspector)) {
        if (input === document.activeElement)
            continue;
        const n = store.selection()[0];
        if (!n)
            continue;
        let k = input.dataset.prop, value = k === 'opacityPercent' ? (n.opacity ?? 1) * 100 : n[k];
        if (input.type === 'number' && Number.isFinite(value))
            input.value = Math.round(value * 100) / 100;
    }
}
function movingSnap(dx, dy, initial) {
    if (!snapping)
        return { dx, dy };
    const b = { ...initial, x: initial.x + dx, y: initial.y + dy }, xs = [b.x, b.x + b.w / 2, b.x + b.w], ys = [b.y, b.y + b.h / 2, b.y + b.h], threshold = 5 / camera.zoom;
    let bestX = threshold, bestY = threshold, outX = 0, outY = 0;
    guides = [];
    const sx = [], sy = [];
    for (const info of store.index.values()) {
        if (info.page !== store.page || info.node.visible === false || store.selected.has(info.node.id) || info.ancestry.some(n => store.selected.has(n.id)))
            continue;
        const q = bounds(corners(info.node, info.world));
        sx.push(q.x, q.x + q.w / 2, q.x + q.w);
        sy.push(q.y, q.y + q.h / 2, q.y + q.h);
    }
    for (const g of store.page.guides || [])
        (g.axis === 'x' ? sx : sy).push(g.value);
    for (const x of sx)
        for (const xx of xs) {
            const d = x - xx;
            if (Math.abs(d) < bestX) {
                bestX = Math.abs(d);
                outX = d;
                guides = guides.filter(g => g.axis !== 'x');
                guides.push({ axis: 'x', value: x });
            }
        }
    for (const y of sy)
        for (const yy of ys) {
            const d = y - yy;
            if (Math.abs(d) < bestY) {
                bestY = Math.abs(d);
                outY = d;
                guides = guides.filter(g => g.axis !== 'y');
                guides.push({ axis: 'y', value: y });
            }
        }
    return { dx: dx + outX, dy: dy + outY };
}
function captureSelection() {
    return store.roots().map(n => ({ id: n.id, original: clone(n), world: store.info(n.id).world, parent: store.info(n.id).parentMatrix }));
}
function pointHandle(p) {
    const n = store.get(vectorId);
    if (!n?.points)
        return null;
    const m = store.info(n.id).world;
    for (let i = n.points.length - 1; i >= 0; i--) {
        let q = n.points[i];
        for (const k of ['out', 'in', 'point']) {
            let v = k === 'point' ? q : q[k];
            if (!v)
                continue;
            let s = screen(point(m, v));
            if (Math.hypot(s.x - p.x, s.y - p.y) < 7)
                return { index: i, part: k };
        }
    }
    return null;
}
function parentAt(p) {
    for (const n of [...store.page.nodes].reverse())
        if (n.type === 'frame' && n.visible !== false && !n.locked) {
            let info = store.info(n.id), q = point(inverse(info.world), p);
            if (contains({ x: 0, y: 0, w: n.w, h: n.h }, q))
                return n;
        }
    return null;
}
function normalizePath(n) {
    if (!n.points?.length)
        return;
    let b = bounds(n.points.flatMap(p => [p, ...[p.in, p.out].filter(Boolean)])), old = matrix(n), newOrigin = point(old, { x: b.x, y: b.y });
    for (const p of n.points) {
        p.x -= b.x;
        p.y -= b.y;
        for (const k of ['in', 'out'])
            if (p[k]) {
                p[k].x -= b.x;
                p[k].y -= b.y;
            }
    }
    n.w = Math.max(1, b.w);
    n.h = Math.max(1, b.h);
    n.x = 0;
    n.y = 0;
    let m = matrix(n);
    n.x = newOrigin.x - m[4];
    n.y = newOrigin.y - m[5];
}
function beginPen(p, e) {
    if (penId) {
        const n = store.get(penId), info = store.info(penId), first = screen(point(info.world, n.points[0]));
        if (n.points.length > 2 && Math.hypot(first.x - p.x, first.y - p.y) < 9) {
            finishPen(true);
            return;
        }
        const local = point(inverse(info.world), world(p));
        n.points.push(local);
        activePoint = n.points.length - 1;
        drag = { kind: 'pen', id: n.id, index: activePoint, start: p };
        store.emit({ interactive: true });
        return;
    }
    const parent = parentAt(world(p)), pm = parent ? store.info(parent.id).world : I, q = point(inverse(pm), world(p));
    store.begin('Draw vector path');
    const n = node('path', { name: 'Vector', x: q.x, y: q.y, w: 1, h: 1, points: [{ x: 0, y: 0 }], closed: false, stroke: '#244C3C', strokeWidth: 2, fill: 'none' });
    store.add(n, parent);
    penId = n.id;
    vectorId = null;
    activePoint = 0;
    drag = { kind: 'pen', id: n.id, index: 0, start: p };
    expandTo(n.id);
    store.emit({ interactive: true });
    allUI();
}
function finishPen(closed) {
    const n = store?.get(penId);
    if (!n) {
        penId = null;
        return;
    }
    n.closed = closed;
    if (closed)
        n.fill = n.fill === 'none' ? '#C8DDD2' : n.fill;
    if (n.points.length < 2) {
        store.cancel();
    }
    else {
        normalizePath(n);
        store.commit();
    }
    penId = null;
    drag = null;
    tool = 'select';
    setTool('select');
    allUI();
}
function enterPath() {
    const n = store.selection()[0];
    if (!n)
        return toast('Select a vector shape first.');
    if (n.type === 'text')
        return startText(n);
    if (n.children)
        return toast('Select a shape inside the group to edit its points.');
    if (n.type === 'image')
        return toast('Raster images do not contain editable vector points.');
    if (n.contours)
        return toast('This is a compound path. Ungroup or edit its source shapes before combining.');
    if (!n.points)
        store.transaction('Convert to vector', () => {
            n.points = flatten(n)[0].map(p => ({ ...p }));
            n.closed = true;
            n.type = 'path';
        });
    vectorId = n.id;
    activePoint = -1;
    tool = 'select';
    renderInspector(true);
    dirty = true;
    toast('Vector editing · Drag anchors or handles · Enter to finish');
}
function pointerDown(e) {
    if (e.button === 2)
        return;
    closeMenu();
    if (textEditing && e.target !== $('#text-editor'))
        finishText();
    if (e.target !== overlay && e.target !== renderer.canvas && e.target !== stage)
        return;
    e.preventDefault();
    stage.focus({ preventScroll: true });
    const p = eventPoint(e);
    pointers.set(e.pointerId, p);
    stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
        if (drag && store.before !== null)
            store.cancel();
        const ps = [...pointers.values()], mid = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
        drag = { kind: 'pinch', distance: Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y), zoom: camera.zoom, anchor: world(mid) };
        return;
    }
    if (space || tool === 'hand' || e.button === 1) {
        drag = { kind: 'pan', start: p, x: camera.x, y: camera.y };
        stage.style.cursor = 'grabbing';
        return;
    }
    if (showRulers && (p.x < 19 || p.y < 19)) {
        store.begin('Add guide');
        const axis = p.x < 19 ? 'x' : 'y', g = { axis, value: world(p)[axis] };
        store.page.guides ??= [];
        store.page.guides.push(g);
        drag = { kind: 'guide', guide: g };
        return;
    }
    if (tool === 'pen') {
        beginPen(p, e);
        return;
    }
    if (vectorId) {
        const h = pointHandle(p);
        if (h) {
            activePoint = h.index;
            store.begin('Edit vector point');
            drag = { kind: 'point', id: vectorId, ...h, original: clone(store.get(vectorId).points[h.index]) };
            dirty = true;
            return;
        }
        const n = store.get(vectorId);
        if (n) {
            const q = point(inverse(store.info(n.id).world), world(p));
            let best = Infinity, bestIndex = -1;
            for (let i = 0; i < n.points.length - (n.closed ? 0 : 1); i++) {
                let a = n.points[i], b = n.points[(i + 1) % n.points.length], dx = b.x - a.x, dy = b.y - a.y, t = clamp(((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1), dist = Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy);
                if (dist < best) {
                    best = dist;
                    bestIndex = i;
                }
            }
            if (best < 6 / camera.zoom && bestIndex >= 0) {
                store.transaction('Insert vector point', () => {
                    n.points.splice(bestIndex + 1, 0, q);
                });
                activePoint = bestIndex + 1;
                allUI();
                return;
            }
        }
        vectorId = null;
        activePoint = -1;
    }
    if (tool === 'text') {
        const hit = findHit(world(p));
        if (hit?.type === 'text') {
            select([hit.id]);
            startText(hit);
            return;
        }
        const parent = parentAt(world(p)), q = point(inverse(parent ? store.info(parent.id).world : I), world(p));
        store.transaction('Add text', () => {
            store.add(text('Your next idea', q.x, q.y, 28, '#244C3C', { w: 260, h: 48, name: 'Text' }), parent);
        });
        setTool('select');
        startText(store.selection()[0], true);
        return;
    }
    if (['rect', 'ellipse', 'frame', 'line', 'star', 'polygon'].includes(tool)) {
        const parent = tool === 'frame' ? null : parentAt(world(p)), pm = parent ? store.info(parent.id).world : I, q = point(inverse(pm), world(p));
        store.begin('Draw ' + tool);
        const n = node(tool, { name: tool === 'frame' ? 'Untitled frame' : tool[0].toUpperCase() + tool.slice(1), x: q.x, y: q.y, w: 1, h: 1, fill: tool === 'frame' ? '#FFFFFF' : tool === 'line' ? 'none' : '#C8DDD2', radius: tool === 'rect' ? 8 : 0, ...(tool === 'frame' ? { children: [], clip: true } : {}), ...(tool === 'line' ? { stroke: '#244C3C', strokeWidth: 2, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], closed: false } : {}) });
        store.add(n, parent);
        drag = { kind: 'draw', id: n.id, start: p, startLocal: q, parent: pm, type: tool, moved: false };
        expandTo(n.id);
        store.emit({ interactive: true });
        allUI();
        return;
    }
    const handle = handleHit(p);
    if (handle) {
        const initial = captureSelection(), b = store.bounds();
        store.begin(handle.name === 'rotate' ? 'Rotate layer' : 'Resize layers');
        drag = { kind: handle.name === 'rotate' ? 'rotate' : 'resize', handle: handle.name, start: p, initial, bounds: b, center: screen({ x: b.x + b.w / 2, y: b.y + b.h / 2 }) };
        return;
    }
    const hit = findHit(world(p), { deep: !e.altKey });
    if (hit) {
        if (e.shiftKey) {
            let ids = new Set(store.selected);
            ids.has(hit.id) ? ids.delete(hit.id) : ids.add(hit.id);
            select([...ids]);
        }
        else if (!store.selected.has(hit.id))
            select([hit.id]);
        if (!store.selected.size)
            return;
        store.begin(e.altKey ? 'Duplicate and move' : 'Move layers');
        if (e.altKey) {
            store.duplicate(0);
            allUI();
        }
        drag = { kind: 'move', start: p, initial: captureSelection(), bounds: store.bounds(), moved: false };
    }
    else {
        if (!e.shiftKey)
            select([]);
        drag = { kind: 'marquee', start: p, previous: [...store.selected] };
        marquee = { x: p.x, y: p.y, w: 0, h: 0 };
        dirty = true;
    }
}
function pointerMove(e) {
    const p = eventPoint(e);
    if (pointers.has(e.pointerId))
        pointers.set(e.pointerId, p);
    if (!drag) {
        if (tool === 'select') {
            const h = handleHit(p), ph = pointHandle(p);
            stage.style.cursor = space ? 'grab' : ph ? 'move' : h ? h.name === 'rotate' ? 'crosshair' : `${h.name === 'n' || h.name === 's' ? 'ns' : h.name === 'e' || h.name === 'w' ? 'ew' : h.name === 'ne' || h.name === 'sw' ? 'nesw' : 'nwse'}-resize` : 'default';
            const n = findHit(world(p));
            if (n?.id !== hover?.id) {
                hover = n;
                dirty = true;
            }
        }
        return;
    }
    if (drag.kind === 'pinch') {
        const ps = [...pointers.values()];
        if (ps.length !== 2)
            return;
        let mid = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 }, dist = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
        camera.zoom = clamp(drag.zoom * dist / Math.max(1, drag.distance), .02, 32);
        camera.x = mid.x - drag.anchor.x * camera.zoom;
        camera.y = mid.y - drag.anchor.y * camera.zoom;
        dirty = true;
        return;
    }
    if (drag.kind === 'pan') {
        camera.x = drag.x + p.x - drag.start.x;
        camera.y = drag.y + p.y - drag.start.y;
        dirty = true;
        return;
    }
    if (drag.kind === 'guide') {
        drag.guide.value = world(p)[drag.guide.axis];
        dirty = true;
        return;
    }
    if (drag.kind === 'marquee') {
        marquee = { x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
        dirty = true;
        return;
    }
    if (drag.kind === 'pen') {
        const n = store.get(drag.id), q = point(inverse(store.info(n.id).world), world(p)), anchor = n.points[drag.index];
        if (Math.hypot(p.x - drag.start.x, p.y - drag.start.y) > 3) {
            anchor.out = q;
            anchor.in = { x: anchor.x * 2 - q.x, y: anchor.y * 2 - q.y };
        }
        store.emit({ interactive: true });
        return;
    }
    if (drag.kind === 'point') {
        const n = store.get(drag.id), q = point(inverse(store.info(n.id).world), world(p)), anchor = n.points[drag.index];
        if (drag.part === 'point') {
            const dx = q.x - anchor.x, dy = q.y - anchor.y;
            anchor.x = q.x;
            anchor.y = q.y;
            for (const k of ['in', 'out'])
                if (anchor[k]) {
                    anchor[k].x += dx;
                    anchor[k].y += dy;
                }
        }
        else {
            anchor[drag.part] = q;
            if (!e.altKey) {
                let other = drag.part === 'in' ? 'out' : 'in';
                anchor[other] = { x: anchor.x * 2 - q.x, y: anchor.y * 2 - q.y };
            }
        }
        store.emit({ interactive: true });
        return;
    }
    if (drag.kind === 'draw') {
        const n = store.get(drag.id), p1 = point(inverse(drag.parent), world(p)), p0 = drag.startLocal;
        let dx = p1.x - p0.x, dy = p1.y - p0.y;
        if (e.shiftKey) {
            if (drag.type === 'line') {
                let angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4, len = Math.hypot(dx, dy);
                dx = Math.cos(angle) * len;
                dy = Math.sin(angle) * len;
            }
            else {
                let size = Math.max(Math.abs(dx), Math.abs(dy));
                dx = Math.sign(dx || 1) * size;
                dy = Math.sign(dy || 1) * size;
            }
        }
        let x = Math.min(p0.x, p0.x + dx), y = Math.min(p0.y, p0.y + dy), w = Math.max(1, Math.abs(dx)), h = Math.max(1, Math.abs(dy));
        if (e.altKey && drag.type !== 'line') {
            x = p0.x - w;
            y = p0.y - h;
            w *= 2;
            h *= 2;
        }
        Object.assign(n, { x, y, w, h });
        if (drag.type === 'line')
            n.points = [{ x: dx < 0 ? w : 0, y: dy < 0 ? h : 0 }, { x: dx < 0 ? 0 : w, y: dy < 0 ? 0 : h }];
        drag.moved = true;
        store.emit({ interactive: true });
        syncFields();
        return;
    }
    if (drag.kind === 'move') {
        let dx = (p.x - drag.start.x) / camera.zoom, dy = (p.y - drag.start.y) / camera.zoom;
        if (!drag.moved && Math.hypot(p.x - drag.start.x, p.y - drag.start.y) < 2)
            return;
        drag.moved = true;
        if (e.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy))
                dy = 0;
            else
                dx = 0;
        }
        ({ dx, dy } = movingSnap(dx, dy, drag.bounds));
        for (const d of drag.initial) {
            const n = store.get(d.id);
            if (!n || n.locked)
                continue;
            const inv = inverse(d.parent);
            n.x = d.original.x + inv[0] * dx + inv[2] * dy;
            n.y = d.original.y + inv[1] * dx + inv[3] * dy;
        }
        store.emit({ interactive: true });
        syncFields();
        return;
    }
    if (drag.kind === 'rotate') {
        let c = drag.center, a0 = Math.atan2(drag.start.y - c.y, drag.start.x - c.x), a1 = Math.atan2(p.y - c.y, p.x - c.x), delta = (a1 - a0) * 180 / Math.PI;
        for (const d of drag.initial) {
            const n = store.get(d.id);
            n.rotation = d.original.rotation + delta;
            if (e.shiftKey)
                n.rotation = Math.round(n.rotation / 15) * 15;
        }
        store.emit({ interactive: true });
        syncFields();
        return;
    }
    if (drag.kind === 'resize') {
        if (drag.initial.length === 1) {
            const d = drag.initial[0], n = store.get(d.id), q = point(inverse(d.world), world(p)), o = d.original;
            let left = 0, top = 0, right = o.w, bottom = o.h;
            if (drag.handle.includes('w'))
                left = Math.min(q.x, right - 1);
            if (drag.handle.includes('e'))
                right = Math.max(q.x, left + 1);
            if (drag.handle.includes('n'))
                top = Math.min(q.y, bottom - 1);
            if (drag.handle.includes('s'))
                bottom = Math.max(q.y, top + 1);
            let w = right - left, h = bottom - top;
            if (e.shiftKey || o.constrain) {
                const aspect = o.w / o.h;
                if (w / h > aspect)
                    h = w / aspect;
                else
                    w = h * aspect;
                if (drag.handle.includes('w'))
                    left = right - w;
                if (drag.handle.includes('n'))
                    top = bottom - h;
            }
            Object.assign(n, clone(o));
            store.resize(n, w, h);
            const localOrigin = { x: left, y: top }, worldOrigin = point(d.world, localOrigin), parentOrigin = point(inverse(d.parent), worldOrigin);
            n.x = 0;
            n.y = 0;
            const m = matrix(n);
            n.x = parentOrigin.x - m[4];
            n.y = parentOrigin.y - m[5];
        }
        else {
            const b = drag.bounds, q = world(p);
            let x = drag.handle.includes('w') ? Math.min(q.x, b.x + b.w - 1) : b.x, y = drag.handle.includes('n') ? Math.min(q.y, b.y + b.h - 1) : b.y, r = drag.handle.includes('e') ? Math.max(q.x, x + 1) : b.x + b.w, bt = drag.handle.includes('s') ? Math.max(q.y, y + 1) : b.y + b.h, sx = (r - x) / b.w, sy = (bt - y) / b.h;
            if (e.shiftKey)
                sx = sy = Math.max(sx, sy);
            for (const d of drag.initial) {
                const n = store.get(d.id), center = point(d.world, { x: d.original.w / 2, y: d.original.h / 2 }), newCenter = { x: x + (center.x - b.x) * sx, y: y + (center.y - b.y) * sy }, pc = point(inverse(d.parent), newCenter);
                Object.assign(n, clone(d.original));
                store.resize(n, d.original.w * sx, d.original.h * sy);
                n.x = pc.x - n.w / 2;
                n.y = pc.y - n.h / 2;
            }
        }
        store.emit({ interactive: true });
        syncFields();
    }
}
function pointerUp(e) {
    pointers.delete(e.pointerId);
    try {
        stage.releasePointerCapture(e.pointerId);
    }
    catch {
    }
    if (!drag)
        return;
    const kind = drag.kind;
    if (kind === 'pinch') {
        if (pointers.size === 0)
            drag = null;
        return;
    }
    if (kind === 'marquee') {
        const b = { x: (marquee.x - camera.x) / camera.zoom, y: (marquee.y - camera.y) / camera.zoom, w: marquee.w / camera.zoom, h: marquee.h / camera.zoom }, ids = [...drag.previous];
        for (const info of store.index.values()) {
            const n = info.node;
            if (info.page !== store.page || n.locked || n.visible === false || n.type === 'frame' || info.ancestry.some(a => a.locked || a.visible === false))
                continue;
            let q = bounds(corners(n, info.world));
            if (b.w > 2 / camera.zoom && b.h > 2 / camera.zoom && contains(b, { x: q.x, y: q.y }) && contains(b, { x: q.x + q.w, y: q.y + q.h }))
                ids.push(n.id);
        }
        const set = new Set(ids);
        select(ids.filter(id => !store.info(id).ancestry.some(a => set.has(a.id))));
        marquee = null;
    }
    else if (kind === 'draw') {
        const n = store.get(drag.id);
        if (!drag.moved) {
            n.w = drag.type === 'frame' ? 393 : 120;
            n.h = drag.type === 'frame' ? 852 : drag.type === 'line' ? 1 : 100;
            if (n.points)
                n.points = [{ x: 0, y: 0 }, { x: n.w, y: n.h }];
        }
        store.commit();
        setTool('select');
    }
    else if (kind === 'point') {
        normalizePath(store.get(drag.id));
        store.commit();
    }
    else if (kind === 'guide') {
        const p = eventPoint(e);
        if (p.x < 19 || p.y < 19 || p.x > width || p.y > height)
            store.page.guides = store.page.guides.filter(g => g !== drag.guide);
        store.commit();
    }
    else if (['move', 'resize', 'rotate'].includes(kind)) {
        store.commit();
    }
    drag = null;
    guides = [];
    dirty = true;
    uiDirty = true;
    stage.style.cursor = tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
}
function cancelGesture() {
    pointers.clear();
    if (drag && store.before !== null)
        store.cancel();
    drag = null;
    marquee = null;
    guides = [];
    penId = null;
    dirty = true;
    uiDirty = true;
}
stage.addEventListener('pointerdown', pointerDown);
stage.addEventListener('pointermove', pointerMove);
stage.addEventListener('pointerup', pointerUp);
stage.addEventListener('pointercancel', cancelGesture);
stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey)
        zoomAt(Math.exp(-e.deltaY * .008), eventPoint(e));
    else {
        camera.x -= e.shiftKey ? e.deltaY : e.deltaX;
        camera.y -= e.shiftKey ? e.deltaX : e.deltaY;
        dirty = true;
    }
}, { passive: false });
stage.addEventListener('dblclick', e => {
    if (textEditing)
        return;
    const p = eventPoint(e);
    if (penId) {
        finishPen(false);
        return;
    }
    if (vectorId) {
        const h = pointHandle(p);
        if (h && h.part === 'point') {
            activePoint = h.index;
            togglePointCurve();
            return;
        }
    }
    const n = findHit(world(p));
    if (!n)
        return;
    select([n.id]);
    if (n.type === 'text')
        startText(n);
    else if (!n.children && n.type !== 'image')
        enterPath();
});
function startText(n, selectAll = false) {
    if (!n || n.locked)
        return;
    if (textEditing)
        finishText();
    store.begin('Edit text');
    textEditing = n.id;
    vectorId = null;
    const input = $('#text-editor');
    input.hidden = false;
    input.value = n.text || '';
    input.style.font = font(n);
    input.style.lineHeight = String(n.lineHeight || 1.25);
    input.style.letterSpacing = (n.letterSpacing || 0) + 'px';
    input.style.textAlign = n.textAlign || 'left';
    input.style.color = n.fill || '#000000';
    positionTextEditor();
    input.focus();
    if (selectAll)
        input.select();
    dirty = true;
}
function positionTextEditor() {
    const n = store.get(textEditing);
    if (!n)
        return;
    const m = store.info(n.id).world, el = $('#text-editor');
    el.style.left = '0';
    el.style.top = '0';
    el.style.width = n.w + 'px';
    el.style.height = Math.max(n.h, (n.fontSize || 16) * 1.3) + 'px';
    el.style.transform = `matrix(${m[0] * camera.zoom},${m[1] * camera.zoom},${m[2] * camera.zoom},${m[3] * camera.zoom},${m[4] * camera.zoom + camera.x},${m[5] * camera.zoom + camera.y})`;
}
function finishText(cancel = false) {
    if (!textEditing)
        return;
    const n = store.get(textEditing);
    if (n && !cancel)
        n.text = $('#text-editor').value;
    $('#text-editor').hidden = true;
    textEditing = null;
    cancel ? store.cancel() : store.commit();
    stage.focus({ preventScroll: true });
    allUI();
}
$('#text-editor').addEventListener('input', e => {
    const n = store.get(textEditing);
    if (!n)
        return;
    n.text = e.target.value;
    n.h = Math.max(n.h, (n.fontSize || 16) * (n.lineHeight || 1.25) * n.text.split('\n').length);
    store.emit({ interactive: true });
});
$('#text-editor').addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Escape') {
        e.preventDefault();
        finishText(true);
    }
    else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finishText();
    }
});
let modalAccept = null;
function modal(title, body, footer = '') {
    closeMenu();
    $('#modal-content').innerHTML = `<div class="modal-header"><h2>${esc(title)}</h2><button class="icon-button" data-action="closeModal" title="Close">${icon('close')}</button></div><div class="modal-body">${body}</div>${footer ? `<div class="modal-footer">${footer}</div>` : ''}`;
    if (!$('#modal').open)
        $('#modal').showModal();
}
function closeModal() {
    $('#modal').close();
    modalAccept = null;
}
function promptValue(title, label, value, onAccept) {
    modalAccept = null;
    modal(title, `<p>${esc(label)}</p><input id="prompt-input" class="modal-input" value="${esc(value)}" maxlength="250" aria-label="${esc(title)}">`, `<button class="secondary-button" data-action="closeModal">Cancel</button><button class="primary-button" data-action="acceptModal">Save</button>`);
    modalAccept = () => {
        const value = $('#prompt-input').value.trim();
        if (value) {
            onAccept(value);
            closeModal();
        }
    };
    setTimeout(() => {
        $('#prompt-input').focus();
        $('#prompt-input').select();
    }, 30);
}
$('#modal').addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'prompt-input') {
        e.preventDefault();
        modalAccept?.();
    }
});
$('#modal').addEventListener('click', e => {
    if (e.target === $('#modal'))
        closeModal();
});
function closeMenu() {
    $('#menu').hidden = true;
}
function menu(items, anchor) {
    const el = $('#menu');
    el.innerHTML = items.map(i => i === '-' ? '<div class="menu-divider"></div>' : i.label ? `<div class="menu-label">${esc(i.label)}</div>` : `<button class="menu-item ${i.danger ? 'danger' : ''}" data-action="${esc(i.action)}" ${i.disabled ? 'disabled' : ''}>${icon(i.icon || 'dot')}<span>${esc(i.name)}</span>${i.key ? `<kbd>${esc(i.key)}</kbd>` : ''}</button>`).join('');
    el.hidden = false;
    const r = anchor?.getBoundingClientRect?.() || { left: anchor?.x ?? 25, bottom: anchor?.y ?? 45 };
    el.style.left = Math.min(r.left, innerWidth - 250) + 'px';
    el.style.top = Math.min(r.bottom + 5, innerHeight - el.offsetHeight - 10) + 'px';
}
const fileItems = [{ label: 'FORMA / LOCAL WORKSPACE' }, { name: 'New document', action: 'new', icon: 'file', key: '⌘N' }, { name: 'Open design…', action: 'open', icon: 'upload', key: '⌘O' }, { name: 'Save a copy…', action: 'save', icon: 'save', key: '⌘S' }, '-', { name: 'Export…', action: 'export', icon: 'download', key: '⇧⌘E' }, { name: 'Import image…', action: 'importImage', icon: 'image', key: '⇧⌘K' }, '-', { name: 'Search commands…', action: 'command', icon: 'search', key: '⌘K' }, { name: 'Keyboard shortcuts', action: 'shortcuts', icon: 'keyboard', key: '?' }, { name: 'Reload example design', action: 'demo', icon: 'spark' }, { name: 'About Forma', action: 'about', icon: 'help' }];
const insertItems = [{ label: 'Insert a layer' }, ...['rect', 'ellipse', 'line', 'star', 'polygon', 'pen', 'text', 'frame'].map((t, i) => ({ name: { rect: 'Rectangle', ellipse: 'Oval', line: 'Line', star: 'Star', polygon: 'Polygon', pen: 'Vector path', text: 'Text', frame: 'Frame' }[t], action: 'tool:' + t, icon: t === 'pen' ? 'pen' : t, key: ['R', 'O', 'L', '', '', 'P', 'T', 'A'][i] })), '-', { name: 'Image…', action: 'importImage', icon: 'image', key: '⇧⌘K' }];
const booleanItems = [{ label: 'Boolean geometry' }, { name: 'Union', action: 'union', icon: 'union' }, { name: 'Subtract front', action: 'subtract', icon: 'subtract' }, { name: 'Intersect', action: 'intersect', icon: 'intersect' }, { name: 'Difference (XOR)', action: 'xor', icon: 'xor' }, '-', { name: 'Convert to vector', action: 'flatten', icon: 'pen' }];
const contextItems = () => [{ name: 'Cut', action: 'cut', icon: 'copy', key: '⌘X' }, { name: 'Copy', action: 'copy', icon: 'copy', key: '⌘C' }, { name: 'Paste', action: 'paste', icon: 'copy', key: '⌘V' }, { name: 'Duplicate', action: 'duplicate', icon: 'copy', key: '⌘D' }, '-', { name: 'Group selection', action: 'group', icon: 'group', key: '⌘G' }, { name: 'Ungroup', action: 'ungroup', icon: 'ungroup', key: '⇧⌘G' }, { name: 'Create Symbol', action: 'component', icon: 'component' }, '-', { name: 'Bring forward', action: 'forward', icon: 'arrowUp', key: '⌘]' }, { name: 'Send backward', action: 'backward', icon: 'arrowDown', key: '⌘[' }, { name: 'Bring to front', action: 'front', icon: 'arrowUp' }, { name: 'Send to back', action: 'back', icon: 'arrowDown' }, '-', { name: 'Lock / unlock', action: 'lock', icon: 'lock', key: '⇧⌘L' }, { name: 'Hide / show', action: 'hide', icon: 'eye' }, { name: 'Rename', action: 'rename', icon: 'text', key: '⌘R' }, { name: 'Delete', action: 'delete', icon: 'trash', key: '⌫', danger: true }];
function applyProperty(key, value) {
    const nodes = store.roots();
    if (!nodes.length)
        return;
    store.transaction('Change ' + key, () => {
        for (const n of nodes) {
            if (n.locked && key !== 'locked')
                continue;
            if (key === 'w' || key === 'h') {
                let w = key === 'w' ? Math.max(1, value) : n.w, h = key === 'h' ? Math.max(1, value) : n.h;
                if (n.constrain) {
                    if (key === 'w')
                        h = n.h * w / n.w;
                    else
                        w = n.w * h / n.h;
                }
                store.resize(n, w, h);
            }
            else if (key === 'opacityPercent')
                n.opacity = clamp(value / 100, 0, 1);
            else {
                if (key === 'radius')
                    value = Math.max(0, value);
                if (key === 'sides')
                    value = clamp(Math.round(value), 3, 32);
                if (key === 'innerRadius')
                    value = clamp(value, .05, .95);
                if (key === 'fontSize')
                    value = clamp(value, 1, 2000);
                if (key === 'lineHeight')
                    value = clamp(value, .1, 10);
                if (key === 'strokeWidth')
                    value = clamp(value, 0, 1000);
                if (key === 'shadowBlur')
                    value = clamp(value, 0, 500);
                if (key === 'shadowOpacity')
                    value = clamp(value, 0, 1);
                n[key] = value;
            }
            if (['layout', 'gap', 'padding', 'align', 'hug', 'w', 'h'].includes(key))
                store.layout(n);
        }
    });
    allUI();
}
function alignSelection(action) {
    const ns = store.roots().filter(n => !n.locked);
    if (!ns.length)
        return;
    let target = ns.length > 1 ? store.bounds(ns.map(n => n.id)) : store.info(ns[0].id).parent ? bounds(corners(store.info(ns[0].id).parent, store.info(store.info(ns[0].id).parent.id).world)) : { x: 0, y: 0, w: 1080, h: 820 };
    store.transaction('Align layers', () => {
        for (const n of ns) {
            const info = store.info(n.id), b = bounds(corners(n, info.world));
            let dx = 0, dy = 0;
            if (action === 'alignLeft')
                dx = target.x - b.x;
            if (action === 'alignCenter')
                dx = target.x + target.w / 2 - b.x - b.w / 2;
            if (action === 'alignRight')
                dx = target.x + target.w - b.x - b.w;
            if (action === 'alignTop')
                dy = target.y - b.y;
            if (action === 'alignMiddle')
                dy = target.y + target.h / 2 - b.y - b.h / 2;
            if (action === 'alignBottom')
                dy = target.y + target.h - b.y - b.h;
            const im = inverse(info.parentMatrix);
            n.x += im[0] * dx + im[2] * dy;
            n.y += im[1] * dx + im[3] * dy;
        }
    });
}
function distribute(axis) {
    let ns = store.roots();
    if (ns.length < 3)
        return toast('Select at least three layers to distribute.');
    let infos = ns.map(n => ({ n, b: bounds(corners(n, store.info(n.id).world)) })).sort((a, b) => a.b[axis] - b.b[axis]), dim = axis === 'x' ? 'w' : 'h', start = infos[0].b[axis], end = infos.at(-1).b[axis] + infos.at(-1).b[dim], gap = (end - start - infos.reduce((s, i) => s + i.b[dim], 0)) / (infos.length - 1);
    store.transaction('Distribute layers', () => {
        let pos = start;
        for (const i of infos) {
            let d = pos - i.b[axis], im = inverse(store.info(i.n.id).parentMatrix);
            i.n.x += (axis === 'x' ? im[0] : im[2]) * d;
            i.n.y += (axis === 'x' ? im[1] : im[3]) * d;
            pos += i.b[dim] + gap;
        }
    });
}
function arrange(direction) {
    store.transaction('Arrange layers', () => {
        let ns = store.roots();
        if (direction === 'forward' || direction === 'front')
            ns.reverse();
        for (const n of ns) {
            const list = store.info(n.id).list, i = list.indexOf(n);
            list.splice(i, 1);
            list.splice(direction === 'front' ? list.length : direction === 'back' ? 0 : direction === 'forward' ? Math.min(list.length, i + 1) : Math.max(0, i - 1), 0, n);
        }
    });
}
function booleanOperation(operation) {
    const ns = store.roots(), infos = ns.map(n => store.info(n.id));
    if (ns.length < 2)
        return toast('Select two or more vector shapes to combine.');
    if (ns.some(n => n.children || ['text', 'image', 'frame'].includes(n.type)))
        return toast('Boolean operations accept vector shapes, not text, images, or groups.');
    if (infos.some(i => i.parent !== infos[0].parent))
        return toast('Select shapes with the same parent.');
    const list = infos[0].list, sorted = ns.sort((a, b) => list.indexOf(a) - list.indexOf(b)), operands = sorted.map(n => flatten(n).map(r => r.map(p => point(matrix(n), p)))), rings = booleanRings(operands, operation);
    if (!rings.length)
        return toast('The operation has an empty result. Nothing was changed.');
    const b = bounds(rings.flat()), base = sorted[0], result = node('path', { name: operation[0].toUpperCase() + operation.slice(1), ...b, fill: base.fill, stroke: base.stroke, strokeWidth: base.strokeWidth, closed: true, contours: rings.map(r => r.map(p => ({ x: p.x - b.x, y: p.y - b.y }))) });
    store.transaction('Boolean ' + operation, () => {
        const at = Math.max(...sorted.map(n => list.indexOf(n)));
        list.splice(at + 1, 0, result);
        for (const n of sorted)
            list.splice(list.indexOf(n), 1);
        store.reindex();
        select([result.id]);
    });
    toast(operation[0].toUpperCase() + operation.slice(1) + ' created · Undo preserves your source shapes');
}
function togglePointCurve(force) {
    const n = store.get(vectorId);
    if (!n?.points)
        return;
    let i = activePoint >= 0 ? activePoint : 0, p = n.points[i];
    store.transaction('Change vector point', () => {
        if (force === 'straight' || p.in && force !== 'curve') {
            delete p.in;
            delete p.out;
        }
        else {
            let prev = n.points[(i - 1 + n.points.length) % n.points.length], next = n.points[(i + 1) % n.points.length], dx = (next.x - prev.x) * .18, dy = (next.y - prev.y) * .18;
            p.in = { x: p.x - dx, y: p.y - dy };
            p.out = { x: p.x + dx, y: p.y + dy };
        }
    });
}
function createFrame(w, h, name) {
    const center = world({ x: width / 2, y: height / 2 }), n = node('frame', { name: name || 'Frame', x: Math.round(center.x - w / 2), y: Math.round(center.y - h / 2), w, h, fill: '#FFFFFF', clip: true, children: [] });
    store.transaction('Create frame', () => store.add(n));
    expanded.add(n.id);
    fitBox(store.bounds([n.id]), 65);
    setTool('select');
}
function insertSymbol(id) {
    const source = store.get(id);
    if (!source)
        return;
    const n = resetIds(clone(source), true);
    n.type = 'instance';
    n.masterId = source.id;
    n.name = source.name + ' instance';
    const center = world({ x: width / 2, y: height / 2 });
    n.x = center.x - n.w / 2;
    n.y = center.y - n.h / 2;
    delete n.symbolKey;
    store.transaction('Insert symbol instance', () => store.add(n));
    allUI();
    toast('Linked instance inserted');
}
async function copySelection(cut = false) {
    if (!store.selected.size)
        return;
    clipboard = exportNodes(store, true);
    const payload = JSON.stringify({ format: 'forma-clipboard', nodes: clipboard });
    try {
        await navigator.clipboard.writeText(payload);
    }
    catch {
    }
    if (cut)
        store.transaction('Cut layers', () => store.remove());
    toast(cut ? 'Cut to clipboard' : 'Copied editable layers');
}
function pasteNodes(nodes) {
    if (!Array.isArray(nodes) || !nodes.length)
        return;
    const temp = validateDocument({ format: 'forma', version: 1, pages: [{ id: 'clipboard', name: 'Clipboard', nodes: clone(nodes) }], activePage: 'clipboard', colors: [], textStyles: [] }), copies = temp.pages[0].nodes.map(n => resetIds(n));
    store.transaction('Paste layers', () => {
        for (const n of copies) {
            n.x += 24;
            n.y += 24;
            store.page.nodes.push(n);
        }
        store.reindex();
        select(copies.map(n => n.id));
    });
    allUI();
}
async function paste() {
    try {
        const txt = await navigator.clipboard.readText();
        if (txt.trim().startsWith('<svg')) {
            const result = importSVG(txt);
            store.transaction('Paste SVG', () => store.add(result.node));
            toast(result.warning);
            return;
        }
        const data = JSON.parse(txt);
        if (data.format === 'forma-clipboard') {
            pasteNodes(data.nodes);
            return;
        }
    }
    catch {
    }
    if (clipboard)
        pasteNodes(clipboard);
    else
        toast('Use ⌘V / Ctrl+V to paste an image, SVG, or copied layers.');
}
async function importFiles(files, at = null) {
    for (const file of files) {
        if (file.size > 32000000) {
            toast(`${file.name} exceeds the 32 MB import limit.`);
            continue;
        }
        try {
            const ext = file.name.split('.').pop().toLowerCase();
            if (ext === 'forma' || ext === 'json') {
                const data = validateDocument(JSON.parse(await file.text()));
                store.transaction('Open document', () => {
                    store.doc = data;
                    store.selected.clear();
                });
                expanded.clear();
                fitInitial();
                toast('Opened ' + file.name);
            }
            else if (ext === 'sketch') {
                toast('Reading Sketch archive locally…');
                const result = await importSketch(file);
                store.transaction('Import Sketch', () => {
                    store.doc = result.doc;
                    store.selected.clear();
                });
                expanded.clear();
                fitInitial();
                modal('Sketch import report', `<p>Imported ${result.doc.pages.length} page(s) and ${store.index.size} layers.</p><div class="help-card">${result.warnings.map(s => `<div>• ${esc(s)}</div>`).join('')}</div>`, `<button class="primary-button" data-action="closeModal">Continue designing</button>`);
            }
            else if (ext === 'svg') {
                const result = importSVG(await file.text());
                const p = at || world({ x: width / 2, y: height / 2 });
                result.node.x = p.x - result.node.w / 2;
                result.node.y = p.y - result.node.h / 2;
                result.node.name = file.name.replace(/\.svg$/i, '');
                store.transaction('Import SVG', () => store.add(result.node));
                expanded.add(result.node.id);
                toast(result.warning);
            }
            else if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
                const src = await readDataURL(file), image = new Image();
                await new Promise((resolve, reject) => {
                    image.onload = resolve;
                    image.onerror = () => reject(Error('Unable to decode image.'));
                    image.src = src;
                });
                const scale = Math.min(1, 1000 / Math.max(image.naturalWidth, image.naturalHeight)), w = image.naturalWidth * scale, h = image.naturalHeight * scale, p = at || world({ x: width / 2, y: height / 2 });
                store.transaction('Import image', () => {
                    store.add(node('image', { name: file.name, x: p.x - w / 2, y: p.y - h / 2, w, h, src, fill: 'none', radius: 0 }));
                });
                toast('Image embedded in your document');
            }
            else
                toast('Supported imports: .forma, .sketch, SVG, PNG, JPEG, WebP, and GIF.');
        }
        catch (e) {
            fail(e);
        }
    }
    allUI();
}
function exportBox(scope) {
    return scope === 'page' ? store.bounds(store.page.nodes.map(n => n.id)) : store.selected.size ? store.bounds() : store.bounds(store.page.nodes.map(n => n.id));
}
function openExport() {
    const b = exportBox('selection'), nodes = exportNodes(store, true);
    modal('Export your design', `<div class="export-thumb">${nodes.length && b.w ? exportSVG(nodes, b) : ''}</div><div class="input-row"><label>Export</label><select id="export-scope" class="inspector-select"><option value="selection" ${!store.selected.size ? 'disabled' : ''}>Selected layers</option><option value="page" ${!store.selected.size ? 'selected' : ''}>Current page</option></select></div><div class="input-row"><label>Format</label><select id="export-format" class="inspector-select"><option>PNG</option><option>SVG</option><option>Forma</option></select></div><div class="input-row"><label>Scale</label><select id="export-scale" class="inspector-select"><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></div><p class="section-note" style="margin-top:14px">${Math.round(b.w)} × ${Math.round(b.h)} px · Generated locally · No watermark</p>`, `<button class="secondary-button" data-action="closeModal">Cancel</button><button class="primary-button" data-action="exportNow">${icon('download', 15)} Export</button>`);
}
async function doExport() {
    const format = $('#export-format')?.value || $('#inspector-export-format')?.value || 'PNG', scale = Number($('#export-scale')?.value || $('#inspector-export-scale')?.value || 1), scope = $('#export-scope')?.value || (store.selected.size ? 'selection' : 'page');
    if (format === 'Forma') {
        saveDocument();
        closeModal();
        return;
    }
    const b = exportBox(scope);
    if (!b.w || !b.h)
        return toast('There is nothing to export.');
    const nodes = exportNodes(store, scope === 'selection'), name = (scope === 'selection' && store.selection().length === 1 ? store.selection()[0].name : store.page.name).replace(/[<>:"/\\|?*]/g, '-');
    if (format === 'SVG')
        download(name + '.svg', exportSVG(nodes, b), 'image/svg+xml');
    else
        download(name + (scale > 1 ? '@' + scale + 'x' : '') + '.png', await exportPNG(nodes, b, scale, renderer.images), 'image/png');
    closeModal();
    toast(format + ' exported');
}
function saveDocument() {
    download(store.doc.name.replace(/[<>:"/\\|?*]/g, '-') + '.forma', JSON.stringify(store.doc, null, 2), 'application/json');
    toast('Editable document saved');
}
function cssFor(n) {
    const p = { position: 'absolute', left: Math.round(n.x) + 'px', top: Math.round(n.y) + 'px', width: Math.round(n.w) + 'px', height: Math.round(n.h) + 'px' };
    if (n.fill && n.fill !== 'none')
        p[n.type === 'text' ? 'color' : 'background'] = n.gradient ? `linear-gradient(${n.gradientAngle || 0}deg, ${n.fill}, ${n.fill2})` : n.fill;
    if (n.radius)
        p['border-radius'] = n.radius + 'px';
    if (n.strokeWidth && n.stroke !== 'none')
        p.border = `${n.strokeWidth}px solid ${n.stroke}`;
    if (n.opacity < 1)
        p.opacity = n.opacity;
    if (n.rotation)
        p.transform = `rotate(${n.rotation}deg)`;
    if (n.type === 'text') {
        p['font-family'] = `"${n.fontFamily || 'Arial'}"`;
        p['font-size'] = (n.fontSize || 16) + 'px';
        p['font-weight'] = n.fontWeight || 400;
        p['line-height'] = n.lineHeight || 1.25;
        p['letter-spacing'] = (n.letterSpacing || 0) + 'px';
    }
    return '.' + n.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + ' {\n' + Object.entries(p).map(([k, v]) => `  ${k}: ${v};`).join('\n') + '\n}';
}
function showCode() {
    const ns = store.roots();
    if (!ns.length)
        return toast('Select a layer to inspect its CSS.');
    const code = ns.map(cssFor).join('\n\n');
    modal('CSS handoff', `<p>Layout and paint properties for your selection. Complex vector paths export as SVG.</p><pre class="modal-code" id="css-output">${esc(code)}</pre>`, `<button class="secondary-button" data-action="closeModal">Close</button><button class="primary-button" data-action="copyCss">Copy CSS</button>`);
}
async function showPreview(id) {
    let frameNode = id ? store.get(id) : store.selection().map(n => n.type === 'frame' ? n : store.info(n.id).ancestry.find(a => a.type === 'frame')).find(Boolean) || store.page.nodes.find(n => n.type === 'frame');
    if (!frameNode)
        return toast('Create a frame to preview your design.');
    previewId = frameNode.id;
    $('#prototype-view').hidden = false;
    $('#prototype-title').textContent = frameNode.name;
    await renderer.images.ready();
    const s = $('#prototype-stage'), c = $('#prototype-canvas'), scale = Math.min((s.clientWidth - 70) / frameNode.w, (s.clientHeight - 70) / frameNode.h, 1.3), dpr = Math.min(devicePixelRatio || 1, 2);
    c.style.width = frameNode.w * scale + 'px';
    c.style.height = frameNode.h * scale + 'px';
    c.width = Math.ceil(frameNode.w * scale * dpr);
    c.height = Math.ceil(frameNode.h * scale * dpr);
    const ctx = c.getContext('2d');
    ctx.scale(scale * dpr, scale * dpr);
    const copy = clone(frameNode);
    copy.x = 0;
    copy.y = 0;
    copy.rotation = 0;
    paintTree(ctx, [copy], renderer.images);
}
$('#prototype-canvas').addEventListener('click', e => {
    const n = store.get(previewId);
    if (!n)
        return;
    const r = e.currentTarget.getBoundingClientRect(), p = { x: (e.clientX - r.left) / r.width * n.w, y: (e.clientY - r.top) / r.height * n.h };
    const find = (ns, m = I, inherited = null) => {
        for (const c of [...ns].reverse()) {
            if (c.visible === false)
                continue;
            const mm = mul(m, matrix(c)), q = point(inverse(mm), p);
            if (c.clip && !contains({ x: 0, y: 0, w: c.w, h: c.h }, q))
                continue;
            if (c.children) {
                const hit = find(c.children, mm, c.link ? c : inherited);
                if (hit)
                    return hit;
            }
            if (hitNode(c, q, 0))
                return c.link ? c : inherited;
        }
        return null;
    };
    const hit = find(n.children || [], I, n.link ? n : null);
    if (hit?.link && store.get(hit.link)) {
        previewStack.push(previewId);
        if (hit.transition === 'dissolve') {
            $('#prototype-canvas').animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
        }
        showPreview(hit.link);
    }
    else {
        $('#prototype-canvas').animate([{ transform: 'scale(1)' }, { transform: 'scale(.997)' }, { transform: 'scale(1)' }], { duration: 180 });
    }
});
const actions = {
    toggleLayers: () => {
        const w = $('.workspace');
        w.classList.remove('show-inspector');
        w.classList.toggle('show-layers');
    },
    toggleInspector: () => {
        const w = $('.workspace');
        w.classList.remove('show-layers');
        w.classList.toggle('show-inspector');
    },
    fileMenu: (el) => menu(fileItems, el), insertMenu: el => menu(insertItems, el), booleanMenu: el => menu(booleanItems, el), leftMenu: el => menu(contextItems(), el),
    viewMenu: el => menu([{ label: 'Canvas' }, ...[[showRulers, 'Rulers', 'toggleRulers', 'ruler', '⇧R'], [showGrid, 'Pixel grid', 'toggleGrid', 'grid', "'"], [snapping, 'Smart guides', 'toggleSnap', 'spark', ''], [showGuides, 'Show guides', 'toggleGuides', 'line', '']].map(([on, name, action, ic, key]) => ({ name: (on ? '✓  ' : '') + name, action, icon: ic, key })), '-', { name: 'Zoom to fit', action: 'fitAll', icon: 'fit', key: '1' }, { name: 'Zoom to selection', action: 'fitSelection', icon: 'zoomIn', key: '2' }, { name: 'Actual size', action: 'actualSize', icon: 'zoomIn', key: '0' }, '-', { name: 'Distribute horizontally', action: 'distributeH', icon: 'distributeH' }, { name: 'Distribute vertically', action: 'distributeV', icon: 'distributeV' }, '-', { name: 'Toggle light / dark', action: 'theme', icon: 'moon' }, { name: 'Renderer diagnostics', action: 'metrics', icon: 'code' }], el),
    zoomMenu: el => menu([{ name: 'Zoom to fit', action: 'fitAll', icon: 'fit', key: '1' }, { name: 'Zoom to selection', action: 'fitSelection', icon: 'zoomIn', key: '2' }, '-', ...[25, 50, 75, 100, 150, 200, 400].map(n => ({ name: n + '%', action: 'zoom:' + n, icon: 'zoomIn' }))], el),
    open: () => $('#file-input').click(), importImage: () => $('#image-input').click(), save: saveDocument, export: openExport, exportNow: doExport,
    closeModal, acceptModal: () => modalAccept?.(),
    renameDocument: () => promptValue('Rename document', 'Give your design a name.', store.doc.name, v => store.transaction('Rename document', () => store.doc.name = v)),
    rename: () => {
        const n = store.selection()[0];
        if (n)
            promptValue('Rename layer', 'Choose a layer name.', n.name, v => applyProperty('name', v));
    },
    new: () => {
        store.transaction('New document', () => {
            store.doc = { format: 'forma', version: 1, id: uid(), name: 'Untitled design', activePage: 'page-' + uid(), pages: [], colors: ['#244C3C', '#ED7855', '#FFFFFF', '#151515', '#A48CBE'], textStyles: [], assets: {} };
            store.doc.pages = [{ id: store.doc.activePage, name: 'Page 1', nodes: [] }];
            store.selected.clear();
        });
        expanded.clear();
        camera.x = 70;
        camera.y = 70;
        camera.zoom = 1;
        setTool('select');
        toast('New document · Your previous design is available with Undo');
    },
    demo: () => {
        store.transaction('Load example', () => {
            store.doc = demoDocument();
            store.selected.clear();
        });
        expanded.clear();
        fitInitial();
        toast('Editable Roam example loaded');
    },
    addPage: () => promptValue('New page', 'Keep a fresh canvas for a new direction.', 'Page ' + (store.doc.pages.length + 1), v => {
        store.transaction('Add page', () => {
            const p = { id: uid(), name: v, nodes: [] };
            store.doc.pages.push(p);
            store.doc.activePage = p.id;
            store.selected.clear();
        });
        camera.x = 70;
        camera.y = 70;
        camera.zoom = 1;
    }),
    deletePage: () => {
        if (store.doc.pages.length === 1)
            return toast('A document needs at least one page.');
        store.transaction('Delete page', () => {
            const i = store.doc.pages.indexOf(store.page);
            store.doc.pages.splice(i, 1);
            store.doc.activePage = store.doc.pages[Math.max(0, i - 1)].id;
            store.selected.clear();
        });
        fitInitial();
    },
    renamePage: () => promptValue('Rename page', 'Choose a page name.', store.page.name, v => store.transaction('Rename page', () => store.page.name = v)),
    collapseLayers: () => {
        expanded.clear();
        allUI();
    }, tabLayers: () => {
        leftTab = 'layers';
        $('#layers-panel').hidden = false;
        $('#assets-panel').hidden = true;
        $('#tab-layers').classList.add('active');
        $('#tab-assets').classList.remove('active');
        allUI();
    }, tabAssets: () => {
        leftTab = 'assets';
        $('#layers-panel').hidden = true;
        $('#assets-panel').hidden = false;
        $('#tab-layers').classList.remove('active');
        $('#tab-assets').classList.add('active');
        renderAssets();
    },
    undo: () => {
        finishText();
        vectorId = null;
        penId = null;
        store.undo();
        allUI();
    }, redo: () => {
        finishText();
        vectorId = null;
        store.redo();
        allUI();
    },
    group: () => {
        if (!store.selected.size)
            return toast('Select layers to group.');
        store.transaction('Group layers', () => store.group());
        expanded.add(store.selection()[0]?.id);
    },
    ungroup: () => store.transaction('Ungroup layers', () => store.ungroup()),
    duplicate: () => {
        if (store.selected.size)
            store.transaction('Duplicate layers', () => store.duplicate());
    },
    delete: () => {
        if (vectorId && activePoint >= 0) {
            const n = store.get(vectorId);
            store.transaction('Delete vector point', () => {
                n.points.splice(activePoint, 1);
                if (n.points.length < 2) {
                    vectorId = null;
                    store.remove();
                }
                else
                    normalizePath(n);
            });
            activePoint = -1;
        }
        else if (store.selected.size)
            store.transaction('Delete layers', () => store.remove());
    },
    copy: () => copySelection(), cut: () => copySelection(true), paste,
    selectAll: () => select(store.page.nodes.filter(n => !n.locked && n.visible !== false).map(n => n.id)),
    lock: () => {
        const first = store.selection()[0];
        if (first)
            applyProperty('locked', !first.locked);
    }, hide: () => {
        const first = store.selection()[0];
        if (first)
            applyProperty('visible', first.visible === false);
    },
    front: () => arrange('front'), back: () => arrange('back'), forward: () => arrange('forward'), backward: () => arrange('backward'),
    alignLeft: () => alignSelection('alignLeft'), alignCenter: () => alignSelection('alignCenter'), alignRight: () => alignSelection('alignRight'), alignTop: () => alignSelection('alignTop'), alignMiddle: () => alignSelection('alignMiddle'), alignBottom: () => alignSelection('alignBottom'), distributeH: () => distribute('x'), distributeV: () => distribute('y'),
    union: () => booleanOperation('union'), subtract: () => booleanOperation('subtract'), intersect: () => booleanOperation('intersect'), xor: () => booleanOperation('xor'),
    flatten: () => {
        const ns = store.roots();
        if (ns.some(n => n.children || ['text', 'image'].includes(n.type)))
            return toast('Select basic vector shapes to convert.');
        store.transaction('Convert to vector', () => {
            for (const n of ns) {
                if (n.points || n.contours)
                    continue;
                n.points = flatten(n)[0];
                n.closed = true;
                n.type = 'path';
            }
        });
    },
    editPath: enterPath, donePath: () => {
        vectorId = null;
        activePoint = -1;
        allUI();
    }, pointStraight: () => togglePointCurve('straight'), pointCurve: () => togglePointCurve('curve'), toggleClosed: () => {
        const n = store.get(vectorId);
        if (n)
            applyProperty('closed', !n.closed);
    },
    flipH: () => {
        const n = store.selection()[0];
        if (n)
            applyProperty('flipX', !n.flipX);
    }, flipV: () => {
        const n = store.selection()[0];
        if (n)
            applyProperty('flipY', !n.flipY);
    }, italic: () => {
        const n = store.selection()[0];
        if (n)
            applyProperty('fontStyle', n.fontStyle === 'italic' ? 'normal' : 'italic');
    },
    toggleFill: () => {
        const n = store.selection()[0];
        if (n)
            applyProperty('fill', n.fill === 'none' ? '#C8DDD2' : 'none');
    }, toggleStroke: () => {
        const n = store.selection()[0];
        if (n) {
            store.transaction('Toggle border', () => {
                for (const s of store.roots()) {
                    s.stroke = s.stroke === 'none' ? '#244C3C' : 'none';
                    if (!s.strokeWidth)
                        s.strokeWidth = 1;
                }
            });
        }
    },
    saveColor: () => {
        const n = store.selection()[0];
        if (n && /^#[a-f0-9]{6}$/i.test(n.fill)) {
            store.transaction('Save document color', () => {
                if (!store.doc.colors.includes(n.fill))
                    store.doc.colors.push(n.fill);
            });
            toast('Color saved to document');
        }
    },
    mask: () => {
        const ns = store.roots();
        if (ns.length === 1 && ns[0].children) {
            applyProperty('clip', !ns[0].clip);
            return;
        }
        if (ns.length < 2)
            return toast('Select a rectangle behind one or more layers to use as a mask.');
        const list = store.info(ns[0].id).list;
        if (ns.some(n => store.info(n.id).list !== list))
            return toast('Mask layers must share a parent.');
        ns.sort((a, b) => list.indexOf(a) - list.indexOf(b));
        const base = ns[0];
        if (base.type !== 'rect')
            return toast('This release supports rectangular and rounded-rectangle masks. Place one behind the content.');
        store.transaction('Create clipping mask', () => {
            const group = node('group', { name: 'Clipping group', x: base.x, y: base.y, w: base.w, h: base.h, rotation: base.rotation, radius: base.radius, fill: 'none', clip: true, children: ns.slice(1) }), inv = inverse(matrix(base));
            for (const n of group.children) {
                const local = mul(inv, matrix(n)), center = point(local, { x: n.w / 2, y: n.h / 2 });
                n.x = center.x - n.w / 2;
                n.y = center.y - n.h / 2;
                n.rotation = Math.atan2(local[1], local[0]) * 180 / Math.PI;
            }
            const at = Math.max(...ns.map(n => list.indexOf(n)));
            list.splice(at + 1, 0, group);
            for (const n of ns)
                list.splice(list.indexOf(n), 1);
            store.reindex();
            select([group.id]);
            expanded.add(group.id);
        });
    },
    component: () => {
        const ns = store.roots();
        if (!ns.length)
            return toast('Select layers to create a symbol.');
        store.transaction('Create symbol', () => {
            if (ns.length === 1 && ns[0].children) {
                ns[0].type = 'symbol';
                ns[0].name = ns[0].name === 'Group' ? 'New symbol' : ns[0].name;
            }
            else
                store.group(true);
        });
        toast('Reusable symbol created');
    }, insertInstance: () => {
        const n = store.selection()[0];
        if (n?.type === 'symbol')
            insertSymbol(n.id);
    }, syncSymbol: () => {
        const n = store.selection()[0];
        if (n?.type === 'symbol') {
            store.transaction('Update symbol instances', () => store.syncSymbols(n));
            toast('All linked instances updated');
        }
    }, detachInstance: () => {
        const n = store.selection()[0];
        if (n?.type === 'instance')
            store.transaction('Detach instance', () => {
                n.type = 'group';
                delete n.masterId;
                delete n.overrides;
            });
    },
    preview: () => {
        previewStack = [];
        showPreview();
    }, closePreview: () => {
        $('#prototype-view').hidden = true;
        previewId = null;
        previewStack = [];
    }, prototypeBack: () => {
        const id = previewStack.pop();
        if (id)
            showPreview(id);
    },
    fitAll, fitSelection: () => {
        if (store.selected.size)
            fitBox(store.bounds());
        else
            fitAll();
    }, zoomIn: () => zoomAt(1.25), zoomOut: () => zoomAt(.8), actualSize: () => zoomAt(1 / camera.zoom),
    toggleGrid: () => {
        showGrid = !showGrid;
        allUI();
    }, toggleRulers: () => {
        showRulers = !showRulers;
        allUI();
    }, toggleSnap: () => {
        snapping = !snapping;
        allUI();
        toast('Smart guides ' + (snapping ? 'enabled' : 'disabled'));
    }, toggleGuides: () => {
        showGuides = !showGuides;
        allUI();
    },
    theme: () => {
        theme = theme === 'light' ? 'dark' : 'light';
        document.documentElement.dataset.theme = theme;
        writePreference('forma-theme', theme);
        dirty = true;
    },
    code: showCode, copyCss: async () => {
        try {
            await navigator.clipboard.writeText($('#css-output').textContent);
            toast('CSS copied');
        }
        catch {
            toast('Clipboard permission unavailable. Select and copy the CSS.');
        }
    },
    shortcuts: () => modal('A shortcut to a good idea', `<p>The little things that keep you in your flow. Use Ctrl in place of ⌘ on Windows and Linux.</p><div class="shortcuts-grid">${[['Select', 'V'], ['Hand / pan', 'H / Space'], ['Rectangle', 'R'], ['Oval', 'O'], ['Vector path', 'P'], ['Text', 'T'], ['Frame', 'A'], ['Line', 'L'], ['Edit points / finish path', 'Enter'], ['Constrain / snap angles', 'Shift'], ['Duplicate while dragging', 'Alt'], ['Move by 10 px', 'Shift + arrows'], ['Undo / redo', '⌘Z / ⇧⌘Z'], ['Group / ungroup', '⌘G / ⇧⌘G'], ['Duplicate', '⌘D'], ['Select all', '⌘A'], ['Copy / paste', '⌘C / ⌘V'], ['Fit page / selection', '1 / 2'], ['100% zoom', '0'], ['Zoom around pointer', '⌘ + wheel'], ['Search commands', '⌘K'], ['Save document', '⌘S'], ['Open document', '⌘O'], ['Export', '⇧⌘E'], ['Delete selection', 'Backspace / Delete'], ['Cancel / exit', 'Esc']].map(([n, k]) => `<div class="shortcut-row"><span>${n}</span><kbd>${k}</kbd></div>`).join('')}</div>`),
    metrics: () => {
        const m = renderer.metrics;
        modal('Renderer diagnostics', `<p>Live measurements from the current session. Frame preparation time is CPU wall time, not GPU timing or a performance benchmark.</p>${Object.entries({ 'Backend': m.backend, 'Visible draw primitives': m.visiblePrimitives, 'GPU draw calls': m.drawCalls, 'CPU preparation': m.cpuMs.toFixed(2) + ' ms', 'Cached texture memory': (m.textureBytes / 1048576).toFixed(2) + ' MiB', 'Rendered frames': m.frame, 'Layer count': store.index.size, 'Canvas resolution': renderer.canvas.width + ' × ' + renderer.canvas.height, 'Device pixel ratio': renderer.dpr }).map(([k, v]) => `<div class="metric-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`).join('')}<div class="help-card"><b>Retained, on demand.</b>Geometry and texture caches survive camera moves. The render loop submits only when invalidated. Shapes are GPU-analytic; vectors are tessellated; text is browser-shaped into cached textures.${m.error ? `<br><br>WebGPU initialization: ${esc(m.error)}` : ''}</div>`);
    },
    about: () => modal('Meet Forma', `<div style="display:flex;align-items:center;gap:14px;margin-bottom:18px"><span class="brand-mark" style="width:48px;height:48px;font-size:37px;border-radius:12px">F</span><div><b style="font-size:23px;letter-spacing:-1px">A little more possible.</b><div style="font-size:10px;color:var(--muted);margin-top:5px">FORMA DESIGN · VERSION 0.1</div></div></div><p>A local-first vector design editor. Built with plain JavaScript and a real WebGPU renderer, with Canvas 2D fallback.</p><div class="help-card"><b>Your canvas. Your computer.</b>No sign-in, analytics, or server uploads. Documents autosave to this browser’s IndexedDB. Download a .forma copy for a durable backup.</div><div class="help-card"><b>An independent implementation.</b>Inspired by Sketch’s familiar design workflow. Not affiliated with Sketch. This is a substantial working editor, not a feature-complete replacement: native Sketch round-tripping, collaboration, advanced typographic shaping controls, arbitrary masks, and plugin compatibility are not included.</div>`),
    command: () => openCommand()
};
function invoke(action, el) {
    closeMenu();
    try {
        if (action.startsWith('tool:'))
            return setTool(action.slice(5));
        if (action.startsWith('zoom:'))
            return zoomAt(Number(action.slice(5)) / 100 / camera.zoom);
        const fn = actions[action];
        if (!fn)
            return;
        const result = fn(el);
        if (result?.catch)
            result.catch(fail);
    }
    catch (e) {
        fail(e);
    }
}
const commandItems = [...fileItems.filter(x => x?.action), ...insertItems.filter(x => x?.action), ...contextItems().filter(x => x?.action), ...booleanItems.filter(x => x?.action), ...['alignLeft', 'alignCenter', 'alignRight', 'alignTop', 'alignMiddle', 'alignBottom', 'distributeH', 'distributeV', 'fitAll', 'fitSelection', 'toggleGrid', 'toggleRulers', 'theme', 'preview', 'code', 'metrics'].map(a => ({ name: a.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase()), action: a, icon: a.startsWith('align') ? a : 'spark' }))];
function openCommand() {
    closeMenu();
    modalAccept = null;
    $('#modal-content').innerHTML = '<input class="command-input" id="command-input" placeholder="What would you like to do?" aria-label="Search commands" autocomplete="off"><div class="command-list" id="command-list"></div><div class="modal-footer" style="justify-content:space-between;font-size:10px;color:var(--muted)"><span>↑ ↓ to navigate · Enter to run</span><span>Esc to close</span></div>';
    if (!$('#modal').open)
        $('#modal').showModal();
    commandIndex = 0;
    const update = () => {
        const q = $('#command-input').value.toLowerCase(), items = commandItems.filter(i => i.name.toLowerCase().includes(q)).filter((i, p, a) => a.findIndex(v => v.action === i.action) === p);
        commandIndex = clamp(commandIndex, 0, Math.max(0, items.length - 1));
        $('#command-list').innerHTML = items.map((i, j) => `<button class="menu-item ${j === commandIndex ? 'focused' : ''}" data-command="${esc(i.action)}">${icon(i.icon || 'spark')}<span>${esc(i.name)}</span>${i.key ? `<kbd>${esc(i.key)}</kbd>` : ''}</button>`).join('') || '<div class="empty-panel">No matching commands</div>';
    };
    $('#command-input').addEventListener('input', () => {
        commandIndex = 0;
        update();
    });
    $('#command-input').addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            commandIndex += e.key === 'ArrowDown' ? 1 : -1;
            update();
            $('#command-list .focused')?.scrollIntoView({ block: 'nearest' });
        }
        else if (e.key === 'Enter') {
            e.preventDefault();
            const action = $('#command-list .focused')?.dataset.command;
            if (action) {
                closeModal();
                invoke(action);
            }
        }
    });
    update();
    setTimeout(() => $('#command-input').focus(), 25);
}
// A single delegated UI surface keeps layers and property panels cheap to rebuild.
document.addEventListener('click', e => {
    const b = e.target.closest('button,[data-layer],[data-insert-symbol]');
    if (!b) {
        if (!e.target.closest('#menu'))
            closeMenu();
        return;
    }
    if (b.dataset.command) {
        closeModal();
        invoke(b.dataset.command);
        return;
    }
    if (b.dataset.action) {
        e.stopPropagation();
        invoke(b.dataset.action, b);
        return;
    }
    if (b.dataset.tool) {
        setTool(b.dataset.tool);
        return;
    }
    if (b.dataset.inspector) {
        inspectorTab = b.dataset.inspector;
        renderInspector(true);
        return;
    }
    if (b.dataset.toggle) {
        const id = b.dataset.toggle;
        expanded.has(id) ? expanded.delete(id) : expanded.add(id);
        renderLayers();
        return;
    }
    if (b.dataset.lock) {
        store.transaction('Toggle layer lock', () => {
            const n = store.get(b.dataset.lock);
            n.locked = !n.locked;
        });
        return;
    }
    if (b.dataset.visible) {
        store.transaction('Toggle layer visibility', () => {
            const n = store.get(b.dataset.visible);
            n.visible = n.visible === false;
        });
        return;
    }
    if (b.dataset.layer) {
        let ids = new Set(store.selected);
        if (e.shiftKey) {
            ids.has(b.dataset.layer) ? ids.delete(b.dataset.layer) : ids.add(b.dataset.layer);
        }
        else
            ids = new Set([b.dataset.layer]);
        select([...ids]);
        return;
    }
    if (b.dataset.page) {
        finishText();
        penId = null;
        vectorId = null;
        store.doc.activePage = b.dataset.page;
        select([]);
        fitInitial();
        allUI();
        scheduleSave();
        return;
    }
    if (b.dataset.preset) {
        const [w, h, name] = b.dataset.preset.split(',');
        createFrame(Number(w), Number(h), name);
        return;
    }
    if (b.dataset.swatch) {
        if (store.selected.size)
            applyProperty('fill', b.dataset.swatch);
        else
            toast(b.dataset.swatch + ' · Select a layer to apply this color');
        return;
    }
    if (b.dataset.textAlign) {
        applyProperty('textAlign', b.dataset.textAlign);
        return;
    }
    if (b.dataset.insertSymbol) {
        insertSymbol(b.dataset.insertSymbol);
        return;
    }
    if (b.dataset.previewFrame) {
        previewStack = [];
        showPreview(b.dataset.previewFrame);
        return;
    }
    if (b.dataset.textStyle) {
        const style = store.doc.textStyles[Number(b.dataset.textStyle)], ns = store.selection().filter(n => n.type === 'text');
        store.transaction('Apply text style', () => {
            if (ns.length)
                ns.forEach(n => Object.assign(n, style, { name: n.name }));
            else {
                const center = world({ x: width / 2, y: height / 2 });
                store.add(text(style.name, center.x, center.y, style.fontSize, '#244C3C', { ...style, w: 450, h: 100 }));
            }
        });
    }
});
document.addEventListener('change', e => {
    const el = e.target;
    if (el.dataset.prop) {
        let v = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
        if (el.type === 'number' && !Number.isFinite(v)) {
            renderInspector(true);
            return;
        }
        if (['fill', 'fill2', 'stroke', 'shadowColor'].includes(el.dataset.prop) && v !== 'none' && !/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(v)) {
            toast('Use a hex color such as #244C3C, or none.');
            renderInspector(true);
            return;
        }
        applyProperty(el.dataset.prop, v);
        el.blur();
        renderInspector(true);
    }
    if (el.dataset.color) {
        if (store.before !== null)
            store.commit();
        allUI();
    }
    if (el.dataset.setting) {
        const s = el.dataset.setting;
        if (s === 'grid')
            showGrid = el.checked;
        if (s === 'rulers')
            showRulers = el.checked;
        if (s === 'snap')
            snapping = el.checked;
        if (s === 'guides')
            showGuides = el.checked;
        dirty = true;
    }
});
document.addEventListener('input', e => {
    const el = e.target;
    if (el.dataset.color) {
        store.begin('Change ' + el.dataset.color + ' color');
        for (const n of store.roots())
            if (!n.locked)
                n[el.dataset.color] = el.value;
        store.emit({ interactive: true });
    }
});
$('#layer-search').addEventListener('input', renderLayers);
$('#pages').addEventListener('dblclick', e => {
    const b = e.target.closest('[data-page]');
    if (b) {
        store.doc.activePage = b.dataset.page;
        actions.renamePage();
    }
});
$('#layer-tree').addEventListener('dblclick', e => {
    const row = e.target.closest('[data-layer]');
    if (row) {
        select([row.dataset.layer]);
        actions.rename();
    }
});
document.addEventListener('contextmenu', e => {
    if (e.target.closest('#stage')) {
        e.preventDefault();
        const n = findHit(world(eventPoint(e)));
        if (n && !store.selected.has(n.id))
            select([n.id]);
        menu(contextItems(), { x: e.clientX, y: e.clientY });
    }
    else if (e.target.closest('[data-layer]')) {
        e.preventDefault();
        const id = e.target.closest('[data-layer]').dataset.layer;
        if (!store.selected.has(id))
            select([id]);
        menu(contextItems(), { x: e.clientX, y: e.clientY });
    }
    else if (e.target.closest('[data-page]')) {
        e.preventDefault();
        store.doc.activePage = e.target.closest('[data-page]').dataset.page;
        menu([{ name: 'Rename page', action: 'renamePage', icon: 'text' }, { name: 'Delete page', action: 'deletePage', icon: 'trash', danger: true }], { x: e.clientX, y: e.clientY });
    }
});
$('#layer-tree').addEventListener('dragstart', e => {
    const row = e.target.closest('[data-layer]');
    if (row) {
        dragLayerId = row.dataset.layer;
        e.dataTransfer.setData('application/x-forma-layer', dragLayerId);
        e.dataTransfer.effectAllowed = 'move';
    }
});
$('#layer-tree').addEventListener('dragover', e => {
    if (dragLayerId) {
        e.preventDefault();
        $$('.drag-over').forEach(r => r.classList.remove('drag-over'));
        e.target.closest('[data-layer]')?.classList.add('drag-over');
    }
});
$('#layer-tree').addEventListener('drop', e => {
    e.preventDefault();
    const row = e.target.closest('[data-layer]'), source = store.info(dragLayerId), target = store.info(row?.dataset.layer);
    $$('.drag-over').forEach(r => r.classList.remove('drag-over'));
    dragLayerId = null;
    if (!source || !target || source.node === target.node)
        return;
    if (target.ancestry.some(n => n.id === source.node.id))
        return toast('A layer cannot contain itself.');
    store.transaction('Reorder layer', () => {
        const oldWorld = source.world;
        source.list.splice(source.list.indexOf(source.node), 1);
        let parent = target.parent, list = target.list;
        if (e.altKey && target.node.children) {
            parent = target.node;
            list = target.node.children;
        }
        const pm = parent ? store.info(parent.id).world : I, lm = mul(inverse(pm), oldWorld), center = point(lm, { x: source.node.w / 2, y: source.node.h / 2 });
        source.node.x = center.x - source.node.w / 2;
        source.node.y = center.y - source.node.h / 2;
        source.node.rotation = Math.atan2(lm[1], lm[0]) * 180 / Math.PI;
        source.node.flipX = false;
        source.node.flipY = (lm[0] * lm[3] - lm[1] * lm[2]) < 0;
        list.splice(parent === target.node ? list.length : list.indexOf(target.node) + 1, 0, source.node);
        if (parent)
            expanded.add(parent.id);
    });
});
$('#layer-tree').addEventListener('dragend', () => {
    dragLayerId = null;
    $$('.drag-over').forEach(r => r.classList.remove('drag-over'));
});
for (const input of [$('#file-input'), $('#image-input')])
    input.addEventListener('change', async (e) => {
        await importFiles([...e.target.files]);
        e.target.value = '';
    });
let dragCounter = 0;
stage.addEventListener('dragenter', e => {
    if (dragLayerId)
        return;
    e.preventDefault();
    dragCounter++;
    $('#drop-hint').hidden = false;
});
stage.addEventListener('dragover', e => {
    if (!dragLayerId)
        e.preventDefault();
});
stage.addEventListener('dragleave', () => {
    if (--dragCounter <= 0)
        $('#drop-hint').hidden = true;
});
stage.addEventListener('drop', e => {
    if (dragLayerId)
        return;
    e.preventDefault();
    dragCounter = 0;
    $('#drop-hint').hidden = true;
    importFiles([...e.dataTransfer.files], world(eventPoint(e)));
});
document.addEventListener('paste', e => {
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName))
        return;
    const files = [...e.clipboardData.files];
    if (files.length) {
        e.preventDefault();
        importFiles(files);
        return;
    }
    const txt = e.clipboardData.getData('text/plain');
    if (txt.trim().startsWith('<svg')) {
        e.preventDefault();
        try {
            const r = importSVG(txt);
            store.transaction('Paste SVG', () => store.add(r.node));
            toast(r.warning);
        }
        catch (err) {
            fail(err);
        }
        return;
    }
    try {
        const data = JSON.parse(txt);
        if (data.format === 'forma-clipboard') {
            e.preventDefault();
            pasteNodes(data.nodes);
        }
    }
    catch {
    }
});
document.addEventListener('keydown', e => {
    if (!store)
        return;
    const editable = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if (!$('#prototype-view').hidden) {
        if (e.key === 'Escape') {
            e.preventDefault();
            actions.closePreview();
        }
        else if (e.key === 'ArrowLeft')
            actions.prototypeBack();
        return;
    }
    if ($('#modal').open)
        return;
    if (editable)
        return;
    const mod = e.metaKey || e.ctrlKey, k = e.key.toLowerCase();
    if (e.code === 'Space') {
        e.preventDefault();
        space = true;
        stage.style.cursor = 'grab';
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        closeMenu();
        if (penId) {
            store.cancel();
            penId = null;
        }
        else if (drag)
            cancelGesture();
        else if (vectorId) {
            vectorId = null;
            activePoint = -1;
        }
        else
            select([]);
        setTool('select');
        return;
    }
    if (mod) {
        const key = e.shiftKey ? 'shift+' + k : k, bindings = { z: 'undo', 'shift+z': 'redo', y: 'redo', a: 'selectAll', g: 'group', 'shift+g': 'ungroup', d: 'duplicate', c: 'copy', x: 'cut', s: 'save', o: 'open', n: 'new', k: 'command', 'shift+k': 'importImage', 'shift+e': 'export', 'shift+l': 'lock', r: 'rename', '[': 'backward', ']': 'forward', 'shift+[': 'back', 'shift+]': 'front', 'shift+c': 'code' };
        if (k === 'f') {
            e.preventDefault();
            $('#layer-search').focus();
            return;
        }
        if (k === 'v')
            return;
        if (bindings[key]) {
            e.preventDefault();
            invoke(bindings[key]);
            return;
        }
        if (e.key === '=' || e.key === '+') {
            e.preventDefault();
            zoomAt(1.25);
            return;
        }
        if (e.key === '-') {
            e.preventDefault();
            zoomAt(.8);
            return;
        }
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        actions.delete();
        return;
    }
    if (e.key === 'Enter') {
        e.preventDefault();
        if (penId)
            finishPen(false);
        else if (vectorId) {
            vectorId = null;
            allUI();
        }
        else
            enterPath();
        return;
    }
    if (e.key.startsWith('Arrow')) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1, dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
        store.transaction('Nudge layers', () => {
            for (const n of store.roots()) {
                if (n.locked)
                    continue;
                const m = inverse(store.info(n.id).parentMatrix);
                n.x += m[0] * dx + m[2] * dy;
                n.y += m[1] * dx + m[3] * dy;
            }
        });
        return;
    }
    if (e.key === '?' || k === 'f1') {
        e.preventDefault();
        actions.shortcuts();
        return;
    }
    if (e.shiftKey && k === 'r') {
        actions.toggleRulers();
        return;
    }
    if (e.key === "'") {
        actions.toggleGrid();
        return;
    }
    if (k === '1') {
        fitAll();
        return;
    }
    if (k === '2') {
        actions.fitSelection();
        return;
    }
    if (k === '0') {
        actions.actualSize();
        return;
    }
    if (e.key === '+' || e.key === '=') {
        zoomAt(1.25);
        return;
    }
    if (e.key === '-') {
        zoomAt(.8);
        return;
    }
    const tools = { v: 'select', h: 'hand', a: 'frame', r: 'rect', o: 'ellipse', l: 'line', p: 'pen', t: 'text' };
    if (tools[k]) {
        e.preventDefault();
        setTool(tools[k]);
    }
});
document.addEventListener('keyup', e => {
    if (e.code === 'Space') {
        space = false;
        stage.style.cursor = tool === 'hand' ? 'grab' : tool === 'select' ? 'default' : 'crosshair';
    }
});
window.addEventListener('blur', () => {
    space = false;
    if (drag && !['pen'].includes(drag.kind))
        cancelGesture();
});
// Tooltips do not move focus or interfere with pointer capture.
document.addEventListener('pointerover', e => {
    const el = e.target.closest('[title]');
    clearTimeout(tipTimer);
    $('#tooltip').hidden = true;
    if (!el?.title || drag)
        return;
    const title = el.title;
    tipTimer = setTimeout(() => {
        if (drag)
            return;
        const r = el.getBoundingClientRect(), tip = $('#tooltip');
        tip.textContent = title;
        tip.hidden = false;
        tip.style.top = Math.min(innerHeight - 36, r.bottom + 7) + 'px';
        tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, r.left + r.width / 2 - tip.offsetWidth / 2)) + 'px';
    }, 750);
});
document.addEventListener('pointerout', () => {
    clearTimeout(tipTimer);
    $('#tooltip').hidden = true;
});
async function saveLocal() {
    if (!persistence?.db)
        return;
    if (saveRunning) {
        saveAgain = true;
        return;
    }
    saveRunning = true;
    try {
        await persistence.save(store.doc);
        $('#save-status').textContent = 'Saved on this device';
        lastSaveRevision = store.revision;
    }
    catch (e) {
        $('#save-status').textContent = 'Save a backup';
        toast('Local autosave failed. Save a .forma copy to protect your work.');
        console.warn(e);
    }
    finally {
        saveRunning = false;
        if (saveAgain) {
            saveAgain = false;
            saveLocal();
        }
    }
}
function scheduleSave() {
    if (!persistence?.db) {
        $('#save-status').textContent = 'Temporary session';
        return;
    }
    $('#save-status').textContent = 'Saving…';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveLocal, 600);
}
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearTimeout(saveTimer);
        saveLocal();
    }
});
stage.addEventListener('pointerdown', () => $('.workspace').classList.remove('show-layers', 'show-inspector'));
async function start() {
    icons();
    let doc = null;
    try {
        persistence = new Persistence();
        await persistence.open();
        const stored = await persistence.load();
        if (stored)
            doc = validateDocument(stored);
    }
    catch (e) {
        console.warn('Local persistence unavailable', e);
        $('#save-status').textContent = 'Temporary session';
    }
    store = new DocumentStore(doc || demoDocument());
    store.addEventListener('change', e => {
        dirty = true;
        if (e.detail.commit) {
            uiDirty = true;
            scheduleSave();
        }
        else if (!e.detail.interactive)
            uiDirty = true;
    });
    store.addEventListener('selection', () => {
        uiDirty = true;
        dirty = true;
    });
    renderer = new Renderer($('#gpu-canvas'), invalidate, (mode, reason) => {
        $('#renderer-status').textContent = mode;
        if (mode === 'Canvas 2D')
            $('.renderer-badge i').style.background = '#CCAA62';
    });
    await renderer.init(new URLSearchParams(location.search).get('renderer') === 'canvas');
    resizeCanvas();
    new ResizeObserver(resizeCanvas).observe(stage);
    fitInitial();
    if (!doc) {
        const hero = [...store.index.values()].find(i => i.node.name === 'Hero headline');
        if (hero) {
            store.select([hero.node.id]);
            expandTo(hero.node.id);
        }
    }
    setTool('select');
    renderUI();
    frame();
    if (!doc)
        scheduleSave();
    window.forma = { store, renderer, camera, actions, select, fitBox, createFrame, importFiles, exportSVG, exportPNG, exportNodes, booleanOperation, ready: true, get tool() {
            return tool;
        }, get vectorId() {
            return vectorId;
        }, get previewId() {
            return previewId;
        }, get state() {
            return { tool, vectorId, previewId, dirty, drag: drag?.kind || null };
        } };
    document.dispatchEvent(new Event('forma-ready'));
}
start().catch(e => {
    console.error(e);
    $('#inspector').innerHTML = `<div class="loading-error"><b>Forma could not start.</b><p>${esc(e.message)}</p><p>Serve the files over localhost or HTTPS. Open developer tools for details.</p></div>`;
    $('#renderer-status').textContent = 'Startup error';
});
