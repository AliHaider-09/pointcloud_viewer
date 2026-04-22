
import * as THREE from "three";
import {MapControls} from "three/addons/controls/MapControls.js";
import {CameraAdapter} from "./CameraAdapter.js";
import {RendererAdapter} from "./RendererAdapter.js";
import {Potree} from "potree";
import {PointCloudOctree} from "potree";
import {EventDispatcher} from "potree";
import {Scene} from "potree";
import {Vector3, Vector4, Box3} from "potree";
import {MeasureTool} from "../interaction/measure.js";
import {InputHandler} from "../InputHandler.js";
import {FirstPersonControls} from "../navigation/FirstPersonControls.js";
import {SPECTRAL, GRAYSCALE, INFERNO} from "../misc/Gradients.js";
import {setMaxConcurrentNodes} from "../potree/octree/loader/PotreeLoader.js";

/**
 * WebGL fallback viewer using Three.js.
 * Reuses Potree's data loading pipeline (PotreeLoader, PointCloudOctree,
 * decoder workers) while rendering with Three.js WebGLRenderer + PointsMaterial.
 */

let frame = 0;
let lastFpsCount = 0;
let framesSinceLastCount = 0;
let fps = 0;

export async function initWebGL(canvas) {

	console.log("WebGPU not available, using WebGL fallback");

	// Ensure canvas has real dimensions before creating GL context
	let w = canvas.clientWidth || window.innerWidth;
	let h = canvas.clientHeight || window.innerHeight;

	// --- Three.js setup (request high-performance GPU) ---
	let glContext =
		canvas.getContext("webgl2", {antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true}) ||
		canvas.getContext("webgl",  {antialias: true, powerPreference: "high-performance", preserveDrawingBuffer: true});

	if (!glContext) {
		console.error("[Potree] WebGL context creation failed");
		return;
	}

	let threeRenderer = new THREE.WebGLRenderer({
		canvas,
		context: glContext,
		antialias: true,
		powerPreference: "high-performance",
	});
	threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	threeRenderer.setSize(w, h, false);

	let threeScene = new THREE.Scene();
	applyBackground(threeScene);

	// Z-up camera matching Potree convention
	let threeCamera = new THREE.PerspectiveCamera(60, w / h, 0.1, 50000);
	threeCamera.up.set(0, 0, 1);
	threeCamera.position.set(0, -50, 30);
	threeCamera.lookAt(0, 0, 0);

	let threeControls = new MapControls(threeCamera, canvas);
	threeControls.enableDamping = true;
	threeControls.dampingFactor = 0.15;
	threeControls.screenSpacePanning = true;
	threeControls.maxPolarAngle = Math.PI;

	// First Person View controls
	let fpvControls = new FirstPersonControls(canvas);
	let _usingFPV = false;
	let _lastFrameTime = performance.now();

	// Shared material for all point clouds
	let pointsMaterial = new THREE.PointsMaterial({
		size: Potree.settings.pointSize,
		vertexColors: true,
		sizeAttenuation: false,
	});

	// Track current attribute mode + brightness + gradient for recoloring
	let _currentAttribute = Potree.settings.attribute || "rgba";
	let _currentBrightness = 1.0;
	let _currentGradient = Potree.settings.gradient;

	// Per-node stored attribute data for recoloring
	// key → { rgbColors, intensityValues, rawElevations, octreeBBMinZ, octreeBBMaxZ (Float32Arrays) }
	let nodeAttributeData = new Map();

	// Adapters for PointCloudOctree.updateVisibility()
	let cameraAdapter = new CameraAdapter(threeCamera);
	let rendererAdapter = new RendererAdapter(canvas);

	// Potree scene (shared with index.html code)
	let scene = new Scene();
	Potree.scene = scene;

	// Cache of Three.js Points objects keyed by octree node name
	let threePointsCache = new Map();

	// Dispatcher for Potree event compatibility
	let dispatcher = new EventDispatcher();

	function addEventListener(name, callback) {
		dispatcher.addEventListener(name, callback);
	}
	function removeEventListener(name, callback) {
		dispatcher.removeEventListener(name, callback);
	}

	// --- zoomTo ---
	function zoomTo(node) {
		let box = new Box3();
		let tmp = new Box3();
		node.traverse((child) => {
			let childBox = child.boundingBox;
			if (!childBox || !childBox.isFinite()) return;

			tmp.copy(childBox);
			tmp.applyMatrix4(child.world);
			box.expandByBox(tmp);
		});

		let center = box.center();
		let size = box.size();
		let radius = size.length() * 0.8;

		threeCamera.position.set(
			center.x + radius * 0.5,
			center.y - radius * 0.7,
			center.z + radius * 0.5
		);
		threeControls.target.set(center.x, center.y, center.z);
		threeControls.update();
	}

	// --- Resize handler ---
	function onResize() {
		let w = canvas.clientWidth || window.innerWidth;
		let h = canvas.clientHeight || window.innerHeight;
		let dpr = Math.min(window.devicePixelRatio, 2);
		let pw = Math.floor(w * dpr);
		let ph = Math.floor(h * dpr);
		if (canvas.width !== pw || canvas.height !== ph) {
			threeRenderer.setSize(w, h, false);
			threeCamera.aspect = w / h;
			threeCamera.updateProjectionMatrix();
		}
	}

	// --- Extract a scalar attribute from the buffer as normalized [0,1] Float32Array ---
	function extractScalarAttribute(buffer, numPoints, attrOffset, attr) {
		let view = new DataView(buffer);
		let typeName = attr.type?.name ?? "uint16";
		let elemSize = attr.type?.size ?? 2;
		let values = new Float32Array(numPoints);

		let rangeMin = 0, rangeMax = 1;
		if (attr.range) {
			rangeMin = Array.isArray(attr.range[0]) ? attr.range[0][0] : attr.range[0];
			rangeMax = Array.isArray(attr.range[1]) ? attr.range[1][0] : attr.range[1];
		}
		let rangeDelta = rangeMax - rangeMin;
		if (rangeDelta === 0) rangeDelta = 1;

		for (let i = 0; i < numPoints; i++) {
			let base = attrOffset + i * elemSize;
			let raw = 0;
			if (typeName === "uint16") raw = view.getUint16(base, true);
			else if (typeName === "uint8") raw = view.getUint8(base);
			else if (typeName === "int16") raw = view.getInt16(base, true);
			else if (typeName === "int32") raw = view.getInt32(base, true);
			else if (typeName === "float") raw = view.getFloat32(base, true);
			else if (typeName === "double") raw = view.getFloat64(base, true);

			values[i] = Math.max(0, Math.min(1, (raw - rangeMin) / rangeDelta));
		}
		return values;
	}

	// --- Apply gradient to a scalar array → RGB Float32Array ---
	function applyGradient(values, gradient) {
		let n = values.length;
		let colors = new Float32Array(n * 3);
		for (let i = 0; i < n; i++) {
			let c = gradient.get(values[i]);
			colors[i * 3 + 0] = c[0] / 255;
			colors[i * 3 + 1] = c[1] / 255;
			colors[i * 3 + 2] = c[2] / 255;
		}
		return colors;
	}

	// --- Apply brightness multiplier to an RGB array ---
	function applyBrightness(colors, brightness) {
		if (brightness === 1.0) return colors;
		let out = new Float32Array(colors.length);
		for (let i = 0; i < colors.length; i++) {
			out[i] = Math.min(1.0, colors[i] * brightness);
		}
		return out;
	}

	// --- Compute global elevation range from ALL currently cached nodes ---
	function getGlobalElevationRange() {
		let globalMin = Infinity, globalMax = -Infinity;
		for (let [, data] of nodeAttributeData) {
			if (!data.rawElevations) continue;
			for (let i = 0; i < data.numPoints; i++) {
				let z = data.rawElevations[i];
				if (z < globalMin) globalMin = z;
				if (z > globalMax) globalMax = z;
			}
		}
		if (!isFinite(globalMin)) { globalMin = 0; globalMax = 1; }
		return { min: globalMin, max: globalMax };
	}

	// --- Compute final colors for a node based on current attribute + brightness ---
	function computeNodeColors(key, elevRange) {
		let data = nodeAttributeData.get(key);
		if (!data) return null;

		let colors;
		let attr = _currentAttribute;
		let gradient = Potree.settings.gradient || SPECTRAL;

		if (attr === "intensity" && data.intensityValues) {
			colors = applyGradient(data.intensityValues, gradient);
		} else if (attr === "elevation" && data.rawElevations) {
			// Use provided global elevation range for consistent coloring
			let eMin = elevRange ? elevRange.min : 0;
			let eMax = elevRange ? elevRange.max : 1;
			let rangeZ = eMax - eMin;
			if (rangeZ === 0) rangeZ = 1;
			let normalized = new Float32Array(data.numPoints);
			for (let i = 0; i < data.numPoints; i++) {
				normalized[i] = Math.max(0, Math.min(1, (data.rawElevations[i] - eMin) / rangeZ));
			}
			colors = applyGradient(normalized, gradient);
		} else {
			// Default: RGB — clone to prevent mutation via BufferAttribute.set()
			colors = data.rgbColors ? new Float32Array(data.rgbColors) : null;
		}

		if (!colors) {
			colors = new Float32Array(data.numPoints * 3);
			colors.fill(1.0);
		}

		return applyBrightness(colors, _currentBrightness);
	}

	// --- Recolor all cached Three.js Points when attribute/brightness changes ---
	function recolorAllPoints() {
		// Compute global elevation range once, shared across all nodes
		let elevRange = (_currentAttribute === "elevation") ? getGlobalElevationRange() : null;

		for (let [key, points] of threePointsCache) {
			let colors = computeNodeColors(key, elevRange);
			if (colors && points.geometry) {
				let colorAttr = points.geometry.getAttribute("color");
				if (colorAttr && colorAttr.array.length === colors.length) {
					colorAttr.array.set(colors);
					colorAttr.needsUpdate = true;
				} else {
					points.geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
				}
			}
		}
	}

	// --- Convert node buffer to Three.js BufferGeometry ---
	function createThreePoints(node, octree, cacheKey) {
		let geometry = node.geometry;
		if (!geometry || !geometry.buffer) return null;

		let numPoints = geometry.numElements;
		if (numPoints === 0) return null;

		let buffer = geometry.buffer;
		let attributes = octree.loader?.attributes;

		// Compute attribute offsets from attribute list
		// Buffer layout: contiguous blocks per attribute, each of size numPoints * attribute.byteSize
		let posOffset = 0;
		let colorOffset = -1;
		let colorAttribute = null;
		let intensityOffset = -1;
		let intensityAttribute = null;
		let byteAccum = 0;

		if (attributes) {
			for (let attr of attributes.attributes) {
				if (attr.name === "position") {
					posOffset = byteAccum;
				} else if (attr.name === "rgba") {
					colorOffset = byteAccum;
					colorAttribute = attr;
				} else if (attr.name === "intensity") {
					intensityOffset = byteAccum;
					intensityAttribute = attr;
				}
				byteAccum += numPoints * attr.byteSize;
			}
		} else {
			posOffset = 0;
			colorOffset = numPoints * 12;
		}

		// Positions: float32 x 3
		let positions = new Float32Array(buffer, posOffset, numPoints * 3);

		let threeGeom = new THREE.BufferGeometry();
		threeGeom.setAttribute("position", new THREE.BufferAttribute(positions, 3));

		// Extract and store RGB colors
		let rgbColors = null;
		if (colorOffset >= 0) {
			rgbColors = new Float32Array(numPoints * 3);
			let view = new DataView(buffer);

			let typeName = colorAttribute?.type?.name ?? "uint16";
			let numComp = colorAttribute?.numElements ?? 4;
			let elemSize = colorAttribute?.type?.size ?? 2;

			if (typeName === "uint16") {
				for (let i = 0; i < numPoints; i++) {
					let base = colorOffset + i * numComp * elemSize;
					rgbColors[i * 3 + 0] = view.getUint16(base + 0, true) / 65535;
					rgbColors[i * 3 + 1] = view.getUint16(base + 2, true) / 65535;
					rgbColors[i * 3 + 2] = view.getUint16(base + 4, true) / 65535;
				}
			} else if (typeName === "uint8") {
				for (let i = 0; i < numPoints; i++) {
					let base = colorOffset + i * numComp * elemSize;
					rgbColors[i * 3 + 0] = view.getUint8(base + 0) / 255;
					rgbColors[i * 3 + 1] = view.getUint8(base + 1) / 255;
					rgbColors[i * 3 + 2] = view.getUint8(base + 2) / 255;
				}
			} else {
				rgbColors.fill(1.0);
			}
		}

		// Extract intensity values (normalized 0–1)
		let intensityValues = null;
		if (intensityOffset >= 0 && intensityAttribute) {
			intensityValues = extractScalarAttribute(buffer, numPoints, intensityOffset, intensityAttribute);
		}

		// Store raw Z positions for elevation coloring
		let rawElevations = new Float32Array(numPoints);
		for (let i = 0; i < numPoints; i++) {
			rawElevations[i] = positions[i * 3 + 2];
		}

		// Store attribute data for recoloring
		nodeAttributeData.set(cacheKey, { rgbColors, intensityValues, rawElevations, numPoints });

		// Apply current coloring
		let elevRange = (_currentAttribute === "elevation") ? getGlobalElevationRange() : null;
		let colors = computeNodeColors(cacheKey, elevRange);
		if (colors) {
			threeGeom.setAttribute("color", new THREE.BufferAttribute(colors, 3));
		}

		let material = pointsMaterial;
		let points = new THREE.Points(threeGeom, material);

		// Apply octree world position offset
		let pos = octree.position;
		points.position.set(pos.x, pos.y, pos.z);

		return points;
	}

	// --- Apply background setting ---
	function applyBackground(scene) {
		let bg = Potree.settings.background;
		if (bg === "white") {
			scene.background = new THREE.Color(1, 1, 1);
		} else if (bg === "black") {
			scene.background = new THREE.Color(0, 0, 0);
		} else {
			// gradient approximation — use dark blue
			scene.background = new THREE.Color(0.1, 0.2, 0.3);
		}
	}

	// --- Render loop ---
	let previousVisibleNodeNames = new Set();

	function animate() {
		requestAnimationFrame(animate);

		let now = performance.now();

		// FPS tracking
		framesSinceLastCount++;
		if ((now - lastFpsCount) >= 1000.0) {
			fps = framesSinceLastCount;
			lastFpsCount = now;
			framesSinceLastCount = 0;
			Potree.state.fps = Math.floor(fps).toLocaleString();
		}
		frame++;

		// Resize check
		onResize();

		// Update controls (Orbit or FPV)
		let delta = (_lastFrameTime - now) / 1000; // negative seconds, matching WebGPU convention
		_lastFrameTime = now;

		if (_usingFPV) {
			fpvControls.update(delta);
			// Sync Three.js camera from FPV world matrix
			let els = fpvControls.world.elements;
			let m = new THREE.Matrix4();
			m.set(
				els[0], els[4], els[8],  els[12],
				els[1], els[5], els[9],  els[13],
				els[2], els[6], els[10], els[14],
				els[3], els[7], els[11], els[15]
			);
			threeCamera.matrix.copy(m);
			threeCamera.matrixAutoUpdate = false;
			threeCamera.matrixWorldNeedsUpdate = true;
		} else {
			threeCamera.matrixAutoUpdate = true;
			threeControls.update();
		}

		// Sync camera adapter from Three.js camera
		threeCamera.updateMatrixWorld();
		cameraAdapter.sync();

		// Update Potree state
		Potree.state.camPos = `${threeCamera.position.x.toFixed(1)}, ${threeCamera.position.y.toFixed(1)}, ${threeCamera.position.z.toFixed(1)}`;
		let targetStr = _usingFPV
			? `${fpvControls.pivot.x.toFixed(1)}, ${fpvControls.pivot.y.toFixed(1)}, ${fpvControls.pivot.z.toFixed(1)}`
			: `${threeControls.target.x.toFixed(1)}, ${threeControls.target.y.toFixed(1)}, ${threeControls.target.z.toFixed(1)}`;
		Potree.state.camTarget = targetStr;

		// Find PointCloudOctrees in Potree scene
		let octrees = [];
		for (let child of scene.root.children) {
			if (child.constructor.name === "PointCloudOctree") {
				octrees.push(child);
			}
		}

		Potree.state.numVisiblePoints = 0;

		let currentVisibleNodeNames = new Set();

		for (let octree of octrees) {
			octree.showBoundingBox = Potree.settings.showBoundingBox;
			octree.pointBudget = Potree.settings.pointBudget;
			octree.pointSize = Potree.settings.pointSize;

			// Layer visibility — hide all Three.js Points for hidden octrees
			if (octree.visible === false) {
				for (let [key, points] of threePointsCache) {
					if (key.startsWith(octree.name + "/")) {
						points.visible = false;
					}
				}
				continue;
			}

			// Update world matrix for the octree
			octree.updateWorld();

			if (Potree.settings.updateEnabled) {
				octree.updateVisibility(cameraAdapter, rendererAdapter);
			}

			// Sync visible nodes to Three.js scene
			for (let node of octree.visibleNodes) {
				let key = octree.name + "/" + node.name;
				currentVisibleNodeNames.add(key);

				Potree.state.numVisiblePoints += node.numPoints ?? node.numElements ?? 0;

				if (!threePointsCache.has(key)) {
					let points = createThreePoints(node, octree, key);
					if (points) {
						threePointsCache.set(key, points);
						threeScene.add(points);
					}
				} else {
					// Ensure visible (may have been hidden by layer toggle)
					threePointsCache.get(key).visible = true;
				}
			}

			// LRU clearing via adapter (no-op dispose, but keeps the LRU bookkeeping happy)
			PointCloudOctree.clearLRU(rendererAdapter);
		}

		// Remove nodes that are no longer visible
		for (let [key, points] of threePointsCache) {
			if (!currentVisibleNodeNames.has(key)) {
				threeScene.remove(points);
				points.geometry.dispose();
				threePointsCache.delete(key);
				nodeAttributeData.delete(key);
			}
		}

		previousVisibleNodeNames = currentVisibleNodeNames;

		// Apply settings
		pointsMaterial.size = Potree.settings.pointSize;
		applyBackground(threeScene);

		// Detect attribute/brightness/gradient changes and recolor
		let newAttr = Potree.settings.attribute || "rgba";
		let newBrightness = Potree.settings._brightness ?? _currentBrightness;
		let newGradient = Potree.settings.gradient;
		if (newAttr !== _currentAttribute || newBrightness !== _currentBrightness || newGradient !== _currentGradient) {
			_currentAttribute = newAttr;
			_currentBrightness = newBrightness;
			_currentGradient = newGradient;
			recolorAllPoints();
		}

		// Approximate GPU memory from cache size
		Potree.state.gpuMemoryMB = Math.round(threePointsCache.size * 0.25);

		Potree.state.frameCounter = frame;
		Potree.events.dispatcher.dispatch("frame_start");

		threeRenderer.render(threeScene, threeCamera);

		Potree.events.dispatcher.dispatch("frame_end");
	}

	// --- Controls adapter with zoomTo ---
	let controlsAdapter = {
		zoomTo,
		getPosition() {
			return new Vector3(threeCamera.position.x, threeCamera.position.y, threeCamera.position.z);
		},
		pivot: new Vector3(0, 0, 0),
		dispatcher: new EventDispatcher(),
		update() {},
		// Expose radius for FPV speed seeding
		get radius() {
			let t = threeControls.target;
			let p = threeCamera.position;
			return Math.sqrt((t.x-p.x)**2 + (t.y-p.y)**2 + (t.z-p.z)**2);
		},
		// Expose world matrix for FPV seeding from orbit
		get world() {
			let m = cameraAdapter.world;
			return m;
		},
	};

	// --- Real InputHandler for WebGL mode (needed for measurement events) ---
	rendererAdapter.canvas = canvas;
	let inputHandler = new InputHandler({ renderer: rendererAdapter });
	inputHandler.hoveredElements = [];

	// Start render loop
	animate();

	// Clear all cached Three.js Points (call when switching datasets)
	function clearPointCache() {
		for (let [key, points] of threePointsCache) {
			threeScene.remove(points);
			points.geometry.dispose();
		}
		threePointsCache.clear();
		nodeAttributeData.clear();
	}

	// --- Raycaster for Potree.pick in WebGL mode ---
	let raycaster = new THREE.Raycaster();
	raycaster.params.Points = { threshold: 1.0 };
	let mouseNDC = new THREE.Vector2();

	function processPickQueue() {
		if (Potree.pickQueue.length === 0) return;

		for (let {x, y, callback} of Potree.pickQueue) {
			let rect = canvas.getBoundingClientRect();
			mouseNDC.x = ((x) / rect.width) * 2 - 1;
			mouseNDC.y = -((y) / rect.height) * 2 + 1;
			raycaster.setFromCamera(mouseNDC, threeCamera);

			let pointObjects = [];
			for (let [, pts] of threePointsCache) { pointObjects.push(pts); }
			let intersects = raycaster.intersectObjects(pointObjects, false);

			if (intersects.length > 0) {
				let p = intersects[0].point;
				let pos = new Vector3(p.x, p.y, p.z);
				Potree.pickPosition.copy(pos);
				callback({ depth: intersects[0].distance, position: pos });
			} else {
				callback({ depth: Infinity, position: new Vector3(0, 0, 0) });
			}
		}
		Potree.pickQueue.length = 0;
	}

	// --- Three.js measurement rendering ---
	let measureGroup = new THREE.Group();
	threeScene.add(measureGroup);
	let sphereGeomCache = new Map(); // radius → geometry

	function getMeasureSphereGeom(radius) {
		let key = radius.toFixed(4);
		if (!sphereGeomCache.has(key)) {
			sphereGeomCache.set(key, new THREE.SphereGeometry(radius, 12, 12));
		}
		return sphereGeomCache.get(key);
	}

	// Add drawSphere/drawLine to rendererAdapter so MeasureTool can render
	let drawQueue = { spheres: [], lines: [] };
	rendererAdapter.drawSphere = function(position, radius, args = {}) {
		drawQueue.spheres.push([position, radius, args]);
	};
	rendererAdapter.drawLine = function(start, end, color) {
		drawQueue.lines.push([start, end, color]);
	};
	rendererAdapter.draws = drawQueue;

	function renderMeasureDraws() {
		// Clear old visuals
		while (measureGroup.children.length > 0) {
			let child = measureGroup.children[0];
			measureGroup.remove(child);
			if (child.material) child.material.dispose();
		}

		// Render spheres
		for (let [pos, radius, args] of drawQueue.spheres) {
			let c = args.color || new Vector4(1, 0, 0, 1);
			let color = new THREE.Color(c.x, c.y, c.z);
			let geom = getMeasureSphereGeom(radius);
			let mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: c.w || 1 });
			let mesh = new THREE.Mesh(geom, mat);
			mesh.position.set(pos.x, pos.y, pos.z);
			mesh.renderOrder = 999;
			measureGroup.add(mesh);
		}

		// Render lines
		for (let [start, end, color] of drawQueue.lines) {
			let c = color || new Vector3(255, 0, 0);
			let threeColor = new THREE.Color(c.x / 255, c.y / 255, c.z / 255);
			let geom = new THREE.BufferGeometry().setFromPoints([
				new THREE.Vector3(start.x, start.y, start.z),
				new THREE.Vector3(end.x, end.y, end.z),
			]);
			let mat = new THREE.LineBasicMaterial({ color: threeColor, depthTest: false });
			let line = new THREE.Line(geom, mat);
			line.renderOrder = 998;
			measureGroup.add(line);
		}

		// Clear queues
		drawQueue.spheres.length = 0;
		drawQueue.lines.length = 0;
	}

	// --- Initialize real MeasureTool ---
	// MeasureTool needs a potree-like object with renderer, scene, etc.
	// and a global `camera` variable
	window.camera = cameraAdapter;
	let potreeForMeasure = {
		renderer: rendererAdapter,
		scene: scene,
		onUpdate: (callback) => addEventListener("update", callback),
		inputHandler: inputHandler,
	};
	let realMeasureTool = new MeasureTool(potreeForMeasure);
	// Register MeasureTool's dispatcher with InputHandler so it receives mouse events
	// (needed for startMeasuring click-to-place and right-click-to-finish)
	inputHandler.addInputListener(realMeasureTool.dispatcher);

	// Continuously update Potree.pickPosition on mouse move via raycasting.
	// This is needed for: vertex dragging (follows cursor), cursor during active measurement,
	// and hover detection — matching WebGPU behavior where pick runs every frame.
	let _lastMouseX = 0, _lastMouseY = 0;
	canvas.addEventListener("pointermove", (e) => {
		let rect = canvas.getBoundingClientRect();
		_lastMouseX = e.clientX - rect.left;
		_lastMouseY = e.clientY - rect.top;
	});

	function continuousPick() {
		mouseNDC.x = (_lastMouseX / (canvas.clientWidth || 1)) * 2 - 1;
		mouseNDC.y = -(_lastMouseY / (canvas.clientHeight || 1)) * 2 + 1;
		raycaster.setFromCamera(mouseNDC, threeCamera);

		let pointObjects = [];
		for (let [, pts] of threePointsCache) { pointObjects.push(pts); }
		let intersects = raycaster.intersectObjects(pointObjects, false);

		if (intersects.length > 0) {
			let p = intersects[0].point;
			Potree.pickPosition.x = p.x;
			Potree.pickPosition.y = p.y;
			Potree.pickPosition.z = p.z;
		}
	}

	// Hook pick processing + measure rendering into the render loop
	let _origRender = threeRenderer.render.bind(threeRenderer);
	threeRenderer.render = function(s, c) {
		processPickQueue();
		continuousPick();
		// Fire update event so MeasureTool.update() runs
		dispatcher.dispatch("update");
		renderMeasureDraws();
		_origRender(s, c);
	};

	// --- setControls: switch between orbit and FPV ---
	let _activeControls = controlsAdapter;

	function setControls(newControls) {
		let oldControls = _activeControls;

		if (newControls instanceof FirstPersonControls) {
			// Switching TO FPV
			_usingFPV = true;
			threeControls.enabled = false;
			// Register FPV dispatcher with inputHandler for WASD/mouse events
			inputHandler.removeInputListener(oldControls.dispatcher);
			inputHandler.addInputListener(newControls.dispatcher);
			_activeControls = newControls;

			oldControls.dispatcher.dispatch("unfocused");
			newControls.dispatcher.dispatch("focused");
		} else {
			// Switching TO orbit
			_usingFPV = false;
			threeControls.enabled = true;
			threeCamera.matrixAutoUpdate = true;

			// Sync Three.js orbit controls from current camera position
			if (oldControls instanceof FirstPersonControls) {
				let pos = oldControls.position;
				threeCamera.position.set(pos.x, pos.y, pos.z);
				let pivot = oldControls.pivot;
				threeControls.target.set(pivot.x, pivot.y, pivot.z);
				threeControls.update();
			}

			if (oldControls.dispatcher) {
				inputHandler.removeInputListener(oldControls.dispatcher);
			}
			inputHandler.addInputListener(controlsAdapter.dispatcher);
			_activeControls = controlsAdapter;

			if (oldControls.dispatcher) oldControls.dispatcher.dispatch("unfocused");
			controlsAdapter.dispatcher.dispatch("focused");
		}

		Potree.instance.controls = _activeControls;
	}

	Potree.instance = {
		scene,
		controls: controlsAdapter,
		renderer: rendererAdapter,
		camera: cameraAdapter,
		addEventListener,
		removeEventListener,
		onUpdate: (callback) => addEventListener("update", callback),
		setControls,
		_firstPersonControls: fpvControls,
		inputHandler: inputHandler,
		measure: realMeasureTool,
		controls_list: [controlsAdapter],
		clearPointCache,
		// Clip tool support: boost loading during profile extraction
		setProfileLoadingBoost: (enabled) => {
			for (const child of scene.root.children) {
				if (child.constructor.name === "PointCloudOctree") {
					child._maxLoadQueue = enabled ? 50 : 5;
				}
			}
			setMaxConcurrentNodes(enabled ? 30 : 10);
		},
	};

	// F-key toggle between Orbit and FPV (matches WebGPU behavior)
	// Use Potree.instance.setControls so the HTML wrapper updates button state
	window.addEventListener("keydown", (e) => {
		if (e.code === "KeyF" && !e.ctrlKey && !e.altKey && !e.metaKey) {
			if (_usingFPV) {
				Potree.instance.setControls(controlsAdapter);
			} else {
				fpvControls.setFromOrbitControls(controlsAdapter);
				Potree.instance.setControls(fpvControls);
			}
		}
	});

	return Potree.instance;
}
