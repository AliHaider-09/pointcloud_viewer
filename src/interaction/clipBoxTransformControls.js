/**
 * ClipBoxTransformControls - Interactive 3D handles for clip box manipulation
 * 
 * Implements Potree-style clipping volume controls with:
 * - 8 corner handles (uniform resize from opposite corner)
 * - 12 edge handles (resize along 2 axes)
 * - 6 face handles (translate box or resize along 1 axis)
 * - Real-time visual feedback with hover/drag states
 * - Raycaster-based pointer interaction
 */

import * as THREE from "three";

// Handle types
export const HANDLE_FACE = "face";    // 6 faces - translate or resize
export const HANDLE_EDGE = "edge";    // 12 edges - resize along 2 axes  
export const HANDLE_CORNER = "corner"; // 8 corners - uniform resize

// Visual constants
const HANDLE_SIZE = 0.3;              // World units for handle size
const HOVER_SCALE = 1.5;              // Scale factor on hover
const DRAG_SCALE = 1.8;               // Scale factor on drag
const HANDLE_COLOR = 0x3b82f6;        // Blue (normal)
const HOVER_COLOR = 0x93c5fd;         // Light blue (hover)
const DRAG_COLOR = 0x1d4ed8;          // Dark blue (drag)
const WIRE_COLOR = 0x3b82f6;          // Box wireframe color
const FACE_COLOR = 0x3b82f6;          // Face fill color

export class ClipBoxTransformControls {
	constructor(scene, camera, domElement) {
		this.scene = scene;
		this.camera = camera;
		this.domElement = domElement;

		// State
		this.enabled = false;
		this.visible = true;
		this.inverted = false;

		// Box state (center + half-size)
		this._center = new THREE.Vector3(0, 0, 0);
		this._halfSize = new THREE.Vector3(5, 5, 5); // 10m box default

		// Handle meshes
		this._handles = [];           // Array of {mesh, type, index, axis, normal}
		this._boxMesh = null;         // Wireframe box
		this._faceMeshes = [];        // Transparent face planes

		// Interaction state
		this._raycaster = new THREE.Raycaster();
		this._mouse = new THREE.Vector2();
		this._dragPlane = new THREE.Plane();
		this._dragOffset = new THREE.Vector3();
		this._dragStartPoint = new THREE.Vector3();
		this._activeHandle = null;
		this._hoveredHandle = null;

		// Drag state
		this._isDragging = false;
		this._dragStartMouse = new THREE.Vector2();
		this._dragStartCenter = new THREE.Vector3();
		this._dragStartHalfSize = new THREE.Vector3();

		// Callbacks
		this._onChange = null;        // Called when box changes
		this._onDragStart = null;
		this._onDragEnd = null;

		// Build the control meshes
		this._buildHandles();
		this._setVisibility(false);

		// Bind events
		this._onPointerDown = this._onPointerDown.bind(this);
		this._onPointerMove = this._onPointerMove.bind(this);
		this._onPointerUp = this._onPointerUp.bind(this);
		
		domElement.addEventListener("pointerdown", this._onPointerDown);
		domElement.addEventListener("pointermove", this._onPointerMove);
		domElement.addEventListener("pointerup", this._onPointerUp);
	}

