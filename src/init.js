
import {Vector3, Ray} from "potree";
import {
	Scene, SceneNode, Camera, OrbitControls, PotreeControls, StationaryControls, FirstPersonControls, Mesh, RenderTarget,
	PointCloudOctree,
} from "potree";
import {Renderer, Timer, EventDispatcher, InputHandler} from "potree";
import {geometries} from "potree";
import {Potree} from "potree";
import {MeasureTool} from "./interaction/measure.js";
import * as ProgressiveLoader from "./modules/progressive_loader/ProgressiveLoader.js";
import { 
	renderPointsOctree, renderQuadsOctree
} from "potree";
import {dilate, EDL, hqs_normalize} from "potree";
import * as TWEEN from "tween";
import {loadEpoch, incrementEpoch} from "./potree/LoadEpoch.js";
import {cancelStaleWorkers, nodesLoading, setMaxConcurrentNodes} from "./potree/octree/loader/PotreeLoader.js";
import {cancelStaleWorkers_v3} from "./potree/octree/loader_v3/Potree3Loader.js";
import {cancelStaleWorkers_copc} from "./potree/octree/loader/CopcLoader.js";

let frame = 0;
let lastFpsCount = 0;
let framesSinceLastCount = 0;
let fps = 0;
let lastFrameTime = 0;

let renderer = null;
let camera = null;
let controls = null;
let measure = null;
let dbgImage = null;
let inputHandler = null;

let dispatcher = new EventDispatcher();

// Camera movement detection for stale request cancellation
let prevCamElements = null;
let moveDebounceTimer = null;
let isMoving = false;

let scene = new Scene();
let dbgSphere = null;

function addEventListener(name, callback){
	dispatcher.addEventListener(name, callback);
}

function removeEventListener(name, callback){
	dispatcher.removeEventListener(name, callback);
}

dispatcher.add("click", (e) => {
	console.log("click");
});

function initScene(){
	// {
	// 	let mesh = new Mesh("cube", geometries.cube);
	// 	mesh.scale.set(0.5, 0.5, 0.5);

	// 	scene.root.children.push(mesh);
	// }

	dbgSphere = new Mesh("sphere", geometries.sphere);
	dbgSphere.scale.set(0.1, 0.1, 0.1);
	dbgSphere.visible = false;
	// dbgSphere.renderLayer = 10;
	scene.root.children.push(dbgSphere);
}

function update(){
	let now = performance.now();

	if((now - lastFpsCount) >= 1000.0){

		fps = framesSinceLastCount;

		lastFpsCount = now;
		framesSinceLastCount = 0;
		Potree.state.fps = Math.floor(fps).toLocaleString();
	}

	let timeSinceLastFrame = (lastFrameTime - now) / 1000;
	frame++;
	framesSinceLastCount++;

	controls.update(timeSinceLastFrame);
	camera.world.copy(controls.world);

	camera.updateView();
	Potree.state.camPos = camera.getWorldPosition().toString(1);
	Potree.state.camTarget = controls.pivot.toString(1);
	Potree.state.camDir = camera.getWorldDirection().toString(1);

	// Detect camera movement for stale request cancellation
	{
		let els = camera.world.elements;
		if(prevCamElements === null){
			// First frame — just record, don't trigger
			prevCamElements = new Float64Array(els);
		}else{
			let maxDelta = 0;
			for(let i = 0; i < 16; i++){
				maxDelta = Math.max(maxDelta, Math.abs(els[i] - prevCamElements[i]));
			}
			if(maxDelta > 0.05){
				prevCamElements.set(els);

				// Immediate cancellation on movement start
				if(!isMoving){
					isMoving = true;
					incrementEpoch();
					cancelStaleWorkers();
					cancelStaleWorkers_v3();
					cancelStaleWorkers_copc();
				}

				if(moveDebounceTimer !== null){
					clearTimeout(moveDebounceTimer);
				}
				moveDebounceTimer = setTimeout(() => {
					moveDebounceTimer = null;
					isMoving = false;
					incrementEpoch();
					cancelStaleWorkers();
					cancelStaleWorkers_v3();
					cancelStaleWorkers_copc();
				}, 350);
			}
		}
	}

	let size = renderer.getSize();
	camera.aspect = size.width / size.height;
	camera.updateProj();

	dispatcher.dispatch("update");

	lastFrameTime = now;
}

let sumBuffer = null;
function getSumBuffer(renderer){

	if(sumBuffer){
		return sumBuffer;
	}

	let size = [128, 128, 1];
	let descriptor = {
		size: size,
		colorDescriptors: [
			{
				size: size,
				format: "rgba16float",
				usage: GPUTextureUsage.TEXTURE_BINDING 
					| GPUTextureUsage.RENDER_ATTACHMENT,
			},{
				size: size,
				format: "r32uint",
				usage: GPUTextureUsage.TEXTURE_BINDING 
					| GPUTextureUsage.COPY_SRC 
					| GPUTextureUsage.COPY_DST 
					| GPUTextureUsage.RENDER_ATTACHMENT,
			}
		],
		depthDescriptor: {
			size: size,
			format: "depth32float",
			usage: GPUTextureUsage.TEXTURE_BINDING 
				| GPUTextureUsage.RENDER_ATTACHMENT,
		}
	};

	sumBuffer = new RenderTarget(renderer, descriptor);

	return sumBuffer;

}

