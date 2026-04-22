/**
 * ClipViewMeasureTool — Temporary measurements inside the Three.js clip view
 *
 * Provides point, distance, and area measurement tools on the clipped point cloud.
 * All measurements are temporary — never saved to DB, auto-cleared when clip view closes.
 *
 * Behavior matches the main Potree measurement tools:
 * - Point: click to place, instant completion
 * - Distance: click to add vertices, right-click to finish (min 2 points)
 * - Area: click to add vertices, right-click to finish (min 3 points, closed polygon)
 * - Right-click with < min points discards the measurement
 * - "Off" mode deselects all tools
 * - Validation: Point ≥1, Distance ≥2, Area ≥3
 */

import * as THREE from "three";

export class ClipViewMeasureTool {
	constructor(clipViewRenderer) {
		this.cvr = clipViewRenderer;
		this.raycaster = new THREE.Raycaster();
		this.raycaster.params.Points.threshold = 0.5;

		this.mode = null; // "off" | "point" | "distance" | "area" | null
		this.measures = []; // completed + in-progress measures
		this.currentMeasure = null;
		this._mouse = new THREE.Vector2();

		// Callback for status messages (e.g., discarded measurement)
		this.onStatus = null;
		// Callback when a measurement is completed (for DB save)
		this.onMeasureComplete = null;

		// Materials — reuse across all measurements
		this._markerMat = new THREE.MeshBasicMaterial({ color: 0x3b82f6 });
		this._markerRedMat = new THREE.MeshBasicMaterial({ color: 0xef4444 });
		this._markerGeom = new THREE.SphereGeometry(1, 12, 8);
		this._lineMat = new THREE.LineBasicMaterial({ color: 0x3b82f6, linewidth: 2 });
		this._lineRedMat = new THREE.LineBasicMaterial({ color: 0xef4444, linewidth: 2 });
		this._areaMat = new THREE.MeshBasicMaterial({
			color: 0x3b82f6, transparent: true, opacity: 0.15,
			side: THREE.DoubleSide, depthWrite: false,
		});

		// Label container
		this._labelContainer = null;

		// Preview (rubber-band) line from last placed vertex to cursor
		this._previewLine = null;
		this._previewMouse = new THREE.Vector2();

		// Bind handlers
		this._onClick = this._onClick.bind(this);
		this._onContextMenu = this._onContextMenu.bind(this);
		this._onMouseMove = this._onMouseMove.bind(this);
	}

	setMode(mode) {
		// Finish or discard current measurement when switching
		if (this.currentMeasure) {
			this._finishOrDiscard();
		}
		this.mode = mode;

		const dom = this.cvr.getRendererDom();
		// Always remove first to prevent double-binding
		dom.removeEventListener("click", this._onClick);
		dom.removeEventListener("contextmenu", this._onContextMenu);
		dom.removeEventListener("mousemove", this._onMouseMove);
		this._removePreviewLine();

		if (mode && mode !== "off") {
			dom.addEventListener("click", this._onClick);
			dom.addEventListener("contextmenu", this._onContextMenu);
			dom.addEventListener("mousemove", this._onMouseMove);
			dom.style.cursor = "crosshair";
		} else {
			dom.style.cursor = "";
		}
	}

	_onClick(e) {
		if (!this.mode || this.mode === "off") return;

		const rect = this.cvr.getRendererDom().getBoundingClientRect();
		this._mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		this._mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

		this.raycaster.setFromCamera(this._mouse, this.cvr.getCamera());
		if (!this.cvr.pointCloud) return;
		const intersects = this.raycaster.intersectObject(this.cvr.pointCloud);
		if (intersects.length === 0) return;

		const point = intersects[0].point.clone();

		if (this.mode === "point") {
			this._placePoint(point);
		} else if (this.mode === "distance") {
			this._placeDistanceVertex(point);
		} else if (this.mode === "area") {
			this._placeAreaVertex(point);
		}
	}

	_onContextMenu(e) {
		e.preventDefault();
		if (this.currentMeasure) {
			this._finishOrDiscard();
		}
		// Single right-click always turns off the tool (discard + deactivate)
		this.setMode(null);
		if (this.onModeChange) this.onModeChange(null);
	}