	/**
	 * Build all 26 handles + wireframe box + transparent faces
	 */
	_buildHandles() {
		// Wireframe box
		const boxGeo = new THREE.BoxGeometry(1, 1, 1);
		const edges = new THREE.EdgesGeometry(boxGeo);
		this._boxMesh = new THREE.LineSegments(
			edges,
			new THREE.LineBasicMaterial({ color: WIRE_COLOR, linewidth: 2 })
		);
		this._boxMesh.renderOrder = 999;
		this.scene.add(this._boxMesh);

		// Transparent faces for face handles
		const faceGeo = new THREE.PlaneGeometry(1, 1);
		const faceMat = new THREE.MeshBasicMaterial({
			color: FACE_COLOR,
			transparent: true,
			opacity: 0.1,
			side: THREE.DoubleSide,
			depthWrite: false,
		});

		for (let i = 0; i < 6; i++) {
			const faceMesh = new THREE.Mesh(faceGeo, faceMat.clone());
			faceMesh.renderOrder = 998;
			faceMesh.visible = false;
			this.scene.add(faceMesh);
			this._faceMeshes.push(faceMesh);
		}

		// Handle geometry - small spheres for raycasting
		const handleGeo = new THREE.SphereGeometry(HANDLE_SIZE, 8, 8);

		// 6 Face handles
		const faceNormals = [
			{ axis: "y", dir: -1 }, // Bottom
			{ axis: "y", dir: 1 },  // Top
			{ axis: "z", dir: -1 }, // Front
			{ axis: "z", dir: 1 },  // Back
			{ axis: "x", dir: -1 }, // Left
			{ axis: "x", dir: 1 },  // Right
		];

		for (let i = 0; i < 6; i++) {
			const mat = new THREE.MeshBasicMaterial({
				color: HANDLE_COLOR,
				transparent: true,
				opacity: 0.8,
			});
			const mesh = new THREE.Mesh(handleGeo, mat);
			mesh.renderOrder = 1000;
			this.scene.add(mesh);
			
			this._handles.push({
				mesh,
				type: HANDLE_FACE,
				index: i,
				axis: faceNormals[i].axis,
				dir: faceNormals[i].dir,
			});
		}

		// 12 Edge handles
		const edgeConfigs = [
			// Bottom edges (z = -1)
			{ axes: ["x", "z"], y: -1, z: -1 },
			{ axes: ["x", "z"], y: 1, z: -1 },
			{ axes: ["y", "z"], x: -1, z: -1 },
			{ axes: ["y", "z"], x: 1, z: -1 },
			// Top edges (z = 1)
			{ axes: ["x", "z"], y: -1, z: 1 },
			{ axes: ["x", "z"], y: 1, z: 1 },
			{ axes: ["y", "z"], x: -1, z: 1 },
			{ axes: ["y", "z"], x: 1, z: 1 },
			// Vertical edges
			{ axes: ["x", "y"], x: -1, y: -1 },
			{ axes: ["x", "y"], x: 1, y: -1 },
			{ axes: ["x", "y"], x: -1, y: 1 },
			{ axes: ["x", "y"], x: 1, y: 1 },
		];

		for (let i = 0; i < 12; i++) {
			const mat = new THREE.MeshBasicMaterial({
				color: HANDLE_COLOR,
				transparent: true,
				opacity: 0.8,
			});
			const mesh = new THREE.Mesh(handleGeo, mat);
			mesh.renderOrder = 1000;
			this.scene.add(mesh);

			this._handles.push({
				mesh,
				type: HANDLE_EDGE,
				index: i,
				axes: edgeConfigs[i].axes,
			});
		}

		// 8 Corner handles
		for (let x = -1; x <= 1; x += 2) {
			for (let y = -1; y <= 1; y += 2) {
				for (let z = -1; z <= 1; z += 2) {
					const mat = new THREE.MeshBasicMaterial({
						color: HANDLE_COLOR,
						transparent: true,
						opacity: 0.8,
					});
					const mesh = new THREE.Mesh(handleGeo, mat);
					mesh.renderOrder = 1000;
					this.scene.add(mesh);

					this._handles.push({
						mesh,
						type: HANDLE_CORNER,
						index: this._handles.length - 6 - 12,
						sign: { x, y, z },
					});
				}
			}
		}
	}

	/**
	 * Set box center position
	 */
	setCenter(x, y, z) {
		this._center.set(x, y, z);
		this._updateHandlePositions();
		this._onChange?.();
	}

	/**
	 * Set box half-size (half-width, half-height, half-depth)
	 */
	setHalfSize(hx, hy, hz) {
		this._halfSize.set(hx, hy, hz);
		this._updateHandlePositions();
		this._onChange?.();
	}

