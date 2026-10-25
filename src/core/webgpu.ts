import type {GlyphAtlas} from "./atlas"
import {deviceSize, type Canvas, type DrawPass, type RenderBackend} from "./backend"
import {unpackRGBA, type PackedColor} from "./color"
import {GLYPH_STRIDE, type InstanceBuffer, RECT_STRIDE} from "./instances"

// Per-pass uniforms: viewport, offset, atlas size (vec2 each), dpr,
// then the clip rectangle in device pixels (x0, y0, x1, y1).
const shared = /* wgsl */`
struct U { viewport: vec2f, offset: vec2f, atlas: vec2f, dpr: f32, pad: f32, clip: vec4f }
@group(0) @binding(0) var<uniform> u: U;
fn corner(vi: u32) -> vec2f { return vec2f(f32(vi & 1u), f32(vi >> 1u)); }
// Positions and the pass offset snap to device pixels separately, so
// rows (a fractional number of device pixels apart, like the DOM's)
// keep their pixel spacing while scrolling.
fn snap(p: vec2f) -> vec2f { return floor(p * u.dpr + 0.5); }
fn toClip(p: vec2f) -> vec4f {
  return vec4f(p.x / u.viewport.x * 2.0 - 1.0, 1.0 - p.y / u.viewport.y * 2.0, 0.0, 1.0);
}
fn clipped(p: vec4f) -> bool {
  return p.x < u.clip.x || p.y < u.clip.y || p.x >= u.clip.z || p.y >= u.clip.w;
}
`

const glyphWGSL = shared + /* wgsl */`
@group(0) @binding(1) var tex: texture_2d<f32>;
struct VOut {
  @builtin(position) pos: vec4f,
  @location(0) @interpolate(flat) texel: vec2u,
  @location(1) local: vec2f,
  @location(2) @interpolate(flat) color: vec4f
}
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) pos: vec2f,
              @location(1) uv: vec2u, @location(2) size: vec2u, @location(3) color: vec4f) -> VOut {
  let c = corner(vi);
  let s = vec2f(size);
  let origin = snap(pos) + snap(u.offset);
  var out: VOut;
  out.pos = toClip(origin + c * s);
  out.texel = uv;
  out.local = c * s;
  out.color = color;
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (clipped(in.pos)) { discard; }
  // Glyph quads map 1:1 onto atlas texels, so load texels directly.
  let t = textureLoad(tex, in.texel + vec2u(in.local), 0);
  // Tint the coverage mask; a zero tint marks color glyphs (emoji).
  if (in.color.a == 0.0) { return t; }
  return vec4f(in.color.rgb, 1.0) * (t.a * in.color.a);
}
`

const rectWGSL = shared + /* wgsl */`
struct VOut { @builtin(position) pos: vec4f, @location(0) color: vec4f }
@vertex fn vs(@builtin(vertex_index) vi: u32, @location(0) rect: vec4f, @location(1) color: vec4f) -> VOut {
  let c = corner(vi);
  let off = snap(u.offset);
  let a = snap(rect.xy) + off;
  let b = max(snap(rect.xy + rect.zw) + off, a + 1.0);
  var out: VOut;
  out.pos = toClip(mix(a, b, c));
  out.color = vec4f(color.rgb * color.a, color.a);
  return out;
}
@fragment fn fs(in: VOut) -> @location(0) vec4f {
  if (clipped(in.pos)) { discard; }
  return in.color;
}
`

const UNIFORM_SLOT = 256
const UNIFORM_FLOATS = 12
const NO_CLIP = 1e7

interface BufferState {
	buffer: GPUBuffer
	bytes: number
}

