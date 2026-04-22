
import {Potree, Mesh, Vector3, Vector4, geometries, SceneNode} from "potree";
import {EventDispatcher, KeyCodes, MouseCodes} from "potree";

let counter = 0;

export class Measure{
	constructor(){
		this.label = `Measure ${counter}`;
		this.markers = [];
		this.markers_highlighted = [];
		this.requiredMarkers = 1;
		this.maxMarkers = 1;
		this.showEdges = true;
		counter++;
	}
	addMarker(position){ this.markers.push(position.clone()); }
	toHtml(prefix = ""){
		let htmlMarkers = "";
		for(let i = 0; i < this.markers.length; i++){
			let marker = this.markers[i];
			htmlMarkers += `<tr id="${prefix}_${i}"><td style="text-align:right">${marker.x.toFixed(3)}</td><td style="text-align:right">${marker.y.toFixed(3)}</td><td style="text-align:right">${marker.z.toFixed(3)}</td></tr>`;
		}
		return `<table style="width:100%">${htmlMarkers}</table>`;
	}
};

export class PointMeasure extends Measure{
	constructor(){ super(); }
	addMarker(position){ this.markers.push(position.clone()); }
};

export class DistanceMeasure extends Measure{
	constructor(){
		super();
		this.requiredMarkers = 0;
		this.maxMarkers = 100;
		this.closed = false;
	}
	addMarker(position){ this.markers.push(position.clone()); }
	getTotalDistance(){
		let total = 0;
		for(let i = 0; i < this.markers.length - 1; i++){
			total += this.markers[i].distanceTo(this.markers[i + 1]);
		}
		if(this.closed && this.markers.length > 2){
			total += this.markers[this.markers.length - 1].distanceTo(this.markers[0]);
		}
		return total;
	}
	getArea(){
		if(this.markers.length < 3) return 0;
		let area = 0, n = this.markers.length;
		for(let i = 0; i < n; i++){
			let j = (i + 1) % n, a = this.markers[i], b = this.markers[j];
			area += (a.x * b.y - b.x * a.y);
			area += (a.y * b.z - b.y * a.z);
			area += (a.z * b.x - b.z * a.x);
		}
		return Math.abs(area) / 2;
	}
};

export class HeightMeasure extends Measure{
	constructor(){ super(); this.requiredMarkers = 2; this.maxMarkers = 2; }
	addMarker(position){ this.markers.push(position.clone()); }
};

export class ProfileMeasure extends Measure{
	constructor(){
		super();
		this.label = `Profile ${counter}`;
		this.requiredMarkers = 2;
		this.maxMarkers = 2;
		this.showEdges = true;
		this.profileWidth = 10; // default width in meters
		this.profileHeightRange = null; // null = full Z, or [minZ, maxZ]
		this.isProfile = true;  // flag to identify profile measurements
	}
	addMarker(position){ this.markers.push(position.clone()); }
};

export class MeasureTool{

