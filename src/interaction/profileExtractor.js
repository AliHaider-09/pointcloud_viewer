/**
 * Profile Point Extractor
 *
 * Extracts points from a Potree octree within an oriented bounding box (OBB)
 * defined by a profile line (A→B) and a perpendicular width.
 *
 * Returns typed arrays for efficient 2D rendering:
 *   - alongAxis: distance along the profile line (0 to lineLength)
 *   - height: Z elevation
 *   - perpDist: perpendicular distance from line center
 *   - worldX/Y/Z: original 3D positions (for green indicator)
 *   - r/g/b: point colors (0-255)
 *   - intensity: normalized intensity values (0-1), null if not available
 */

const MAX_PROFILE_POINTS = 5_000_000;

/**
 * @param {PointCloudOctree} octree - The loaded point cloud octree
 * @param {Vector3} A - Start point of profile line
 * @param {Vector3} B - End point of profile line
 * @param {number} width - Cross-section width in world units (perpendicular to line)
 * @returns {object} { count, alongAxis, height, perpDist, worldX, worldY, worldZ, r, g, b }
 */
/**
 * @param {PointCloudOctree} octree
 * @param {Vector3} A - Start point of profile line
 * @param {Vector3} B - End point of profile line
 * @param {number} width - Cross-section width in world units
 * @param {object} [cameraPos] - Camera position when line was drawn ({x,y,z}).
 *   Used to orient perpDist so "Front" view matches the camera's perspective.
 */