const blend: GPUBlendState = {
	color: {srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add"},
	alpha: {srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add"}
}

/// WebGPU backend. Draw commands are recorded once into a render bundle
/// with indirect draws: a normal frame only writes the per-pass
/// uniforms (offsets) and instance counts, then executes the bundle.
/// The bundle is re-recorded only when the pass structure or a GPU
/// buffer changes.
export class WebGPUBackend implements RenderBackend {
	readonly kind = "webgpu" as const
	lost = false
	onLost: ((permanent: boolean) => void) | null = null
	onRestored: (() => void) | null = null
	readonly maxTextureSize: number
	private destroyed = false
	private context: GPUCanvasContext
	private format: GPUTextureFormat
	private glyphPipeline: GPURenderPipeline
	private rectPipeline: GPURenderPipeline
	private glyphLayout: GPUBindGroupLayout
	private rectLayout: GPUBindGroupLayout
	private uniforms!: GPUBuffer
	private indirect!: GPUBuffer
	private slots = 0
	private uniformData = new Float32Array(0)
	private indirectData = new Uint32Array(0)
	private texture: GPUTexture | null = null
	private atlas: GlyphAtlas | null = null
	private glyphGroup: GPUBindGroup | null = null
	private rectGroup!: GPUBindGroup
	private buffers = new WeakMap<InstanceBuffer, BufferState>()
	private bundle: GPURenderBundle | null = null
	private bundleKey: unknown[] = []
	private passDescriptor: GPURenderPassDescriptor
	private colorAttachment: GPURenderPassColorAttachment
	private width = 1
	private height = 1
	private dpr = 1

	/// Get a device: the slow, asynchronous part of setting up, which
	/// can start before the canvas is ready (null without WebGPU).
	static async requestDevice(): Promise<GPUDevice | null> {
		let gpu = (globalThis.navigator as Navigator | undefined)?.gpu
		if (!gpu) return null
		let adapter = await gpu.requestAdapter({powerPreference: "low-power"})
		return adapter ? adapter.requestDevice() : null
	}

	/// Create a WebGPU backend, or return null when no adapter exists.
	static async create(canvas: Canvas, device = WebGPUBackend.requestDevice()): Promise<WebGPUBackend | null> {
		let dev = await device
		return dev && new WebGPUBackend(canvas, dev, navigator.gpu.getPreferredCanvasFormat())
	}

	private constructor(readonly canvas: Canvas, readonly device: GPUDevice, format: GPUTextureFormat) {
		this.format = format
		this.maxTextureSize = device.limits.maxTextureDimension2D
		let context = canvas.getContext("webgpu") as GPUCanvasContext | null
		if (!context) throw new Error("canvas-view: WebGPU canvas context unavailable")
		this.context = context
		context.configure({device, format, alphaMode: "opaque"})
		// A lost device never comes back (whatever the reason, including
		// a device.destroy() elsewhere): the view creates a new backend.
		device.lost.then(() => {
			if (this.destroyed) return
			this.lost = true
			this.onLost?.(true)
		})

		let uniformEntry: GPUBindGroupLayoutEntry = {
			binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
			buffer: {type: "uniform", hasDynamicOffset: true, minBindingSize: UNIFORM_FLOATS * 4}
		}
		this.glyphLayout = device.createBindGroupLayout({entries: [
			uniformEntry,
			{binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {sampleType: "float"}}
		]})
		this.rectLayout = device.createBindGroupLayout({entries: [uniformEntry]})

		let glyphModule = device.createShaderModule({code: glyphWGSL})
		this.glyphPipeline = device.createRenderPipeline({
			layout: device.createPipelineLayout({bindGroupLayouts: [this.glyphLayout]}),
			vertex: {module: glyphModule, entryPoint: "vs", buffers: [{
				arrayStride: GLYPH_STRIDE * 4, stepMode: "instance",
				attributes: [
					{shaderLocation: 0, offset: 0, format: "float32x2"},
					{shaderLocation: 1, offset: 8, format: "uint16x2"},
					{shaderLocation: 2, offset: 12, format: "uint16x2"},
					{shaderLocation: 3, offset: 16, format: "unorm8x4"}
				]
			}]},
			fragment: {module: glyphModule, entryPoint: "fs", targets: [{format, blend}]},
			primitive: {topology: "triangle-strip"}
		})
		let rectModule = device.createShaderModule({code: rectWGSL})
		this.rectPipeline = device.createRenderPipeline({
			layout: device.createPipelineLayout({bindGroupLayouts: [this.rectLayout]}),
			vertex: {module: rectModule, entryPoint: "vs", buffers: [{
				arrayStride: RECT_STRIDE * 4, stepMode: "instance",
				attributes: [
					{shaderLocation: 0, offset: 0, format: "float32x4"},
					{shaderLocation: 1, offset: 16, format: "unorm8x4"}
				]
			}]},
			fragment: {module: rectModule, entryPoint: "fs", targets: [{format, blend}]},
			primitive: {topology: "triangle-strip"}
		})
		this.allocSlots(16)
		this.colorAttachment = {view: undefined as unknown as GPUTextureView, clearValue: {r: 0, g: 0, b: 0, a: 1}, loadOp: "clear", storeOp: "store"}
		this.passDescriptor = {colorAttachments: [this.colorAttachment]}
	}

	private allocSlots(slots: number) {
		this.uniforms?.destroy()
		this.indirect?.destroy()
		this.slots = slots
		this.uniformData = new Float32Array(slots * UNIFORM_SLOT / 4)
		this.indirectData = new Uint32Array(slots * 4)
		this.indirectData.fill(0xffffffff)
		this.uniforms = this.device.createBuffer({size: slots * UNIFORM_SLOT, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST})
		this.indirect = this.device.createBuffer({size: slots * 16, usage: GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST})
		this.rectGroup = this.device.createBindGroup({layout: this.rectLayout, entries: [
			{binding: 0, resource: {buffer: this.uniforms, size: UNIFORM_FLOATS * 4}}
		]})
		this.glyphGroup = this.makeGlyphGroup()
		this.bundle = null
	}

	private makeGlyphGroup() {
		if (!this.texture) return null
		return this.device.createBindGroup({layout: this.glyphLayout, entries: [
			{binding: 0, resource: {buffer: this.uniforms, size: UNIFORM_FLOATS * 4}},
			{binding: 1, resource: this.texture.createView()}
		]})
	}

	resize(width: number, height: number, dpr: number) {
		this.width = deviceSize(width, dpr)
		this.height = deviceSize(height, dpr)
		this.dpr = dpr
		if (this.canvas.width == this.width && this.canvas.height == this.height) return false
		this.canvas.width = this.width
		this.canvas.height = this.height
		return true
	}

	private createTexture(size: number) {
		return this.device.createTexture({
			size: [size, size], format: "rgba8unorm",
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC | GPUTextureUsage.RENDER_ATTACHMENT
		})
	}

	syncAtlas(atlas: GlyphAtlas) {
		if (this.lost) return
		let tex = this.texture
		if (!tex || atlas != this.atlas || tex.width > atlas.size) {
			// New atlas (font/DPR change) or no texture yet: full upload.
			tex?.destroy()
			this.texture = this.createTexture(atlas.size)
			atlas.markAllDirty()
			this.onTextureChanged()
		} else if (tex.width < atlas.size) {
			// The atlas grew: copy the old contents on the GPU.
			let next = this.createTexture(atlas.size)
			let encoder = this.device.createCommandEncoder()
			encoder.copyTextureToTexture({texture: tex}, {texture: next}, [tex.width, tex.height])
			this.device.queue.submit([encoder.finish()])
			tex.destroy()
			this.texture = next
			this.onTextureChanged()
		}
		this.atlas = atlas
		let d = atlas.takeDirty()
		if (d && d.w > 0 && d.h > 0) {
			this.device.queue.copyExternalImageToTexture(
				{source: atlas.source, origin: {x: d.x, y: d.y}},
				{texture: this.texture!, origin: {x: d.x, y: d.y}, premultipliedAlpha: true},
				{width: d.w, height: d.h})
		}
	}

	private onTextureChanged() {
		this.glyphGroup = this.makeGlyphGroup()
		this.bundle = null
	}

	private upload(buf: InstanceBuffer) {
		let state = this.buffers.get(buf)
		let from = buf.dirtyFrom
		if (!state || state.bytes < buf.byteLength) {
			state?.buffer.destroy()
			let size = Math.max(256, buf.buffer.byteLength)
			state = {buffer: this.device.createBuffer({size, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST}), bytes: size}
			this.buffers.set(buf, state)
			this.bundle = null
			from = 0
		}
		if (from < buf.count) {
			let w = buf.stride * 4
			this.device.queue.writeBuffer(state.buffer, from * w, buf.buffer, from * w, (buf.count - from) * w)
		}
		buf.markClean()
		return state.buffer
	}

	render(background: PackedColor, passes: readonly DrawPass[]) {
		if (this.lost) return
		if (passes.length > this.slots) this.allocSlots(Math.max(passes.length, this.slots * 2))
		let data = this.uniformData, ind = this.indirectData, slot = UNIFORM_SLOT / 4
		let atlasSize = this.texture?.width ?? 1
		let key = this.bundleKey, keyChanged = key.length != passes.length * 2, countsChanged = false
		for (let i = 0; i < passes.length; i++) {
			let p = passes[i]
			let gpuBuffer = this.upload(p.buffer)
			if (key[i * 2] !== gpuBuffer || key[i * 2 + 1] !== p.kind) keyChanged = true
			key[i * 2] = gpuBuffer
			key[i * 2 + 1] = p.kind
			let o = i * slot
			data[o] = this.width; data[o + 1] = this.height
			data[o + 2] = p.offsetX; data[o + 3] = p.offsetY
			data[o + 4] = atlasSize; data[o + 5] = atlasSize
			data[o + 6] = this.dpr
			let c = p.clip
			if (c) {
				data[o + 8] = Math.round(c.x * this.dpr); data[o + 9] = Math.round(c.y * this.dpr)
				data[o + 10] = Math.round((c.x + c.w) * this.dpr); data[o + 11] = Math.round((c.y + c.h) * this.dpr)
			} else {
				data[o + 8] = data[o + 9] = -NO_CLIP
				data[o + 10] = data[o + 11] = NO_CLIP
			}
			// Glyph passes can't draw before the atlas texture exists.
			let count = p.kind == "glyph" && !this.glyphGroup ? 0 : p.count
			if (ind[i * 4 + 1] != count || ind[i * 4] != 4) {
				// vertexCount, instanceCount, firstVertex, firstInstance
				ind[i * 4] = 4
				ind[i * 4 + 1] = count
				ind[i * 4 + 2] = 0
				ind[i * 4 + 3] = 0
				countsChanged = true
			}
			if (p.first != 0) throw new RangeError("canvas-view: WebGPU passes must start at instance 0")
		}
		key.length = passes.length * 2
		let queue = this.device.queue
		queue.writeBuffer(this.uniforms, 0, data.buffer, 0, passes.length * UNIFORM_SLOT)
		// Instance counts rarely change while scrolling.
		if (countsChanged) queue.writeBuffer(this.indirect, 0, ind.buffer, 0, passes.length * 16)
		if (keyChanged || !this.bundle) this.bundle = this.record(passes)

		let [r, g, b] = unpackRGBA(background)
		let clear = this.colorAttachment.clearValue as GPUColorDict
		clear.r = r / 255; clear.g = g / 255; clear.b = b / 255
		this.colorAttachment.view = this.context.getCurrentTexture().createView()
		let encoder = this.device.createCommandEncoder()
		let pass = encoder.beginRenderPass(this.passDescriptor)
		pass.executeBundles([this.bundle])
		pass.end()
		queue.submit([encoder.finish()])
	}

	private record(passes: readonly DrawPass[]) {
		let enc = this.device.createRenderBundleEncoder({colorFormats: [this.format]})
		let current: GPURenderPipeline | null = null
		for (let i = 0; i < passes.length; i++) {
			let p = passes[i]
			let glyph = p.kind == "glyph"
			if (glyph && !this.glyphGroup) continue
			let pipeline = glyph ? this.glyphPipeline : this.rectPipeline
			if (pipeline != current) enc.setPipeline(current = pipeline)
			enc.setBindGroup(0, glyph ? this.glyphGroup! : this.rectGroup, [i * UNIFORM_SLOT])
			enc.setVertexBuffer(0, this.buffers.get(p.buffer)!.buffer)
			enc.drawIndirect(this.indirect, i * 16)
		}
		return enc.finish()
	}

	destroy() {
		this.destroyed = true
		this.onLost = this.onRestored = null
		this.texture?.destroy()
		this.uniforms.destroy()
		this.indirect.destroy()
		this.context.unconfigure()
		this.device.destroy()
	}
}
