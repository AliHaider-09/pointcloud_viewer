
import {Matrix4, Vector3, toRadians} from "potree";

/**
 * Wraps a Three.js PerspectiveCamera to satisfy the interface expected by
 * PointCloudOctree.updateVisibility(camera, renderer).
 *
 * Required interface:
 *   camera.view  - Matrix4 (world-to-camera, Potree Float64Array)
 *   camera.proj  - Matrix4 (projection, Potree Float64Array)
 *   camera.fov   - field-of-view in degrees
 *   camera.getWorldPosition() - returns Potree Vector3
 */
export class CameraAdapter {

	constructor(threeCamera) {
		this.threeCamera = threeCamera;
		this.view = new Matrix4();
		this.proj = new Matrix4();
		this.fov = threeCamera.fov;
		this.near = threeCamera.near;
		this.far = threeCamera.far;
		this.aspect = threeCamera.aspect;
		this.world = new Matrix4();
	}

	/** Call once per frame after Three.js camera matrices are updated. */
	sync() {
		let tc = this.threeCamera;

		// Copy Three.js Float32 elements → Potree Float64 Matrix4
		let srcView = tc.matrixWorldInverse.elements;
		let srcProj = tc.projectionMatrix.elements;
		let srcWorld = tc.matrixWorld.elements;

		for (let i = 0; i < 16; i++) {
			this.view.elements[i] = srcView[i];
			this.proj.elements[i] = srcProj[i];
			this.world.elements[i] = srcWorld[i];
		}

		this.fov = tc.fov;
		this.near = tc.near;
		this.far = tc.far;
		this.aspect = tc.aspect;
	}

	getWorldPosition() {
		let tc = this.threeCamera;
		return new Vector3(tc.position.x, tc.position.y, tc.position.z);
	}

	getWorldDirection() {
		let p0 = new Vector3(0, 0, 0).applyMatrix4(this.world);
		let p1 = new Vector3(0, 0, -1).applyMatrix4(this.world);
		return p1.sub(p0).normalize();
	}

	// u, v in [0, 1], origin: bottom left — matches Potree Camera.mouseToDirection
	mouseToDirection(u, v) {
		let fovRad = toRadians(this.fov);
		let top = Math.tan(fovRad / 2);
		let height = 2 * top;
		let width = this.aspect * height;

		let origin = new Vector3(0, 0, 0).applyMatrix4(this.world);
		let dir = new Vector3(
			0.5 * (2.0 * u - 1.0) * width,
			0.5 * (2.0 * v - 1.0) * height,
			-1,
		).applyMatrix4(this.world);

		return dir.sub(origin).normalize();
	}
}
