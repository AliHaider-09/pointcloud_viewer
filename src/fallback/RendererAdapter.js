
/**
 * Minimal renderer adapter that satisfies what PointCloudOctree needs
 * from the renderer object (getSize, disposeGpuBuffer, cpuGpuBuffers).
 *
 * The WebGL fallback manages Three.js geometry lifecycle separately,
 * so GPU buffer disposal here is a no-op.
 */
export class RendererAdapter {

	constructor(canvas) {
		this.canvas = canvas;
		this.cpuGpuBuffers = new Map();
	}

	getSize() {
		return {
			width: this.canvas.width,
			height: this.canvas.height,
		};
	}

	disposeGpuBuffer(cpuBuffer) {
		// No-op — Three.js geometry disposal handled by WebGLFallbackViewer
		this.cpuGpuBuffers.delete(cpuBuffer);
	}
}
