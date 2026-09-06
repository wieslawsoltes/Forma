/**
 * Geometry kernel. Local coordinates remain double-precision JS numbers; GPU
 * buffers are float32 at submission. Affine transforms rotate around node
 * centers. Filled paths use even-odd scanline tessellation; boolean operations
 * split and classify planar boundary segments. Both topology algorithms run on
 * the main thread and have explicit segment budgets rather than hidden workers.
 */
/** Forma geometry kernel. Affine matrices are column-major [a,b,c,d,e,f]. */
export const I = [1, 0, 0, 1, 0, 0];
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
export const point = (m, p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });
export function inverse(m) {
    let d = m[0] * m[3] - m[1] * m[2];
    if (Math.abs(d) < 1e-12)
        return [...I];
    return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d, (m[2] * m[5] - m[3] * m[4]) / d, (m[1] * m[4] - m[0] * m[5]) / d];
}
export function matrix(n) {
    let r = (n.rotation || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r), sx = n.flipX ? -1 : 1, sy = n.flipY ? -1 : 1;
    let a = c * sx, b = s * sx, k = -s * sy, d = c * sy;
    return [a, b, k, d, n.x + n.w / 2 - a * n.w / 2 - k * n.h / 2, n.y + n.h / 2 - b * n.w / 2 - d * n.h / 2];
}
export const corners = (n, m) => [{ x: 0, y: 0 }, { x: n.w, y: 0 }, { x: n.w, y: n.h }, { x: 0, y: n.h }].map(p => point(m, p));
export function bounds(points) {
    if (!points.length)
        return { x: 0, y: 0, w: 0, h: 0 };
    let x = Infinity, y = Infinity, r = -Infinity, b = -Infinity;
    for (const p of points) {
        x = Math.min(x, p.x);
        y = Math.min(y, p.y);
        r = Math.max(r, p.x);
        b = Math.max(b, p.y);
    }
    return { x, y, w: r - x, h: b - y };
}
export const unionBounds = bs => bounds(bs.flatMap(b => [{ x: b.x, y: b.y }, { x: b.x + b.w, y: b.y + b.h }]));
export const intersects = (a, b) => a.x + a.w >= b.x && b.x + b.w >= a.x && a.y + a.h >= b.y && b.y + b.h >= a.y;
export const contains = (b, p) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;
export function distanceSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, t = clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1), 0, 1);
    return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}