function startPass(renderer, target, label){
	let view = target.colorAttachments[0].texture.createView();

	let colorAttachments = [{
		view, 
		loadOp: "clear", 
		clearValue: Potree.settings.background === "white"
			? { r: 1.0, g: 1.0, b: 1.0, a: 1.0 }
			: Potree.settings.background === "black"
			? { r: 0.0, g: 0.0, b: 0.0, a: 1.0 }
			: { r: 0.1, g: 0.2, b: 0.3, a: 1.0 },
		storeOp: 'store',
	}];

	if(target.colorAttachments.length === 2){
		let view = target.colorAttachments[1].texture.createView();
		colorAttachments.push({
			view, 
			loadOp: "clear", 
			clearValue: { r: 0, g: 0, b: 0, a: 0},
			storeOp: 'store',
		});
	}

	let renderPassDescriptor = {
		colorAttachments,
		depthStencilAttachment: {
			view: target.depth.texture.createView(),
			depthLoadOp: "clear", depthClearValue: 0,
			depthStoreOp: "store",
		},
		sampleCount: 1,
	};

	let timestampEntry = null;
	if(renderer.timestamps.enabled){
		
		let startIndex = 2 * renderer.timestamps.entries.length;

		renderPassDescriptor.timestampWrites = {
			querySet:                  renderer.timestamps.querySet,
			beginningOfPassWriteIndex: startIndex,
			endOfPassWriteIndex:       startIndex + 1,
		};

		timestampEntry = {
			startIndex : startIndex,
			endIndex   : startIndex + 1,
			label      : label,
		};

		renderer.timestamps.entries.push(timestampEntry);
	}

	const commandEncoder = renderer.device.createCommandEncoder();
	const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

	return {commandEncoder, passEncoder, timestampEntry};
}

function revisitPass(renderer, target, label){
	let view = target.colorAttachments[0].texture.createView();

	let colorAttachments = [
		{view, loadOp: "load", storeOp: 'store'}
	];

	if(target.colorAttachments.length === 2){
		let view = target.colorAttachments[1].texture.createView();
		colorAttachments.push({view, loadOp: "load", storeOp: 'store'});
	}

	let renderPassDescriptor = {
		colorAttachments,
		depthStencilAttachment: {
			view: target.depth.texture.createView(),
			depthLoadOp: "load",
			depthStoreOp: "store",
		},
		sampleCount: 1,
	};

	let timestampEntry = null;
	if(renderer.timestamps.enabled){
		
		let startIndex = 2 * renderer.timestamps.entries.length;

		renderPassDescriptor.timestampWrites = {
			querySet:                  renderer.timestamps.querySet,
			beginningOfPassWriteIndex: startIndex,
			endOfPassWriteIndex:       startIndex + 1,
		};

		timestampEntry = {
			startIndex : startIndex,
			endIndex   : startIndex + 1,
			label      : label,
		};

		renderer.timestamps.entries.push(timestampEntry);
	}

	const commandEncoder = renderer.device.createCommandEncoder();
	const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

	return {commandEncoder, passEncoder, timestampEntry};
}

function startSumPass(renderer, target, label){
	let view = target.colorAttachments[0].texture.createView();

	let colorAttachments = [{
		view, 
		loadOp: "clear", 
		clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 0.0 },
		storeOp: 'store',
	}];

	if(target.colorAttachments.length === 2){
		let view = target.colorAttachments[1].texture.createView();
		colorAttachments.push({
			view, 
			loadOp: "clear", 
			clearValue: { r: 0, g: 0, b: 0, a: 0},
			storeOp: 'store',
		});
	}

	let renderPassDescriptor = {
		colorAttachments,
		depthStencilAttachment: {
			view: target.depth.texture.createView(),
			depthLoadOp: "load",
			depthStoreOp: "store",
		},
		sampleCount: 1,
	};

	let timestampEntry = null;
	if(renderer.timestamps.enabled){
		
		let startIndex = 2 * renderer.timestamps.entries.length;

		renderPassDescriptor.timestampWrites = {
			querySet:                  renderer.timestamps.querySet,
			beginningOfPassWriteIndex: startIndex,
			endOfPassWriteIndex:       startIndex + 1,
		};

		timestampEntry = {
			startIndex : startIndex,
			endIndex   : startIndex + 1,
			label      : label,
		};

		renderer.timestamps.entries.push(timestampEntry);
	}

	const commandEncoder = renderer.device.createCommandEncoder();
	const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);

	return {commandEncoder, passEncoder, timestampEntry};
}

