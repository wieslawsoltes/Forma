import test from 'node:test';
import assert from 'node:assert/strict';
import { matrix, mul, inverse, point, bounds, inside, flatten, triangulate, booleanRings, strokeMesh, hitNode } from '../src/geometry.js';
import { node, DocumentStore, clone, validateDocument, demoDocument, resetIds } from '../src/document.js';
const near = (a, b, eps = 1e-5) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const box = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
const area = v => {
    let a = 0;
    for (let i = 0; i < v.length; i += 6)
        a += Math.abs((v[i + 2] - v[i]) * (v[i + 5] - v[i + 1]) - (v[i + 4] - v[i]) * (v[i + 3] - v[i + 1])) / 2;
    return a;
};
test('affine composition / inverse / center rotation', () => {
    const n = node('rect', { x: 21, y: -13, w: 100, h: 70, rotation: 37, flipX: true }), m = matrix(n);
    const p = { x: 15, y: 28 }, q = point(inverse(m), point(m, p));
    near(p.x, q.x);
    near(p.y, q.y);
    const c = point(m, { x: 50, y: 35 });
    near(c.x, 71);
    near(c.y, 22);
});
test('rectangle tessellation area', () => near(area(triangulate([box(0, 0, 100, 60)])), 6000));
test('concave polygon tessellation', () => near(area(triangulate([[{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 100 }, { x: 0, y: 100 }]])), 3600));
test('even-odd hole tessellation', () => near(area(triangulate([box(0, 0, 100, 100), box(20, 20, 60, 60)])), 6400));
test('self-intersection / bow-tie fill', () => near(area(triangulate([[{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }, { x: 100, y: 0 }]])), 5000));
test('union overlapping rectangles', () => near(area(triangulate(booleanRings([[box(0, 0, 100, 100)], [box(50, 0, 100, 100)]], 'union'))), 15000));
test('intersection overlapping rectangles', () => near(area(triangulate(booleanRings([[box(0, 0, 100, 100)], [box(50, 0, 100, 100)]], 'intersect'))), 5000));
test('subtract overlapping rectangles', () => near(area(triangulate(booleanRings([[box(0, 0, 100, 100)], [box(50, 0, 100, 100)]], 'subtract'))), 5000));
test('XOR overlapping rectangles', () => near(area(triangulate(booleanRings([[box(0, 0, 100, 100)], [box(50, 0, 100, 100)]], 'xor'))), 10000));
test('subtract contained shape preserves hole', () => {
    const r = booleanRings([[box(0, 0, 100, 100)], [box(25, 25, 50, 50)]], 'subtract');
    near(area(triangulate(r)), 7500);
    assert.equal(inside({ x: 50, y: 50 }, r), false);
});
test('disjoint union / disjoint intersection', () => {
    const a = [[box(0, 0, 20, 20)], [box(40, 40, 20, 20)]];
    near(area(triangulate(booleanRings(a, 'union'))), 800);
    assert.equal(booleanRings(a, 'intersect').length, 0);
});
test('coincident boundaries', () => {
    const a = [[box(0, 0, 20, 20)], [box(0, 0, 20, 20)]];
    near(area(triangulate(booleanRings(a, 'union'))), 400);
    assert.equal(booleanRings(a, 'subtract').length, 0);
});
test('union edge-adjacent rectangles', () => near(area(triangulate(booleanRings([[box(0, 0, 20, 20)], [box(20, 0, 20, 20)]], 'union'))), 800));
test('three operand union', () => near(area(triangulate(booleanRings([[box(0, 0, 20, 20)], [box(10, 0, 20, 20)], [box(20, 0, 20, 20)]], 'union'))), 800));
test('Bezier subdivision retains endpoints', () => {
    const n = node('path', { points: [{ x: 0, y: 0, out: { x: 0, y: 100 } }, { x: 100, y: 0, in: { x: 100, y: 100 } }], closed: false });
    const r = flatten(n)[0];
    assert.ok(r.length > 8);
    assert.deepEqual(r[0], { x: 0, y: 0 });
    assert.deepEqual(r.at(-1), { x: 100, y: 0 });
    assert.ok(bounds(r).h > 74);
});
test('ellipse shape hit vs corner', () => {
    const n = node('ellipse', { w: 100, h: 50, fill: '#FFFFFF' });
    assert.ok(hitNode(n, { x: 50, y: 25 }));
    assert.equal(hitNode(n, { x: 0, y: 0 }, 0), false);
});
test('stroke mesh finite for zero-length edges', () => {
    const v = strokeMesh([[{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }]], 3, false);
    assert.ok(v.every(Number.isFinite));
});
const empty = () => ({ format: 'forma', version: 1, id: 'doc', name: 'Test', activePage: 'p', pages: [{ id: 'p', name: 'Page', nodes: [] }], colors: [], textStyles: [], assets: {} });
test('transaction, undo, redo preserve document', () => {
    const s = new DocumentStore(empty());
    s.transaction('Add', () => s.add(node('rect')));
    const id = s.page.nodes[0].id;
    assert.equal(s.page.nodes.length, 1);
    s.undo();
    assert.equal(s.page.nodes.length, 0);
    s.redo();
    assert.equal(s.page.nodes[0].id, id);
});
test('cancel restores atomic transaction', () => {
    const s = new DocumentStore(empty());
    s.begin('Abort');
    s.add(node('rect'));
    s.cancel();
    assert.equal(s.page.nodes.length, 0);
    assert.equal(s.undoStack.length, 0);
});
test('group / ungroup preserve world coordinates', () => {
    const s = new DocumentStore(empty()), a = node('rect', { x: 30, y: 40, w: 20, h: 30 }), b = node('rect', { x: 80, y: 60, w: 20, h: 40 });
    s.page.nodes.push(a, b);
    s.reindex();
    s.select([a.id, b.id]);
    const before = point(s.info(a.id).world, { x: 0, y: 0 });
    s.transaction('Group', () => s.group());
    const after = point(s.info(a.id).world, { x: 0, y: 0 });
    near(before.x, after.x);
    near(before.y, after.y);
    s.transaction('Ungroup', () => s.ungroup());
    near(s.get(a.id).x, 30);
    near(s.get(a.id).y, 40);
});
test('nested selection only transforms roots', () => {
    const a = node('rect'), g = node('group', { children: [a] });
    const d = empty();
    d.pages[0].nodes = [g];
    const s = new DocumentStore(d);
    s.select([g.id, a.id]);
    assert.deepEqual(s.roots().map(n => n.id), [g.id]);
});
test('group resize scales children and paths', () => {
    const a = node('path', { x: 10, y: 20, w: 50, h: 40, points: [{ x: 0, y: 0 }, { x: 50, y: 40 }] }), g = node('group', { w: 100, h: 100, children: [a] }), s = new DocumentStore(empty());
    s.resize(g, 200, 300);
    near(a.x, 20);
    near(a.y, 60);
    near(a.w, 100);
    near(a.h, 120);
    near(a.points[1].x, 100);
});
test('stack layout gaps, padding and hug', () => {
    const a = node('rect', { w: 20, h: 30 }), b = node('rect', { w: 40, h: 50 }), g = node('group', { layout: 'horizontal', gap: 7, padding: 9, hug: true, children: [a, b] }), s = new DocumentStore(empty());
    s.layout(g);
    near(a.x, 9);
    near(b.x, 36);
    near(g.w, 85);
});
test('demo schema / symbol instance identity', () => {
    const d = validateDocument(demoDocument()), s = new DocumentStore(d);
    assert.equal(s.doc.pages.length, 2);
    assert.ok(s.index.size > 120);
    const inst = [...s.index.values()].find(i => i.node.type === 'instance').node;
    assert.equal(s.get(inst.masterId).type, 'symbol');
});
test('schema rejects duplicate ids and malicious remote image', () => {
    const d = empty(), a = node('rect');
    d.pages[0].nodes = [a, clone(a)];
    assert.throws(() => validateDocument(d), /duplicate/);
    d.pages[0].nodes = [node('image', { src: 'https://attacker.invalid/tracker.png' })];
    assert.throws(() => validateDocument(d), /embedded/);
});
test('schema rejects invalid bounds and deep nesting', () => {
    const d = empty();
    d.pages[0].nodes = [node('rect', { w: Infinity })];
    assert.throws(() => validateDocument(d), /geometry/);
    let g = node('group', { children: [] });
    d.pages[0].nodes = [g];
    for (let i = 0; i < 55; i++) {
        const c = node('group', { children: [] });
        g.children.push(c);
        g = c;
    }
    assert.throws(() => validateDocument(d), /complexity/);
});
// Symbol editing must keep source identity separate from instance identity.
test('symbol instance overrides survive subsequent master edits', () => {
    const store = new DocumentStore(demoDocument());
    let inst = [...store.index.values()].find(i => i.node.type === 'instance').node;
    const master = store.get(inst.masterId), sourceId = master.children[0].id;
    assert.equal(inst.children[0].sourceId, sourceId);
    store.transaction('Override fill', () => inst.children[0].fill = '#112233');
    assert.equal(inst.overrides[sourceId].fill, '#112233');
    store.transaction('Master stroke', () => master.children[0].stroke = '#FF0000');
    assert.equal(inst.children[0].fill, '#112233');
    assert.equal(inst.children[0].stroke, '#FF0000');
    store.undo();
    inst = store.get(inst.id);
    assert.equal(inst.children[0].fill, '#112233');
});
test('duplicated instance preserves its master source references', () => {
    const s = new DocumentStore(demoDocument());
    const inst = [...s.index.values()].find(i => i.node.type === 'instance').node;
    s.select([inst.id]);
    s.transaction('Duplicate', () => s.duplicate());
    const copy = s.selection()[0];
    assert.notEqual(copy.id, inst.id);
    assert.equal(copy.children[0].sourceId, inst.children[0].sourceId);
    assert.notEqual(copy.children[0].id, inst.children[0].id);
});
test('new instance can explicitly remap to the selected master', () => {
    const child = node('rect', { sourceId: 'old-source' }), g = node('symbol', { children: [child] });
    const c = resetIds(clone(g), true);
    assert.equal(c.children[0].sourceId, child.id);
    assert.equal(c.sourceId, g.id);
});
test('master resize preserves each instance outer dimensions', () => {
    const s = new DocumentStore(demoDocument());
    const inst = [...s.index.values()].find(i => i.node.type === 'instance').node;
    const master = s.get(inst.masterId), width = inst.w, height = inst.h;
    s.transaction('Resize source', () => s.resize(master, master.w * 2, master.h * 2));
    near(inst.w, width);
    near(inst.h, height);
    assert.ok(inst.children.every(n => Number.isFinite(n.x) && Number.isFinite(n.w)));
});
