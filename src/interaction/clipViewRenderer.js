/**
 * ClipViewRenderer — Three.js 3D sub-view for clipped point cloud
 *
 * Renders extracted profile/volume points as a THREE.Points object
 * with full orbit/pan/zoom via OrbitControls.
 * Runs on its own rAF loop (independent of Potree's render loop).
 */

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export class ClipViewRenderer {
	constructor(container) {
		this.container = container;

		this.scene = new THREE.Scene();
		this.scene.background = new THREE.Color(0x0a0a0f);

		this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100000);

		this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
		// Match Potree's linear color output — no sRGB gamma correction
		this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
		this.renderer.setPixelRatio(window.devicePixelRatio);
		this.renderer.domElement.style.position = "absolute";
		this.renderer.domElement.style.top = "0";
		this.renderer.domElement.style.left = "0";
		this.renderer.domElement.style.width = "100%";
		this.renderer.domElement.style.height = "100%";
		this.renderer.domElement.style.zIndex = "0";
		container.appendChild(this.renderer.domElement);

		// Match Potree's orbit feel: snappy rotation, no drift/damping
		this.controls = new OrbitControls(this.camera, this.renderer.domElement);
		this.controls.enableDamping = false;    // Potree has no damping — instant stop
		this.controls.screenSpacePanning = true;
		this.controls.minDistance = 0.1;
		this.controls.maxDistance = 50000;
		this.controls.rotateSpeed = 2.0;        // Potree uses 6x normalized — this is close
		this.controls.panSpeed = 1.5;
		this.controls.zoomSpeed = 1.2;
		this.controls.mouseButtons = {
			LEFT: THREE.MOUSE.ROTATE,
			MIDDLE: THREE.MOUSE.DOLLY,
			RIGHT: THREE.MOUSE.PAN,
		};

		this.pointCloud = null;
		this._animId = null;
		this._destroyed = false;

		// Grid helper
		this._gridHelper = null;
		this.showGrid = true;

		// Point size — will be auto-scaled to data extent
		this.pointSize = 0;

		// Data bounding box for external use (corridor overlay, height controls)
		this.dataBounds = null;

		// Orthographic face view state
		this._isOrtho = false;
		this._orthoCamera = null;
		this._perspCamera = this.camera; // store reference for resetTo3D
		this._activeFaceId = null; // currently selected face (0-5) or null for 3D

		// Stored raw color data for recoloring without re-extraction
		this._rawR = null;
		this._rawG = null;
		this._rawB = null;
		this._rawIntensity = null; // Float32Array (0-1), null if not available
		this._rawWorldZ = null;    // Float32Array — elevation values
		this._hasVisibleRgb = true; // false if RGB data is mostly black (< 10 avg brightness)

		// Hover / raycaster
		this.raycaster = new THREE.Raycaster();
		this.raycaster.params.Points.threshold = 0.3;
		this._mouse = new THREE.Vector2();
		this.hoveredWorldPos = null; // {x,y,z} of last hovered point

		// Prevent context menu on right-click (right-drag = pan)
		this.renderer.domElement.addEventListener("contextmenu", (e) => e.preventDefault());

		// Bind events
		this._onPointerMove = this._onPointerMove.bind(this);
		this.renderer.domElement.addEventListener("pointermove", this._onPointerMove);
	}

	setData(data, attribute, gradient) {
		this._removePointCloud();
		if (!data || data.count === 0) return;

		const { count, worldX, worldY, worldZ, r, g, b, intensity } = data;

		// Store raw data for recoloring
		this._rawR = r;
		this._rawG = g;
		this._rawB = b;
		this._rawIntensity = intensity || null;
		this._rawWorldZ = worldZ;
		this._hasVisibleRgb = this._checkRgbVisible(r, g, b, count);

		const positions = new Float32Array(count * 3);
		const colors = new Float32Array(count * 3);

		for (let i = 0; i < count; i++) {
			positions[i * 3] = worldX[i];
			positions[i * 3 + 1] = worldY[i];
			positions[i * 3 + 2] = worldZ[i];
		}
		this._computeColors(colors, count, attribute, gradient);

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();

		const material = new THREE.PointsMaterial({
			size: 1,
			sizeAttenuation: true,
			vertexColors: true,
		});

		this.pointCloud = new THREE.Points(geometry, material);
		this.scene.add(this.pointCloud);

		// Store bounds
		const box = geometry.boundingBox;
		this.dataBounds = {
			min: { x: box.min.x, y: box.min.y, z: box.min.z },
			max: { x: box.max.x, y: box.max.y, z: box.max.z },
		};

		// Auto-scale point size: match Potree's visual density
		const sz = new THREE.Vector3();
		box.getSize(sz);
		const maxDim = Math.max(sz.x, sz.y, sz.z);
		const autoSize = maxDim / 500;
		this._autoPointSize = autoSize; // base unit for integer pt size multiplier
		this.pointSize = this.pointSize || autoSize;
		material.size = this.pointSize;

		// Fit camera
		this._fitCamera(box);

		// Grid
		this._updateGrid(box);
	}

	// Update data without resetting camera — for progressive re-extraction
	updateData(data, attribute, gradient) {
		if (!data || data.count === 0) return;
		this._removePointCloud();

		const { count, worldX, worldY, worldZ, r, g, b, intensity } = data;

		// Store raw data for recoloring
		this._rawR = r;
		this._rawG = g;
		this._rawB = b;
		this._rawIntensity = intensity || null;
		this._rawWorldZ = worldZ;
		this._hasVisibleRgb = this._checkRgbVisible(r, g, b, count);

		const positions = new Float32Array(count * 3);
		const colors = new Float32Array(count * 3);

		for (let i = 0; i < count; i++) {
			positions[i * 3] = worldX[i];
			positions[i * 3 + 1] = worldY[i];
			positions[i * 3 + 2] = worldZ[i];
		}
		this._computeColors(colors, count, attribute, gradient);

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
		geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();

		const material = new THREE.PointsMaterial({
			size: this.pointSize,
			sizeAttenuation: true,
			vertexColors: true,
		});

		this.pointCloud = new THREE.Points(geometry, material);
		this.scene.add(this.pointCloud);

		const box = geometry.boundingBox;
		this.dataBounds = {
			min: { x: box.min.x, y: box.min.y, z: box.min.z },
			max: { x: box.max.x, y: box.max.y, z: box.max.z },
		};

		this._updateGrid(box);
		// Camera stays where it is — no fitCamera call
	}

	/**
	 * Compute vertex colors based on the current attribute mode.
	 * @param {Float32Array} colors — output array (count * 3)
	 * @param {number} count
	 * @param {string} attribute — "rgba", "intensity", or "elevation"
	 * @param {Gradient} gradient — gradient for intensity/elevation mapping
	 */
	/**
	 * Check if RGB data has visible colors (not mostly black).
	 * Samples up to 1000 points — if average brightness < 10 (out of 255), treat as black.
	 */
	_checkRgbVisible(r, g, b, count) {
		if (!r || !g || !b || count === 0) return false;
		const step = Math.max(1, Math.floor(count / 1000));
		let sum = 0, samples = 0;
		for (let i = 0; i < count; i += step) {
			sum += r[i] + g[i] + b[i];
			samples++;
		}
		const avgBrightness = sum / (samples * 3);
		return avgBrightness >= 10;
	}

	_computeColors(colors, count, attribute, gradient) {
		if (attribute === "intensity" && this._rawIntensity) {
			for (let i = 0; i < count; i++) {
				const c = gradient.get(this._rawIntensity[i]);
				colors[i * 3]     = c[0] / 255;
				colors[i * 3 + 1] = c[1] / 255;
				colors[i * 3 + 2] = c[2] / 255;
			}
			return;
		}

		if (attribute === "elevation") {
			this._applyElevationColors(colors, count, gradient);
			return;
		}

		// Per-point: use actual RGB if the point has visible color,
		// otherwise fall back to grayscale from intensity or elevation.
		// Pre-compute elevation range for grayscale fallback on black points
		let zMin = 0, zMax = 0, zRange = 1;
		if (!this._rawIntensity && this._rawWorldZ) {
			zMin = Infinity; zMax = -Infinity;
			for (let i = 0; i < count; i++) {
				if (this._rawWorldZ[i] < zMin) zMin = this._rawWorldZ[i];
				if (this._rawWorldZ[i] > zMax) zMax = this._rawWorldZ[i];
			}
			zRange = zMax - zMin || 1;
		}

		for (let i = 0; i < count; i++) {
			const ri = this._rawR[i], gi = this._rawG[i], bi = this._rawB[i];
			// Point is "black" if per-channel average < 10
			if ((ri + gi + bi) / 3 < 10) {
				// Grayscale fallback for this point
				if (this._rawIntensity) {
					const v = this._rawIntensity[i];
					colors[i * 3] = v; colors[i * 3 + 1] = v; colors[i * 3 + 2] = v;
				} else if (this._rawWorldZ) {
					const v = 0.2 + 0.8 * ((this._rawWorldZ[i] - zMin) / zRange);
					colors[i * 3] = v; colors[i * 3 + 1] = v; colors[i * 3 + 2] = v;
				} else {
					colors[i * 3] = 0.5; colors[i * 3 + 1] = 0.5; colors[i * 3 + 2] = 0.5;
				}
			} else {
				colors[i * 3]     = ri / 255;
				colors[i * 3 + 1] = gi / 255;
				colors[i * 3 + 2] = bi / 255;
			}
		}
	}

	_applyElevationColors(colors, count, gradient) {
		if (!this._rawWorldZ) return;
		let zMin = Infinity, zMax = -Infinity;
		for (let i = 0; i < count; i++) {
			const z = this._rawWorldZ[i];
			if (z < zMin) zMin = z;
			if (z > zMax) zMax = z;
		}
		let range = zMax - zMin;
		if (range === 0) range = 1;
		for (let i = 0; i < count; i++) {
			const t = Math.max(0, Math.min(1, (this._rawWorldZ[i] - zMin) / range));
			if (gradient && gradient.get) {
				const c = gradient.get(t);
				colors[i * 3]     = c[0] / 255;
				colors[i * 3 + 1] = c[1] / 255;
				colors[i * 3 + 2] = c[2] / 255;
			} else {
				// Fallback: grayscale from elevation
				colors[i * 3]     = t;
				colors[i * 3 + 1] = t;
				colors[i * 3 + 2] = t;
			}
		}
	}

	/**
	 * Recolor existing point cloud without re-extraction.
	 * Called when user changes color mode in the main viewer.
	 */
	recolor(attribute, gradient) {
		if (!this.pointCloud || !this._rawR) return;
		const geom = this.pointCloud.geometry;
		const colorAttr = geom.getAttribute("color");
		if (!colorAttr) return;
		const colors = colorAttr.array;
		const count = colors.length / 3;
		this._computeColors(colors, count, attribute, gradient);
		colorAttr.needsUpdate = true;
	}

	_removePointCloud() {
		if (this.pointCloud) {
			this.scene.remove(this.pointCloud);
			this.pointCloud.geometry.dispose();
			this.pointCloud.material.dispose();
			this.pointCloud = null;
		}
	}

	_fitCamera(box) {
		const center = new THREE.Vector3();
		box.getCenter(center);
		const size = new THREE.Vector3();
		box.getSize(size);
		const maxDim = Math.max(size.x, size.y, size.z);

		// Z-up to match Potree coordinate convention
		this.camera.up.set(0, 0, 1);

		// Position camera at an angle similar to Potree's default orbit view
		// Slightly elevated, looking toward center from the side
		const dist = maxDim * 1.2;
		this.camera.position.set(
			center.x + dist * 0.5,
			center.y - dist * 0.7,
			center.z + dist * 0.4
		);
		this.controls.target.copy(center);

		// Scale pan speed relative to data so panning feels consistent
		this.controls.panSpeed = 1.0;
		this.controls.rotateSpeed = 1.0;

		this.controls.update();

		// Adjust near/far for the data extent
		this.camera.near = maxDim * 0.001;
		this.camera.far = maxDim * 50;
		this.camera.updateProjectionMatrix();
	}

	_updateGrid(box) {
		if (this._gridHelper) {
			this.scene.remove(this._gridHelper);
			this._gridHelper.geometry.dispose();
			this._gridHelper.material.dispose();
			this._gridHelper = null;
		}
		if (!this.showGrid) return;

		const size = new THREE.Vector3();
		box.getSize(size);
		const center = new THREE.Vector3();
		box.getCenter(center);
		const gridSize = Math.max(size.x, size.y) * 1.5;
		const divisions = Math.min(50, Math.max(10, Math.round(gridSize)));

		this._gridHelper = new THREE.GridHelper(gridSize, divisions, 0x444466, 0x222244);
		// GridHelper is XZ by default — rotate to XY plane (Z-up)
		this._gridHelper.rotation.x = Math.PI / 2;
		this._gridHelper.position.set(center.x, center.y, box.min.z);
		this.scene.add(this._gridHelper);
	}

	_onPointerMove(e) {
		if (!this.pointCloud) return;
		const rect = this.renderer.domElement.getBoundingClientRect();
		this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

		this.raycaster.setFromCamera(this._mouse, this.camera);
		const intersects = this.raycaster.intersectObject(this.pointCloud);
		if (intersects.length > 0) {
			const p = intersects[0].point;
			this.hoveredWorldPos = { x: p.x, y: p.y, z: p.z };
		} else {
			this.hoveredWorldPos = null;
		}
	}

	/**
	 * Snap the clip view to an orthographic 2D view of the given face.
	 * @param {number} faceId — 0:Bottom, 1:Top, 2:Front, 3:Back, 4:Left, 5:Right
	 * @param {object} boxInfo — { lineDir:{x,y,z}, perpDir:{x,y,z}, corners: [{x,y,z} x8] }
	 */
	setViewFromFace(faceId, boxInfo) {
		if (!this.dataBounds) return;

		const bounds = this.dataBounds;
		const cx = (bounds.min.x + bounds.max.x) / 2;
		const cy = (bounds.min.y + bounds.max.y) / 2;
		const cz = (bounds.min.z + bounds.max.z) / 2;
		const sx = bounds.max.x - bounds.min.x;
		const sy = bounds.max.y - bounds.min.y;
		const sz = bounds.max.z - bounds.min.z;
		const maxDim = Math.max(sx, sy, sz);
		const dist = maxDim * 2;
		const pad = 1.15; // 15% padding around the view

		const ld = boxInfo.lineDir;
		const pd = boxInfo.perpDir;

		// Compute camera position, look target, up vector, and ortho extents per face
		let camPos, up, halfW, halfH;
		const target = new THREE.Vector3(cx, cy, cz);

		const FACE_NAMES = ["Bottom", "Top", "Front", "Back", "Left", "Right"];

		switch (faceId) {
			case 0: // Bottom — look up from below
				camPos = new THREE.Vector3(cx, cy, cz - dist);
				up = new THREE.Vector3(ld.x, ld.y, ld.z);
				halfW = Math.max(sx, sy) / 2 * pad;
				halfH = halfW;
				break;
			case 1: // Top — look down from above
				camPos = new THREE.Vector3(cx, cy, cz + dist);
				up = new THREE.Vector3(ld.x, ld.y, ld.z);
				halfW = Math.max(sx, sy) / 2 * pad;
				halfH = halfW;
				break;
			case 2: // Front — from +perp direction
				camPos = new THREE.Vector3(cx + pd.x * dist, cy + pd.y * dist, cz);
				up = new THREE.Vector3(0, 0, 1);
				halfW = maxDim / 2 * pad;
				halfH = sz / 2 * pad;
				break;
			case 3: // Back — from -perp direction
				camPos = new THREE.Vector3(cx - pd.x * dist, cy - pd.y * dist, cz);
				up = new THREE.Vector3(0, 0, 1);
				halfW = maxDim / 2 * pad;
				halfH = sz / 2 * pad;
				break;
			case 4: // Left — from -lineDir (A-end)
				camPos = new THREE.Vector3(cx - ld.x * dist, cy - ld.y * dist, cz);
				up = new THREE.Vector3(0, 0, 1);
				halfW = maxDim / 2 * pad;
				halfH = sz / 2 * pad;
				break;
			case 5: // Right — from +lineDir (B-end)
				camPos = new THREE.Vector3(cx + ld.x * dist, cy + ld.y * dist, cz);
				up = new THREE.Vector3(0, 0, 1);
				halfW = maxDim / 2 * pad;
				halfH = sz / 2 * pad;
				break;
			default:
				return;
		}

		// Ensure minimum extents
		halfW = Math.max(halfW, 0.5);
		halfH = Math.max(halfH, 0.5);

		// Create or reuse ortho camera
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		const aspect = w / h;

		// Adjust half extents to match container aspect ratio
		if (aspect > halfW / halfH) {
			halfW = halfH * aspect;
		} else {
			halfH = halfW / aspect;
		}

		if (!this._orthoCamera) {
			this._orthoCamera = new THREE.OrthographicCamera(-halfW, halfW, halfH, -halfH, 0.01, maxDim * 100);
		} else {
			this._orthoCamera.left = -halfW;
			this._orthoCamera.right = halfW;
			this._orthoCamera.top = halfH;
			this._orthoCamera.bottom = -halfH;
			this._orthoCamera.near = 0.01;
			this._orthoCamera.far = maxDim * 100;
		}

		this._orthoCamera.position.copy(camPos);
		this._orthoCamera.up.copy(up);
		this._orthoCamera.lookAt(target);
		this._orthoCamera.updateProjectionMatrix();

		// Switch controls to ortho camera — disable rotation, keep pan + zoom
		this.controls.object = this._orthoCamera;
		this.controls.target.copy(target);
		this.controls.enableRotate = false;
		this.controls.enablePan = true;
		this.controls.enableZoom = true;
		this.controls.update();

		// Update raycaster to use ortho camera
		this.camera = this._orthoCamera;
		this._isOrtho = true;
		this._activeFaceId = faceId;

	}

	/**
	 * Restore the perspective camera with full orbit controls.
	 */
	resetTo3D() {
		if (!this._isOrtho) return;

		const perspCam = this._perspCamera;
		if (!perspCam) return;

		this.camera = perspCam;
		this.controls.object = perspCam;
		this.controls.enableRotate = true;
		this.controls.update();

		this._isOrtho = false;
		this._activeFaceId = null;
	}

	get activeFaceId() { return this._activeFaceId; }
	get isOrtho() { return this._isOrtho; }

	resize() {
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		if (w === 0 || h === 0) return;
		if (this._isOrtho && this._orthoCamera) {
			// Maintain ortho aspect ratio on resize
			const aspect = w / h;
			const halfH = (this._orthoCamera.top - this._orthoCamera.bottom) / 2;
			const halfW = halfH * aspect;
			this._orthoCamera.left = -halfW;
			this._orthoCamera.right = halfW;
			this._orthoCamera.updateProjectionMatrix();
		} else {
			this.camera.aspect = w / h;
			this.camera.updateProjectionMatrix();
		}
		this.renderer.setSize(w, h);
	}

	start() {
		this.resize();
		const animate = () => {
			if (this._destroyed) return;
			this._animId = requestAnimationFrame(animate);
			this.controls.update();
			this.renderer.render(this.scene, this.camera);
		};
		animate();
	}

	stop() {
		if (this._animId) {
			cancelAnimationFrame(this._animId);
			this._animId = null;
		}
	}

	getScene() { return this.scene; }
	getCamera() { return this.camera; }
	getRendererDom() { return this.renderer.domElement; }

	destroy() {
		this._destroyed = true;
		this.stop();
		this.renderer.domElement.removeEventListener("pointermove", this._onPointerMove);
		this._removePointCloud();
		if (this._gridHelper) {
			this.scene.remove(this._gridHelper);
			this._gridHelper.geometry.dispose();
			this._gridHelper.material.dispose();
		}
		this.renderer.dispose();
		if (this.renderer.domElement.parentElement) {
			this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
		}
	}
}
