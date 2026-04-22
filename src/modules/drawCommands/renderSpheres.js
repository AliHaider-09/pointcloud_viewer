
import {Geometry, Vector3, Matrix4} from "potree";
import {sphere} from "../geometries/sphere.js";


const shaderSource = `
struct Uniforms {
	worldView : mat4x4<f32>,
	proj : mat4x4<f32>,
	screen_width : f32,
	screen_height : f32,
};

struct Mat4s { values : array<mat4x4<f32>> };

@binding(0) @group(0) var<uniform> uniforms     : Uniforms;
@binding(1) @group(0) var<storage, read> worldViewArray : Mat4s;
@binding(2) @group(0) var<storage, read> colors : array<vec4<f32>>;

struct VertexIn{
	@builtin(instance_index) instanceID    : u32,
	@location(0)             sphere_pos    : vec4<f32>,
	@location(1)             sphere_radius : f32,
	@location(2)             point_pos     : vec4<f32>,
	@location(3)             point_normal  : vec4<f32>,
};

struct VertexOut{
	@builtin(position)   out_pos   : vec4<f32>,
	@location(0)         fragColor : vec4<f32>,
};

struct FragmentIn{
	@location(0) fragColor : vec4<f32>,
};

struct FragmentOut{
	@location(0) outColor : vec4<f32>,
	@location(1) id : u32,
};

@vertex
fn main_vertex(vertex : VertexIn) -> VertexOut {

	var worldView = worldViewArray.values[vertex.instanceID];
	var worldPos : vec4<f32> = vertex.point_pos * vertex.sphere_radius;
	worldPos.w = 1.0;
	var viewPos : vec4<f32> = worldView * worldPos;

	var vout : VertexOut;
	// vout.fragColor = vec4<f32>(vertex.point_normal.xyz, 1.0);
	vout.fragColor = colors[vertex.instanceID];
	vout.out_pos = uniforms.proj * viewPos;

	return vout;
}

@fragment
fn main_fragment(fragment : FragmentIn) -> FragmentOut {

	var fout : FragmentOut;
	fout.outColor = fragment.fragColor;
	fout.id = 0u;

	return fout;
}
`;

let initialized = false;
let pipeline = null;
let geometry_spheres = null;
let uniformBuffer = null;
let mat4Buffer;
let colorsBuffer;

let bindGroup = null;
let capacity = 10_000;
let f32Matrices = new Float32Array(16 * capacity);
let f32Colors = new Float32Array(4 * capacity);

// Pre-allocated buffers for updateUniforms — avoid per-frame allocations
let _sUniformData = new ArrayBuffer(256);
let _sUniformF32 = new Float32Array(_sUniformData);
let _sUniformView = new DataView(_sUniformData);
let _sWorld = new Matrix4();
let _sWorldView = new Matrix4();

function createPipeline(renderer){

	let {device} = renderer;

	let module = device.createShaderModule({code: shaderSource});

	pipeline = device.createRenderPipeline({
		layout: "auto",
		vertex: {
			module: module,
			entryPoint: "main_vertex",
			buffers: [
				{ // sphere position
					arrayStride: 3 * 4,
					stepMode: "instance",
					attributes: [{ 
						shaderLocation: 0,
						offset: 0,
						format: "float32x3",
					}],
				},{ // sphere radius
					arrayStride: 4,
					stepMode: "instance",
					attributes: [{ 
						shaderLocation: 1,
						offset: 0,
						format: "float32",
					}],
				},{ // sphere-vertices position
					arrayStride: 3 * 4,
					stepMode: "vertex",
					attributes: [{ 
						shaderLocation: 2,
						offset: 0,
						format: "float32x3",
					}],
				},{ // sphere normal
					arrayStride: 4 * 3,
					stepMode: "vertex",
					attributes: [{ 
						shaderLocation: 3,
						offset: 0,
						format: "float32x3",
					}],
				}
			]
		},
		fragment: {
			module: module,
			entryPoint: "main_fragment",
			targets: [
				{format: "bgra8unorm"},
				{format: "r32uint"},
			],
		},
		primitive: {
			topology: 'triangle-list',
			cullMode: 'back',
		},
		depthStencil: {
			depthWriteEnabled: true,
			depthCompare: 'greater',
			format: "depth32float",
		},
	});

	return pipeline;
}

function init(renderer){

	if(initialized){
		return;
	}

	geometry_spheres = new Geometry({
		buffers: [{
			name: "position",
			buffer: new Float32Array(3 * capacity),
		},{
			name: "radius",
			buffer: new Float32Array(capacity),
		}]
	});

	{
		pipeline = createPipeline(renderer);

		let {device} = renderer;
		const uniformBufferSize = 256;

		uniformBuffer = device.createBuffer({
			size: uniformBufferSize,
			usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
		});

		mat4Buffer = device.createBuffer({
			size: 64 * capacity,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});

		colorsBuffer = device.createBuffer({
			size: 16 * capacity,
			usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
		});

		bindGroup = device.createBindGroup({
			layout: pipeline.getBindGroupLayout(0),
			entries: [
				{binding: 0, resource: {buffer: uniformBuffer}},
				{binding: 1, resource: {buffer: mat4Buffer}},
				{binding: 2, resource: {buffer: colorsBuffer}},
			],
		});
	}

	initialized = true;

}