	/**
	 * Set box from A, B points + width (corridor-style)
	 */
	setFromCorridor(A, B, width, zMin, zMax) {
		// Calculate center
		const dx = B.x - A.x;
		const dy = B.y - A.y;
		const len = Math.sqrt(dx * dx + dy * dy);
		if (len < 0.001) return;

		const halfW = width / 2;
		const perpX = (-dy / len) * halfW;
		const perpY = (dx / len) * halfW;

		// Box center (midpoint of corridor, average Z)
		const midX = (A.x + B.x) / 2;
		const midY = (A.y + B.y) / 2;
		const midZ = (zMin + zMax) / 2;
		this._center.set(midX, midY, midZ);

		// Half-size: half-length along corridor, half-width perpendicular, half-height
		this._halfSize.set(
			len / 2,        // Half-length along corridor
			halfW,          // Half-width perpendicular
			(zMax - zMin) / 2 // Half-height
		);

		// Store corridor-specific data for transformation
		this._corridorDir = new THREE.Vector3(dx / len, dy / len, 0);
		this._corridorPerp = new THREE.Vector3(-dy / len, dx / len, 0);
		this._corridorA = new THREE.Vector3(A.x, A.y, A.z);
		this._corridorB = new THREE.Vector3(B.x, B.y, B.z);

		this._updateHandlePositions();
		this._onChange?.();
	}

	/**
	 * Update all handle positions based on current box state
	 */
	_updateHandlePositions() {
		const cx = this._center.x;
		const cy = this._center.y;
		const cz = this._center.z;
		const hx = this._halfSize.x;
		const hy = this._halfSize.y;
		const hz = this._halfSize.z;

		// Update wireframe box
		this._boxMesh.position.copy(this._center);
		this._boxMesh.scale.set(hx * 2, hy * 2, hz * 2);

		// Update face handles (6)
		const facePositions = [
			{ x: cx, y: cy - hy, z: cz }, // Bottom
			{ x: cx, y: cy + hy, z: cz }, // Top
			{ x: cx, y: cy, z: cz - hz }, // Front
			{ x: cx, y: cy, z: cz + hz }, // Back
			{ x: cx - hx, y: cy, z: cz }, // Left
			{ x: cx + hx, y: cy, z: cz }, // Right
		];

		for (let i = 0; i < 6; i++) {
			this._handles[i].mesh.position.set(
				facePositions[i].x,
				facePositions[i].y,
				facePositions[i].z
			);
		}

		// Update edge handles (12)
		const edgePositions = [
			// Bottom edges
			{ x: cx, y: cy - hy, z: cz - hz },
			{ x: cx, y: cy + hy, z: cz - hz },
			{ x: cx - hx, y: cy, z: cz - hz },
			{ x: cx + hx, y: cy, z: cz - hz },
			// Top edges
			{ x: cx, y: cy - hy, z: cz + hz },
			{ x: cx, y: cy + hy, z: cz + hz },
			{ x: cx - hx, y: cy, z: cz + hz },
			{ x: cx + hx, y: cy, z: cz + hz },
			// Vertical edges
			{ x: cx - hx, y: cy - hy, z: cz },
			{ x: cx + hx, y: cy - hy, z: cz },
			{ x: cx - hx, y: cy + hy, z: cz },
			{ x: cx + hx, y: cy + hy, z: cz },
		];

		for (let i = 0; i < 12; i++) {
			this._handles[i + 6].mesh.position.set(
				edgePositions[i].x,
				edgePositions[i].y,
				edgePositions[i].z
			);
		}

		// Update corner handles (8)
		const cornerIdx = 6 + 12;
		const cornerPositions = [
			{ x: cx - hx, y: cy - hy, z: cz - hz },
			{ x: cx - hx, y: cy - hy, z: cz + hz },
			{ x: cx - hx, y: cy + hy, z: cz - hz },
			{ x: cx - hx, y: cy + hy, z: cz + hz },
			{ x: cx + hx, y: cy - hy, z: cz - hz },
			{ x: cx + hx, y: cy - hy, z: cz + hz },
			{ x: cx + hx, y: cy + hy, z: cz - hz },
			{ x: cx + hx, y: cy + hy, z: cz + hz },
		];

		for (let i = 0; i < 8; i++) {
			this._handles[cornerIdx + i].mesh.position.set(
				cornerPositions[i].x,
				cornerPositions[i].y,
				cornerPositions[i].z
			);
		}

		// Update face meshes for visual feedback
		this._updateFaceMeshes();
	}

