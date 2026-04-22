/**
 * Profile Renderer
 *
 * Completely isolated from Potree's render pipeline:
 * - Uses setTimeout (NOT requestAnimationFrame) so it never competes with Potree's rAF
 * - Points baked to offscreen canvas once — pan uses drawImage shift only
 * - NO stopPropagation — profile canvas and Potree canvas are sibling DOM elements,
 *   events on one physically cannot reach the other
 */

export class ProfileRenderer {
	constructor(canvas, crosshairCanvas) {
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d");

		// Crosshair overlay — separate canvas for zero-lag cursor tracking.
		// Only clears + redraws 2 lines + 1 circle on mouse move (microseconds),
		// while main canvas only redraws on zoom/pan/data changes.
		this._chCanvas = crosshairCanvas;
		this._chCtx = crosshairCanvas ? crosshairCanvas.getContext("2d") : null;

		this.data = null;
		this.viewAngle = "left";
		this.showGrid = true;
		this.padding = 20;

		this.offsetX = 0;
		this.offsetY = 0;
		this.scale = 1;
		this._isPanning = false;
		this._panStartX = 0;
		this._panStartY = 0;
		this._panStartOffX = 0;
		this._panStartOffY = 0;

		this.hoverCanvasX = -1;
		this.hoverCanvasY = -1;
		this.hoveredPointIndex = -1;

		this._dataMinX = 0; this._dataMaxX = 0;
		this._dataMinY = 0; this._dataMaxY = 0;

		// Offscreen canvas — points baked here once, drawImage shifts it during pan
		this._off = document.createElement("canvas");
		this._offCtx = this._off.getContext("2d");
		this._needsBake = true;
		this._bakeScale = -1;
		this._bakeAngle = null;

		// Render scheduling — setTimeout, NOT rAF
		this._dirty = false;
		this._timerId = null;
		this._destroyed = false;

		this._bindEvents();
	}

	_bindEvents() {
		const c = this.canvas;
		c.addEventListener("wheel", this._wheel.bind(this), { passive: false });
		c.addEventListener("pointerdown", this._down.bind(this));
		c.addEventListener("pointermove", this._move.bind(this));
		c.addEventListener("pointerup", this._up.bind(this));
	}

	_scheduleRender() {
		if (this._dirty || this._destroyed) return;
		this._dirty = true;
		this._timerId = setTimeout(() => {
			this._dirty = false;
			this._draw();
		}, 16); // ~60fps but on setTimeout queue, not rAF queue
	}

	setData(data) {
		this.data = data;
		this.offsetX = 0; this.offsetY = 0; this.scale = 1;
		this.hoveredPointIndex = -1;
		this._needsBake = true;
		this._computeBounds();
		this._buildGrid();
		this._drawNow();
	}

	// Update data without resetting zoom/pan — used by progressive re-extraction
	updateData(data) {
		this.data = data;
		this.hoveredPointIndex = -1;
		this._needsBake = true;
		this._computeBounds();
		this._buildGrid();
		this._drawNow();
	}

	setViewAngle(angle) {
		this.viewAngle = angle;
		this._computeBounds();
		this.offsetX = 0; this.offsetY = 0; this.scale = 1;
		this._needsBake = true;
		this._buildGrid();
		this._drawNow();
	}

	render() {
		this._needsBake = true;
		this._drawNow();
	}

	// Immediate draw (for setData / setViewAngle / render)
	_drawNow() {
		if (this._timerId) { clearTimeout(this._timerId); this._timerId = null; }
		this._dirty = false;
		this._draw();
	}

	_computeBounds() {
		if (!this.data || this.data.count === 0) return;
		const xArr = this._xArr(), yArr = this.data.height, n = this.data.count;
		let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
		for (let i = 0; i < n; i++) {
			if (xArr[i] < x0) x0 = xArr[i]; if (xArr[i] > x1) x1 = xArr[i];
			if (yArr[i] < y0) y0 = yArr[i]; if (yArr[i] > y1) y1 = yArr[i];
		}
		this._dataMinX = x0; this._dataMaxX = x1;
		this._dataMinY = y0; this._dataMaxY = y1;
	}

	_xArr() {
		if (!this.data) return null;
		// Front/Back = looking along the line (from draw direction) → perpDist on X
		// Left/Right = looking at the line from the side → alongAxis on X
		return (this.viewAngle === "front" || this.viewAngle === "back")
			? this.data.perpDist : this.data.alongAxis;
	}

