/**
 * Retained document model and transactional editing. Page roots own their nested
 * nodes; the derived index stores world transforms, ancestry and parent lists.
 * Snapshot history makes every committed editing gesture atomic. Symbol source
 * identities are separate from instance identities and property overrides.
 */
import { I, matrix, mul, point, inverse, corners, bounds, unionBounds, clamp } from './geometry.js';
export const uid = () => globalThis.crypto?.randomUUID?.() || `f-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
export const clone = v => structuredClone(v);
export const TYPES = new Set(['rect', 'ellipse', 'path', 'line', 'star', 'polygon', 'text', 'image', 'frame', 'group', 'symbol', 'instance']);
export function node(type, props = {}) {
    return { id: uid(), type, name: type[0].toUpperCase() + type.slice(1), x: 0, y: 0, w: 160, h: 100, rotation: 0, opacity: 1, visible: true, locked: false, fill: type === 'line' || type === 'path' ? 'none' : '#DDEAE1', fill2: '#85BBA0', gradient: false, gradientAngle: 90, stroke: type === 'line' || type === 'path' ? '#234B3B' : 'none', strokeWidth: type === 'line' || type === 'path' ? 2 : 0, radius: 0, ...props };
}
export function text(label, x, y, size = 16, color = '#203D32', extra = {}) {
    return node('text', { name: label, text: label, x, y, w: Math.max(50, label.length * size * .65), h: size * 1.45, fontSize: size, fontFamily: 'Arial', fontWeight: 400, fontStyle: 'normal', lineHeight: 1.25, letterSpacing: 0, textAlign: 'left', fill: color, ...extra });
}
export function rect(name, x, y, w, h, fill, radius = 0, extra = {}) {
    return node('rect', { name, x, y, w, h, fill, radius, ...extra });
}
export function path(name, points, fill, extra = {}) {
    let b = bounds(points);
    return node('path', { name, x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), points: points.map(p => ({ x: p.x - b.x, y: p.y - b.y })), closed: true, fill, stroke: 'none', strokeWidth: 0, ...extra });
}
function landscape(x, y, w, h, variant = 0) {
    const colors = variant ? ['#D9E6CE', '#9EB7A4', '#5E8A79', '#416B60', '#254F45'] : ['#DCE9E4', '#9DC1B5', '#669989', '#427B69', '#1E5649'];
    const g = node('group', { name: variant ? 'Valley illustration' : 'Alpine illustration', x, y, w, h, fill: 'none', clip: true, radius: 14, children: [] }), c = g.children;
    c.push(rect('Sky', 0, 0, w, h, colors[0]));
    c.push(node('ellipse', { name: 'Morning sun', x: w * .7, y: h * .12, w: w * .14, h: w * .14, fill: '#F5E7B6' }));
    c.push(path('Distant peaks', [{ x: 0, y: h * .53 }, { x: w * .2, y: h * .18 }, { x: w * .39, y: h * .48 }, { x: w * .56, y: h * .15 }, { x: w * .88, y: h * .49 }, { x: w, y: h * .34 }, { x: w, y: h }, { x: 0, y: h }], colors[1]));
    c.push(path('Snow line', [{ x: w * .4, y: h * .38 }, { x: w * .56, y: h * .15 }, { x: w * .73, y: h * .34 }, { x: w * .62, y: h * .3 }, { x: w * .58, y: h * .34 }, { x: w * .53, y: h * .27 }, { x: w * .5, y: h * .35 }], '#F0F3E8'));
    c.push(path('Mountain ridge', [{ x: 0, y: h * .58 }, { x: w * .31, y: h * .36 }, { x: w * .6, y: h * .68 }, { x: w * .84, y: h * .42 }, { x: w, y: h * .5 }, { x: w, y: h }, { x: 0, y: h }], colors[2]));
    c.push(path('Lake shore', [{ x: 0, y: h * .74 }, { x: w * .23, y: h * .62 }, { x: w * .61, y: h * .76 }, { x: w, y: h * .6 }, { x: w, y: h }, { x: 0, y: h }], colors[3]));
    c.push(path('Glacial lake', [{ x: w * .08, y: h * .85 }, { x: w * .3, y: h * .76 }, { x: w * .57, y: h * .81 }, { x: w * .92, y: h * .72 }, { x: w * .63, y: h * .9 }, { x: w * .78, y: h }, { x: w * .17, y: h }], '#AECAC0'));
    c.push(path('Foreground', [{ x: 0, y: h * .84 }, { x: w * .1, y: h * .79 }, { x: w * .26, y: h }, { x: 0, y: h }], colors[4]));
    for (let i = 0; i < 7; i++) {
        let xx = w * (.04 + i * .033), yy = h * (.7 + i * .036), sz = w * (.025 + i * .002);
        c.push(path('Pine tree', [{ x: xx, y: yy - sz * 2 }, { x: xx - sz, y: yy }, { x: xx + sz, y: yy }], colors[4]));
    }
    return g;
}
export function demoDocument() {
    const green = '#244C3C', ink = '#173F31', muted = '#7C877E', orange = '#ED7855', cream = '#F8F8F1';
    const main = node('frame', { name: '01 — Roam · Desktop', x: 0, y: 0, w: 1080, h: 820, fill: cream, clip: true, children: [] }), c = main.children;
    c.push(text('roam', 44, 24, 31, ink, { fontWeight: 700, letterSpacing: -1.5 }));
    c.push(text('Places', 360, 35, 13, ink, { w: 70 }), text('Experiences', 455, 35, 13, ink, { w: 95 }), text('Our story', 580, 35, 13, ink, { w: 100 }));
    c.push(rect('Navigation · Get inspired', 892, 25, 145, 38, green, 20), text('Get inspired  ↗', 911, 36, 12, '#FFFFFF', { w: 125, fontWeight: 600 }));
    c.push(rect('Header divider', 44, 84, 992, 1, '#E3E6DB'));
    c.push(rect('Eyebrow pill', 46, 124, 174, 25, '#E7EBDD', 13), text('✦   OUTSIDE IS CALLING', 58, 131, 9, green, { letterSpacing: 1.05, w: 165, fontWeight: 600 }));
    c.push(text('A little further.\nA little freer.', 44, 174, 65, ink, { name: 'Hero headline', fontFamily: 'Georgia', lineHeight: 1.02, w: 550, h: 147, letterSpacing: -2.8 }));
    c.push(text('For the places that move you. And the moments\nthat stay with you long after you’re home.', 48, 338, 15, muted, { w: 425, h: 45, lineHeight: 1.55 }));
    const btn = node('symbol', { name: 'Button / Primary', x: 47, y: 407, w: 199, h: 48, fill: 'none', children: [rect('Background', 0, 0, 199, 48, green, 25), text('Explore somewhere new', 19, 17, 12, '#FFFFFF', { w: 175, fontWeight: 600 })] });
    c.push(btn);
    c.push(text('Thoughtfully curated. Wonderfully wild.', 48, 474, 10, muted, { w: 330 }));
    const art = landscape(618, 119, 416, 356);
    art.radius = 112;
    art.name = 'Hero · The great outdoors';
    c.push(art);
    c.push(rect('Postcard label', 589, 365, 165, 78, '#FFFFFF', 10, { rotation: -8, shadowEnabled: true, shadowColor: '#163D31', shadowOpacity: .12, shadowX: 0, shadowY: 7, shadowBlur: 15 }));
    c.push(text('46°38′ N  12°18′ E', 606, 381, 9, muted, { rotation: -8, w: 160 }), text('Find your kind\nof nowhere.', 606, 398, 16, ink, { rotation: -8, w: 148, h: 42, fontFamily: 'Georgia' }));
    c.push(text('A change of scenery', 45, 551, 27, ink, { w: 560, fontFamily: 'Georgia' }));
    c.push(text('THE GOOD KIND OF GETTING LOST', 47, 590, 9, muted, { w: 400, letterSpacing: 1.2 }));
    c.push(text('Explore all places   ↗', 905, 563, 11, green, { w: 150 }));
    const names = ['Higher grounds', 'A slower kind of day', 'Take the scenic route'];
    const locs = ['DOLOMITES, ITALY', 'LAKE DISTRICT, ENGLAND', 'JULIAN ALPS, SLOVENIA'];
    for (let i = 0; i < 3; i++) {
        let x = 45 + i * 338;
        const a = landscape(x, 623, 314, 114, i % 2);
        a.radius = 9;
        c.push(a, text(names[i], x, 749, 15, ink, { w: 310, fontWeight: 600 }), text(locs[i], x, 775, 8, muted, { w: 310, letterSpacing: 1.2 }));
    }
    const mobile = node('frame', { name: '02 — Roam · Mobile', x: 1180, y: 0, w: 350, h: 756, fill: cream, clip: true, radius: 0, children: [] }), m = mobile.children;
    m.push(text('9:41', 23, 16, 11, ink, { fontWeight: 700, w: 50 }), text('● ▰', 293, 16, 11, ink, { w: 40 }));
    m.push(text('roam', 25, 51, 29, ink, { fontWeight: 700, letterSpacing: -1 }), text('☰', 305, 56, 20, green, { w: 28 }));
    m.push(rect('Eyebrow', 25, 115, 172, 25, '#E7EBDD', 13), text('✦   OUTSIDE IS CALLING', 37, 123, 9, green, { w: 164, fontWeight: 600, letterSpacing: 1 }));
    m.push(text('A little further.\nA little freer.', 23, 165, 44, ink, { w: 324, h: 103, fontFamily: 'Georgia', lineHeight: 1.06, letterSpacing: -1.7 }));
    m.push(text('For the places that move you.\nAnd the moments that stay with you.', 25, 284, 12, muted, { w: 308, h: 42, lineHeight: 1.6 }));
    const inst = clone(btn);
    function ids(n) {
        n.sourceId = n.id;
        n.id = uid();
        n.children?.forEach(ids);
    }
    ids(inst);
    inst.type = 'instance';
    inst.masterId = btn.id;
    inst.name = 'Button / Primary instance';
    inst.x = 25;
    inst.y = 350;
    m.push(inst);
    m.push(landscape(25, 425, 300, 244));
    m.push(text('Go where you feel alive.', 25, 694, 19, ink, { w: 310, fontFamily: 'Georgia' }));
    // A prototype connection is a real document property, not a decorative hotspot.
    btn.link = mobile.id;
    inst.link = main.id;
    const styles = node('frame', { name: 'Brand foundations', x: 0, y: 940, w: 1080, h: 400, fill: '#FFFFFF', clip: true, children: [text('The feeling of somewhere new.', 36, 27, 31, ink, { w: 950, fontFamily: 'Georgia' }), text('ROAM / VISUAL IDENTITY', 38, 82, 10, muted, { letterSpacing: 2, w: 500 })] });
    [ink, green, '#AECAC0', cream, orange].forEach((color, i) => {
        styles.children.push(rect('Color / ' + color, 38 + i * 204, 133, 188, 102, color, 9), text(color, 39 + i * 204, 248, 12, muted, { w: 180 }));
    });
    styles.children.push(text('Aa   Georgia', 39, 298, 34, ink, { fontFamily: 'Georgia', w: 440 }), text('Aa   Arial / Regular / Medium / Bold', 535, 310, 18, ink, { w: 500 }));
    return { format: 'forma', version: 1, id: uid(), name: 'Roam — Brand & website', activePage: 'page-design', pages: [{ id: 'page-design', name: 'Website design', nodes: [main, mobile, styles] }, { id: 'page-explorations', name: 'Explorations', nodes: [] }], colors: [ink, green, '#AECAC0', cream, orange, '#FFFFFF', '#151515', '#A48CBE'], textStyles: [{ name: 'Display / Editorial', fontFamily: 'Georgia', fontSize: 48, lineHeight: 1.1, fontWeight: 400 }, { name: 'Body / Regular', fontFamily: 'Arial', fontSize: 16, lineHeight: 1.5, fontWeight: 400 }], assets: {} };
}
export function validateDocument(raw) {
    if (!raw || raw.format !== 'forma' || raw.version !== 1 || !Array.isArray(raw.pages))
        throw Error('This is not a supported Forma v1 document.');
    raw.name = typeof raw.name === 'string' ? raw.name.slice(0, 250) : 'Untitled';
    if (raw.pages.length > 100)
        throw Error('Too many pages.');
    let count = 0, ids = new Set();
    const check = (n, depth = 0) => {
        if (++count > 30000 || depth > 50)
            throw Error('Document complexity limit exceeded.');
        if (!TYPES.has(n.type) || typeof n.id !== 'string' || ids.has(n.id))
            throw Error('Invalid or duplicate layer identity.');
        ids.add(n.id);
        n.fontStyle = ['normal', 'italic', 'oblique'].includes(n.fontStyle) ? n.fontStyle : 'normal';
        if (n.fontWeight != null) {
            const w = Number(n.fontWeight);
            n.fontWeight = Number.isFinite(w) ? Math.max(1, Math.min(1000, w)) : 400;
        }
        n.name = typeof n.name === 'string' ? n.name.slice(0, 500) : n.type;
        if (n.text != null && typeof n.text !== 'string')
            throw Error('Invalid text content.');
        if (n.fontFamily != null && typeof n.fontFamily !== 'string')
            throw Error('Invalid font family.');
        for (const k of ['fill', 'fill2', 'stroke', 'shadowColor'])
            if (n[k] != null && n[k] !== 'none' && !/^#[0-9a-f]{3}([0-9a-f]{3})?([0-9a-f]{2})?$/i.test(n[k]))
                throw Error('Invalid color.');
        if (n.blend && !['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten'].includes(n.blend))
            throw Error('Invalid blend mode.');
        for (const k of ['rotation', 'opacity', 'radius', 'strokeWidth', 'fontSize', 'lineHeight', 'letterSpacing', 'gradientAngle', 'shadowBlur', 'shadowX', 'shadowY', 'shadowOpacity', 'gap', 'padding', 'innerRadius', 'sides'])
            if (n[k] != null && (!Number.isFinite(n[k]) || Math.abs(n[k]) > 1e7))
                throw Error('Invalid numeric layer property.');
        for (const k of ['x', 'y', 'w', 'h'])
            if (!Number.isFinite(n[k]) || Math.abs(n[k]) > 1e7)
                throw Error('Invalid layer geometry.');
        n.w = Math.max(.01, n.w);
        n.h = Math.max(.01, n.h);
        if (n.children) {
            if (!Array.isArray(n.children))
                throw Error('Invalid children.');
            n.children.forEach(c => check(c, depth + 1));
        }
        for (const k of ['points', 'contours'])
            if (n[k] && JSON.stringify(n[k]).length > 2000000)
                throw Error('Path exceeds size limit.');
        for (const p of (n.points || [])) {
            for (const q of [p, p.in, p.out].filter(Boolean))
                if (!Number.isFinite(q.x) || !Number.isFinite(q.y) || Math.abs(q.x) > 1e7 || Math.abs(q.y) > 1e7)
                    throw Error('Invalid vector point.');
        }
        if (n.contours) {
            if (!Array.isArray(n.contours) || n.contours.some(r => !Array.isArray(r) || r.some(q => !q || !Number.isFinite(q.x) || !Number.isFinite(q.y))))
                throw Error('Invalid compound path.');
        }
        if (n.type === 'image' && n.src && !/^data:image\/(png|jpeg|webp|gif);base64,/i.test(n.src))
            throw Error('Only embedded raster images are accepted in Forma documents.');
    };
    let pids = new Set();
    for (const p of raw.pages) {
        if (typeof p.id !== 'string' || pids.has(p.id) || !Array.isArray(p.nodes))
            throw Error('Invalid page.');
        pids.add(p.id);
        p.name = typeof p.name === 'string' ? p.name.slice(0, 250) : 'Page';
        p.nodes.forEach(n => check(n));
    }
    if (!raw.pages.length)
        throw Error('Document needs a page.');
    raw.name = typeof raw.name === 'string' ? raw.name.slice(0, 500) : 'Untitled design';
    raw.id = typeof raw.id === 'string' ? raw.id : uid();
    raw.activePage = pids.has(raw.activePage) ? raw.activePage : raw.pages[0].id;
    raw.colors = Array.isArray(raw.colors) ? raw.colors.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 100) : [];
    raw.textStyles = Array.isArray(raw.textStyles) ? raw.textStyles.slice(0, 100) : [];
    raw.assets = {};
    return raw;
}
export class DocumentStore extends EventTarget {
    constructor(doc) {
        super();
        this.doc = doc;
        this.selected = new Set();
        this.undoStack = [];
        this.redoStack = [];
        this.before = null;
        this.label = '';
        this.revision = 0;
        this.index = new Map();
        this.reindex();
    }
    get page() {
        return this.doc.pages.find(p => p.id === this.doc.activePage) || this.doc.pages[0];
    }
    reindex() {
        this.index.clear();
        for (const page of this.doc.pages) {
            const walk = (ns, parent = null, parentMatrix = I, ancestry = []) => ns.forEach((n, i) => {
                let world = mul(parentMatrix, matrix(n));
                this.index.set(n.id, { node: n, parent, list: ns, index: i, world, parentMatrix, page, ancestry });
                if (n.children)
                    walk(n.children, n, world, [...ancestry, n]);
            });
            walk(page.nodes);
        }
    }
    get(id) {
        return this.index.get(id)?.node;
    }
    info(id) {
        return this.index.get(id);
    }
    selection() {
        return [...this.selected].map(id => this.get(id)).filter(Boolean);
    }
    roots() {
        return this.selection().filter(n => !this.info(n.id).ancestry.some(a => this.selected.has(a.id)));
    }
    emit(detail = {}) {
        this.revision++;
        this.reindex();
        for (const id of this.selected)
            if (!this.index.has(id))
                this.selected.delete(id);
        this.dispatchEvent(new CustomEvent('change', { detail }));
    }
    select(ids) {
        this.selected = new Set(ids.filter(id => this.index.has(id)));
        this.dispatchEvent(new CustomEvent('selection'));
    }
    begin(label) {
        if (this.before === null) {
            this.before = JSON.stringify(this.doc);
            this.label = label;
        }
    }
    commit() {
        if (this.before === null)
            return;
        if (JSON.stringify(this.doc) !== this.before)
            this.synchronizeChanges(JSON.parse(this.before));
        const after = JSON.stringify(this.doc);
        if (after !== this.before) {
            this.undoStack.push({ data: this.before, label: this.label });
            let bytes = this.undoStack.reduce((s, v) => s + v.data.length, 0);
            while (this.undoStack.length > 80 || bytes > 24000000 && this.undoStack.length > 1)
                bytes -= this.undoStack.shift().data.length;
            this.redoStack = [];
        }
        this.before = null;
        this.emit({ commit: true });
    }
    cancel() {
        if (this.before !== null) {
            this.doc = JSON.parse(this.before);
            this.before = null;
            this.emit();
        }
    }
    transaction(label, fn) {
        this.begin(label);
        try {
            fn();
            this.commit();
        }
        catch (e) {
            this.cancel();
            throw e;
        }
    }
    undo() {
        if (this.before !== null)
            this.cancel();
        let h = this.undoStack.pop();
        if (!h)
            return;
        this.redoStack.push({ data: JSON.stringify(this.doc), label: h.label });
        this.doc = JSON.parse(h.data);
        this.emit({ commit: true });
    }
    redo() {
        let h = this.redoStack.pop();
        if (!h)
            return;
        this.undoStack.push({ data: JSON.stringify(this.doc), label: h.label });
        this.doc = JSON.parse(h.data);
        this.emit({ commit: true });
    }
    bounds(ids = [...this.selected]) {
        return unionBounds(ids.map(id => this.info(id)).filter(Boolean).map(i => bounds(corners(i.node, i.world))));
    }
    add(n, parent = null) {
        (parent?.children || this.page.nodes).push(n);
        this.reindex();
        this.select([n.id]);
        return n;
    }
    remove() {
        let roots = this.roots();
        for (const n of roots) {
            const i = this.info(n.id);
            i.list.splice(i.list.indexOf(n), 1);
        }
        this.selected.clear();
    }
    duplicate(offset = 20) {
        let output = [];
        for (const n of this.roots()) {
            let c = clone(n);
            resetIds(c);
            c.x += offset;
            c.y += offset;
            const i = this.info(n.id);
            i.list.splice(i.list.indexOf(n) + 1, 0, c);
            output.push(c.id);
        }
        this.reindex();
        this.select(output);
        return output;
    }
    group(symbol = false) {
        const ns = this.roots();
        if (!ns.length)
            return;
        const infos = ns.map(n => this.info(n.id));
        if (infos.some(i => i.parent !== infos[0].parent))
            throw Error('Group layers that share a parent.');
        const b = unionBounds(ns.map(n => bounds(corners(n, matrix(n))))), list = infos[0].list;
        const g = node(symbol ? 'symbol' : 'group', { name: symbol ? 'New symbol' : 'Group', ...b, fill: 'none', children: ns.sort((a, b) => list.indexOf(a) - list.indexOf(b)) });
        let at = Math.max(...ns.map(n => list.indexOf(n)));
        list.splice(at + 1, 0, g);
        for (const n of ns) {
            n.x -= b.x;
            n.y -= b.y;
            list.splice(list.indexOf(n), 1);
        }
        this.reindex();
        this.select([g.id]);
        return g;
    }
    ungroup() {
        for (const n of this.roots()) {
            if (!n.children)
                continue;
            const i = this.info(n.id), at = i.list.indexOf(n), m = matrix(n);
            for (const c of n.children) {
                const wc = mul(m, matrix(c)), cx = point(wc, { x: c.w / 2, y: c.h / 2 });
                c.x = cx.x - c.w / 2;
                c.y = cx.y - c.h / 2;
                c.rotation = Math.atan2(wc[1], wc[0]) * 180 / Math.PI;
                c.flipX = false;
                c.flipY = (wc[0] * wc[3] - wc[1] * wc[2]) < 0;
            }
            i.list.splice(at, 1, ...n.children);
            this.selected.delete(n.id);
            n.children.forEach(c => this.selected.add(c.id));
        }
        this.reindex();
    }
    resize(n, w, h) {
        w = Math.max(1, w);
        h = Math.max(1, h);
        let sx = w / n.w, sy = h / n.h;
        if (n.children && n.layout && n.layout !== 'none') {
            n.w = w;
            n.h = h;
            this.layout(n);
            return;
        }
        if (n.children)
            for (const c of n.children) {
                if (c.constraints === 'right')
                    c.x += w - n.w;
                else if (c.constraints === 'stretch') {
                    this.resize(c, c.w + w - n.w, c.h);
                }
                else if (c.constraints === 'center')
                    c.x += (w - n.w) / 2;
                else {
                    c.x *= sx;
                    c.y *= sy;
                    this.resize(c, c.w * sx, c.h * sy);
                }
            }
        if (n.points)
            for (const p of n.points) {
                p.x *= sx;
                p.y *= sy;
                for (const k of ['in', 'out'])
                    if (p[k]) {
                        p[k].x *= sx;
                        p[k].y *= sy;
                    }
            }
        if (n.contours)
            for (const r of n.contours)
                for (const p of r) {
                    p.x *= sx;
                    p.y *= sy;
                }
        if (n.type === 'text' && n.scaleText)
            n.fontSize *= sy;
        n.w = w;
        n.h = h;
    }
    layout(n) {
        if (!n.children || !n.layout || n.layout === 'none')
            return;
        let horizontal = n.layout === 'horizontal', padding = n.padding ?? 16, gap = n.gap ?? 12, pos = padding;
        for (const c of n.children.filter(c => c.visible !== false)) {
            if (horizontal) {
                c.x = pos;
                c.y = n.align === 'center' ? (n.h - c.h) / 2 : n.align === 'end' ? n.h - padding - c.h : padding;
                pos += c.w + gap;
            }
            else {
                c.y = pos;
                c.x = n.align === 'center' ? (n.w - c.w) / 2 : n.align === 'end' ? n.w - padding - c.w : padding;
                pos += c.h + gap;
            }
        }
        if (n.hug) {
            if (horizontal)
                n.w = Math.max(1, pos - gap + padding);
            else
                n.h = Math.max(1, pos - gap + padding);
        }
    }
    synchronizeChanges(previous) {
        this.reindex();
        const old = new Map();
        const scan = ns => ns.forEach(n => {
            old.set(n.id, n);
            if (n.children)
                scan(n.children);
        });
        previous.pages.forEach(p => scan(p.nodes));
        const keys = ['text', 'fill', 'fill2', 'gradient', 'gradientAngle', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'textAlign', 'lineHeight', 'letterSpacing', 'opacity', 'visible', 'src', 'radius', 'stroke', 'strokeWidth'];
        for (const info of this.index.values()) {
            const n = info.node, before = old.get(n.id);
            if (!before || !n.sourceId)
                continue;
            const inst = [...info.ancestry].reverse().find(a => a.type === 'instance');
            if (!inst)
                continue;
            for (const k of keys)
                if (JSON.stringify(n[k]) !== JSON.stringify(before[k])) {
                    inst.overrides ??= {};
                    inst.overrides[n.sourceId] ??= {};
                    inst.overrides[n.sourceId][k] = n[k];
                }
        }
        const changed = [...this.index.values()].map(i => i.node).filter(n => n.type === 'symbol' && old.has(n.id) && JSON.stringify(n) !== JSON.stringify(old.get(n.id)));
        for (const master of changed)
            this.syncSymbols(master);
        this.reindex();
    }
    syncSymbols(master) {
        const instances = [...this.index.values()].map(i => i.node).filter(n => n.type === 'instance' && n.masterId === master.id);
        for (const n of instances) {
            const overrides = n.overrides || {}, w = n.w, h = n.h;
            n.children = clone(master.children || []);
            const walk = cs => cs.forEach(c => {
                c.sourceId = c.id;
                c.id = uid();
                if (c.children)
                    walk(c.children);
            });
            walk(n.children);
            n.w = master.w;
            n.h = master.h;
            this.resize(n, w, h);
            const apply = cs => cs.forEach(c => {
                if (overrides[c.sourceId])
                    Object.assign(c, overrides[c.sourceId]);
                if (c.children)
                    apply(c.children);
            });
            apply(n.children);
        }
    }
}
/** Duplicate identities without destroying existing symbol source references.
 * linkToSource is used only when creating a fresh instance from a master. */
export function resetIds(n, linkToSource = false) {
    if (linkToSource)
        n.sourceId = n.id;
    n.id = uid();
    n.children?.forEach(c => resetIds(c, linkToSource));
    return n;
}
export class Persistence {
    async open() {
        return new Promise((resolve, reject) => {
            const r = indexedDB.open('forma-local', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('documents');
            r.onsuccess = () => {
                this.db = r.result;
                resolve();
            };
            r.onerror = () => reject(r.error);
        });
    }
    async load() {
        return new Promise((resolve, reject) => {
            let r = this.db.transaction('documents').objectStore('documents').get('current');
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        });
    }
    async save(doc) {
        return new Promise((resolve, reject) => {
            let t = this.db.transaction('documents', 'readwrite');
            t.objectStore('documents').put(clone(doc), 'current');
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
            t.onabort = () => reject(t.error);
        });
    }
}