export function insideRing(p, ring) {
    let yes = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i], b = ring[j];
        if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)
            yes = !yes;
    }
    return yes;
}
export const inside = (p, rings) => rings.reduce((a, r) => a !== insideRing(p, r), false);
function bezier(a, b, c, d, t) {
    let s = 1 - t;
    return { x: s * s * s * a.x + 3 * s * s * t * b.x + 3 * s * t * t * c.x + t * t * t * d.x, y: s * s * s * a.y + 3 * s * s * t * b.y + 3 * s * t * t * c.y + t * t * t * d.y };
}
function flattenCurve(a, b, c, d, tolerance, output, depth = 0) {
    if (depth > 10 || (distanceSegment(b, a, d) <= tolerance && distanceSegment(c, a, d) <= tolerance)) {
        output.push({ x: d.x, y: d.y });
        return;
    }
    const mid = (x, y) => ({ x: (x.x + y.x) / 2, y: (x.y + y.y) / 2 }), ab = mid(a, b), bc = mid(b, c), cd = mid(c, d), abc = mid(ab, bc), bcd = mid(bc, cd), m = mid(abc, bcd);
    flattenCurve(a, ab, abc, m, tolerance, output, depth + 1);
    flattenCurve(m, bcd, cd, d, tolerance, output, depth + 1);
}
export function flatten(n, tolerance = .4) {
    if (n.contours)
        return n.contours.map(r => r.map(p => ({ ...p })));
    if (n.type === 'path' || n.type === 'line') {
        const ps = n.points || [];
        if (!ps.length)
            return [];
        let r = [{ x: ps[0].x, y: ps[0].y }];
        for (let i = 0; i < ps.length - (n.closed ? 0 : 1); i++) {
            const a = ps[i], b = ps[(i + 1) % ps.length];
            if (a.out || b.in)
                flattenCurve(a, a.out || a, b.in || b, b, tolerance, r);
            else
                r.push({ x: b.x, y: b.y });
        }
        if (n.closed && r.length > 1)
            r.pop();
        return [r];
    }
    if (n.type === 'ellipse') {
        const steps = clamp(Math.ceil(Math.PI * Math.sqrt(Math.max(n.w, n.h) / Math.max(.01, tolerance))), 24, 256);
        return [Array.from({ length: steps }, (_, i) => ({ x: n.w / 2 + Math.cos(i * 2 * Math.PI / steps) * n.w / 2, y: n.h / 2 + Math.sin(i * 2 * Math.PI / steps) * n.h / 2 }))];
    }
    if (n.type === 'star' || n.type === 'polygon') {
        let k = n.sides || 5, star = n.type === 'star', count = star ? k * 2 : k;
        return [Array.from({ length: count }, (_, i) => {
                let a = i / count * Math.PI * 2 - Math.PI / 2, q = star && i % 2 ? (n.innerRadius || .45) : 1;
                return { x: n.w / 2 + Math.cos(a) * n.w / 2 * q, y: n.h / 2 + Math.sin(a) * n.h / 2 * q };
            })];
    }
    const w = n.w, h = n.h, r = clamp(n.radius || 0, 0, Math.min(w, h) / 2);
    if (!r)
        return [[{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }]];
    const ring = [];
    for (const [cx, cy, a] of [[w - r, r, -Math.PI / 2], [w - r, h - r, 0], [r, h - r, Math.PI / 2], [r, r, Math.PI]])
        for (let j = 0; j <= 10; j++)
            ring.push({ x: cx + Math.cos(a + j * Math.PI / 20) * r, y: cy + Math.sin(a + j * Math.PI / 20) * r });
    return [ring];
}
export function path2D(n) {
    let p = new Path2D();
    if (n.contours) {
        for (const r of n.contours) {
            if (!r.length)
                continue;
            p.moveTo(r[0].x, r[0].y);
            for (let i = 1; i < r.length; i++)
                p.lineTo(r[i].x, r[i].y);
            p.closePath();
        }
        return p;
    }
    if (n.type === 'path' || n.type === 'line') {
        let ps = n.points || [];
        if (!ps.length)
            return p;
        p.moveTo(ps[0].x, ps[0].y);
        for (let i = 0; i < ps.length - (n.closed ? 0 : 1); i++) {
            const a = ps[i], b = ps[(i + 1) % ps.length];
            if (a.out || b.in)
                p.bezierCurveTo((a.out || a).x, (a.out || a).y, (b.in || b).x, (b.in || b).y, b.x, b.y);
            else
                p.lineTo(b.x, b.y);
        }
        if (n.closed)
            p.closePath();
        return p;
    }
    if (n.type === 'ellipse')
        p.ellipse(n.w / 2, n.h / 2, n.w / 2, n.h / 2, 0, 0, Math.PI * 2);
    else if (n.type === 'star' || n.type === 'polygon') {
        for (const r of flatten(n)) {
            p.moveTo(r[0].x, r[0].y);
            r.slice(1).forEach(q => p.lineTo(q.x, q.y));
            p.closePath();
        }
    }
    else
        p.roundRect(0, 0, n.w, n.h, clamp(n.radius || 0, 0, Math.min(n.w, n.h) / 2));
    return p;
}
function edges(rings) {
    let e = [];
    for (const r of rings)
        for (let i = 0; i < r.length; i++) {
            const a = r[i], b = r[(i + 1) % r.length];
            if (Math.hypot(a.x - b.x, a.y - b.y) > 1e-9)
                e.push({ a, b });
        }
    return e;
}
const cross = (a, b) => a.x * b.y - a.y * b.x;
function intersection(e, f) {
    let p = { x: e.b.x - e.a.x, y: e.b.y - e.a.y }, q = { x: f.b.x - f.a.x, y: f.b.y - f.a.y }, r = { x: f.a.x - e.a.x, y: f.a.y - e.a.y }, d = cross(p, q);
    if (Math.abs(d) < 1e-10)
        return null;
    let t = cross(r, q) / d, u = cross(r, p) / d;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9 ? { t, u, x: e.a.x + p.x * t, y: e.a.y + p.y * t } : null;
}
/** Even-odd trapezoidal tessellation: supports holes, concavity and self-intersections.
 * Expensive geometry work is retained per geometry key, never repeated on a camera move. */