	_mirrored() { return this.viewAngle === "back" || this.viewAngle === "right"; }

	_d2c(dx, dy) {
		const w = this.canvas.width, h = this.canvas.height, p = this.padding;
		const pw = w - p * 2, ph = h - p * 2;
		const rx = this._dataMaxX - this._dataMinX || 1;
		const ry = this._dataMaxY - this._dataMinY || 1;
		let nx = (dx - this._dataMinX) / rx, ny = (dy - this._dataMinY) / ry;
		if (this._mirrored()) nx = 1 - nx;
		return [p + nx * pw * this.scale + this.offsetX, h - p - ny * ph * this.scale - this.offsetY];
	}

	_c2d(cx, cy) {
		const w = this.canvas.width, h = this.canvas.height, p = this.padding;
		const pw = w - p * 2, ph = h - p * 2;
		const rx = this._dataMaxX - this._dataMinX || 1;
		const ry = this._dataMaxY - this._dataMinY || 1;
		let nx = (cx - p - this.offsetX) / (pw * this.scale);
		let ny = (h - p - cy - this.offsetY) / (ph * this.scale);
		if (this._mirrored()) nx = 1 - nx;
		return [nx * rx + this._dataMinX, ny * ry + this._dataMinY];
	}

	// ===== DRAW =====

	_draw() {
		if (!this.data || this.data.count === 0) return;
		const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;

		// Bake if needed — offscreen canvas is now full data size at current scale
		const expectedW = this._bakeWidth();
		const expectedH = this._bakeHeight();
		if (this._needsBake || this._bakeScale !== this.scale || this._bakeAngle !== this.viewAngle
			|| this._off.width !== expectedW || this._off.height !== expectedH) {
			this._bake();
		}

		ctx.fillStyle = "#0a0a0f";
		ctx.fillRect(0, 0, w, h);

		// Draw the visible viewport portion of the full-size baked canvas
		this._drawViewport(w, h);

		if (this.showGrid) this._grid();

		// Crosshair is drawn on the separate overlay canvas (_drawCrosshair)
		// so it updates instantly on mouse move without redrawing the main canvas.
	}

	_bakeWidth() {
		const w = this.canvas.width, p = this.padding;
		const pw = w - p * 2;
		return Math.ceil(pw * this.scale + p * 2);
	}

	_bakeHeight() {
		const h = this.canvas.height, p = this.padding;
		const ph = h - p * 2;
		return Math.ceil(ph * this.scale + p * 2);
	}

	_bake() {
		const w = this.canvas.width, h = this.canvas.height;
		if (!w || !h) return;

		const bakeW = this._bakeWidth();
		const bakeH = this._bakeHeight();
		this._off.width = bakeW;
		this._off.height = bakeH;

		const img = this._offCtx.createImageData(bakeW, bakeH);
		const px = img.data;
		const { count, r, g, b } = this.data;
		const xa = this._xArr(), ya = this.data.height;
		const mir = this._mirrored();
		const p = this.padding, pw = w - p * 2, ph = h - p * 2;
		const rx = this._dataMaxX - this._dataMinX || 1;
		const ry = this._dataMaxY - this._dataMinY || 1;
		const s = this.scale;

		// Adaptive point size — larger points fill gaps for clearer shapes
		const screenArea = pw * ph * s * s;
		const density = count / screenArea;
		const ptSize = density > 0.1 ? 2 : density > 0.03 ? 3 : density > 0.005 ? 4 : density > 0.001 ? 5 : 6;
		const ptMax = ptSize - 1;

		for (let i = 0; i < count; i++) {
			let nx = (xa[i] - this._dataMinX) / rx;
			const ny = (ya[i] - this._dataMinY) / ry;
			if (mir) nx = 1 - nx;
			// Place in full-size baked canvas — bottom-left of data at (p, bakeH - p)
			const cx = (p + nx * pw * s) | 0;
			const cy = (bakeH - p - ny * ph * s) | 0;
			if (cx < 1 || cx >= bakeW - ptSize || cy < 1 || cy >= bakeH - ptSize) continue;
			const cr = r[i], cg = g[i], cb = b[i];
			for (let dy = 0; dy <= ptMax; dy++) {
				for (let dx = 0; dx <= ptMax; dx++) {
					const idx = ((cy + dy) * bakeW + (cx + dx)) * 4;
					px[idx] = cr; px[idx+1] = cg; px[idx+2] = cb; px[idx+3] = 255;
				}
			}
		}
		this._offCtx.putImageData(img, 0, 0);
		this._bakeScale = s; this._bakeAngle = this.viewAngle; this._needsBake = false;
	}