	/**
	 * Update transparent face plane visuals
	 */
	_updateFaceMeshes() {
		const cx = this._center.x;
		const cy = this._center.y;
		const cz = this._center.z;
		const hx = this._halfSize.x;
		const hy = this._halfSize.y;
		const hz = this._halfSize.z;

		const faceConfigs = [
			// Bottom, Top
			{ pos: { x: cx, y: cy - hy, z: cz }, rot: { x: Math.PI / 2, y: 0, z: 0 }, size: { w: hx * 2, h: hz * 2 } },
			{ pos: { x: cx, y: cy + hy, z: cz }, rot: { x: Math.PI / 2, y: 0, z: 0 }, size: { w: hx * 2, h: hz * 2 } },
			// Front, Back
			{ pos: { x: cx, y: cy, z: cz - hz }, rot: { x: 0, y: 0, z: 0 }, size: { w: hx * 2, h: hy * 2 } },
			{ pos: { x: cx, y: cy, z: cz + hz }, rot: { x: 0, y: 0, z: 0 }, size: { w: hx * 2, h: hy * 2 } },
			// Left, Right
			{ pos: { x: cx - hx, y: cy, z: cz }, rot: { x: 0, y: Math.PI / 2, z: 0 }, size: { w: hz * 2, h: hy * 2 } },
			{ pos: { x: cx + hx, y: cy, z: cz }, rot: { x: 0, y: Math.PI / 2, z: 0 }, size: { w: hz * 2, h: hy * 2 } },
		];

		for (let i = 0; i < 6; i++) {
			const face = this._faceMeshes[i];
			const config = faceConfigs[i];
			face.position.set(config.pos.x, config.pos.y, config.pos.z);
			face.rotation.set(config.rot.x, config.rot.y, config.rot.z);
			face.scale.set(config.size.w, config.size.h, 1);
		}
	}

	/**
	 * Raycast to find handle under mouse
	 */
	_getHandleAtPosition(mouseX, mouseY) {
		const rect = this.domElement.getBoundingClientRect();
		this._mouse.x = ((mouseX - rect.left) / rect.width) * 2 - 1;
		this._mouse.y = -((mouseY - rect.top) / rect.height) * 2 + 1;

		this._raycaster.setFromCamera(this._mouse, this.camera);

		const handleMeshes = this._handles.map(h => h.mesh);
		const intersects = this._raycaster.intersectObjects(handleMeshes);

		if (intersects.length > 0) {
			const hitMesh = intersects[0].object;
			return this._handles.find(h => h.mesh === hitMesh);
		}
		return null;
	}

	/**
	 * Pointer down - start drag
	 */
	_onPointerDown(event) {
		if (!this.enabled || !this.visible) return;
		if (event.button !== 0) return; // Only left click

		const handle = this._getHandleAtPosition(event.clientX, event.clientY);
		if (handle) {
			event.stopPropagation();
			this._startDrag(handle, event);
		}
	}

	/**
	 * Pointer move - hover or drag
	 */
	_onPointerMove(event) {
		if (!this.enabled || !this.visible) return;

		if (this._isDragging && this._activeHandle) {
			this._continueDrag(event);
		} else {
			this._updateHover(event);
		}
	}

	/**
	 * Pointer up - end drag
	 */
	_onPointerUp(event) {
		if (!this.enabled || !this.visible) return;
		if (!this._isDragging) return;

		this._endDrag(event);
	}