export function triangulate(rings) {
    let es = edges(rings), ys = es.flatMap(e => [e.a.y, e.b.y]);
    if (es.length > 6000)
        throw Error('Path is too large for the interactive tessellator (6,000 edges).');
    for (let i = 0; i < es.length; i++)
        for (let j = i + 1; j < es.length; j++) {
            let q = intersection(es[i], es[j]);
            if (q)
                ys.push(q.y);
        }
    ys = [...new Set(ys.map(y => Math.round(y * 1e7) / 1e7))].sort((a, b) => a - b);
    let verts = [];
    const xAt = (e, y) => e.a.x + (y - e.a.y) * (e.b.x - e.a.x) / (e.b.y - e.a.y);
    for (let i = 0; i < ys.length - 1; i++) {
        let y0 = ys[i], y1 = ys[i + 1];
        if (y1 - y0 < 1e-8)
            continue;
        let ym = (y0 + y1) / 2, active = es.filter(e => Math.min(e.a.y, e.b.y) < ym && Math.max(e.a.y, e.b.y) > ym).sort((a, b) => xAt(a, ym) - xAt(b, ym));
        for (let k = 0; k + 1 < active.length; k += 2) {
            let l = active[k], r = active[k + 1], a = xAt(l, y0), b = xAt(r, y0), c = xAt(r, y1), d = xAt(l, y1);
            if (Math.abs(b + c - a - d) < 1e-9)
                continue;
            verts.push(a, y0, b, y0, c, y1, a, y0, c, y1, d, y1);
        }
    }
    return new Float32Array(verts);
}
export function strokeMesh(rings, width, closed = true) {
    let v = [], r = width / 2;
    function tri(a, b, c) {
        v.push(a.x, a.y, b.x, b.y, c.x, c.y);
    }
    for (const ring of rings) {
        if (ring.length < 2)
            continue;
        for (let i = 0; i < ring.length - (closed ? 0 : 1); i++) {
            let a = ring[i], b = ring[(i + 1) % ring.length], len = Math.hypot(b.x - a.x, b.y - a.y) || 1, nx = -(b.y - a.y) * r / len, ny = (b.x - a.x) * r / len, p = { x: a.x + nx, y: a.y + ny }, q = { x: a.x - nx, y: a.y - ny }, s = { x: b.x + nx, y: b.y + ny }, t = { x: b.x - nx, y: b.y - ny };
            tri(p, q, s);
            tri(q, t, s);
        }
        for (const p of ring)
            for (let i = 0; i < 12; i++)
                tri(p, { x: p.x + Math.cos(i * Math.PI / 6) * r, y: p.y + Math.sin(i * Math.PI / 6) * r }, { x: p.x + Math.cos((i + 1) * Math.PI / 6) * r, y: p.y + Math.sin((i + 1) * Math.PI / 6) * r });
    }
    return new Float32Array(v);
}
/** Polygon boundary classification. The original operands remain in history.
 * Collinear overlaps are split at endpoints; output is oriented with interior on the left. */