	// Draw the visible viewport portion of the baked canvas onto the display canvas.
	// The baked canvas is the FULL data size at the current scale (larger than display
	// when zoomed in). Browser's drawImage clips automatically to the visible region.
	//
	// We need the data's bottom edge (at bakeY = bakeH - p) to appear at
	// displayY = dh - p - offsetY, so: dy = dh - bakeH - offsetY
	_drawViewport(dw, dh) {
		const bakeH = this._off.height;
		const dy = dh - bakeH - this.offsetY;
		this.ctx.drawImage(this._off, this.offsetX, dy);
	}

	_grid() {
		const ctx = this.ctx, w = this.canvas.width, h = this.canvas.height;
		const rx = this._dataMaxX - this._dataMinX || 1;
		const ry = this._dataMaxY - this._dataMinY || 1;
		const sx = nice(rx / this.scale / 6), sy = nice(ry / this.scale / 6);

		ctx.strokeStyle = "rgba(148,163,184,0.12)"; ctx.lineWidth = 1;
		ctx.font = "10px Poppins,sans-serif"; ctx.fillStyle = "#64748b";

		ctx.textAlign = "center";
		for (let x = Math.ceil(this._dataMinX / sx) * sx; x <= this._dataMaxX; x += sx) {
			const [cx] = this._d2c(x, this._dataMinY);
			if (cx < 0 || cx > w) continue;
			ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
			ctx.fillText(x.toFixed(1) + "m", cx, h - 6);
		}
		ctx.textAlign = "left";
		for (let y = Math.ceil(this._dataMinY / sy) * sy; y <= this._dataMaxY; y += sy) {
			const [, cy] = this._d2c(this._dataMinX, y);
			if (cy < 0 || cy > h) continue;
			ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.stroke();
			ctx.fillText(y.toFixed(1) + "m", 4, cy - 4);
		}
	}

	// Spatial grid for O(1) hover lookup instead of O(n) brute-force.
	// Built once per setData/setViewAngle. Each cell holds point indices.
	_buildGrid() {
		this._grid2d = null;
		if (!this.data || this.data.count === 0) return;
		const xa = this._xArr(), ya = this.data.height, n = this.data.count;
		const rx = this._dataMaxX - this._dataMinX || 1;
		const ry = this._dataMaxY - this._dataMinY || 1;

		// ~200x200 grid = 40K cells. Each cell covers ~0.5% of data range.
		const cols = 200, rows = 200;
		const cells = new Array(cols * rows);
		for (let c = 0; c < cells.length; c++) cells[c] = null;

		for (let i = 0; i < n; i++) {
			const gx = Math.min(cols - 1, ((xa[i] - this._dataMinX) / rx * cols) | 0);
			const gy = Math.min(rows - 1, ((ya[i] - this._dataMinY) / ry * rows) | 0);
			const ci = gy * cols + gx;
			if (cells[ci] === null) cells[ci] = [i];
			else cells[ci].push(i);
		}
		this._grid2d = { cells, cols, rows, rx, ry, minX: this._dataMinX, minY: this._dataMinY };
	}

	findNearestPoint(cx, cy) {
		if (!this.data || this.data.count === 0) return -1;
		const [dx, dy] = this._c2d(cx, cy);
		const xa = this._xArr(), ya = this.data.height;
		const g = this._grid2d;
		if (!g) return -1;

		const { cells, cols, rows, rx, ry, minX, minY } = g;
		const gx = ((dx - minX) / rx * cols) | 0;
		const gy = ((dy - minY) / ry * rows) | 0;

		// Search expanding ring of cells until we find a point.
		// Start with 1-cell radius, expand up to 5 if needed.
		let best = Infinity, idx = -1;
		for (let radius = 1; radius <= 5; radius++) {
			const x0 = Math.max(0, gx - radius), x1 = Math.min(cols - 1, gx + radius);
			const y0 = Math.max(0, gy - radius), y1 = Math.min(rows - 1, gy + radius);
			for (let cy2 = y0; cy2 <= y1; cy2++) {
				for (let cx2 = x0; cx2 <= x1; cx2++) {
					const cell = cells[cy2 * cols + cx2];
					if (!cell) continue;
					for (let k = 0; k < cell.length; k++) {
						const i = cell[k];
						const a = (xa[i] - dx) / rx, b = (ya[i] - dy) / ry;
						const d = a * a + b * b;
						if (d < best) { best = d; idx = i; }
					}
				}
			}
			// If we found something within this radius, no need to expand further
			if (idx >= 0) break;
		}
		return idx;
	}