function endPass(pass){

	let {passEncoder, commandEncoder, timestampEntry} = pass;

	passEncoder.end();

	// handle timestamp queries
	if(timestampEntry)
	if(renderer.timestamps.resultBuffer){

		let {resultBuffer} = renderer.timestamps;

		if(resultBuffer.mapState === "mapped"){
			debugger;
		}
		
		let byteOffset = 256 * timestampEntry.startIndex / 2;
		commandEncoder.resolveQuerySet(
			renderer.timestamps.querySet, timestampEntry.startIndex, 2, 
			renderer.timestamps.resolveBuffer, byteOffset
		);

		commandEncoder.copyBufferToBuffer(
			renderer.timestamps.resolveBuffer, byteOffset,
			renderer.timestamps.resultBuffer, byteOffset,
			256
		);
	}

	let commandBuffer = commandEncoder.finish();
	renderer.device.queue.submit([commandBuffer]);
}

function renderBasic(){
	let layers = new Map();

	let stack = [scene.root];
	while(stack.length > 0){
		let node = stack.pop();

		if(!node.visible){
			continue;
		}

		let layer = layers.get(node.renderLayer);
		if(!layer){
			layer = {renderables: new Map()};
			layers.set(node.renderLayer, layer);
		}

		let renderables = layer.renderables;

		let nodeType = node.constructor.name;
		if(!renderables.has(nodeType)){
			renderables.set(nodeType, []);
		}
		renderables.get(nodeType).push(node);

		for(let child of node.children){

			child.updateWorld();
			child.world.multiplyMatrices(node.world, child.world);

			stack.push(child);
		}
	}

	let renderables = layers.get(0).renderables;

	renderer.start();
	// renderer.updateScreenbuffer();

	let screenbuffer = renderer.screenbuffer;

	let pass = startPass(renderer, screenbuffer, "render basic");
	let drawstate = {renderer, camera, renderables, pass};

	for(let [key, nodes] of renderables){
		for(let node of nodes){
			if(typeof node.render !== "undefined"){
				node.render(drawstate);
			}
		}
	}

	renderer.renderDrawCommands(drawstate);

	endPass(pass);

	renderer.finish();
}

// Track camera/budget changes to skip updateVisibility when idle
let _lastCamHash = 0;
let _lastBudget = 0;