	/**
	 * Start dragging a handle
	 */
	_startDrag(handle, event) {
		this._isDragging = true;
		this._activeHandle = handle;

		// Visual feedback
		this._setHandleColor(handle, DRAG_COLOR);
		handle.mesh.scale.setScalar(DRAG_SCALE);

		// Store drag start state
		this._dragStartMouse.set(event.clientX, event.clientY);
		this._dragStartCenter.copy(this._center);
		this._dragStartHalfSize.copy(this._halfSize);

		// Setup drag plane (perpendicular to camera view)
		const cameraDir = new THREE.Vector3();
		this.camera.getWorldDirection(cameraDir);
		this._dragPlane.setFromNormalAndCoplanarPoint(
			cameraDir,
			handle.mesh.position
		);

		// Calculate drag offset
		const raycaster = new THREE.Raycaster();
		const rect = this.domElement.getBoundingClientRect();
		const mouse = new THREE.Vector2(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1
		);
		raycaster.setFromCamera(mouse, this.camera);
		
		const intersection = new THREE.Vector3();
		raycaster.ray.intersectPlane(this._dragPlane, intersection);
		this._dragOffset.copy(intersection).sub(handle.mesh.position);

		this._onDragStart?.(handle);
	}

	/**
	 * Continue dragging - update box based on handle type
	 */
	_continueDrag(event) {
		if (!this._activeHandle) return;

		const rect = this.domElement.getBoundingClientRect();
		const mouse = new THREE.Vector2(
			((event.clientX - rect.left) / rect.width) * 2 - 1,
			-((event.clientY - rect.top) / rect.height) * 2 + 1
		);

		const raycaster = new THREE.Raycaster();
		raycaster.setFromCamera(mouse, this.camera);

		const intersection = new THREE.Vector3();
		if (!raycaster.ray.intersectPlane(this._dragPlane, intersection)) return;

		const worldPos = intersection.clone().sub(this._dragOffset);
		const delta = worldPos.clone().sub(this._dragStartCenter);

		const handle = this._activeHandle;

		if (handle.type === HANDLE_FACE) {
			this._dragFaceHandle(handle, delta, worldPos);
		} else if (handle.type === HANDLE_EDGE) {
			this._dragEdgeHandle(handle, delta, worldPos);
		} else if (handle.type === HANDLE_CORNER) {
			this._dragCornerHandle(handle, delta, worldPos);
		}

		this._updateHandlePositions();
		this._onChange?.();
	}

	/**
	 * Drag face handle - translate box or resize along one axis
	 */
	_dragFaceHandle(handle, delta, worldPos) {
		const axis = handle.axis;
		const dir = handle.dir;

		// Determine if we're translating or resizing
		// (Shift key = translate, otherwise resize)
		const translate = false; // TODO: Add modifier key support

		if (translate) {
			// Translate entire box along axis
			this._center[axis] = this._dragStartCenter[axis] + delta[axis];
		} else {
			// Resize box along axis
			const newHalf = Math.max(0.5, this._dragStartHalfSize[axis] + delta[axis] * dir * 0.5);
			this._halfSize[axis] = newHalf;
			
			// Move center to keep opposite face fixed
			this._center[axis] = this._dragStartCenter[axis] + delta[axis] * 0.5;
		}
	}

	/**
	 * Drag edge handle - resize along two axes
	 */
	_dragEdgeHandle(handle, delta, worldPos) {
		const axes = handle.axes;
		
		// Resize along both axes
		for (const axis of axes) {
			const sign = worldPos[axis] > this._dragStartCenter[axis] ? 1 : -1;
			const newHalf = Math.max(0.5, this._dragStartHalfSize[axis] + delta[axis] * sign * 0.5);
			this._halfSize[axis] = newHalf;
			this._center[axis] = this._dragStartCenter[axis] + delta[axis] * 0.5;
		}
	}

	/**
	 * Drag corner handle - uniform resize from opposite corner
	 */
	_dragCornerHandle(handle, delta, worldPos) {
		const sign = handle.sign;

		// Resize uniformly from opposite corner
		for (const axis of ["x", "y", "z"]) {
			const s = sign[axis];
			const newHalf = Math.max(0.5, this._dragStartHalfSize[axis] + delta[axis] * s * 0.5);
			this._halfSize[axis] = newHalf;
			this._center[axis] = this._dragStartCenter[axis] + delta[axis] * 0.5;
		}
	}