	constructor(potree){
		this.potree = potree;
		this.renderer = potree.renderer;
		this.element = potree.renderer.canvas;

		this.node = new SceneNode("MeasureTool");
		this.cursor = new Mesh("MeasureTool_cursor", geometries.sphere);
		this.cursor.scale.set(2, 2, 2);
		this.cursor.position.set(67.97, -4.54, -23.56);
		this.cursor.visible = true;

		this.node.children.push(this.cursor);
		potree.scene.root.children.push(this.node);

		this.currentMeasurement = null;
		this.selectedMeasure = null;
		this.allMidpoints = [];
		this.measures = [];
		this._hoveredMeasure = null;
		this.onMidpointInsert = null;
		this.onMeasureDiscarded = null;
		this.toolActive = false; // set by viewer when measurement tool is active
		this._skipSphereDraws = false; // set by magnifier to hide spheres on capture frames

		// --- Pre-allocated objects ---
		this._vpCache = new Float64Array(16);
		this._vpCacheValid = false;
		this._hoverFrame = 0;
		this._cachedRect = null;
		this._rectFrame = 0;
		this._lastVP0 = 0;

		// Colors — allocated once, reused forever
		this._colorRed = new Vector4(1, 0, 0, 1);
		this._colorHighlight = new Vector4(); this._colorHighlight.set(255, 200, 50, 255).multiplyScalar(1 / 255);
		this._colorSelected = new Vector4(); this._colorSelected.set(59, 130, 246, 255).multiplyScalar(1 / 255);
		this._colorMidpoint = new Vector4(0.15, 0.15, 0.15, 0.3);
		this._colorCursor = new Vector4(); this._colorCursor.set(59, 200, 100, 255).multiplyScalar(1 / 255);
		this._edgeRed = new Vector3(255, 0, 0);
		this._edgeBlue = new Vector3(59, 130, 246);
		this._edgeHeightBlue = new Vector3(0, 0, 255);
		this._edgePreview = new Vector3(255, 100, 100); // lighter red for rubber-band
		this._midVec = new Vector3();
		this._heightStart = new Vector3();
		this._heightEnd = new Vector3();

		// Midpoint pool
		this._midpointPool = [];
		this._midpointPoolIdx = 0;

		// Reusable draw args (avoid {color} object creation per call)
		this._drawArgs = { color: null };

		// Reusable projection result (avoid [x,y] array allocation per hover check)
		this._projOut = { x: 0, y: 0 };

		// Smooth cursor — interpolate toward pickPosition for fluid movement
		this._smoothPos = new Vector3();
		this._smoothInited = false;

		// Cached rect
		this._getCachedRect = () => {
			this._rectFrame++;
			if(!this._cachedRect || this._rectFrame % 30 === 0)
				this._cachedRect = this.element.getBoundingClientRect();
			return this._cachedRect;
		};

		// Mouse tracking
		this.element.addEventListener("pointermove", (e) => {
			let rect = this._getCachedRect();
			this._mouseX = e.clientX - rect.left;
			this._mouseY = e.clientY - rect.top;
		});

		potree.onUpdate(this.update.bind(this));
		this.dispatcher = new EventDispatcher();

		// === CLICK HANDLING ===
		let clickStart = null;
		this._movingVertex = null;

		this.element.addEventListener("pointerdown", (e) => {
			if(e.button === 0) clickStart = { x: e.clientX, y: e.clientY, time: Date.now() };
		});

		// Right-click: cancel drag or deselect
		this.element.addEventListener("contextmenu", (e) => {
			if(this._movingVertex){
				e.preventDefault();
				let mv = this._movingVertex;
				if(mv.isNew){
					mv.measure.markers.splice(mv.markerIndex, 1);
					mv.measure.markers_highlighted.splice(mv.markerIndex, 1);
				} else {
					let marker = mv.measure.markers[mv.markerIndex];
					if(marker){ marker.x = mv.originalPos.x; marker.y = mv.originalPos.y; marker.z = mv.originalPos.z; }
					mv.measure.markers_highlighted[mv.markerIndex] = false;
				}
				this._movingVertex = null;
			} else if(this.selectedMeasure && !this.currentMeasurement){
				e.preventDefault();
				this.selectedMeasure = null;
				if(this.onSelectionChange) this.onSelectionChange(null);
			}
		});

		// Click: place vertex, select, or edit
		this.element.addEventListener("pointerup", (e) => {
			if(e.button !== 0 || !clickStart) return;
			if(this.currentMeasurement) { clickStart = null; return; }

			let dx = e.clientX - clickStart.x, dy = e.clientY - clickStart.y;
			let dt = Date.now() - clickStart.time;
			clickStart = null;
			if(dx*dx + dy*dy > 100 || dt > 400) return;

			let rect = this._getCachedRect();
			let x = e.clientX - rect.left, y = e.clientY - rect.top;

			// Build viewProj once per click (reuse _vpCache)
			let vp = this._vpCache;
			let v = camera.view?.elements, p = camera.proj?.elements;
			if(v && p){
				for(let r = 0; r < 4; r++)
					for(let c = 0; c < 4; c++)
						vp[r + c*4] = p[r]*v[c*4] + p[r+4]*v[1+c*4] + p[r+8]*v[2+c*4] + p[r+12]*v[3+c*4];
			}
			let cw = this.element.clientWidth, ch = this.element.clientHeight;

			let project = (pt) => {
				let px = pt.x, py = pt.y, pz = pt.z;
				let w = vp[3]*px + vp[7]*py + vp[11]*pz + vp[15];
				if(w <= 0) return null;
				return [(vp[0]*px + vp[4]*py + vp[8]*pz + vp[12])/w * 0.5 + 0.5, 1.0 - ((vp[1]*px + vp[5]*py + vp[9]*pz + vp[13])/w * 0.5 + 0.5)];
			};
			let screenDist = (pt) => {
				let s = project(pt);
				if(!s) return Infinity;
				let sx = s[0]*cw - x, sy = s[1]*ch - y;
				return Math.sqrt(sx*sx + sy*sy);
			};
			let segDist = (ax, ay, bx, by) => {
				let dx = bx-ax, dy = by-ay, len2 = dx*dx+dy*dy;
				if(len2 < 0.001) return Math.sqrt((x-ax*cw)*(x-ax*cw)+(y-ay*ch)*(y-ay*ch));
				let t = ((x/cw-ax)*dx+(y/ch-ay)*dy)/len2;
				if(t<0)t=0; else if(t>1)t=1;
				let cx2 = (ax+t*dx)*cw-x, cy2 = (ay+t*dy)*ch-y;
				return Math.sqrt(cx2*cx2+cy2*cy2);
			};

			// Place vertex using mouse ray at pick depth (matches visual drag position)
			let placePos = Potree.pickPosition;

			// Moving vertex → place at mouse ray position (same as drag visual)
			if(this._movingVertex && placePos){
				let mv = this._movingVertex;
				let marker = mv.measure.markers[mv.markerIndex];
				if(marker){
					let camPos = camera.getWorldPosition();
					let u = x / cw;
					let v = 1.0 - (y / ch);
					let dir = camera.mouseToDirection(u, v);
					let dist = camPos.distanceTo(placePos);
					marker.x = camPos.x + dir.x * dist;
					marker.y = camPos.y + dir.y * dist;
					marker.z = camPos.z + dir.z * dist;
				}
				mv.measure.markers_highlighted[mv.markerIndex] = false;
				this._movingVertex = null;
				if(this.onMidpointInsert) this.onMidpointInsert(mv.measure);
				return;
			}

			// Midpoints on selected measurement
			if(this.selectedMeasure){
				let bestDist = Infinity, bestMp = null;
				for(let mp of this.allMidpoints){
					let sd = screenDist(mp.position);
					if(sd < 25 && sd < bestDist){ bestDist = sd; bestMp = mp; }
				}
				if(bestMp){
					let vertexCloser = false;
					for(let mi = 0; mi < this.selectedMeasure.markers.length; mi++){
						if(screenDist(this.selectedMeasure.markers[mi]) < bestDist){ vertexCloser = true; break; }
					}
					if(!vertexCloser){
						let insertAt = bestMp.insertAfter + 1;
						bestMp.measure.markers.splice(insertAt, 0, bestMp.position.clone());
						bestMp.measure.markers_highlighted.splice(insertAt, 0, true);
						this._movingVertex = {
							measure: bestMp.measure, markerIndex: insertAt,
							originalPos: bestMp.position.clone(), isNew: true,
						};
						if(this.onMidpointInsert) this.onMidpointInsert(bestMp.measure);
						return;
					}
				}
			}

			// Vertices
			let clickedMeasure = null, clickedIdx = -1, bestVDist = Infinity;
			for(let m of this.measures){
				if(m.markers.length < 1 || m.visible === false) continue;
				for(let mi = 0; mi < m.markers.length; mi++){
					let sd = screenDist(m.markers[mi]);
					if(sd < 20 && sd < bestVDist){ bestVDist = sd; clickedMeasure = m; clickedIdx = mi; }
				}
			}

			// Edges
			if(!clickedMeasure){
				let bestED = Infinity;
				for(let m of this.measures){
					if(m.markers.length < 2 || m.visible === false) continue;
					let ec = m.markers.length - 1;
					if(m.closed && m.markers.length > 2) ec = m.markers.length;
					for(let i = 0; i < ec; i++){
						let sa = project(m.markers[i]);
						let sb = project(m.markers[(i+1) % m.markers.length]);
						if(sa && sb){
							let sd = segDist(sa[0], sa[1], sb[0], sb[1]);
							if(sd < 12 && sd < bestED){ bestED = sd; clickedMeasure = m; clickedIdx = -1; }
						}
					}
				}
			}

			if(clickedMeasure){
				this.selectedMeasure = clickedMeasure;
				if(this.onSelectionChange) this.onSelectionChange(clickedMeasure);
				if(clickedIdx >= 0){
					this._movingVertex = {
						measure: clickedMeasure, markerIndex: clickedIdx,
						originalPos: clickedMeasure.markers[clickedIdx].clone(), isNew: false,
					};
					clickedMeasure.markers_highlighted[clickedIdx] = true;
				}
				return;
			}

			this.selectedMeasure = null;
			if(this.onSelectionChange) this.onSelectionChange(null);
		});
	}