	// ==========================================
	// POINT
	// ==========================================
	_placePoint(point) {
		const m = this._newMeasure("point");
		m.markers.push(point);
		m.meshes.push(this._createMarker(point));
		m.labels.push(this._createLabel(
			`(${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`,
			point
		));
		this.measures.push(m);
		// Point completes instantly — no currentMeasure
		if (this.onMeasureComplete) this.onMeasureComplete(m);
	}

	// ==========================================
	// DISTANCE
	// ==========================================
	_placeDistanceVertex(point) {
		if (!this.currentMeasure) {
			const m = this._newMeasure("distance");
			m.markers.push(point);
			m.meshes.push(this._createMarker(point));
			this.currentMeasure = m;
			this.measures.push(m);
			return;
		}

		const m = this.currentMeasure;
		m.markers.push(point);
		m.meshes.push(this._createMarker(point));

		// Line from previous vertex
		const prev = m.markers[m.markers.length - 2];
		m.lines.push(this._createLine(prev, point));

		// Update label — show segment + total distance
		this._updateDistanceLabels(m);
	}

	_updateDistanceLabels(m) {
		// Remove old labels
		for (const l of m.labels) l.el.remove();
		m.labels.length = 0;

		let total = 0;
		for (let i = 1; i < m.markers.length; i++) {
			const seg = m.markers[i - 1].distanceTo(m.markers[i]);
			total += seg;
			const mid = new THREE.Vector3().addVectors(m.markers[i - 1], m.markers[i]).multiplyScalar(0.5);
			m.labels.push(this._createLabel(this._formatDist(seg), mid));
		}
		// Total label at last vertex if multi-segment
		if (m.markers.length > 2) {
			const last = m.markers[m.markers.length - 1];
			m.labels.push(this._createLabel(`Total: ${this._formatDist(total)}`, last));
		}
	}

	// ==========================================
	// AREA
	// ==========================================
	_placeAreaVertex(point) {
		if (!this.currentMeasure) {
			const m = this._newMeasure("area");
			m.markers.push(point);
			m.meshes.push(this._createMarker(point, true));
			this.currentMeasure = m;
			this.measures.push(m);
			return;
		}

		const m = this.currentMeasure;
		m.markers.push(point);
		m.meshes.push(this._createMarker(point, true));

		// Line from previous vertex
		const prev = m.markers[m.markers.length - 2];
		m.lines.push(this._createLine(prev, point, true));

		// Update closing line + area fill preview
		this._updateAreaPreview(m);
	}

	_updateAreaPreview(m) {
		// Remove old closing line and fill mesh
		if (m._closingLine) { this.cvr.getScene().remove(m._closingLine); m._closingLine.geometry.dispose(); m._closingLine = null; }
		if (m._fillMesh) { this.cvr.getScene().remove(m._fillMesh); m._fillMesh.geometry.dispose(); m._fillMesh = null; }

		// Remove old labels
		for (const l of m.labels) l.el.remove();
		m.labels.length = 0;

		if (m.markers.length >= 3) {
			// Closing line
			m._closingLine = this._createLine(m.markers[m.markers.length - 1], m.markers[0], true);

			// Fill polygon
			m._fillMesh = this._createAreaFill(m.markers);

			// Edge labels
			const n = m.markers.length;
			let perimeter = 0;
			for (let i = 0; i < n; i++) {
				const a = m.markers[i], b = m.markers[(i + 1) % n];
				const seg = a.distanceTo(b);
				perimeter += seg;
				const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
				m.labels.push(this._createLabel(this._formatDist(seg), mid));
			}

			// Area label at centroid
			const centroid = new THREE.Vector3();
			for (const p of m.markers) centroid.add(p);
			centroid.divideScalar(n);
			const area = this._computeArea(m.markers);
			m.labels.push(this._createLabel(
				`Area: ${this._formatArea(area)}`,
				centroid
			));
		} else if (m.markers.length === 2) {
			// Show edge distance for first 2 points
			const seg = m.markers[0].distanceTo(m.markers[1]);
			const mid = new THREE.Vector3().addVectors(m.markers[0], m.markers[1]).multiplyScalar(0.5);
			m.labels.push(this._createLabel(this._formatDist(seg), mid));
		}
	}

