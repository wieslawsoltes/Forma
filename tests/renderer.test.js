/** CPU-side WebGPU command tests. This is NOT a driver or WGSL validation test.
 * A deliberately small device double checks the packing, batching, culling,
 * cache lifetime and device-loss paths without pretending to execute shaders.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/renderer.js';
import { node } from '../src/document.js';
function mockGpu() {
    const log = { buffers: [], textures: [], writes: [], draws: [], shaders: [], submits: 0 };
    let lose;
    const device = {
        lost: new Promise(resolve => {
            lose = resolve;
        }),
        addEventListener() {
        }, pushErrorScope() {
        }, popErrorScope: async () => null,
        createShaderModule({ code }) {
            log.shaders.push(code);
            return { getCompilationInfo: async () => ({ messages: [] }) };
        },
        createBindGroupLayout: d => d,
        createPipelineLayout: d => d,
        createRenderPipelineAsync: async (d) => d,
        createSampler: d => d,
        createBuffer(d) {
            assert.equal(d.size % 4, 0);
            const b = { ...d, destroy() {
                    this.destroyed = true;
                } };
            log.buffers.push(b);
            return b;
        },
        createTexture(d) {
            const t = { ...d, createView: () => ({}), destroy() {
                    this.destroyed = true;
                } };
            log.textures.push(t);
            return t;
        },
        createBindGroup: d => d,
        createCommandEncoder() {
            return {
                beginRenderPass() {
                    return { setPipeline() {
                        }, setBindGroup() {
                        }, setVertexBuffer() {
                        }, draw(...args) {
                            log.draws.push(args);
                        }, end() {
                        } };
                },
                finish: () => ({})
            };
        },
        queue: {
            writeTexture() {
            },
            copyExternalImageToTexture() {
            },
            writeBuffer(buffer, offset, data) {
                assert.ok([...data].every(Number.isFinite));
                assert.ok(data.byteLength + offset <= buffer.size);
                log.writes.push({ buffer, offset, data: new Float32Array(data) });
            },
            submit() {
                log.submits++;
            }
        }
    };
    globalThis.GPUBufferUsage = { UNIFORM: 1, COPY_DST: 2, STORAGE: 4, VERTEX: 8 };
    globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2, RENDER_ATTACHMENT: 4 };
    globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2 };
    globalThis.devicePixelRatio = 1;
    Object.defineProperty(globalThis.navigator, 'gpu', { configurable: true, value: {
            requestAdapter: async () => ({ requestDevice: async () => device, info: { description: 'TEST DOUBLE: NO GPU EXECUTION' } }),
            getPreferredCanvasFormat: () => 'bgra8unorm'
        } });
    const context = { configure() {
        }, getCurrentTexture: () => ({ createView: () => ({}) }) };
    const canvas = { width: 1, height: 1, getContext: kind => kind === 'webgpu' ? context : {}, cloneNode() {
            return { ...this };
        }, replaceWith() {
        } };
    const statuses = [];
    const renderer = new Renderer(canvas, () => {
    }, (...args) => statuses.push(args));
    return { renderer, log, statuses, lose };
}
test('WebGPU command packing, batching and culling with a mock device', async () => {
    const { renderer: r, log } = mockGpu();
    await r.init();
    r.resize(800, 600);
    assert.equal(r.mode, 'WebGPU');
    assert.ok(log.shaders[0].includes('@fragment fn fs'));
    assert.equal(r.quad.multisample.count, 4);
    r.render([
        node('rect', { x: 0, y: 0, w: 100, h: 80 }),
        node('ellipse', { x: 110, y: 0, w: 60, h: 60 }),
        node('rect', { x: 5000, y: 0, w: 20, h: 20 })
    ], { x: 0, y: 0, zoom: 1 });
    assert.equal(r.visibleCount, 2);
    assert.deepEqual(log.draws[0], [6, 2, 0, 0]);
    assert.equal(r.drawCalls, 1);
    const packed = log.writes.find(w => w.buffer === r.instanceBuffer).data;
    assert.equal(packed.length, 2 * 36);
    assert.equal(packed[24], 1); // inherited opacity
    assert.equal(packed[36 + 22], 1); // ellipse primitive
    assert.equal(log.submits, 1);
});
test('WebGPU clip ranges and affine inverse packing with a mock device', async () => {
    const { renderer: r, log } = mockGpu();
    await r.init();
    r.resize(800, 600);
    r.render([node('group', { x: 20, y: 30, w: 300, h: 200, clip: true, children: [node('rect', { w: 40, h: 40 })] })], { x: 0, y: 0, zoom: 1 });
    const packed = log.writes.find(w => w.buffer === r.instanceBuffer).data;
    const clips = log.writes.find(w => w.buffer === r.clipBuffer).data;
    assert.equal(packed[29], 1);
    assert.equal(clips.length, 12);
    assert.equal(clips[4], -20);
    assert.equal(clips[5], -30);
});
test('WebGPU mesh caching invalidates fill and releases old resources with a mock device', async () => {
    const { renderer: r } = mockGpu();
    await r.init();
    r.resize(800, 600);
    const n = node('path', { w: 100, h: 100, closed: true, fill: '#FF0000', points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 100 }] });
    const a = r.geometry(n);
    assert.ok(a.fill);
    assert.equal(r.geometry(n), a);
    n.fill = 'none';
    const b = r.geometry(n);
    assert.equal(b.fill, null);
    assert.equal(a.fill.buffer.destroyed, true);
});
test('WebGPU buffer growth invalidates bindings with a mock device', async () => {
    const { renderer: r } = mockGpu();
    await r.init();
    const old = r.instanceBuffer, version = r.bindingVersion;
    r.ensureBuffers(1000, 1000);
    assert.equal(r.instanceCapacity, 1024);
    assert.equal(r.clipCapacity, 1024);
    assert.ok(old.destroyed);
    assert.ok(r.bindingVersion > version);
});
test('WebGPU device loss changes canvas and reports fallback with a mock device', async () => {
    const { renderer: r, lose, statuses } = mockGpu();
    await r.init();
    const original = r.canvas;
    lose({ message: 'Simulated loss' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.mode, 'Canvas 2D');
    assert.notEqual(r.canvas, original);
    assert.match(statuses.at(-1)[1], /Simulated loss/);
});