	reset(){}

	update(){
		this._midpointPoolIdx = 0;
		this.allMidpoints.length = 0;

		// Compute VP matrix once per frame — shared by hover, magLoop, labels
		if(camera.proj && camera.view){
			let v = camera.view.elements, p = camera.proj.elements;
			let e = this._vpCache;
			for(let r = 0; r < 4; r++)
				for(let c = 0; c < 4; c++)
					e[r + c*4] = p[r]*v[c*4] + p[r+4]*v[1+c*4] + p[r+8]*v[2+c*4] + p[r+12]*v[3+c*4];
			this._vpCacheValid = true;
		} else {
			this._vpCacheValid = false;
		}

		let pp = Potree.pickPosition;
		let camPos = camera.getWorldPosition();

		// --- Vertex dragging — project mouse ray to pick depth so vertex follows mouse ---
		if(this._movingVertex){
			this.element.style.cursor = "grabbing";
			if(pp){
				let marker = this._movingVertex.measure.markers[this._movingVertex.markerIndex];
				if(marker && this._mouseX !== undefined){
					let cw = this.element.clientWidth, ch = this.element.clientHeight;
					let u = this._mouseX / cw;
					let v = 1.0 - (this._mouseY / ch);
					let dir = camera.mouseToDirection(u, v);
					let dist = camPos.distanceTo(pp);
					marker.x = camPos.x + dir.x * dist;
					marker.y = camPos.y + dir.y * dist;
					marker.z = camPos.z + dir.z * dist;
				} else if(marker){
					marker.x = pp.x;
					marker.y = pp.y;
					marker.z = pp.z;
				}
			}
		}

		// --- Cursor sync — project mouse ray to pickPosition depth so vertex sticks to glass ---
		if(this.currentMeasurement){
			if(pp && this._mouseX !== undefined){
				let cw = this.element.clientWidth, ch = this.element.clientHeight;
				let u = this._mouseX / cw;        // 0..1 left to right
				let v = 1.0 - (this._mouseY / ch); // 0..1 bottom to top (camera convention)
				let dir = camera.mouseToDirection(u, v);
				let dist = camPos.distanceTo(pp);
				this.cursor.position.x = camPos.x + dir.x * dist;
				this.cursor.position.y = camPos.y + dir.y * dist;
				this.cursor.position.z = camPos.z + dir.z * dist;
			} else if(pp){
				this.cursor.position.x = pp.x;
				this.cursor.position.y = pp.y;
				this.cursor.position.z = pp.z;
			}
			let depth = camPos.distanceTo(this.cursor.position);
			let s = depth / 200;
			this.cursor.visible = !this._skipSphereDraws;
			this.cursor.scale.set(s, s, s);

			// Rubber-band preview lines
			let cm = this.currentMeasurement;
			if(cm.markers.length > 0 && cm.showEdges !== false){
				// Profile lines always draw red to match completed state
				let previewColor = (cm instanceof ProfileMeasure) ? this._edgeRed : this._edgePreview;
				this.renderer.drawLine(cm.markers[cm.markers.length - 1], this.cursor.position, previewColor);
				if(cm.closed && cm.markers.length >= 2){
					this.renderer.drawLine(this.cursor.position, cm.markers[0], previewColor);
				}
			}
		}else{
			this.cursor.visible = false;
			this._smoothInited = false;
		}

		// --- Hover detection ---
		this._hoverFrame++;
		let cameraChanged = false;
		if(camera.proj){
			let vp0 = camera.proj.elements[0];
			if(vp0 !== this._lastVP0){ cameraChanged = true; this._lastVP0 = vp0; }
		}
		if(!this.currentMeasurement && !this._movingVertex && this._mouseX !== undefined
			&& this._vpCacheValid && (this.toolActive || this.selectedMeasure || this.measures.length > 0)
			&& (cameraChanged || (this._hoverFrame % 5 === 0)))
		{
			let e = this._vpCache;

			let cw = this.element.clientWidth, ch = this.element.clientHeight;
			let mx = this._mouseX, my = this._mouseY;

			let po = this._projOut;
			let projectPt = (px, py, pz) => {
				let w = e[3]*px + e[7]*py + e[11]*pz + e[15];
				if(w <= 0) return false;
				po.x = (e[0]*px + e[4]*py + e[8]*pz + e[12])/w * 0.5 + 0.5;
				po.y = 1.0 - ((e[1]*px + e[5]*py + e[9]*pz + e[13])/w * 0.5 + 0.5);
				return true;
			};
			let ptSegSq = (ax, ay, bx, by) => {
				let sx = ax*cw, sy = ay*ch, ex = bx*cw, ey = by*ch;
				let dx = ex-sx, dy = ey-sy, len2 = dx*dx+dy*dy;
				if(len2 < 0.001){ let fx=mx-sx,fy=my-sy; return fx*fx+fy*fy; }
				let t = ((mx-sx)*dx+(my-sy)*dy)/len2;
				if(t<0)t=0; else if(t>1)t=1;
				let cx2=sx+t*dx-mx, cy2=sy+t*dy-my;
				return cx2*cx2+cy2*cy2;
			};

			let newHovered = null, bestSq = 400;

			for(let i = 0; i < this.measures.length; i++){
				let measure = this.measures[i];
				if(measure.markers.length < 1 || measure.visible === false) continue;
				for(let mi = 0; mi < measure.markers.length; mi++){
					let pt = measure.markers[mi];
					if(projectPt(pt.x, pt.y, pt.z)){ let dx2 = po.x*cw-mx, dy2 = po.y*ch-my; let sq=dx2*dx2+dy2*dy2; if(sq<bestSq){bestSq=sq;newHovered=measure;} }
				}
				let ec = measure.markers.length - 1;
				if(measure.closed && measure.markers.length > 2) ec = measure.markers.length;
				for(let j = 0; j < ec; j++){
					let a = measure.markers[j], b = measure.markers[(j+1)%measure.markers.length];
					if(!projectPt(a.x,a.y,a.z)) continue;
					let sax = po.x, say = po.y;
					if(!projectPt(b.x,b.y,b.z)) continue;
					let sq = ptSegSq(sax, say, po.x, po.y);
					if(sq<bestSq){bestSq=sq;newHovered=measure;}
				}
			}

			this.element.style.cursor = newHovered ? "pointer" : "";

			if(newHovered !== this._hoveredMeasure){
				if(this._hoveredMeasure && this._hoveredMeasure !== this.selectedMeasure){
					let h = this._hoveredMeasure.markers_highlighted;
					for(let i = 0; i < h.length; i++) h[i] = false;
				}
				if(newHovered && newHovered !== this.selectedMeasure){
					let h = newHovered.markers_highlighted;
					for(let i = 0; i < newHovered.markers.length; i++){
						if(i >= h.length) h.push(true); else h[i] = true;
					}
				}
				this._hoveredMeasure = newHovered;
			}
		}

		// --- Draw all measurements ---
		let args = this._drawArgs;
		let drawSpheres = !this._skipSphereDraws;

		for(let i = 0; i < this.measures.length; i++){
			let measure = this.measures[i];
			if(measure.visible === false) continue;
			let isSelected = (measure === this.selectedMeasure);

			// Markers (skipped on magnifier capture frames)
			if(drawSpheres){
				for(let mi = 0; mi < measure.markers.length; mi++){
					let marker = measure.markers[mi];
					let d = camPos.distanceTo(marker);
					args.color = measure.markers_highlighted[mi] ? this._colorHighlight
						: isSelected ? this._colorSelected : this._colorRed;
					this.renderer.drawSphere(marker, isSelected ? d/140 : d/200, args);
				}
			}

			// Midpoints for selected (skipped on magnifier capture frames)
			if(isSelected && measure instanceof DistanceMeasure && measure.markers.length >= 2 && !this.currentMeasurement){
				let edges = measure.markers.length - 1;
				if(measure.closed && measure.markers.length > 2) edges = measure.markers.length;
				args.color = this._colorMidpoint;
				for(let j = 0; j < edges; j++){
					let a = measure.markers[j], b = measure.markers[(j+1)%measure.markers.length];
					let midPos;
					if(this._midpointPoolIdx < this._midpointPool.length){
						midPos = this._midpointPool[this._midpointPoolIdx];
					} else { midPos = new Vector3(); this._midpointPool.push(midPos); }
					this._midpointPoolIdx++;
					midPos.set((a.x+b.x)*0.5, (a.y+b.y)*0.5, (a.z+b.z)*0.5);
					this.allMidpoints.push({ position: midPos, measure, insertAfter: j });
					if(drawSpheres) this.renderer.drawSphere(midPos, camPos.distanceTo(midPos)/100, args);
				}
			}

			// Edges
			if(measure.showEdges){
				let ec = isSelected ? this._edgeBlue : this._edgeRed;
				let mlen = measure.markers.length;
				for(let j = 0; j < mlen - 1; j++)
					this.renderer.drawLine(measure.markers[j], measure.markers[j+1], ec);
				if(measure.closed && mlen > 2)
					this.renderer.drawLine(measure.markers[mlen-1], measure.markers[0], ec);
			}

			// Height
			if(measure instanceof HeightMeasure && measure.markers.length === 2){
				let low = measure.markers[0], high = measure.markers[1];
				if(low.z > high.z){ let tmp = low; low = high; high = tmp; }
				this._heightStart.set(high.x, high.y, high.z);
				this._heightEnd.set(high.x, high.y, low.z);
				this.renderer.drawLine(this._heightStart, this._heightEnd, this._edgeHeightBlue);
				this.renderer.drawLine(low, this._heightEnd, this._edgeRed);
			}
		}
	}