function renderNotSoBasic(){
	// Timer.setEnabled(true);

	Potree.state.renderedObjects = [];
	Potree.state.renderedElements = 0;


	let layers = new Map();

	// Traverse scenegraph and assemble renderables
	let stack = [scene.root];
	while(stack.length > 0){
		let node = stack.pop();

		if(!node.visible){
			continue;
		}

		let layer = layers.get(node.renderLayer);
		if(!layer){
			layer = {renderables: new Map()};
			layers.set(node.renderLayer, layer);
		}

		let renderables = layer.renderables;

		let nodeType = node.constructor.name;
		if(!renderables.has(nodeType)){
			renderables.set(nodeType, []);
		}
		renderables.get(nodeType).push(node);

		for(let child of node.children){

			child.updateWorld();
			child.world.multiplyMatrices(node.world, child.world);

			stack.push(child);
		}
	}

	let renderables = layers.get(0).renderables;

	let points = renderables.get("Points") ?? [];
	let octrees = renderables.get("PointCloudOctree") ?? [];

	Potree.state.numVisiblePoints   = 0;
	Potree.state.numPoints          = 0;
	Potree.state.numVoxels          = 0;
	Potree.state.numElements        = 0;
	Potree.state.numNodes           = 0;
	Potree.state.num3DTileNodes     = 0;
	Potree.state.num3DTileTriangles = 0;

	// Skip updateVisibility when nothing changed — saves the full octree traversal.
	// Must run when: camera moves, budget changes, or nodes are still loading.
	let _camHash = camera.view ? (camera.view.elements[12] + camera.view.elements[13] + camera.view.elements[14] + camera.view.elements[0]) : 0;
	let _needsVisUpdate = (_camHash !== _lastCamHash) || (_lastBudget !== Potree.settings.pointBudget) || (nodesLoading > 0);
	_lastCamHash = _camHash;
	_lastBudget = Potree.settings.pointBudget;
	// Still run at least every 30 frames to catch edge cases
	if (!_needsVisUpdate) {
		let _visFrame = renderer.frameCounter || 0;
		if (_visFrame % 30 === 0) _needsVisUpdate = true;
	}

	for(let octree of octrees){
		octree.showBoundingBox = Potree.settings.showBoundingBox;
		octree.pointBudget = Potree.settings.pointBudget;
		octree.pointSize = Potree.settings.pointSize;

		if(Potree.settings.updateEnabled && _needsVisUpdate){
			octree.updateVisibility(camera, renderer);
		}

		// Zero-alloc point count — avoid .map().reduce() array allocation every frame
		let _nvp = 0;
		for(let _ni = 0; _ni < octree.visibleNodes.length; _ni++) _nvp += octree.visibleNodes[_ni].numPoints;
		Potree.state.numVisiblePoints += _nvp;
	}

	// Track GPU memory usage (approximate from uploaded buffers)
	Potree.state.gpuMemoryMB = Math.round(renderer.cpuGpuBuffers.size * 0.25);

	// Throttle LRU cleanup — only every 10th frame (GPU buffer destruction causes stalls)
	if ((renderer.frameCounter || 0) % 10 === 0) {
		PointCloudOctree.clearLRU(renderer);
	}

	Timer.frameStart(renderer);
	
	let hqsEnabled = Potree.settings.hqsEnabled;
	let edlEnabled = Potree.settings.edlEnabled;
	let dilateEnabled = Potree.settings.dilateEnabled;

	renderer.start();
	// renderer.updateScreenbuffer();

	let screenbuffer = renderer.screenbuffer;
	let fbo_source = screenbuffer;

	let fbo_0 = renderer.getFramebuffer("fbo intermediate 0");
	let fbo_1 = renderer.getFramebuffer("fbo intermediate 1");
	
	fbo_0.setSize(...screenbuffer.size);
	fbo_1.setSize(...screenbuffer.size);
	
	let forwardRendering = !(hqsEnabled || dilateEnabled || edlEnabled);

	let fboTarget = (!dilateEnabled && !edlEnabled) ? screenbuffer : fbo_0;
	
	if(hqsEnabled){

		Timer.timestampSep(renderer, "HQS(total)-start");

		let fbo_hqs_depth = renderer.getFramebuffer("hqs depth");
		let fbo_hqs_sum = getSumBuffer(renderer);

		fbo_hqs_sum.setSize(...screenbuffer.size);
		fbo_hqs_depth.setSize(...screenbuffer.size);

		{ // depth pass
			let pass = startPass(renderer, fbo_hqs_depth, "HQS-depth");
			let drawstate = {renderer, camera, renderables, pass};

			renderPointsOctree(octrees, drawstate, ["hqs-depth"]);

			endPass(pass);
		}

		{ // attribute pass
			fbo_hqs_sum.depth = fbo_hqs_depth.depth;

			let pass = startSumPass(renderer, fbo_hqs_sum, "HQS-accumulate");
			let drawstate = {renderer, camera, renderables, pass};

			renderPointsOctree(octrees, drawstate, ["additive_blending"]);

			endPass(pass);
		}

		{ // normalization pass
			let pass = startPass(renderer, fboTarget, "HQS-normalize");
			let drawstate = {renderer, camera, renderables, pass};

			// Timer.timestamp(pass.passEncoder, "HQS-normalize-start");
			hqs_normalize(fbo_hqs_sum, drawstate);
			// Timer.timestamp(pass.passEncoder, "HQS-normalize-end");

			endPass(pass);
		}

		fbo_source = fboTarget;

		Timer.timestampSep(renderer, "HQS(total)-end");

	}else if(forwardRendering){

		// // render directly to screenbuffer
		// let pass = startPass(renderer, screenbuffer);
		// let drawstate = {renderer, camera, renderables, pass};

		// for(let [key, nodes] of renderables){
		// 	for(let node of nodes){
		// 		if(typeof node.render !== "undefined"){
		// 			node.render(drawstate);
		// 		}
		// 	}
		// }

		// renderer.renderDrawCommands(drawstate);

		// endPass(pass);
	}else{

		// render to intermediate framebuffer
		let pass = startPass(renderer, fbo_0, "render to intermediate");
		let drawstate = {renderer, camera, renderables, pass};

		renderPointsOctree(octrees, drawstate);

		endPass(pass);

		fbo_source = fbo_0;
	}


	// // DILATE
	// if(dilateEnabled && Potree.settings.pointSize >= 2){ // dilate
	// 	// let fboTarget = edlEnabled ? fbo_1 : screenbuffer;
	// 	let fboTarget = fbo_1;

	// 	let pass = startPass(renderer, fboTarget);
	// 	let drawstate = {renderer, camera, renderables, pass};

	// 	dilate(fbo_source, drawstate);

	// 	endPass(pass);

	// 	fbo_source = fboTarget;
	// }

	// renderer.drawBoundingBox(
	// 	new Vector3(0.0, 0.0, 0.0),
	// 	new Vector3(50, 50, 50),
	// 	new Vector3(0, 255, 0),
	// );
	// renderer.drawBoundingBox(
	// 	new Vector3(4323655, 511232, 4646856),
	// 	new Vector3(50, 50, 50),
	// 	new Vector3(0, 255, 0),
	// );

	{ // render everything but point clouds
		let pass = revisitPass(renderer, fbo_source, "render everything else");
		let drawstate = {renderer, camera, renderables, pass};

		for(let [key, nodes] of renderables){
			for(let node of nodes){
				let hasRender = typeof node.render !== "undefined";
				let isOctree = node.constructor.name === "PointCloudOctree";
				let isGS = node.constructor.name === "GaussianSplats";
				let isImages360 = node.constructor.name === "Images360";

				if(hasRender && !isOctree && !isGS){
					node.render(drawstate);
				}
			}
		}

		renderer.renderDrawCommands(drawstate);

		endPass(pass);
	}

	// EDL
	if(edlEnabled){ 
		let pass = startPass(renderer, screenbuffer, "EDL");
		let drawstate = {renderer, camera, renderables, pass};

		EDL(fbo_source, drawstate);

		endPass(pass);
	}

	{ // Render Gaussian Splats into their own render target, then compose with previously rendered stuff
		let drawstate = {renderer, camera, renderables};

		for(let [key, nodes] of renderables){
			for(let node of nodes){
				let isGS = node.constructor.name === "GaussianSplats";

				if(isGS){
					node.render(drawstate);
				}
			}
		}
	}

	{ // HANDLE PICKING — adaptive throttle + skip during camera movement

		// readPixels → mapAsync blocks until GPU finishes ALL queued rendering.
		// At 92M+ points, GPU render time is high → pick stall freezes the main thread.
		// Skip entirely during camera movement — picking during orbit/pan is useless
		// and causes the worst stalls (GPU is busiest re-rendering the moved view).
		let _pickFrame = (renderer.frameCounter || 0);
		let _visiblePts = Potree.state.numVisiblePoints || 0;
		let _skipPick = isMoving; // completely skip readPixels during orbit/pan
		let _pickEvery;
		if (nodesLoading > 5) {
			_pickEvery = 15;
		} else if (_visiblePts > 50_000_000) {
			_pickEvery = 10;
		} else if (_visiblePts > 10_000_000) {
			_pickEvery = 6;
		} else {
			_pickEvery = 3;
		}
		if(_skipPick || _pickFrame % _pickEvery !== 0){
			// Still process pick queue callbacks with last known position
			for(let {x, y, callback} of Potree.pickQueue){
				let position = Potree.pickPosition;
				let distance = camera.getWorldPosition().distanceTo(position);
				callback({distance, position});
			}
			Potree.pickQueue.length = 0;
		}else{

		let renderedObjects = Potree.state.renderedObjects;

		let mouse = inputHandler.mouse;
		let searchWindow = 3;
		let wh = searchWindow / 2;
		// console.log(mouse);
		renderer.readPixels(fbo_source.colorAttachments[1].texture, mouse.x - wh, mouse.y - wh, searchWindow, searchWindow).catch(e => {
			// Device lost during readPixels — silently ignore
			return null;
		}).then(buffer => {
			if(!buffer) return;

			let maxID = Math.max(...new Uint32Array(buffer));

			if(maxID === 0){
				return;
			}

			let node = null;
			let counter = 0;
			for(let i = 0; i < renderedObjects.length; i++){
				let object = renderedObjects[i];

				if(maxID < counter + object.numElements){
					node = object.node;
					break;
				}

				counter += object.numElements;
			}

			let elementIndex = maxID - counter;

			if(node?.constructor.name === "PointCloudOctreeNode"){

				let pointBuffer = node.geometry.buffer;
				let view = new DataView(pointBuffer);

				let point = node.getPoint(elementIndex);

				// let x = view.getFloat32(12 * elementIndex + 0, true);
				// let y = view.getFloat32(12 * elementIndex + 4, true);
				// let z = view.getFloat32(12 * elementIndex + 8, true);

				// x = x + node.octree.position.x;
				// y = y + node.octree.position.y;
				// z = z + node.octree.position.z;

				// let position = new Vector3(x, y, z);

				Potree.pickPosition.copy(point.position);

				Potree.hoveredItem = {
					type: node?.constructor.name + " (Point)",
					instance: node,
					node: node,
					pointIndex: elementIndex,
					position: point.position,
					object: node.octree,
				};

			}else if(node?.constructor.name === "Images360"){

				let images = node;
				let image = node.images[elementIndex];
				
				let position = image.position.clone().add(images.position);

				Potree.pickPosition.copy(position);

				node.setHovered(elementIndex);

				Potree.hoveredItem = {
					type: image?.constructor.name,
					image, images, position,
					object: images,
				};
			}else if(node?.constructor.name === "Mesh"){
				let {geometry} = node;
				let positions = geometry.buffers.find(buffer => buffer.name === "position");
				let view = new DataView(positions.buffer.buffer);

				let p0 = new Vector3(
					view.getFloat32(3 * 12 * elementIndex +  0, true),
					view.getFloat32(3 * 12 * elementIndex +  4, true),
					view.getFloat32(3 * 12 * elementIndex +  8, true),
				);
				let p1 = new Vector3(
					view.getFloat32(3 * 12 * elementIndex + 12, true),
					view.getFloat32(3 * 12 * elementIndex + 16, true),
					view.getFloat32(3 * 12 * elementIndex + 20, true),
				);
				let p2 = new Vector3(
					view.getFloat32(3 * 12 * elementIndex + 24, true),
					view.getFloat32(3 * 12 * elementIndex + 28, true),
					view.getFloat32(3 * 12 * elementIndex + 32, true),
				);

				let center = p0.clone().add(p1).add(p2).divideScalar(3);

				center.applyMatrix4(node.world);

				Potree.pickPosition.copy(center);

				Potree.hoveredItem = {
					type: node?.constructor.name,
					instance: node,
					node: node,
					pointIndex: elementIndex,
					position: center,
					object: node,
				};
				
				
			}else if(node?.constructor.name === "TDTiles"){
				// console.log("hovering a 3D Tile");
			}else if(node?.constructor.name === "TDTilesNode"){

				let tiles = node.tdtile;
				let position = new Vector3();

				let triangleIndex = elementIndex;

				{
					let b3dm = node.content.b3dm;
					let json = b3dm.gltf.json;
					let binStart = b3dm.gltf.chunks[1].start;

					let indexBufferRef  = json.meshes[0].primitives[0].indices;
					let POSITION_bufferRef = json.meshes[0].primitives[0].attributes.POSITION;
					let TEXCOORD_bufferRef = json.meshes[0].primitives[0].attributes.TEXCOORD_0;

					let index_accessor      = json.accessors[indexBufferRef];
					let POSITION_accessor   = json.accessors[POSITION_bufferRef];

					let index_bufferView    = json.bufferViews[index_accessor.bufferView];
					let POSITION_bufferView = json.bufferViews[POSITION_accessor.bufferView];

					let buffer = node.content.b3dm.buffer;
					let view = new DataView(buffer);

					let offset_indexbuffer = binStart + 8 + index_bufferView.byteOffset
					let offset_posbuffer   = binStart + 8 + POSITION_bufferView.byteOffset;

					// 3 vertices per triangle, 2 bytes per vertex
					let index_v0 = view.getUint16(offset_indexbuffer + 3 * 2 * triangleIndex + 0, true);
					let index_v1 = view.getUint16(offset_indexbuffer + 3 * 2 * triangleIndex + 2, true);
					let index_v2 = view.getUint16(offset_indexbuffer + 3 * 2 * triangleIndex + 4, true);


					let v0 = new Vector3(
						 view.getFloat32(offset_posbuffer + 12 * index_v0 + 0, true),
						-view.getFloat32(offset_posbuffer + 12 * index_v0 + 8, true),
						 view.getFloat32(offset_posbuffer + 12 * index_v0 + 4, true),
					);
					let v1 = new Vector3(
						 view.getFloat32(offset_posbuffer + 12 * index_v1 + 0, true),
						-view.getFloat32(offset_posbuffer + 12 * index_v1 + 8, true),
						 view.getFloat32(offset_posbuffer + 12 * index_v1 + 4, true),
					);
					let v2 = new Vector3(
						 view.getFloat32(offset_posbuffer + 12 * index_v2 + 0, true),
						-view.getFloat32(offset_posbuffer + 12 * index_v2 + 8, true),
						 view.getFloat32(offset_posbuffer + 12 * index_v2 + 4, true),
					);

					v0.applyMatrix4(node.world);
					v1.applyMatrix4(node.world);
					v2.applyMatrix4(node.world);

					position.copy(v0).add(v1).add(v2).multiplyScalar(1 / 3);


					let dpr = window.devicePixelRatio;
					let u = mouse.x / (dpr * renderer.canvas.clientWidth);
					let v = 1 - mouse.y / (dpr * renderer.canvas.clientHeight);
					
					let origin = controls.getPosition();
					let dir = camera.mouseToDirection(u, v);

					let ray = new Ray(origin, dir);
					let closest_v0 = ray.closestPointToPoint(v0);
					let closest_v1 = ray.closestPointToPoint(v1);
					let closest_v2 = ray.closestPointToPoint(v2);
					
					let d_0 = origin.distanceTo(closest_v0);
					let d_1 = origin.distanceTo(closest_v1);
					let d_2 = origin.distanceTo(closest_v2);

					let closest = closest_v0;
					if(d_1 < d_0) closest = closest_v1;
					if(d_2 < d_1) closest = closest_v2;

					// TODO: should compute proper triangle intersection.
					// Right now, we're bastically taking the distance to v0, 
					// even if the interesection is further or closer
					position.copy(closest);
				}

				// let dpr = window.devicePixelRatio;
				// let u = mouse.x / (dpr * renderer.canvas.clientWidth);
				// let v = 1 - mouse.y / (dpr * renderer.canvas.clientHeight);
				
				// let origin = controls.getPosition();
				// let dir = camera.mouseToDirection(u, v);

				// let ray = new Ray(origin, direction);
				// ray.closestPointToPoint(

				// position.copy(dir).multiplyScalar(100).add(origin);


				Potree.pickPosition.copy(position);

				Potree.hoveredItem = {
					type: node?.constructor.name + " (Triangle)",
					instance: node,
					node: node,
					pointIndex: elementIndex,
					position: position,
					object: node.tdtile,
				};

			}else{
				Potree.hoveredItem = null;
			}

		});

		{
			let radius = controls.getPosition().distanceTo(Potree.pickPosition) / 80;
			dbgSphere.position.copy(Potree.pickPosition);
			dbgSphere.scale.set(radius, radius, radius);
			dbgSphere.updateWorld();
		}

		for(let {x, y, callback} of Potree.pickQueue){
			let position = Potree.pickPosition;
			let distance = camera.getWorldPosition().distanceTo(position);
			callback({distance, position});
		}
		Potree.pickQueue.length = 0;

		if(Potree.hoveredItem){
			inputHandler.hoveredElements = [Potree.hoveredItem];
		}else{
			inputHandler.hoveredElements = [];
		}


	} // end else (pick this frame)
	} // end HANDLE PICKING


	renderer.finish();

	Timer.frameEnd(renderer);

	// read timestamp queries
	if(renderer.timestamps.enabled)
	if((renderer.frameCounter % 20) == 0)
	if(renderer.timestamps.resultBuffer)
	{

		let entries = renderer.timestamps.entries;
		let resultBuffer = renderer.timestamps.resultBuffer;

		renderer.timestamps.resultBuffer = null;

		resultBuffer.mapAsync(GPUMapMode.READ).then(() => {
			let data = resultBuffer.getMappedRange();
			let view = new DataView(data);

			let msg = "durations: \n";
			// msg += `label                  avg   min   max   \n`;
			msg += `label                  duration   \n`;
			msg += `=========================================\n`;

			let firstTimestamp = view.getBigInt64(256 * 0 + 0, true);
			let lastTimestamp = view.getBigInt64(256 * (entries.length - 1) + 8, true);
			let totalNanos = Number(lastTimestamp - firstTimestamp);
			let totalMillies = totalNanos / 1_000_000;

			for(let i = 0; i < entries.length; i++){
				let entry = entries[i];

				let start = view.getBigInt64(256 * i + 0, true);
				let end = view.getBigInt64(256 * i + 8, true);

				let nanos = Number(end - start);
				let millies = nanos / 1_000_000;

				// console.log(`[${entry.label}] duration: ${millies.toFixed(1)} ms`);
				msg += `${entry.label.padEnd(25)}   ${millies.toFixed(1)} ms\n`;
			}
			msg += `=========================================\n`;
			msg += `${totalMillies.toFixed(1).padStart(31)} ms\n`;


			if(Potree.settings.showDebugMessages){
				document.getElementById("msg_dbg").innerText = msg;
			}else{
				document.getElementById("msg_dbg").innerText = "";
			}
			
			resultBuffer.unmap();

			renderer.timestamps.resultBufferPool.push(resultBuffer);

		});

	}

}