export function booleanRings(operands, operation) {
    let all = operands.flatMap(edges), ts = all.map(() => [0, 1]);
    if (all.length > 2500)
        throw Error('Boolean operation exceeds 2,500 flattened edges. Simplify the paths first.');
    for (let i = 0; i < all.length; i++)
        for (let j = i + 1; j < all.length; j++) {
            let p = intersection(all[i], all[j]);
            if (p) {
                ts[i].push(clamp(p.t, 0, 1));
                ts[j].push(clamp(p.u, 0, 1));
            }
            else {
                for (const [k, l] of [[i, j], [j, i]]) {
                    let e = all[k], dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, dd = dx * dx + dy * dy;
                    for (const p of [all[l].a, all[l].b])
                        if (distanceSegment(p, e.a, e.b) < 1e-7)
                            ts[k].push(clamp(((p.x - e.a.x) * dx + (p.y - e.a.y) * dy) / dd, 0, 1));
                }
            }
        }
    const inResult = p => {
        let bs = operands.map(r => inside(p, r));
        return operation === 'union' ? bs.some(Boolean) : operation === 'intersect' ? bs.every(Boolean) : operation === 'subtract' ? bs[0] && !bs.slice(1).some(Boolean) : bs.filter(Boolean).length % 2 === 1;
    };
    let segments = [], dedup = new Set(), key = p => `${Math.round(p.x * 1e5)},${Math.round(p.y * 1e5)}`;
    for (let i = 0; i < all.length; i++) {
        let e = all[i], a = [...new Set(ts[i].map(t => Math.round(t * 1e10) / 1e10))].sort((a, b) => a - b), dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
        for (let k = 0; k < a.length - 1; k++) {
            if (a[k + 1] - a[k] < 1e-9)
                continue;
            let p = { x: e.a.x + dx * a[k], y: e.a.y + dy * a[k] }, q = { x: e.a.x + dx * a[k + 1], y: e.a.y + dy * a[k + 1] }, m = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }, len = Math.hypot(dx, dy), eps = Math.max(1e-5, Math.min(1e-3, Math.hypot(q.x - p.x, q.y - p.y) * .001)), left = inResult({ x: m.x - dy / len * eps, y: m.y + dx / len * eps }), right = inResult({ x: m.x + dy / len * eps, y: m.y - dx / len * eps });
            if (left === right)
                continue;
            if (!left)
                [p, q] = [q, p];
            let id = key(p) + '>' + key(q);
            if (!dedup.has(id)) {
                dedup.add(id);
                segments.push({ p, q, used: false });
            }
        }
    }
    let starts = new Map();
    for (const s of segments) {
        let k = key(s.p);
        if (!starts.has(k))
            starts.set(k, []);
        starts.get(k).push(s);
    }
    let rings = [];
    for (const start of segments) {
        if (start.used)
            continue;
        let ring = [], s = start, guard = segments.length + 1;
        while (s && !s.used && guard--) {
            s.used = true;
            ring.push(s.p);
            if (key(s.q) === key(start.p))
                break;
            let options = (starts.get(key(s.q)) || []).filter(q => !q.used);
            s = options[0];
        }
        if (ring.length >= 3)
            rings.push(ring);
    }
    return rings;
}
export function rgba(hex, alpha = 1) {
    if (!hex || hex === 'none')
        return [0, 0, 0, 0];
    let s = hex.replace('#', '');
    if (s.length === 3)
        s = s.split('').map(c => c + c).join('');
    return [parseInt(s.slice(0, 2), 16) / 255, parseInt(s.slice(2, 4), 16) / 255, parseInt(s.slice(4, 6), 16) / 255, (s.length === 8 ? parseInt(s.slice(6, 8), 16) / 255 : 1) * alpha];
}
export const geometryKey = n => JSON.stringify([n.type, n.w, n.h, n.radius, n.sides, n.innerRadius, n.points, n.contours, n.closed, n.strokeWidth, n.fill !== 'none', n.stroke !== 'none']);
export function hitNode(n, p, tolerance = 3) {
    if (n.type === 'group' || n.type === 'frame' || n.type === 'symbol' || n.type === 'instance' || n.type === 'text' || n.type === 'image')
        return contains({ x: 0, y: 0, w: n.w, h: n.h }, p);
    let rings = flatten(n);
    if (n.fill && n.fill !== 'none' && inside(p, rings))
        return true;
    for (const r of rings)
        for (let i = 0; i < r.length - ((n.type === 'line' || n.type === 'path') && !n.closed ? 1 : 0); i++)
            if (distanceSegment(p, r[i], r[(i + 1) % r.length]) <= tolerance + (n.strokeWidth || 0) / 2)
                return true;
    return false;
}