	/**
	 * End drag
	 */
	_endDrag(event) {
		if (this._activeHandle) {
			this._setHandleColor(this._activeHandle, HANDLE_COLOR);
			this._activeHandle.mesh.scale.setScalar(HANDLE_SIZE);
		}

		this._isDragging = false;
		this._activeHandle = null;
		this._onDragEnd?.();
	}

	/**
	 * Update hover state
	 */
	_updateHover(event) {
		const handle = this._getHandleAtPosition(event.clientX, event.clientY);

		if (handle !== this._hoveredHandle) {
			// Reset previous hover
			if (this._hoveredHandle) {
				this._setHandleColor(this._hoveredHandle, HANDLE_COLOR);
				this._hoveredHandle.mesh.scale.setScalar(HANDLE_SIZE);
			}

			// Set new hover
			if (handle) {
				this._setHandleColor(handle, HOVER_COLOR);
				handle.mesh.scale.setScalar(HOVER_SCALE);
				this.domElement.style.cursor = "pointer";
			} else {
				this.domElement.style.cursor = "grab";
			}

			this._hoveredHandle = handle;
		}
	}

	/**
	 * Set handle color
	 */
	_setHandleColor(handle, color) {
		handle.mesh.material.color.setHex(color);
	}

	/**
	 * Set visibility of all controls
	 */
	_setVisibility(visible) {
		this._boxMesh.visible = visible;
		this._handles.forEach(h => h.mesh.visible = visible);
		this._faceMeshes.forEach(f => f.visible = visible);
	}

	/**
	 * Enable/disable interaction
	 */
	setEnabled(enabled) {
		this.enabled = enabled;
		this._setVisibility(enabled && this.visible);
	}

	/**
	 * Show/hide controls
	 */
	setVisible(visible) {
		this.visible = visible;
		this._setVisibility(visible && this.enabled);
	}

	/**
	 * Set change callback
	 */
	onChange(callback) {
		this._onChange = callback;
	}

	/**
	 * Set drag start callback
	 */
	onDragStart(callback) {
		this._onDragStart = callback;
	}

	/**
	 * Set drag end callback
	 */
	onDragEnd(callback) {
		this._onDragEnd = callback;
	}

	/**
	 * Get current box state
	 */
	getState() {
		return {
			center: this._center.clone(),
			halfSize: this._halfSize.clone(),
			corridorDir: this._corridorDir?.clone(),
			corridorPerp: this._corridorPerp?.clone(),
			corridorA: this._corridorA?.clone(),
			corridorB: this._corridorB?.clone(),
		};
	}

	/**
	 * Reset box to fit data bounds
	 */
	fitToData(dataBounds) {
		if (!dataBounds) return;
		
		const min = dataBounds.min;
		const max = dataBounds.max;
		
		this._center.set(
			(min.x + max.x) / 2,
			(min.y + max.y) / 2,
			(min.z + max.z) / 2
		);
		
		this._halfSize.set(
			(max.x - min.x) / 2,
			(max.y - min.y) / 2,
			(max.z - min.z) / 2
		);

		this._updateHandlePositions();
		this._onChange?.();
	}

	/**
	 * Cleanup
	 */
	dispose() {
		this.domElement.removeEventListener("pointerdown", this._onPointerDown);
		this.domElement.removeEventListener("pointermove", this._onPointerMove);
		this.domElement.removeEventListener("pointerup", this._onPointerUp);

		this.scene.remove(this._boxMesh);
		this._boxMesh.geometry.dispose();
		this._boxMesh.material.dispose();

		for (const handle of this._handles) {
			this.scene.remove(handle.mesh);
			handle.mesh.geometry.dispose();
			handle.mesh.material.dispose();
		}

		for (const face of this._faceMeshes) {
			this.scene.remove(face);
			face.geometry.dispose();
			face.material.dispose();
		}

		this._handles = [];
		this._faceMeshes = [];
	}
}