function loop(time){

	if(renderer.deviceLost){
		requestAnimationFrame(loop);
		return;
	}

	// Skip rendering entirely when tab is hidden — frees GPU for other tabs
	if(document.hidden){
		requestAnimationFrame(loop);
		return;
	}

	Potree.state.frameCounter = renderer.frameCounter;

	try {
		Potree.events.dispatcher.dispatch("frame_start");

		TWEEN.update(time);

		update();
		renderNotSoBasic();

		Potree.events.dispatcher.dispatch("frame_end");
	} catch(e) {
		console.error("[Potree] Render loop error:", e);
	}

	requestAnimationFrame(loop);
}

function dbgControls(){

	let str = `
	
		controls.set({
			yaw: ${controls.yaw},
			pitch: ${controls.pitch},
			radius: ${controls.radius},
			pivot:  [${controls.pivot.toArray().join(", ")}],
		});

	`;

	console.log(str);

}
window.dbgControls = dbgControls;

async function isWebGPUAvailable() {
	// Force WebGL fallback via URL param: ?fallback=1
	let params = new URLSearchParams(window.location.search);
	if (params.get("fallback") === "1") {
		console.warn("[Potree] WebGL fallback forced via ?fallback=1");
		return false;
	}

	// All iOS browsers use WebKit — Safari's WebGPU fails during rendering
	let ua = navigator.userAgent;
	let isSafari = /Safari/.test(ua) && !/Chrome/.test(ua) && !/Chromium/.test(ua);
	let isiOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
	if (isSafari || isiOS) {
		console.warn("[Potree] Safari/iOS detected — using WebGL for compatibility");
		return false;
	}

	if (!navigator.gpu) return false;
	try {
		let adapter = await navigator.gpu.requestAdapter({powerPreference: "high-performance"});
		if (!adapter) return false;

		// Check if the GPU can support the buffer sizes we need (1 GB)
		// Most mobile GPUs have much smaller limits and will fail at requestDevice()
		let maxBuffer = adapter.limits?.maxStorageBufferBindingSize ?? 0;
		if (maxBuffer < 1_073_741_824) {
			console.warn(`[Potree] GPU max storage buffer ${maxBuffer} bytes is below required 1 GB — using WebGL`);
			return false;
		}

		// Verify we can actually create a device with our required limits
		let device = await adapter.requestDevice({
			requiredLimits: {
				maxStorageBufferBindingSize: 1_073_741_824,
				maxBufferSize: 1_073_741_824,
			}
		});
		if (!device) return false;
		device.destroy();

		return true;
	} catch (e) {
		console.warn("[Potree] WebGPU device creation failed — using WebGL:", e.message);
		return false;
	}
}