	measureMove(e){
		// Cursor synced in update() — only trigger Potree's pick system
		Potree.pick(e.mouse.x, e.mouse.y, (result) => {
			if(result.depth !== Infinity) Potree.pickPos = result.position;
		});
	}

	onClick(e){}

	startMeasuring(measure){
		if(this.currentMeasurement) this.stopMeasuring();
		if(!measure) measure = new Measure();
		this.currentMeasurement = measure;
		this._smoothInited = false;
		this.measures.push(measure);

		this.dispatcher.add("mousemove", (e) => { this.measureMove(e); });
		this.dispatcher.add("mouseup", (e) => {
			if(e.event.button === MouseCodes.LEFT && this.cursor.visible){
				// Place at smoothed position (what user sees) for consistency
				let markerPos = Potree.pickPosition
					? Potree.pickPosition.clone()
					: this.cursor.position.clone();

				measure.addMarker(markerPos);

				if(measure.markers.length === measure.maxMarkers){
					this.stopMeasuring();
				}else if(measure.markers.length === measure.requiredMarkers){
					this.stopMeasuring();
				}
			}else if(e.event.button === MouseCodes.RIGHT){
				let minRequired = 1;
				if(measure instanceof DistanceMeasure) minRequired = measure.closed ? 3 : 2;
				if(measure.markers.length < minRequired){
					let idx = this.measures.indexOf(measure);
					if(idx >= 0) this.measures.splice(idx, 1);
					if(this.onMeasureDiscarded){
						let type = measure instanceof DistanceMeasure ? (measure.closed ? "Area" : "Distance") : "Point";
						this.onMeasureDiscarded(type, measure.markers.length, minRequired);
					}
				}
				this.stopMeasuring();
			}
		});
	}

