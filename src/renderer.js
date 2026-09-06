/**
 * Hybrid retained renderer: analytic WGSL primitives, cached triangle meshes,
 * browser-shaped text textures, per-fragment ancestor clipping and 4x MSAA.
 * Device loss / unavailable adapters use the shared Canvas2D painter. Artistic
 * blend modes deliberately raster-composite the viewport for consistent order.
 * cpuMs is CPU scene preparation/submission time, NEVER a GPU timestamp.
 */
import { I, mul, matrix, inverse, point, corners, bounds, intersects, flatten, path2D, triangulate, strokeMesh, geometryKey, rgba, clamp } from './geometry.js';
const isContainer = n => ['group', 'symbol', 'instance'].includes(n.type);
export function font(n) {
    return `${n.fontStyle || 'normal'} ${n.fontWeight || 400} ${n.fontSize || 16}px "${(n.fontFamily || 'Arial').replaceAll('"', '')}"`;
}
export function textLines(ctx, n) {
    const out = [], width = Math.max(1, n.w);
    ctx.font = font(n);
    if ('letterSpacing' in ctx)
        ctx.letterSpacing = (n.letterSpacing || 0) + 'px';
    for (const para of (n.text || '').split('\n')) {
        let line = '';
        for (const word of para.split(' ')) {
            let next = line ? line + ' ' + word : word;
            if (line && ctx.measureText(next).width > width) {
                out.push(line);
                line = word;
            }
            else
                line = next;
        }
        out.push(line);
    }
    return out;
}
export function paintText(ctx, n) {
    ctx.font = font(n);
    ctx.textBaseline = 'top';
    ctx.textAlign = n.textAlign || 'left';
    if ('letterSpacing' in ctx)
        ctx.letterSpacing = (n.letterSpacing || 0) + 'px';
    let lines = textLines(ctx, n), lh = (n.fontSize || 16) * (n.lineHeight || 1.25), x = n.textAlign === 'center' ? n.w / 2 : n.textAlign === 'right' ? n.w : 0;
    ctx.fillStyle = n.fill === 'none' ? 'transparent' : n.fill || '#000000';
    lines.forEach((l, i) => ctx.fillText(l, x, i * lh + Math.max(0, (lh - (n.fontSize || 16)) * .28)));
}
export class ImageStore {
    constructor(invalidate) {
        this.items = new Map();
        this.invalidate = invalidate;
    }
    get(src) {
        if (!src)
            return null;
        let item = this.items.get(src);
        if (item)
            return item.image;
        item = { image: null };
        this.items.set(src, item);
        const image = new Image();
        image.onload = () => {
            item.image = image;
            this.invalidate();
        };
        image.onerror = () => {
            item.failed = true;
            this.invalidate();
        };
        image.src = src;
        return null;
    }
    async ready() {
        await Promise.all([...this.items.keys()].map(src => new Promise(resolve => {
            let im = this.get(src);
            if (im) {
                resolve();
                return;
            }
            const image = new Image();
            image.onload = resolve;
            image.onerror = resolve;
            image.src = src;
        })));
    }
}
function fillStyle(ctx, n) {
    if (n.gradient && n.fill !== 'none') {
        let a = (n.gradientAngle || 0) * Math.PI / 180, dx = Math.cos(a) * n.w / 2, dy = Math.sin(a) * n.h / 2;
        let g = ctx.createLinearGradient(n.w / 2 - dx, n.h / 2 - dy, n.w / 2 + dx, n.h / 2 + dy);
        g.addColorStop(0, n.fill);
        g.addColorStop(1, n.fill2 || '#FFFFFF');
        return g;
    }
    return n.fill || 'transparent';
}
export function paintImage(ctx, n, image) {
    if (!image) {
        ctx.fillStyle = '#E6E9E5';
        ctx.fillRect(0, 0, n.w, n.h);
        return;
    }
    const s = Math.max(n.w / image.width, n.h / image.height), w = image.width * s, h = image.height * s;
    ctx.drawImage(image, (n.w - w) / 2, (n.h - h) / 2, w, h);
}
/** The same painter supplies raster export, browser-shaped text, and the no-WebGPU fallback. */
export function paintTree(ctx, nodes, images, { includeFrames = true } = {}) {
    for (const n of nodes) {
        if (n.visible === false)
            continue;
        ctx.save();
        ctx.transform(...matrix(n));
        ctx.globalAlpha *= n.opacity ?? 1;
        if (n.blend && n.blend !== 'normal')
            ctx.globalCompositeOperation = n.blend;
        const p = path2D(n), draw = !isContainer(n) && !(n.type === 'frame' && !includeFrames);
        if (draw) {
            ctx.save();
            if (n.shadowEnabled) {
                const c = rgba(n.shadowColor || '#000000', n.shadowOpacity ?? .18);
                ctx.shadowColor = `rgba(${c[0] * 255},${c[1] * 255},${c[2] * 255},${c[3]})`;
                ctx.shadowOffsetX = n.shadowX || 0;
                ctx.shadowOffsetY = n.shadowY || 4;
                ctx.shadowBlur = n.shadowBlur || 12;
            }
            if (n.type === 'text') {
                ctx.beginPath();
                ctx.rect(0, 0, n.w, n.h);
                ctx.clip();
                paintText(ctx, n);
            }
            else if (n.type === 'image') {
                ctx.clip(p);
                paintImage(ctx, n, images.get(n.src));
            }
            else {
                if (n.fill && n.fill !== 'none') {
                    ctx.fillStyle = fillStyle(ctx, n);
                    ctx.fill(p, 'evenodd');
                }
                if (n.stroke && n.stroke !== 'none' && n.strokeWidth) {
                    ctx.strokeStyle = n.stroke;
                    ctx.lineWidth = n.strokeWidth;
                    ctx.lineJoin = 'round';
                    ctx.lineCap = 'round';
                    ctx.stroke(p);
                }
            }
            ctx.restore();
        }
        if (n.children) {
            if (n.clip)
                ctx.clip(p);
            paintTree(ctx, n.children, images, { includeFrames });
        }
        ctx.restore();
    }
}
const shader = /* wgsl */ `
diagnostic(off, derivative_uniformity);
struct Global { view: vec4f, camera: vec4f };
struct Item { mat: vec4f, posSize: vec4f, fill: vec4f, fill2: vec4f, stroke: vec4f, config: vec4f, extra: vec4f, clips: vec4f, box: vec4f };
struct Clip { mat: vec4f, posSize: vec4f, props: vec4f };
@group(0) @binding(0) var<uniform> g: Global;
@group(0) @binding(1) var<storage,read> items: array<Item>;
@group(0) @binding(2) var<storage,read> clips: array<Clip>;
@group(0) @binding(3) var tex: texture_2d<f32>;
@group(0) @binding(4) var samp: sampler;
struct VOut { @builtin(position) position: vec4f, @location(0) local: vec2f, @location(1) world: vec2f, @location(2) @interpolate(flat) index: u32 };
fn vertex(p:vec2f, index:u32)->VOut { let d=items[index];let w=vec2f(d.mat.x*p.x+d.mat.z*p.y,d.mat.y*p.x+d.mat.w*p.y)+d.posSize.xy;let screen=(w*g.view.z+g.camera.xy)/g.view.xy*2.0-1.0;var o:VOut;o.position=vec4f(screen.x,-screen.y,0.0,1.0);o.local=p;o.world=w;o.index=index;return o; }
@vertex fn vsQuad(@builtin(vertex_index) vi:u32,@builtin(instance_index) ii:u32)->VOut {let coords=array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1));return vertex(items[ii].box.xy+coords[vi]*items[ii].box.zw,ii);}
@vertex fn vsMesh(@location(0) p:vec2f,@builtin(instance_index) ii:u32)->VOut{return vertex(p,ii);}
fn rounded(p:vec2f,size:vec2f,radius:f32)->f32 {let r=min(radius,min(size.x,size.y)*.5);let q=abs(p-size*.5)-(size*.5-vec2f(r));return length(max(q,vec2f(0)))+min(max(q.x,q.y),0.0)-r;}
fn ellipse(p:vec2f,size:vec2f)->f32 {let r=max(size*.5,vec2f(.0001));let q=p-r;let k0=length(q/r);let k1=length(q/(r*r));return select(k0*(k0-1.0)/max(k1,.0001),-min(r.x,r.y),k0<.0001);}
fn premultiply(c:vec4f)->vec4f{return vec4f(c.rgb*c.a,c.a);}
@fragment fn fs(v:VOut)->@location(0) vec4f {
 let d=items[v.index];let kind=u32(d.config.z);let size=d.posSize.zw;let uv=v.local/max(size,vec2f(.0001));let dir=d.extra.yz;
 let axis=dir*size;let t=clamp(dot(v.local-size*.5,axis)/max(dot(axis,axis),.0001)+.5,0.0,1.0);
 var fill=d.fill;if(d.config.w>0.5){fill=mix(d.fill,d.fill2,t);}var color:vec4f;
 var dist=rounded(v.local,size,d.config.x);if(kind==1u||kind==4u){dist=ellipse(v.local,size);}let aa=max(fwidth(dist),.35/g.view.z);
 if(kind==2u){color=textureSample(tex,samp,uv);color*=1.0-smoothstep(-aa*.5,aa*.5,dist);}
 else if(kind==3u||kind==4u){let b=max(d.extra.w,.01);let a=1.0-smoothstep(-b,b,dist);color=premultiply(fill)*a;}
 else if(kind==5u){color=premultiply(fill);}
 else if(kind==6u){color=premultiply(d.stroke);}
 else {let a=1.0-smoothstep(-aa*.5,aa*.5,dist);color=premultiply(fill)*a;if(d.config.y>0.0&&d.stroke.a>0.0){let outer=1.0-smoothstep(-aa*.5,aa*.5,dist-d.config.y*.5);let inner=1.0-smoothstep(-aa*.5,aa*.5,dist+d.config.y*.5);let stroke=premultiply(d.stroke)*(outer-inner);color=stroke+color*(1.0-stroke.a);}}
 var coverage=1.0;for(var i=0u;i<u32(d.clips.y);i++){let c=clips[u32(d.clips.x)+i];let p=vec2f(c.mat.x*v.world.x+c.mat.z*v.world.y,c.mat.y*v.world.x+c.mat.w*v.world.y)+c.posSize.xy;let cd=rounded(p,c.posSize.zw,c.props.x);let ca=max(fwidth(cd),.3/g.view.z);coverage*=1.0-smoothstep(-ca*.5,ca*.5,cd);}
 return color*(d.extra.x*coverage);
}`;
export class Renderer {
    constructor(canvas, invalidate, onStatus) {
        this.canvas = canvas;
        this.invalidate = invalidate;
        this.onStatus = onStatus;
        this.images = new ImageStore(invalidate);
        this.meshes = new Map();
        this.textures = new Map();
        this.frame = 0;
        this.drawCalls = 0;
        this.mode = 'Initializing';
        this.width = 1;
        this.height = 1;
        this.dpr = Math.min(devicePixelRatio || 1, 2);
        this.disposed = false;
    }
    async init(forceCanvas = false) {
        if (!forceCanvas && navigator.gpu) {
            try {
                const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
                if (!adapter)
                    throw Error('No WebGPU adapter available.');
                this.device = await adapter.requestDevice();
                this.adapterInfo = adapter.info;
                this.context = this.canvas.getContext('webgpu');
                if (!this.context)
                    throw Error('WebGPU canvas context unavailable.');
                this.format = navigator.gpu.getPreferredCanvasFormat();
                this.context.configure({ device: this.device, format: this.format, alphaMode: 'premultiplied' });
                const d = this.device;
                d.pushErrorScope('validation');
                const module = d.createShaderModule({ code: shader });
                let diagnostics = await module.getCompilationInfo();
                const errors = diagnostics.messages.filter(m => m.type === 'error');
                if (errors.length)
                    throw Error(errors.map(m => m.message).join('\n'));
                const layout = d.createBindGroupLayout({ entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }, { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }, { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} }, { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: {} }] });
                this.layout = layout;
                const pipelineLayout = d.createPipelineLayout({ bindGroupLayouts: [layout] }), blend = { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' } }, desc = { layout: pipelineLayout, fragment: { module, entryPoint: 'fs', targets: [{ format: this.format, blend }] }, primitive: { topology: 'triangle-list' }, multisample: { count: 4 } };
                this.quad = await d.createRenderPipelineAsync({ ...desc, vertex: { module, entryPoint: 'vsQuad' } });
                this.mesh = await d.createRenderPipelineAsync({ ...desc, vertex: { module, entryPoint: 'vsMesh', buffers: [{ arrayStride: 8, attributes: [{ shaderLocation: 0, format: 'float32x2', offset: 0 }] }] } });
                let validation = await d.popErrorScope();
                if (validation)
                    throw Error(validation.message);
                this.uniform = d.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
                this.sampler = d.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
                this.white = d.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
                d.queue.writeTexture({ texture: this.white }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1]);
                this.whiteEntry = { texture: this.white };
                this.ensureBuffers(128, 32);
                this.mode = 'WebGPU';
                d.lost.then(info => {
                    if (!this.disposed)
                        this.fallback('WebGPU device lost: ' + info.message);
                });
                d.addEventListener('uncapturederror', e => {
                    console.error(e.error);
                    this.lastError = e.error.message;
                });
                this.onStatus(this.mode);
                return;
            }
            catch (e) {
                console.warn('WebGPU unavailable; using Canvas 2D.', e);
                this.lastError = e.message;
            }
        }
        this.fallback(this.lastError);
    }
    fallback(reason) {
        if (this.context) {
            const replacement = this.canvas.cloneNode(false);
            this.canvas.replaceWith(replacement);
            this.canvas = replacement;
            this.context = null;
        }
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        this.mode = 'Canvas 2D';
        this.onStatus(this.mode, reason);
        this.resize(this.width, this.height);
        this.invalidate();
    }
    resize(w, h) {
        this.width = Math.max(1, w);
        this.height = Math.max(1, h);
        this.dpr = Math.min(devicePixelRatio || 1, 2);
        const width = Math.max(1, Math.round(w * this.dpr)), height = Math.max(1, Math.round(h * this.dpr));
        if (this.canvas.width === width && this.canvas.height === height && this.target)
            return;
        this.canvas.width = width;
        this.canvas.height = height;
        if (this.device && this.mode === 'WebGPU') {
            this.target?.destroy();
            this.target = this.device.createTexture({ size: [width, height], format: this.format, sampleCount: 4, usage: GPUTextureUsage.RENDER_ATTACHMENT });
        }
    }
    ensureBuffers(count, clips) {
        let changed = false;
        const next = x => Math.pow(2, Math.ceil(Math.log2(Math.max(1, x))));
        if (!this.instanceCapacity || count > this.instanceCapacity) {
            this.instanceBuffer?.destroy();
            this.instanceCapacity = next(count);
            this.instanceBuffer = this.device.createBuffer({ size: this.instanceCapacity * 144, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            changed = true;
        }
        if (!this.clipCapacity || clips > this.clipCapacity) {
            this.clipBuffer?.destroy();
            this.clipCapacity = next(clips);
            this.clipBuffer = this.device.createBuffer({ size: this.clipCapacity * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
            changed = true;
        }
        if (changed) {
            this.bindingVersion = (this.bindingVersion || 0) + 1;
        }
    }
    bind(entry) {
        if (entry.bindingVersion !== this.bindingVersion) {
            entry.bind = this.device.createBindGroup({ layout: this.layout, entries: [{ binding: 0, resource: { buffer: this.uniform } }, { binding: 1, resource: { buffer: this.instanceBuffer } }, { binding: 2, resource: { buffer: this.clipBuffer } }, { binding: 3, resource: entry.texture.createView() }, { binding: 4, resource: this.sampler }] });
            entry.bindingVersion = this.bindingVersion;
        }
        return entry.bind;
    }
    texture(n, scale) {
        const bucket = Math.min(4, Math.max(1, Math.pow(2, Math.ceil(Math.log2(scale * this.dpr)))));
        let key = n.type === 'image' ? JSON.stringify([n.src, n.w, n.h, bucket]) : JSON.stringify([n.text, n.w, n.h, n.fontFamily, n.fontSize, n.fontWeight, n.fontStyle, n.textAlign, n.lineHeight, n.letterSpacing, n.fill, n.shadowEnabled, n.shadowColor, n.shadowOpacity, n.shadowX, n.shadowY, n.shadowBlur, bucket]);
        let entry = this.textures.get(n.id);
        if (entry?.key === key) {
            entry.used = this.frame;
            return entry;
        }
        let source;
        if (n.type === 'image') {
            const image = this.images.get(n.src);
            if (!image)
                return this.whiteEntry;
            source = document.createElement('canvas');
            source.width = Math.min(4096, Math.max(1, Math.ceil(n.w * bucket)));
            source.height = Math.min(4096, Math.max(1, Math.ceil(n.h * bucket)));
            const c = source.getContext('2d');
            c.scale(source.width / n.w, source.height / n.h);
            paintImage(c, n, image);
        }
        else {
            source = document.createElement('canvas');
            let factor = Math.min(bucket, 4096 / Math.max(n.w, n.h));
            source.width = Math.max(1, Math.ceil(n.w * factor));
            source.height = Math.max(1, Math.ceil(n.h * factor));
            const c = source.getContext('2d');
            c.scale(source.width / n.w, source.height / n.h);
            if (n.shadowEnabled) {
                const a = rgba(n.shadowColor || '#000000', n.shadowOpacity ?? .18);
                c.shadowColor = `rgba(${a[0] * 255},${a[1] * 255},${a[2] * 255},${a[3]})`;
                c.shadowOffsetX = (n.shadowX ?? 0) * factor;
                c.shadowOffsetY = (n.shadowY ?? 4) * factor;
                c.shadowBlur = (n.shadowBlur ?? 12) * factor;
            }
            paintText(c, n);
        }
        entry?.texture.destroy();
        const texture = this.device.createTexture({ size: [source.width, source.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
        this.device.queue.copyExternalImageToTexture({ source }, { texture, premultipliedAlpha: true }, [source.width, source.height]);
        entry = { key, texture, bytes: source.width * source.height * 4, used: this.frame };
        this.textures.set(n.id, entry);
        return entry;
    }
    geometry(n) {
        let key = geometryKey(n), old = this.meshes.get(n.id);
        if (old?.key === key) {
            old.used = this.frame;
            return old;
        }
        if (old) {
            old.fill?.buffer.destroy();
            old.stroke?.buffer.destroy();
        }
        const rings = flatten(n), make = data => {
            if (!data.length)
                return null;
            let buffer = this.device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
            this.device.queue.writeBuffer(buffer, 0, data);
            return { buffer, count: data.length / 2 };
        };
        let entry = { key, fill: n.fill !== 'none' ? make(triangulate(rings)) : null, stroke: n.strokeWidth && n.stroke !== 'none' ? make(strokeMesh(rings, n.strokeWidth, n.type !== 'line' && (n.type !== 'path' || n.closed))) : null, used: this.frame };
        this.meshes.set(n.id, entry);
        return entry;
    }
    render(nodes, camera, bg = '#E9EAED') {
        const start = performance.now();
        this.frame++;
        if (this.mode !== 'WebGPU') {
            const c = this.ctx;
            if (!c)
                return;
            c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
            c.fillStyle = bg;
            c.fillRect(0, 0, this.width, this.height);
            c.save();
            c.translate(camera.x, camera.y);
            c.scale(camera.zoom, camera.zoom);
            paintTree(c, nodes, this.images);
            c.restore();
            this.drawCalls = 0;
            this.cpuMs = performance.now() - start;
            return;
        }
        // Browser compositing is used only for non-normal artistic blend modes.
        const hasBlend = ns => ns.some(n => n.blend && n.blend !== 'normal' || n.children && hasBlend(n.children));
        if (hasBlend(nodes)) {
            this.renderBlended(nodes, camera, bg);
            this.cpuMs = performance.now() - start;
            return;
        }
        let instances = [], clips = [], commands = [];
        const view = { x: -camera.x / camera.zoom, y: -camera.y / camera.zoom, w: this.width / camera.zoom, h: this.height / camera.zoom };
        const add = (n, m, opacity, clipIds, kind, texture = null, mesh = null, shadow = false) => {
            let pad = shadow ? (n.shadowBlur || 12) * 2 + 2 : Math.max(1, (n.strokeWidth || 0) / 2 + 1), w = n.w, h = n.h, fill = rgba(shadow ? n.shadowColor || '#000000' : n.fill, shadow ? n.shadowOpacity ?? .18 : 1), a = (n.gradientAngle || 0) * Math.PI / 180;
            let index = instances.length / 36, clipStart = clips.length / 12;
            for (const c of clipIds)
                clips.push(...c);
            instances.push(...m.slice(0, 4), m[4] + (shadow ? m[0] * (n.shadowX ?? 0) + m[2] * (n.shadowY ?? 4) : 0), m[5] + (shadow ? m[1] * (n.shadowX ?? 0) + m[3] * (n.shadowY ?? 4) : 0), w, h, ...fill, ...rgba(n.fill2 || n.fill), ...rgba(n.stroke), n.radius || 0, shadow ? 0 : n.strokeWidth || 0, kind, n.gradient && !shadow ? 1 : 0, opacity, Math.cos(a), Math.sin(a), n.shadowBlur || 12, clipStart, clipIds.length, 0, 0, -pad, -pad, w + pad * 2, h + pad * 2);
            commands.push({ index, texture: texture || this.whiteEntry, mesh });
        };
        const walk = (ns, parent = I, opacity = 1, clipIds = []) => {
            for (const n of ns) {
                if (n.visible === false)
                    continue;
                const m = mul(parent, matrix(n)), op = opacity * (n.opacity ?? 1), b = bounds(corners(n, m)), padding = (n.shadowBlur || 0) * 2 + (n.strokeWidth || 0);
                const visible = intersects({ x: b.x - padding, y: b.y - padding, w: b.w + padding * 2, h: b.h + padding * 2 }, view);
                if (visible && !isContainer(n)) {
                    const primitive = ['rect', 'ellipse', 'frame'].includes(n.type);
                    if (primitive) {
                        if (n.shadowEnabled)
                            add(n, m, op, clipIds, n.type === 'ellipse' ? 4 : 3, null, null, true);
                        add(n, m, op, clipIds, n.type === 'ellipse' ? 1 : 0);
                    }
                    else if (n.type === 'text' || n.type === 'image') {
                        add(n, m, op, clipIds, 2, this.texture(n, camera.zoom));
                    }
                    else {
                        const g = this.geometry(n);
                        if (g.fill)
                            add(n, m, op, clipIds, 5, null, g.fill);
                        if (g.stroke)
                            add(n, m, op, clipIds, 6, null, g.stroke);
                    }
                }
                if (n.children) {
                    let next = clipIds;
                    if (n.clip) {
                        const inv = inverse(m);
                        next = [...clipIds, [...inv.slice(0, 4), inv[4], inv[5], n.w, n.h, n.radius || 0, 0, 0, 0]];
                    }
                    if (!n.clip || visible)
                        walk(n.children, m, op, next);
                }
            }
        };
        walk(nodes);
        this.submit(instances, clips, commands, camera, bg);
        this.cpuMs = performance.now() - start;
        this.visibleCount = commands.length;
        if (this.frame % 120 === 0) {
            for (const [k, v] of this.textures)
                if (this.frame - v.used > 240) {
                    v.texture.destroy();
                    this.textures.delete(k);
                }
            for (const [k, v] of this.meshes)
                if (this.frame - v.used > 240) {
                    v.fill?.buffer.destroy();
                    v.stroke?.buffer.destroy();
                    this.meshes.delete(k);
                }
        }
    }
    submit(instances, clips, commands, camera, bg) {
        const d = this.device;
        this.ensureBuffers(instances.length / 36 || 1, clips.length / 12 || 1);
        d.queue.writeBuffer(this.uniform, 0, new Float32Array([this.width, this.height, camera.zoom, this.dpr, camera.x, camera.y, 0, 0]));
        if (instances.length)
            d.queue.writeBuffer(this.instanceBuffer, 0, new Float32Array(instances));
        if (clips.length)
            d.queue.writeBuffer(this.clipBuffer, 0, new Float32Array(clips));
        const encoder = d.createCommandEncoder(), color = rgba(bg);
        if (!this.target)
            this.resize(this.width, this.height);
        const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.target.createView(), resolveTarget: this.context.getCurrentTexture().createView(), clearValue: { r: color[0], g: color[1], b: color[2], a: 1 }, loadOp: 'clear', storeOp: 'discard' }] });
        this.drawCalls = 0;
        for (let i = 0; i < commands.length;) {
            const cmd = commands[i];
            pass.setPipeline(cmd.mesh ? this.mesh : this.quad);
            pass.setBindGroup(0, this.bind(cmd.texture));
            if (cmd.mesh) {
                pass.setVertexBuffer(0, cmd.mesh.buffer);
                pass.draw(cmd.mesh.count, 1, 0, cmd.index);
                i++;
            }
            else {
                let count = 1;
                while (i + count < commands.length && !commands[i + count].mesh && commands[i + count].texture === cmd.texture)
                    count++;
                pass.draw(6, count, 0, cmd.index);
                i += count;
            }
            this.drawCalls++;
        }
        pass.end();
        d.queue.submit([encoder.finish()]);
    }
    renderBlended(nodes, camera, bg) {
        if (!this.blendCanvas)
            this.blendCanvas = document.createElement('canvas');
        let c = this.blendCanvas;
        if (c.width !== this.canvas.width || c.height !== this.canvas.height) {
            c.width = this.canvas.width;
            c.height = this.canvas.height;
            this.blendTexture?.texture.destroy();
            this.blendTexture = null;
        }
        let ctx = c.getContext('2d');
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.translate(camera.x, camera.y);
        ctx.scale(camera.zoom, camera.zoom);
        paintTree(ctx, nodes, this.images);
        if (!this.blendTexture)
            this.blendTexture = { texture: this.device.createTexture({ size: [c.width, c.height], format: 'rgba8unorm', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT }) };
        this.device.queue.copyExternalImageToTexture({ source: c }, { texture: this.blendTexture.texture, premultipliedAlpha: true }, [c.width, c.height]);
        this.submit([1, 0, 0, 1, 0, 0, this.width, this.height, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 2, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, this.width, this.height], [], [{ index: 0, texture: this.blendTexture }], { x: 0, y: 0, zoom: 1 }, bg);
    }
    get metrics() {
        return { backend: this.mode, cpuMs: this.cpuMs || 0, drawCalls: this.drawCalls, visiblePrimitives: this.visibleCount || 0, textureBytes: [...this.textures.values()].reduce((s, t) => s + t.bytes, 0), frame: this.frame, error: this.lastError || null };
    }
}