	_createAreaFill(markers) {
		if (markers.length < 3) return null;
		// Simple fan triangulation from first vertex (works for convex and near-convex)
		const vertices = [];
		for (let i = 1; i < markers.length - 1; i++) {
			vertices.push(markers[0].x, markers[0].y, markers[0].z);
			vertices.push(markers[i].x, markers[i].y, markers[i].z);
			vertices.push(markers[i + 1].x, markers[i + 1].y, markers[i + 1].z);
		}
		const geom = new THREE.BufferGeometry();
		geom.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
		geom.computeVertexNormals();
		const mesh = new THREE.Mesh(geom, this._areaMat);
		this.cvr.getScene().add(mesh);
		return mesh;
	}

	_computeArea(markers) {
		// 3D polygon area via cross product sum
		if (markers.length < 3) return 0;
		let ax = 0, ay = 0, az = 0;
		const n = markers.length;
		for (let i = 0; i < n; i++) {
			const a = markers[i], b = markers[(i + 1) % n];
			ax += a.y * b.z - b.y * a.z;
			ay += a.z * b.x - b.z * a.x;
			az += a.x * b.y - b.x * a.y;
		}
		return Math.sqrt(ax * ax + ay * ay + az * az) / 2;
	}

	// ==========================================
	// FINISH / DISCARD
	// ==========================================
	_finishOrDiscard() {
		const m = this.currentMeasure;
		if (!m) return true;

		this._removePreviewLine();

		const minRequired = m.type === "area" ? 3 : m.type === "distance" ? 2 : 1;
		if (m.markers.length < minRequired) {
			// Discard — not enough points
			const typeName = m.type === "area" ? "Area" : m.type === "distance" ? "Distance" : "Point";
			if (this.onStatus) {
				this.onStatus(`${typeName} needs at least ${minRequired} point${minRequired > 1 ? "s" : ""} (placed ${m.markers.length})`, "error");
			}
			this._removeMeasure(m);
			this.currentMeasure = null;
			return false;
		}

		// Finalize
		if (m.type === "area") {
			this._updateAreaPreview(m); // ensure closing line + fill + labels
		}
		if (m.type === "distance") {
			this._updateDistanceLabels(m);
		}
		this.currentMeasure = null;
		if (this.onMeasureComplete) this.onMeasureComplete(m);
		return true;
	}

	// ==========================================
	// PREVIEW LINE (rubber-band from last vertex to cursor)
	// ==========================================
	_onMouseMove(e) {
		if (!this.currentMeasure || this.currentMeasure.markers.length === 0) return;

		const rect = this.cvr.getRendererDom().getBoundingClientRect();
		this._previewMouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
		this._previewMouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;

		this.raycaster.setFromCamera(this._previewMouse, this.cvr.getCamera());
		if (!this.cvr.pointCloud) return;
		const intersects = this.raycaster.intersectObject(this.cvr.pointCloud);
		if (intersects.length === 0) return;

		const cursorPos = intersects[0].point;
		const lastMarker = this.currentMeasure.markers[this.currentMeasure.markers.length - 1];
		this._updatePreviewLine(lastMarker, cursorPos);
	}

	_updatePreviewLine(from, to) {
		this._removePreviewLine();
		const isArea = this.currentMeasure && this.currentMeasure.type === "area";
		const geom = new THREE.BufferGeometry().setFromPoints([from, to]);
		this._previewLine = new THREE.Line(geom, isArea ? this._lineRedMat : this._lineMat);
		this.cvr.getScene().add(this._previewLine);
	}

	_removePreviewLine() {
		if (this._previewLine) {
			this.cvr.getScene().remove(this._previewLine);
			this._previewLine.geometry.dispose();
			this._previewLine = null;
		}
	}

	// ==========================================
	// HELPERS
	// ==========================================
	_newMeasure(type) {
		return {
			type,
			markers: [],
			meshes: [],
			lines: [],
			labels: [],
			_closingLine: null,
			_fillMesh: null,
		};
	}

	_createMarker(position, isArea) {
		const mat = isArea ? this._markerRedMat : this._markerMat;
		const mesh = new THREE.Mesh(this._markerGeom, mat);
		mesh.position.copy(position);
		this._applyMarkerScale(mesh);
		this.cvr.getScene().add(mesh);
		return mesh;
	}