	// ===== EVENTS — minimal, no stopPropagation, no rAF =====

	_wheel(e) {
		e.preventDefault();
		const f = e.deltaY > 0 ? 0.9 : 1.1;
		const ns = Math.max(0.1, Math.min(20, this.scale * f));
		const r = this.canvas.getBoundingClientRect();
		const mx = (e.clientX - r.left) * (this.canvas.width / r.width);
		const my = (e.clientY - r.top) * (this.canvas.height / r.height);
		const zoomFactor = ns / this.scale;
		this.offsetX = mx - (mx - this.offsetX) * zoomFactor;
		this.offsetY = my - (my - this.offsetY) * zoomFactor;
		this.scale = ns;
		this._needsBake = true;
		this._scheduleRender();
	}

	_down(e) {
		if (e.button !== 0) return;
		e.preventDefault();
		// Capture pointer to THIS canvas during pan — all pointermove/pointerup
		// events stay on the profile canvas even if the cursor drifts into the
		// Potree area. Without this, stray events leak to Potree's InputHandler,
		// causing orbit controls to spin the camera and blocking the render loop.
		this._pointerId = e.pointerId;
		if (e.pointerId !== undefined) {
			try { this.canvas.setPointerCapture(e.pointerId); } catch(_) {}
		}
		this._isPanning = true;
		this._panStartX = e.clientX;
		this._panStartY = e.clientY;
		this._panStartOffX = this.offsetX;
		this._panStartOffY = this.offsetY;
	}

	_move(e) {
		e.preventDefault();
		if (this._isPanning) {
			const r = this.canvas.getBoundingClientRect();
			this.offsetX = this._panStartOffX + (e.clientX - this._panStartX) * (this.canvas.width / r.width);
			this.offsetY = this._panStartOffY - (e.clientY - this._panStartY) * (this.canvas.height / r.height);
			this._scheduleRender();
		} else {
			const r = this.canvas.getBoundingClientRect();
			const cx = (e.clientX - r.left) * (this.canvas.width / r.width);
			const cy = (e.clientY - r.top) * (this.canvas.height / r.height);
			this.hoverCanvasX = cx;
			this.hoverCanvasY = cy;
			this.hoveredPointIndex = this.findNearestPoint(cx, cy);
			// Crosshair draws on lightweight overlay — instant, no main canvas redraw
			this._drawCrosshair();
		}
	}

	// Draw crosshair on the overlay canvas — called directly from pointermove.
	// Clears + draws 2 lines + 1 circle. Takes <0.1ms, zero lag.
	_drawCrosshair() {
		const ctx = this._chCtx;
		if (!ctx) return;
		const w = this._chCanvas.width, h = this._chCanvas.height;
		ctx.clearRect(0, 0, w, h);
		if (this.hoverCanvasX < 0 || this.hoveredPointIndex < 0) return;

		const mx = this.hoverCanvasX, my = this.hoverCanvasY;
		// Crosshair lines at raw cursor position — tracks mouse 1:1
		ctx.strokeStyle = "#22c55e"; ctx.lineWidth = 1;
		ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, h); ctx.stroke();
		ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(w, my); ctx.stroke();
		// Snap circle at nearest data point
		const xa = this._xArr();
		const [px, py] = this._d2c(xa[this.hoveredPointIndex], this.data.height[this.hoveredPointIndex]);
		ctx.lineWidth = 2;
		ctx.beginPath(); ctx.arc(px, py, 6, 0, Math.PI * 2); ctx.stroke();
	}

	_up(e) {
		if (this._isPanning) {
			this._isPanning = false;
			// Release pointer capture so events flow normally again
			if (this._pointerId !== undefined) {
				try { this.canvas.releasePointerCapture(this._pointerId); } catch(_) {}
				this._pointerId = undefined;
			}
			this._needsBake = true;
			this._scheduleRender();
		}
	}

	destroy() {
		this._destroyed = true;
		if (this._timerId) clearTimeout(this._timerId);
		const c = this.canvas;
		// Can't easily unbind since we used .bind(), but _destroyed flag prevents further work
	}
}

function nice(v) {
	const m = Math.pow(10, Math.floor(Math.log10(v)));
	const n = v / m;
	return (n <= 1.5 ? 1 : n <= 3.5 ? 2 : n <= 7.5 ? 5 : 10) * m;
}