export async function init(){

	let webgpuAvailable = await isWebGPUAvailable();
	Potree.isWebGPU = webgpuAvailable;

	console.log(`[Potree] Renderer: ${webgpuAvailable ? "WebGPU" : "WebGL (fallback)"}`);

	if (!webgpuAvailable) {
		console.warn("[Potree] WebGPU not available — falling back to Three.js WebGL renderer");
		let {initWebGL} = await import("./fallback/WebGLFallbackViewer.js");
		let canvas = document.getElementById("canvas");
		return await initWebGL(canvas);
	}

	console.log("[Potree] WebGPU adapter found, initializing GPU renderer");
	renderer = new Renderer();
	Potree.renderer = renderer;

	await renderer.init();

	let potree = {};

	camera = new Camera();
	// controls = new OrbitControls(renderer.canvas);
	controls = new PotreeControls(renderer.canvas);
	window.orbitControls = new OrbitControls(renderer.canvas);
	let firstPersonControls = new FirstPersonControls(renderer.canvas);
	potree._firstPersonControls = firstPersonControls;

	potree.controls_list = [controls];
	potree.camera = camera;
	potree.controls = controls;
	potree.addEventListener = addEventListener;
	potree.removeEventListener = removeEventListener;
	potree.renderer = renderer;
	potree.scene = scene;
	potree.onUpdate = (callback) => {
		addEventListener("update", callback);
	};
	potree.setControls = (newControls) => {

		let oldControls = potree.controls;

		inputHandler.removeInputListener(controls.dispatcher);
		inputHandler.addInputListener(newControls.dispatcher);
		
		controls = newControls;
		potree.controls = controls;

		oldControls.dispatcher.dispatch("unfocused");
		newControls.dispatcher.dispatch("focused");
	};

	measure = new MeasureTool(potree);
	potree.measure = measure;

	// Profile loading boost — temporarily increase load concurrency for profile extraction
	potree.setProfileLoadingBoost = (enabled) => {
		// Boost octree maxLoadQueue and worker concurrency so corridor nodes load fast
		for (const child of scene.root.children) {
			if (child.constructor.name === "PointCloudOctree") {
				child._maxLoadQueue = enabled ? 50 : 5;
			}
		}
		setMaxConcurrentNodes(enabled ? 30 : 10);
	};

	inputHandler = new InputHandler(potree);
	potree.inputHandler = inputHandler;

	inputHandler.addInputListener(controls.dispatcher);
	inputHandler.addInputListener(measure.dispatcher);
	inputHandler.addInputListener(dispatcher);

	// F-key toggle between PotreeControls and FirstPersonControls
	let orbitControlsRef = controls; // store the initial orbit/potree controls
	window.addEventListener("keydown", (e) => {
		if(e.code === "KeyF" && !e.ctrlKey && !e.altKey && !e.metaKey){
			if(controls instanceof FirstPersonControls){
				// Switch back to orbit controls
				potree.setControls(orbitControlsRef);
			}else{
				// Switch to first person — seed from current camera state
				orbitControlsRef = controls;
				firstPersonControls.setFromOrbitControls(controls);
				potree.setControls(firstPersonControls);
			}
		}
	});

	// make things available in dev tools for debugging
	window.camera = camera;
	window.controls = controls;
	window.scene = scene;
	window.renderer = renderer;

	initScene();
	Potree.scene = scene;

	// progressive loader
	let element = document.getElementById("canvas");
	ProgressiveLoader.install(element, {
		onSetup: (node) => {
			scene.root.children.push(node)
			console.log("setup done");
		},
		onProgress: (e) => {
			console.log("progress", e);
		}
	});

	requestAnimationFrame(loop);

	Potree.instance = potree;

	return potree;
}