	selectMeasure(measure){
		this.selectedMeasure = measure;
		if(this.onSelectionChange) this.onSelectionChange(measure);
	}

	deselectMeasure(){
		this.selectedMeasure = null;
		this.allMidpoints.length = 0;
		this._midpointPoolIdx = 0;
		if(this.onSelectionChange) this.onSelectionChange(null);
	}

	deleteMeasure(measure){
		// Full cleanup: deselect, remove from array, clear all references
		if(this.selectedMeasure === measure) this.selectedMeasure = null;
		if(this._hoveredMeasure === measure) this._hoveredMeasure = null;
		if(this._movingVertex && this._movingVertex.measure === measure) this._movingVertex = null;
		const idx = this.measures.indexOf(measure);
		if(idx >= 0) this.measures.splice(idx, 1);
		this.allMidpoints.length = 0;
		this._midpointPoolIdx = 0;
		if(this.onSelectionChange) this.onSelectionChange(null);
	}

	stopMeasuring(){
		let measure = this.currentMeasurement;
		this.dispatcher.removeAll();
		this.cursor.visible = false;
		this.currentMeasurement = null;
		this._smoothInited = false;

		// Validate: discard if not enough points (same logic as right-click)
		if(measure){
			let minRequired = 1;
			if(measure instanceof DistanceMeasure) minRequired = measure.closed ? 3 : 2;
			if(measure instanceof ProfileMeasure) minRequired = 2;
			if(measure.markers.length < minRequired){
				let idx = this.measures.indexOf(measure);
				if(idx >= 0) this.measures.splice(idx, 1);
				if(this.onMeasureDiscarded){
					let type = measure instanceof ProfileMeasure ? "Clip"
						: measure instanceof DistanceMeasure ? (measure.closed ? "Area" : "Distance") : "Point";
					this.onMeasureDiscarded(type, measure.markers.length, minRequired);
				}
			} else if(measure instanceof ProfileMeasure && measure.markers.length >= 2){
				// Profile completed — keep in measures list for re-editing, fire callback
				if(this.onProfileComplete) this.onProfileComplete(measure);
			}
		}
	}

};