export function extractProfilePoints(octree, A, B, width, cameraPos, zRange) {

	const halfWidth = width / 2;

	// Line direction (2D, XY plane)
	const dx = B.x - A.x;
	const dy = B.y - A.y;
	const dz = B.z - A.z;
	const lineLength2D = Math.sqrt(dx * dx + dy * dy);
	const lineLength3D = Math.sqrt(dx * dx + dy * dy + dz * dz);

	if (lineLength2D < 0.001) {
		return { count: 0, alongAxis: null, height: null, perpDist: null, worldX: null, worldY: null, worldZ: null, r: null, g: null, b: null, intensity: null, lineLength: 0 };
	}

	// Unit direction along line (2D projection)
	const lineDirX = dx / lineLength2D;
	const lineDirY = dy / lineLength2D;

	// Perpendicular direction (90° rotation in XY plane)
	let perpDirX = -lineDirY;
	let perpDirY = lineDirX;

	// Orient perp so "Front" (positive perpDist) faces the camera.
	// Project camera onto the perp axis — if camera is on the negative side, flip.
	if (cameraPos) {
		const camRelX = cameraPos.x - A.x;
		const camRelY = cameraPos.y - A.y;
		const camPerp = camRelX * perpDirX + camRelY * perpDirY;
		if (camPerp < 0) {
			perpDirX = -perpDirX;
			perpDirY = -perpDirY;
		}
	}

	// Pre-allocate output buffers
	const alongAxis = new Float32Array(MAX_PROFILE_POINTS);
	const height = new Float32Array(MAX_PROFILE_POINTS);
	const perpDist = new Float32Array(MAX_PROFILE_POINTS);
	const worldX = new Float32Array(MAX_PROFILE_POINTS);
	const worldY = new Float32Array(MAX_PROFILE_POINTS);
	const worldZ = new Float32Array(MAX_PROFILE_POINTS);
	const r = new Uint8Array(MAX_PROFILE_POINTS);
	const g = new Uint8Array(MAX_PROFILE_POINTS);
	const b = new Uint8Array(MAX_PROFILE_POINTS);
	const intensity = new Float32Array(MAX_PROFILE_POINTS);
	let hasIntensity = false;

	let count = 0;
	const octreePos = octree.position;

	// Find the rgb and intensity attribute offsets in the buffer layout
	const attributes = octree.loader.attributes;

	if (attributes && attributes.attributes) {
		for (const attr of attributes.attributes) {
			if (attr.name === "intensity") { hasIntensity = true; }
		}
	}

	// Traverse ALL loaded nodes (not just visibleNodes) so the profile captures
	// the full cross-section regardless of the current point budget.
	// visibleNodes is budget-limited — at 10M budget on a 1.8B file, most loaded
	// nodes are excluded, causing incomplete profile extraction.
	const loadedNodes = [];
	if (octree.root) {
		octree.root.traverse(node => {
			if (node.loaded && node.geometry && node.geometry.buffer) {
				loadedNodes.push(node);
			}
		});
	}

	for (const node of loadedNodes) {

		const numPoints = node.geometry.numElements;
		if (!numPoints || numPoints === 0) continue;

		// Node-level bounding box pre-filter against the profile OBB
		// The node BB is relative to octree, but we need world coords
		const bbMin = node.boundingBox.min;
		const bbMax = node.boundingBox.max;
		const nodeMinX = bbMin.x + octreePos.x;
		const nodeMinY = bbMin.y + octreePos.y;
		const nodeMaxX = bbMax.x + octreePos.x;
		const nodeMaxY = bbMax.y + octreePos.y;

		// Quick OBB vs AABB rejection test using separating axis
		if (!nodeIntersectsProfileOBB(
			nodeMinX, nodeMinY, nodeMaxX, nodeMaxY,
			A.x, A.y, lineDirX, lineDirY, perpDirX, perpDirY,
			lineLength2D, halfWidth
		)) continue;

		// Z-range pre-filter: reject entire node if outside height range
		if (zRange) {
			const nodeMinZ = bbMin.z + octreePos.z;
			const nodeMaxZ = bbMax.z + octreePos.z;
			if (nodeMaxZ < zRange[0] || nodeMinZ > zRange[1]) continue;
		}

		const geom = node.geometry;
		const buffer = geom.buffer;
		const view = new DataView(buffer);
		const isVoxel = geom.numVoxels > 0;

		// Compute rgb and intensity attribute byte offsets for this node's buffer
		let nodeRgbOffset = -1;
		let nodeIntensityOffset = -1;
		let intensityByteSize = 0;
		if (attributes && attributes.attributes) {
			let byteOff = 0;
			for (const attr of attributes.attributes) {
				if (attr.name === "rgb" || attr.name === "rgba") {
					nodeRgbOffset = byteOff;
				} else if (attr.name === "intensity") {
					nodeIntensityOffset = byteOff;
					intensityByteSize = attr.type?.size ?? 2; // typically uint16
				}
				byteOff += numPoints * attr.byteSize;
			}
		}

		for (let i = 0; i < numPoints; i++) {
			if (count >= MAX_PROFILE_POINTS) break;

			let px, py, pz;

			if (isVoxel) {
				// Voxel format: 3 bytes per point (uint8 normalized position)
				const X = view.getUint8(3 * i + 0);
				const Y = view.getUint8(3 * i + 1);
				const Z = view.getUint8(3 * i + 2);
				px = (bbMax.x - bbMin.x) * (X / 128.0) + bbMin.x + octreePos.x;
				py = (bbMax.y - bbMin.y) * (Y / 128.0) + bbMin.y + octreePos.y;
				pz = (bbMax.z - bbMin.z) * (Z / 128.0) + bbMin.z + octreePos.z;
			} else {
				// Point format: 3 float32 per point (12 bytes)
				px = view.getFloat32(12 * i + 0, true) + octreePos.x;
				py = view.getFloat32(12 * i + 4, true) + octreePos.y;
				pz = view.getFloat32(12 * i + 8, true) + octreePos.z;
			}

			// Project point onto profile line (2D, XY plane)
			const relX = px - A.x;
			const relY = py - A.y;

			// Distance along line
			const along = relX * lineDirX + relY * lineDirY;
			// Distance perpendicular to line
			const perp = relX * perpDirX + relY * perpDirY;

			// Filter: must be within line segment and within width
			if (along < -0.5 || along > lineLength2D + 0.5) continue;
			if (Math.abs(perp) > halfWidth) continue;
			// Z-range filter for volume box clipping
			if (zRange && (pz < zRange[0] || pz > zRange[1])) continue;

			// Accept this point
			alongAxis[count] = along;
			height[count] = pz;
			perpDist[count] = perp;
			worldX[count] = px;
			worldY[count] = py;
			worldZ[count] = pz;

			// Extract color
			if (!isVoxel && nodeRgbOffset >= 0) {
				// Point format: rgb is uint16 x3
				const rgbOff = nodeRgbOffset + i * 6; // 3 elements x 2 bytes
				r[count] = view.getUint16(rgbOff + 0, true) >> 8;
				g[count] = view.getUint16(rgbOff + 2, true) >> 8;
				b[count] = view.getUint16(rgbOff + 4, true) >> 8;
			} else if (isVoxel) {
				// Voxel format: color from block encoding
				const blockSize = 8;
				const bytesPerBlock = 8;
				const blockIndex = Math.floor(i / bytesPerBlock);
				const colorOffset = numPoints * 3;
				r[count] = view.getUint8(colorOffset + bytesPerBlock * blockIndex + 0);
				g[count] = view.getUint8(colorOffset + bytesPerBlock * blockIndex + 1);
				b[count] = view.getUint8(colorOffset + bytesPerBlock * blockIndex + 2);
			} else {
				r[count] = 200;
				g[count] = 200;
				b[count] = 200;
			}

			// Extract intensity (normalized to 0-1)
			if (!isVoxel && nodeIntensityOffset >= 0) {
				if (intensityByteSize === 2) {
					intensity[count] = view.getUint16(nodeIntensityOffset + i * 2, true) / 65535;
				} else if (intensityByteSize === 1) {
					intensity[count] = view.getUint8(nodeIntensityOffset + i) / 255;
				}
			}

			count++;
		}

		if (count >= MAX_PROFILE_POINTS) break;
	}

	// Compute height range (always, not just for debug)
	let minH = Infinity, maxH = -Infinity;
	let minAlong = Infinity, maxAlong = -Infinity;
	for (let i = 0; i < count; i++) {
		if (alongAxis[i] < minAlong) minAlong = alongAxis[i];
		if (alongAxis[i] > maxAlong) maxAlong = alongAxis[i];
		if (height[i] < minH) minH = height[i];
		if (height[i] > maxH) maxH = height[i];
	}

	if (count > 0) {
		console.log(`[ProfileExtract] A=(${A.x.toFixed(1)},${A.y.toFixed(1)},${A.z.toFixed(1)}) B=(${B.x.toFixed(1)},${B.y.toFixed(1)},${B.z.toFixed(1)})`);
		console.log(`[ProfileExtract] lineLen2D=${lineLength2D.toFixed(2)}, lineLen3D=${lineLength3D.toFixed(2)}, along=[${minAlong.toFixed(2)},${maxAlong.toFixed(2)}], height=[${minH.toFixed(2)},${maxH.toFixed(2)}], nodes=${loadedNodes.length}, pts=${count}/${MAX_PROFILE_POINTS}`);
	}

	return {
		count,
		alongAxis: alongAxis.subarray(0, count),
		height: height.subarray(0, count),
		perpDist: perpDist.subarray(0, count),
		worldX: worldX.subarray(0, count),
		worldY: worldY.subarray(0, count),
		worldZ: worldZ.subarray(0, count),
		r: r.subarray(0, count),
		g: g.subarray(0, count),
		b: b.subarray(0, count),
		intensity: hasIntensity ? intensity.subarray(0, count) : null,
		lineLength: lineLength2D,
		minHeight: count > 0 ? minH : 0,
		maxHeight: count > 0 ? maxH : 0,
	};
}


