/**
 * Portable Forma JSON, vector SVG, raster PNG, sanitized SVG import and a bounded
 * Sketch ZIP/JSON compatibility importer. Sketch import is deliberately a subset;
 * unsupported features generate warnings rather than a lossless-compatibility claim.
 */
import { node, uid, clone, resetIds, validateDocument } from './document.js';
import { matrix, bounds, point, flatten, clamp } from './geometry.js';
import { paintTree, textLines, font } from './renderer.js';
export const escapeXML = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));
export function download(name, data, type = 'application/octet-stream') {
    const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
}
export const readDataURL = file => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
});
const num = n => Math.round(n * 1e4) / 1e4;
export function svgPath(n) {
    if (n.contours)
        return n.contours.map(r => r.length ? 'M' + r.map(p => `${num(p.x)} ${num(p.y)}`).join('L') + 'Z' : '').join('');
    const ps = n.points || [];
    if (!ps.length)
        return '';
    let d = `M${num(ps[0].x)} ${num(ps[0].y)}`;
    for (let i = 0; i < ps.length - (n.closed ? 0 : 1); i++) {
        const a = ps[i], b = ps[(i + 1) % ps.length];
        if (a.out || b.in) {
            let c = a.out || a, e = b.in || b;
            d += `C${num(c.x)} ${num(c.y)} ${num(e.x)} ${num(e.y)} ${num(b.x)} ${num(b.y)}`;
        }
        else
            d += `L${num(b.x)} ${num(b.y)}`;
    }
    return d + (n.closed ? 'Z' : '');
}
export function exportSVG(nodes, box) {
    let defs = [], counter = 0;
    const ctx = document.createElement('canvas').getContext('2d');
    function shape(n, attributes) {
        const a = ` ${attributes}`;
        if (n.type === 'ellipse')
            return `<ellipse cx="${n.w / 2}" cy="${n.h / 2}" rx="${n.w / 2}" ry="${n.h / 2}"${a}/>`;
        if (n.type === 'path' || n.type === 'line')
            return `<path d="${svgPath(n)}"${a}/>`;
        if (n.type === 'star' || n.type === 'polygon')
            return `<polygon points="${flatten(n)[0].map(p => `${num(p.x)},${num(p.y)}`).join(' ')}"${a}/>`;
        return `<rect width="${n.w}" height="${n.h}" rx="${n.radius || 0}"${a}/>`;
    }
    function render(n) {
        if (n.visible === false)
            return '';
        let id = 'f' + counter++, fill = escapeXML(n.fill || 'none');
        if (n.gradient && n.fill !== 'none') {
            let rad = (n.gradientAngle || 0) * Math.PI / 180, dx = Math.cos(rad) / 2, dy = Math.sin(rad) / 2;
            defs.push(`<linearGradient id="${id}g" x1="${.5 - dx}" y1="${.5 - dy}" x2="${.5 + dx}" y2="${.5 + dy}"><stop stop-color="${fill}"/><stop offset="1" stop-color="${escapeXML(n.fill2 || '#FFFFFF')}"/></linearGradient>`);
            fill = `url(#${id}g)`;
        }
        let filter = '';
        if (n.shadowEnabled) {
            defs.push(`<filter id="${id}s" x="-100%" y="-100%" width="300%" height="300%"><feDropShadow dx="${n.shadowX || 0}" dy="${n.shadowY || 4}" stdDeviation="${(n.shadowBlur || 12) / 2}" flood-color="${escapeXML(n.shadowColor || '#000000')}" flood-opacity="${n.shadowOpacity ?? .18}"/></filter>`);
            filter = ` filter="url(#${id}s)"`;
        }
        let attrs = `fill="${fill}" stroke="${escapeXML(n.stroke || 'none')}" stroke-width="${n.strokeWidth || 0}" stroke-linecap="round" stroke-linejoin="round" fill-rule="evenodd"`, body = '';
        if (n.type === 'text') {
            ctx.font = font(n);
            let lines = textLines(ctx, n), lh = (n.fontSize || 16) * (n.lineHeight || 1.25), x = n.textAlign === 'center' ? n.w / 2 : n.textAlign === 'right' ? n.w : 0;
            body = `<text fill="${fill}" font-family="${escapeXML(n.fontFamily || 'Arial')}" font-size="${n.fontSize || 16}" font-weight="${escapeXML(n.fontWeight || 400)}" font-style="${escapeXML(n.fontStyle || 'normal')}" letter-spacing="${n.letterSpacing || 0}" text-anchor="${n.textAlign === 'center' ? 'middle' : n.textAlign === 'right' ? 'end' : 'start'}">${lines.map((l, i) => `<tspan x="${x}" y="${num(i * lh + (n.fontSize || 16) * .85)}">${escapeXML(l)}</tspan>`).join('')}</text>`;
        }
        else if (n.type === 'image') {
            defs.push(`<clipPath id="${id}i">${shape(n, '')}</clipPath>`);
            body = `<image href="${escapeXML(n.src)}" width="${n.w}" height="${n.h}" preserveAspectRatio="xMidYMid slice" clip-path="url(#${id}i)"/>`;
        }
        else if (!['group', 'symbol', 'instance'].includes(n.type))
            body = shape(n, attrs);
        if (n.children) {
            let kids = n.children.map(render).join('');
            if (n.clip) {
                defs.push(`<clipPath id="${id}c">${shape(n, '')}</clipPath>`);
                kids = `<g clip-path="url(#${id}c)">${kids}</g>`;
            }
            body += kids;
        }
        return `<g transform="matrix(${matrix(n).map(num).join(' ')})" opacity="${n.opacity ?? 1}"${filter}${n.blend && n.blend !== 'normal' ? ` style="mix-blend-mode:${escapeXML(n.blend)}"` : ''}><title>${escapeXML(n.name)}</title>${body}</g>`;
    }
    const content = nodes.map(render).join('');
    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${box.w}" height="${box.h}" viewBox="${box.x} ${box.y} ${box.w} ${box.h}"><defs>${defs.join('')}</defs>${content}</svg>`;
}
export async function exportPNG(nodes, box, scale, images) {
    if (box.w * scale > 16384 || box.h * scale > 16384 || box.w * box.h * scale * scale > 64000000)
        throw Error('Export exceeds 64 megapixels or 16,384 pixels per side. Choose a lower scale.');
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.ceil(box.w * scale));
    c.height = Math.max(1, Math.ceil(box.h * scale));
    const ctx = c.getContext('2d');
    await images.ready();
    ctx.scale(scale, scale);
    ctx.translate(-box.x, -box.y);
    paintTree(ctx, nodes, images);
    return new Promise((resolve, reject) => c.toBlob(b => b ? resolve(b) : reject(Error('PNG export failed.')), 'image/png'));
}
export function exportNodes(store, selection = true) {
    const roots = selection && store.selected.size ? store.roots() : store.page.nodes;
    return roots.map(n => {
        const c = clone(n), info = store.info(n.id), m = info.world, center = point(m, { x: n.w / 2, y: n.h / 2 });
        c.x = center.x - n.w / 2;
        c.y = center.y - n.h / 2;
        c.rotation = Math.atan2(m[1], m[0]) * 180 / Math.PI;
        c.flipX = false;
        c.flipY = (m[0] * m[3] - m[1] * m[2]) < 0;
        return c;
    });
}
export function importSVG(source) {
    if (source.length > 8000000)
        throw Error('SVG exceeds 8 MB.');
    const parsed = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg')
        throw Error('Invalid SVG.');
    const allow = new Set(['svg', 'g', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'defs', 'linearGradient', 'radialGradient', 'stop', 'clipPath', 'title', 'desc']);
    let dropped = 0;
    for (const e of [...parsed.querySelectorAll('*')]) {
        if (!allow.has(e.localName)) {
            e.remove();
            dropped++;
            continue;
        }
        for (const a of [...e.attributes])
            if (/^on/i.test(a.name) || a.name === 'href' || a.name.endsWith(':href') || a.name === 'style' && /url\(|@import|expression\(/i.test(a.value))
                e.removeAttribute(a.name);
    }
    const root = document.importNode(parsed.documentElement, true);
    root.style.cssText = 'position:fixed;left:-100000px;top:0;opacity:0;pointer-events:none';
    root.setAttribute('width', root.viewBox.baseVal.width || parseFloat(root.getAttribute('width')) || 1000);
    root.setAttribute('height', root.viewBox.baseVal.height || parseFloat(root.getAttribute('height')) || 1000);
    document.body.append(root);
    let children = [];
    const color = css => {
        if (!css || css === 'none')
            return 'none';
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = css;
        c.clearRect(0, 0, 1, 1);
        c.fillRect(0, 0, 1, 1);
        const rgba = c.getImageData(0, 0, 1, 1).data;
        return '#' + [...rgba].slice(0, rgba[3] === 255 ? 3 : 4).map(v => v.toString(16).padStart(2, '0')).join('');
    };
    try {
        for (const el of root.querySelectorAll('rect,circle,ellipse,path,line,polyline,polygon,text')) {
            if (el.closest('defs,clipPath'))
                continue;
            const st = getComputedStyle(el);
            if (st.display === 'none' || st.visibility === 'hidden')
                continue;
            const m = el.getCTM();
            if (!m)
                continue;
            let n;
            if (el.localName === 'text') {
                let b = el.getBBox(), p = point([m.a, m.b, m.c, m.d, m.e, m.f], { x: b.x, y: b.y });
                n = node('text', { text: el.textContent, name: el.id || el.textContent, x: p.x, y: p.y, w: Math.max(1, b.width * Math.hypot(m.a, m.b)), h: Math.max(1, b.height * Math.hypot(m.c, m.d) * 1.3), fontSize: parseFloat(st.fontSize) * Math.hypot(m.c, m.d), fontFamily: st.fontFamily.split(',')[0].replaceAll('"', ''), fontWeight: parseInt(st.fontWeight) || 400, rotation: Math.atan2(m.b, m.a) * 180 / Math.PI, lineHeight: 1.2, fill: color(st.fill) });
            }
            else {
                let length = el.getTotalLength();
                if (!Number.isFinite(length))
                    continue;
                let count = clamp(Math.ceil(length / 2), 12, 2000), ps = [];
                for (let i = 0; i <= count; i++) {
                    let p = el.getPointAtLength(length * i / count);
                    ps.push(point([m.a, m.b, m.c, m.d, m.e, m.f], p));
                }
                let b = bounds(ps);
                n = node('path', { name: el.id || el.localName, x: b.x, y: b.y, w: Math.max(1, b.w), h: Math.max(1, b.h), points: ps.map(p => ({ x: p.x - b.x, y: p.y - b.y })), closed: !['line', 'polyline'].includes(el.localName) && (el.localName !== 'path' || /[zZ]\s*$/.test(el.getAttribute('d') || '')), fill: color(st.fill), stroke: color(st.stroke), strokeWidth: parseFloat(st.strokeWidth) * Math.hypot(m.a, m.b), opacity: parseFloat(st.opacity) });
            }
            children.push(n);
            if (children.length > 5000)
                throw Error('SVG exceeds 5,000 layers.');
        }
        const b = bounds(children.flatMap(n => [{ x: n.x, y: n.y }, { x: n.x + n.w, y: n.y + n.h }]));
        children.forEach(n => {
            n.x -= b.x;
            n.y -= b.y;
        });
        return { node: node('group', { name: 'Imported SVG', x: 0, y: 0, w: Math.max(1, b.w), h: Math.max(1, b.h), fill: 'none', children }), warning: 'SVG geometry imported as editable flattened paths. Filters, masks, linked images, and rich text are not preserved.' + (dropped ? ` ${dropped} unsupported elements omitted.` : '') };
    }
    finally {
        root.remove();
    }
}
/** Minimal bounded ZIP reader for Sketch documents. No remote service or third-party parser. */
async function unzip(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), text = new TextDecoder();
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
        if (view.getUint32(i, true) === 0x06054b50) {
            end = i;
            break;
        }
    if (end < 0)
        throw Error('Invalid ZIP directory.');
    let count = view.getUint16(end + 10, true), offset = view.getUint32(end + 16, true), entries = new Map(), total = 0;
    if (count > 20000)
        throw Error('Too many ZIP entries.');
    for (let i = 0; i < count; i++) {
        if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50)
            throw Error('Corrupt ZIP directory.');
        const flags = view.getUint16(offset + 8, true), method = view.getUint16(offset + 10, true), size = view.getUint32(offset + 20, true), expanded = view.getUint32(offset + 24, true), nl = view.getUint16(offset + 28, true), el = view.getUint16(offset + 30, true), cl = view.getUint16(offset + 32, true), local = view.getUint32(offset + 42, true), name = text.decode(bytes.subarray(offset + 46, offset + 46 + nl));
        if (flags & 1)
            throw Error('Encrypted Sketch files are unsupported.');
        if (expanded > 32000000 || (total += expanded) > 128000000)
            throw Error('Sketch archive exceeds the 128 MB expansion limit.');
        entries.set(name, { method, size, expanded, local });
        offset += 46 + nl + el + cl;
    }
    return { names: [...entries.keys()], async get(name) {
            const e = entries.get(name);
            if (!e)
                return null;
            if (e.local + 30 > bytes.length)
                throw Error('Corrupt ZIP entry.');
            let start = e.local + 30 + view.getUint16(e.local + 26, true) + view.getUint16(e.local + 28, true);
            if (start + e.size > bytes.length)
                throw Error('Truncated ZIP entry.');
            const data = bytes.subarray(start, start + e.size);
            let result;
            if (e.method === 0)
                result = data;
            else if (e.method === 8) {
                let stream;
                try {
                    stream = new DecompressionStream('deflate-raw');
                }
                catch {
                    throw Error('This browser cannot decompress Sketch files. Use a browser with deflate-raw support.');
                }
                const reader = new Blob([data]).stream().pipeThrough(stream).getReader(), chunks = [];
                let length = 0;
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done)
                        break;
                    length += value.length;
                    if (length > e.expanded || length > 32000000) {
                        await reader.cancel();
                        throw Error('ZIP expansion size mismatch.');
                    }
                    chunks.push(value);
                }
                result = new Uint8Array(length);
                let pos = 0;
                for (const c of chunks) {
                    result.set(c, pos);
                    pos += c.length;
                }
            }
            else
                throw Error('Unsupported ZIP compression method: ' + e.method);
            if (result.length !== e.expanded)
                throw Error('ZIP entry length mismatch.');
            return result;
        } };
}
export async function importSketch(file) {
    const archive = await unzip(new Uint8Array(await file.arrayBuffer())), decoder = new TextDecoder(), pages = [], masters = new Map(), warnings = new Set();
    const col = c => !c ? 'none' : '#' + [c.red, c.green, c.blue].map(x => clamp(Math.round((x || 0) * 255), 0, 255).toString(16).padStart(2, '0')).join('') + (c.alpha != null && c.alpha < 1 ? Math.round(c.alpha * 255).toString(16).padStart(2, '0') : '');
    const pair = s => {
        let a = String(s).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [0, 0];
        return { x: a[0] || 0, y: a[1] || 0 };
    };
    async function convert(s) {
        const type = { artboard: 'frame', group: 'group', shapeGroup: 'group', symbolMaster: 'symbol', symbolInstance: 'instance', rectangle: 'rect', oval: 'ellipse', shapePath: 'path', triangle: 'polygon', star: 'star', polygon: 'polygon', text: 'text', bitmap: 'image' }[s._class];
        if (!type) {
            warnings.add('Unsupported layer classes were omitted');
            return null;
        }
        const f = s.frame || {}, style = s.style || {}, fill = style.fills?.find(f => f.isEnabled), border = style.borders?.find(b => b.isEnabled), n = node(type, { id: s.do_objectID || uid(), name: s.name || type, x: f.x || 0, y: f.y || 0, w: Math.max(1, f.width || 1), h: Math.max(1, f.height || 1), rotation: -(s.rotation || 0), visible: s.isVisible !== false, locked: s.isLocked || false, flipX: s.isFlippedHorizontal || false, flipY: s.isFlippedVertical || false, opacity: style.contextSettings?.opacity ?? 1, fill: col(fill?.color), stroke: col(border?.color), strokeWidth: border?.thickness || 0, radius: s.fixedRadius || s.points?.[0]?.cornerRadius || 0, clip: type === 'frame' });
        if (s._class === 'artboard' && s.hasBackgroundColor)
            n.fill = col(s.backgroundColor);
        if (fill?.fillType === 1 && fill.gradient?.stops?.length) {
            n.gradient = true;
            n.fill = col(fill.gradient.stops[0].color);
            n.fill2 = col(fill.gradient.stops.at(-1).color);
            let a = pair(fill.gradient.from), b = pair(fill.gradient.to);
            n.gradientAngle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
        }
        if ((style.fills?.length || 0) > 1)
            warnings.add('Only the first enabled fill and border are imported');
        const shadow = style.shadows?.find(s => s.isEnabled);
        if (shadow)
            Object.assign(n, { shadowEnabled: true, shadowColor: col(shadow.color).slice(0, 7), shadowOpacity: shadow.color?.alpha ?? .2, shadowX: shadow.offsetX, shadowY: shadow.offsetY, shadowBlur: shadow.blurRadius });
        if (type === 'text') {
            let attr = s.attributedString?.attributes?.[0]?.attributes || style.textStyle?.encodedAttributes || {}, ft = attr.MSAttributedStringFontAttribute?.attributes || {};
            Object.assign(n, { text: s.attributedString?.string || '', fontSize: ft.size || 16, fontFamily: ft.name?.replace(/-(Regular|Bold|Medium|Light|Italic|Semibold)$/i, '') || 'Arial', fontWeight: /bold/i.test(ft.name) ? 700 : /medium/i.test(ft.name) ? 500 : 400, fontStyle: /italic/i.test(ft.name) ? 'italic' : 'normal', fill: col(attr.MSAttributedStringColorAttribute) || '#000000', lineHeight: 1.25, letterSpacing: attr.kerning || 0, textAlign: ['left', 'right', 'center', 'justify'][attr.paragraphStyle?.alignment || 0] || 'left' });
            if ((s.attributedString?.attributes?.length || 0) > 1)
                warnings.add('Mixed text styles are flattened to the first run');
        }
        if (type === 'path') {
            n.points = (s.points || []).map(p => {
                const q = pair(p.point), t = { x: q.x * n.w, y: q.y * n.h };
                if (p.hasCurveFrom) {
                    let c = pair(p.curveFrom);
                    t.out = { x: c.x * n.w, y: c.y * n.h };
                }
                if (p.hasCurveTo) {
                    let c = pair(p.curveTo);
                    t.in = { x: c.x * n.w, y: c.y * n.h };
                }
                return t;
            });
            n.closed = s.isClosed !== false;
        }
        if (type === 'image') {
            let data = await archive.get(s.image?._ref);
            if (data)
                n.src = await readDataURL(new Blob([data], { type: s.image._ref.endsWith('.jpg') ? 'image/jpeg' : 'image/png' }));
            else
                warnings.add('Some embedded images could not be found');
        }
        if (s.layers)
            n.children = (await Promise.all(s.layers.map(convert))).filter(Boolean);
        if (type === 'symbol') {
            n.symbolKey = s.symbolID;
            masters.set(s.symbolID, n);
        }
        if (type === 'instance') {
            n.symbolKey = s.symbolID;
            n.sketchOverrides = s.overrideValues || [];
        }
        if (s.hasClippingMask)
            warnings.add('Sketch clipping-mask chains are not reconstructed');
        if (s._class === 'shapeGroup')
            warnings.add('Sketch compound shapes are imported as editable groups');
        return n;
    }
    const pageNames = archive.names.filter(n => /^pages\/[^/]+\.json$/.test(n));
    if (!pageNames.length)
        throw Error('No pages found in this Sketch archive.');
    for (const name of pageNames) {
        let raw = JSON.parse(decoder.decode(await archive.get(name)));
        pages.push({ id: raw.do_objectID || uid(), name: raw.name || 'Page', nodes: (await Promise.all((raw.layers || []).map(convert))).filter(Boolean) });
    }
    const resolve = ns => ns.forEach(n => {
        if (n.type === 'instance') {
            const m = masters.get(n.symbolKey);
            if (m) {
                n.masterId = m.id;
                n.children = clone(m.children || []);
                n.children.forEach(c => resetIds(c, true));
                for (const override of n.sketchOverrides || [])
                    if (typeof override.value === 'string' && override.overrideName?.endsWith('_stringValue')) {
                        const key = override.overrideName.slice(0, -12);
                        const apply = cs => cs.forEach(c => {
                            if (c.sourceId === key)
                                c.text = override.value;
                            if (c.children)
                                apply(c.children);
                        });
                        apply(n.children);
                    }
            }
            else
                warnings.add('External-library symbol masters are unavailable');
        }
        else if (n.children)
            resolve(n.children);
    });
    pages.forEach(p => resolve(p.nodes));
    const doc = validateDocument({ format: 'forma', version: 1, id: uid(), name: file.name.replace(/\.sketch$/i, ''), activePage: pages[0].id, pages, colors: ['#244C3C', '#ED7855', '#FFFFFF', '#151515'], textStyles: [] });
    warnings.add('Sketch import is a compatibility subset, not lossless round-tripping');
    return { doc, warnings: [...warnings] };
}