function updateUniforms(drawstate){

	let {renderer, camera} = drawstate;

	// Reuse pre-allocated buffer (no allocation)
	_sUniformF32.fill(0);

	{ // transform
		// _sWorld is identity (elements[0,5,10,15] = 1, rest 0)
		let we = _sWorld.elements;
		we[0] = 1; we[1] = 0; we[2] = 0; we[3] = 0;
		we[4] = 0; we[5] = 1; we[6] = 0; we[7] = 0;
		we[8] = 0; we[9] = 0; we[10] = 1; we[11] = 0;
		we[12] = 0; we[13] = 0; we[14] = 0; we[15] = 1;

		_sWorldView.multiplyMatrices(camera.view, _sWorld);

		_sUniformF32.set(_sWorldView.elements, 0);
		_sUniformF32.set(camera.proj.elements, 16);
	}

	{ // misc
		let size = renderer.getSize();

		_sUniformView.setUint32(128, size.width, true);
		_sUniformView.setUint32(132, size.height, true);
	}

	renderer.device.queue.writeBuffer(uniformBuffer, 0, _sUniformData, 0, _sUniformData.byteLength);
}

export function render(spheres, drawstate){

	let {renderer} = drawstate;
	let {device} = renderer;

	init(renderer);

	updateUniforms(drawstate);

	let {passEncoder} = drawstate.pass;

	passEncoder.setPipeline(pipeline);
	passEncoder.setBindGroup(0, bindGroup);

	let position = geometry_spheres.buffers.find(g => g.name === "position").buffer;
	let radius = geometry_spheres.buffers.find(g => g.name === "radius").buffer;
	let vboPosition = renderer.getGpuBuffer(position);
	let vboRadius = renderer.getGpuBuffer(radius);

	{

		let world = _sWorld;
		let view = drawstate.camera.view;
		let worldView = _sWorldView;

		// Reset world to identity once before loop
		let we = world.elements;
		we[0] = 1; we[1] = 0; we[2] = 0; we[3] = 0;
		we[4] = 0; we[5] = 1; we[6] = 0; we[7] = 0;
		we[8] = 0; we[9] = 0; we[10] = 1; we[11] = 0;
		we[12] = 0; we[13] = 0; we[14] = 0; we[15] = 1;

		for(let i = 0; i < spheres.length; i++){
			let sphere = spheres[i];
			let pos = sphere[0];

			position[3 * i + 0] = pos.x;
			position[3 * i + 1] = pos.y;
			position[3 * i + 2] = pos.z;

			radius[i] = sphere[1];

			world.elements[12] = pos.x;
			world.elements[13] = pos.y;
			world.elements[14] = pos.z;
			
			worldView.multiplyMatrices(view, world);

			f32Matrices.set(worldView.elements, 16 * i);

			if(sphere[2].color){
				let color = sphere[2].color;
				f32Colors[4 * i + 0] = color.x;
				f32Colors[4 * i + 1] = color.y;
				f32Colors[4 * i + 2] = color.z;
				f32Colors[4 * i + 3] = color.w;
			}else{
				f32Colors[4 * i + 0] = 1.0;
				f32Colors[4 * i + 1] = 0.0;
				f32Colors[4 * i + 2] = 0.0;
				f32Colors[4 * i + 3] = 1.0;
			}
			
		}

		let numSpheres = spheres.length;
		device.queue.writeBuffer(vboPosition, 0, position.buffer, 0, 12 * numSpheres);
		device.queue.writeBuffer(vboRadius, 0, radius.buffer, 0, 4 * numSpheres);
		device.queue.writeBuffer(mat4Buffer, 0, f32Matrices.buffer, 0, 64 * numSpheres);
		device.queue.writeBuffer(colorsBuffer, 0, f32Colors.buffer, 0, 16 * numSpheres);
	}

	{ // solid
		let sphereVertices = sphere.buffers.find(b => b.name === "position").buffer;
		let sphereNormals = sphere.buffers.find(b => b.name === "normal").buffer;
		let vboSphereVertices = renderer.getGpuBuffer(sphereVertices);
		let vboSphereNormals = renderer.getGpuBuffer(sphereNormals);

		passEncoder.setVertexBuffer(0, vboPosition);
		passEncoder.setVertexBuffer(1, vboRadius);
		passEncoder.setVertexBuffer(2, vboSphereVertices);
		passEncoder.setVertexBuffer(3, vboSphereNormals);

		let vboIndices = renderer.getGpuBuffer(sphere.indices);

		passEncoder.setIndexBuffer(vboIndices, "uint32");

		let numSpheres = spheres.length;
		let numVertices = sphere.numElements;
		// passEncoder.draw(numVertices, numSpheres, 0, 0);

		let numIndices = sphere.indices.length;
		passEncoder.drawIndexed(numIndices, numSpheres);
	}


};