/**
 * Fast OBB vs AABB intersection test using separating axis theorem (2D, XY plane).
 * The OBB is defined by the profile line center, direction, and half-extents.
 */
function nodeIntersectsProfileOBB(
	nodeMinX, nodeMinY, nodeMaxX, nodeMaxY,
	originX, originY,
	lineDirX, lineDirY, perpDirX, perpDirY,
	lineLength, halfWidth
) {
	// OBB center
	const obbCenterX = originX + lineDirX * lineLength / 2;
	const obbCenterY = originY + lineDirY * lineLength / 2;
	const obbHalfAlong = lineLength / 2 + 0.5; // small padding
	const obbHalfPerp = halfWidth;

	// AABB center and half-extents
	const aabbCenterX = (nodeMinX + nodeMaxX) / 2;
	const aabbCenterY = (nodeMinY + nodeMaxY) / 2;
	const aabbHalfX = (nodeMaxX - nodeMinX) / 2;
	const aabbHalfY = (nodeMaxY - nodeMinY) / 2;

	// Separation vector
	const sepX = aabbCenterX - obbCenterX;
	const sepY = aabbCenterY - obbCenterY;

	// Test 4 axes: AABB x, AABB y, OBB along, OBB perp

	// Axis 1: AABB X axis (1, 0)
	let projOBB = Math.abs(lineDirX) * obbHalfAlong + Math.abs(perpDirX) * obbHalfPerp;
	if (Math.abs(sepX) > aabbHalfX + projOBB) return false;

	// Axis 2: AABB Y axis (0, 1)
	projOBB = Math.abs(lineDirY) * obbHalfAlong + Math.abs(perpDirY) * obbHalfPerp;
	if (Math.abs(sepY) > aabbHalfY + projOBB) return false;

	// Axis 3: OBB along axis (lineDirX, lineDirY)
	let projAABB = aabbHalfX * Math.abs(lineDirX) + aabbHalfY * Math.abs(lineDirY);
	let sepProj = Math.abs(sepX * lineDirX + sepY * lineDirY);
	if (sepProj > obbHalfAlong + projAABB) return false;

	// Axis 4: OBB perp axis (perpDirX, perpDirY)
	projAABB = aabbHalfX * Math.abs(perpDirX) + aabbHalfY * Math.abs(perpDirY);
	sepProj = Math.abs(sepX * perpDirX + sepY * perpDirY);
	if (sepProj > obbHalfPerp + projAABB) return false;

	return true;
}