	// Scale a single marker to a consistent screen-space size based on the current camera.
	// Perspective: scale ∝ distance from camera (stays ~same pixels regardless of zoom).
	// Orthographic: scale ∝ frustum width (stays ~same pixels regardless of zoom).
	_applyMarkerScale(mesh) {
		const cam = this.cvr && this.cvr.getCamera();
		if (!cam) return;
		let s;
		if (cam.isOrthographicCamera) {
			const frustumW = (cam.right - cam.left) / (cam.zoom || 1);
			s = frustumW * 0.004;
		} else {
			const d = cam.position.distanceTo(mesh.position);
			s = d * 0.005;
		}
		if (!isFinite(s) || s <= 0) s = 0.01;
		mesh.scale.set(s, s, s);
	}

	// Called every frame by the host render loop so markers stay responsive to zoom.
	updateMarkerScales() {
		for (const m of this.measures) {
			for (const mesh of m.meshes) this._applyMarkerScale(mesh);
		}
	}

	_createLine(a, b, isArea) {
		const geometry = new THREE.BufferGeometry().setFromPoints([a, b]);
		const line = new THREE.Line(geometry, isArea ? this._lineRedMat : this._lineMat);
		this.cvr.getScene().add(line);
		return line;
	}

	_createLabel(text, worldPos) {
		if (!this._labelContainer) {
			this._labelContainer = document.createElement("div");
			this._labelContainer.style.cssText = "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:20;overflow:hidden;";
			this.cvr.container.appendChild(this._labelContainer);
		}

		const el = document.createElement("div");
		el.textContent = text;
		el.style.cssText = `
			position:absolute;
			background:rgba(255,255,255,0.92);
			color:#000;
			padding:2px 6px;
			border-radius:4px;
			font-size:11px;
			font-family:Poppins,monospace;
			white-space:nowrap;
			pointer-events:none;
			transform:translate(-50%,-100%);
		`;
		this._labelContainer.appendChild(el);

		const label = { el, worldPos: worldPos.clone() };
		this._updateLabelPosition(label);
		return label;
	}

	_updateLabelPosition(label) {
		const pos = label.worldPos.clone().project(this.cvr.getCamera());
		if (pos.z > 1) { label.el.style.display = "none"; return; }
		label.el.style.display = "";
		const rect = this.cvr.container.getBoundingClientRect();
		const x = (pos.x * 0.5 + 0.5) * rect.width;
		const y = (-pos.y * 0.5 + 0.5) * rect.height;
		label.el.style.left = x + "px";
		label.el.style.top = (y - 8) + "px";
	}

	updateLabels() {
		for (const m of this.measures) {
			for (const l of m.labels) {
				this._updateLabelPosition(l);
			}
		}
	}

	_removeMeasure(measure) {
		for (const mesh of measure.meshes) {
			this.cvr.getScene().remove(mesh);
			mesh.geometry.dispose();
		}
		for (const line of measure.lines) {
			this.cvr.getScene().remove(line);
			line.geometry.dispose();
		}
		for (const label of measure.labels) {
			label.el.remove();
		}
		if (measure._closingLine) {
			this.cvr.getScene().remove(measure._closingLine);
			measure._closingLine.geometry.dispose();
		}
		if (measure._fillMesh) {
			this.cvr.getScene().remove(measure._fillMesh);
			measure._fillMesh.geometry.dispose();
		}
		const idx = this.measures.indexOf(measure);
		if (idx >= 0) this.measures.splice(idx, 1);
	}

	clear() {
		for (const m of [...this.measures]) {
			this._removeMeasure(m);
		}
		this.measures = [];
		this.currentMeasure = null;
	}

	destroy() {
		this.setMode(null);
		this._removePreviewLine();
		this.clear();
		if (this._labelContainer) {
			this._labelContainer.remove();
			this._labelContainer = null;
		}
		this._markerMat.dispose();
		this._markerRedMat.dispose();
		this._markerGeom.dispose();
		this._lineMat.dispose();
		this._lineRedMat.dispose();
		this._areaMat.dispose();
	}

	_formatDist(d) {
		if (d >= 1000) return (d / 1000).toFixed(2) + " km";
		if (d >= 1) return d.toFixed(2) + " m";
		return (d * 100).toFixed(1) + " cm";
	}

	_formatArea(a) {
		if (a >= 1_000_000) return (a / 1_000_000).toFixed(2) + " km²";
		if (a >= 1) return a.toFixed(2) + " m²";
		return (a * 10000).toFixed(1) + " cm²";
	}
}
