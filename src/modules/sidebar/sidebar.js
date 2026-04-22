
import {Potree, nodesLoading, FirstPersonControls} from "potree";
import {GRAYSCALE, SPECTRAL} from "../../misc/Gradients.js";

let sidebarWidth = "320px";

function formatNumber(val) {
	if (val >= 1_000_000_000) return (val / 1_000_000_000).toFixed(1) + "B";
	if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
	if (val >= 1_000) return (val / 1_000).toFixed(1) + "K";
	return val.toString();
}

function formatBudget(val) {
	if (val >= 1_000_000_000) return (val / 1_000_000_000).toFixed(1) + "B";
	if (val >= 1_000_000) return (val / 1_000_000).toFixed(1) + "M";
	if (val >= 1_000) return (val / 1_000).toFixed(0) + "K";
	return val.toString();
}

export async function installSidebar(elPotree, potree) {

	let {css} = await import("./sidebar.css.js");

	let style = document.createElement('style');
	style.innerHTML = css;
	document.getElementsByTagName('head')[0].appendChild(style);

	// Determine rendering mode and GPU name
	let isWebGPU = Potree.isWebGPU !== false;
	let gpuName = "Unknown GPU";
	let gpuBadgeLabel, gpuBadgeColor;

	// Get real GPU name via WebGL debug info
	try {
		let canvas = document.createElement("canvas");
		let gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
		let ext = gl?.getExtension("WEBGL_debug_renderer_info");
		if (ext) {
			let raw = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
			// Parse "ANGLE (NVIDIA, NVIDIA Quadro M2000M (0x000013B0) Direct3D11 ..., D3D11)"
			let match = raw.match(/ANGLE \([^,]+,\s*(.+?)(?:Direct3D|OpenGL|Vulkan)/);
			gpuName = match ? match[1].replace(/\(0x[0-9A-Fa-f]+\)/g, "").trim() : raw;
		}
	} catch (e) {}

	if (isWebGPU) {
		gpuBadgeLabel = `WebGPU | ${gpuName}`;
		gpuBadgeColor = "#3B82F6";
	} else {
		gpuBadgeLabel = "WebGL (Fallback)";
		gpuBadgeColor = "#7a5a2a";
	}

	let elSidebar = document.createElement("div");
	elSidebar.id = "potree_sidebar";

	// White glass theme matching measurement panel
	elSidebar.style.cssText = `
		background: rgba(255,255,255,0.88); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
		color: #000; font-family: 'Poppins', 'Segoe UI', system-ui, sans-serif;
		font-size: 14px; overflow-y: auto; overflow-x: hidden; height: 100dvh; height: 100vh;
		box-sizing: border-box; padding: 16px;
		border-right: 1px solid rgba(0,0,0,0.1); box-shadow: 4px 0 16px rgba(0,0,0,0.06);
	`;

	let sLabel = `font-size:11px; font-weight:800; color:#000; text-transform:uppercase; letter-spacing:1px; margin-top:16px; margin-bottom:6px;`;
	let sSelect = `width:100%; padding:8px 10px; background:#f8fafc; color:#000; border:1px solid #e2e8f0; border-radius:6px; font-size:13px; font-family:'Poppins','Segoe UI',system-ui,sans-serif;`;
	let sSlider = `width:100%; height:6px; -webkit-appearance:none; appearance:none; background:#e2e8f0; border-radius:3px; outline:none; cursor:pointer; accent-color:#3B82F6;`;
	let sBtn = `background:#f1f5f9; color:#000; border:1px solid #e2e8f0; border-radius:6px; padding:8px 14px; font-size:13px; font-weight:700; cursor:pointer; font-family:'Poppins','Segoe UI',system-ui,sans-serif;`;

	elSidebar.innerHTML = `
		<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
			<span style="font-size:18px; font-weight:bold; color:#000;">Point Cloud Viewer</span>
			<button id="sidebar_close" style="background:none; border:none; color:#000; font-size:18px; cursor:pointer;" title="Collapse panel">&#9664;</button>
		</div>

		<div style="background:${gpuBadgeColor}; color:#fff; border-radius:20px; padding:6px 14px; font-size:12px; text-align:center; margin-bottom:16px;">${gpuBadgeLabel}</div>

		<div style="${sLabel}">DATASET</div>
		<select id="sidebar_dataset" style="${sSelect}">
			${(Potree.datasets || []).map((ds, i) =>
				`<option value="${i}">${ds.name}</option>`
			).join("")}
		</select>

		<div id="sidebar_stats" style="margin:12px 0; font-size:13px; line-height:1.8;">
			<span style="color:#555;">Visible points: </span><span id="stat_visible" style="color:#000; font-weight:bold;">0</span><br>
			<span style="color:#555;">FPS: </span><span id="stat_fps" style="color:#000; font-weight:bold;">0</span>
			&nbsp;&nbsp;&nbsp;
			<span style="color:#555;">Budget: </span><span id="stat_budget" style="color:#000; font-weight:bold;">0</span><br>
			<span style="color:#555;">GPU Memory: </span><span id="stat_gpu_mem" style="color:#000; font-weight:bold;">0 MB</span><br>
			<span style="color:#555;">Loading: </span><span id="stat_loading" style="color:#000; font-weight:bold;">0</span>
			<span style="color:#555;"> / Queued: </span><span id="stat_queued" style="color:#000; font-weight:bold;">0</span>
		</div>

		<div style="${sLabel}">POINT SIZE</div>
		<div>
			<input type="range" id="sld_point_size" min="1" max="50" step="1" value="${Potree.settings.pointSize}" style="${sSlider}">
			<div id="lbl_point_size" style="font-size:13px; color:#000; font-weight:700; margin-top:4px;">${Potree.settings.pointSize}</div>
		</div>

		<div style="${sLabel}">POINT BUDGET</div>
		<div>
			<input type="range" id="sld_point_budget" min="400" max="1000" step="1" value="${Math.round(Math.log10(Potree.settings.pointBudget) * 100)}" style="${sSlider}">
			<div id="lbl_point_budget" style="font-size:13px; color:#000; font-weight:700; margin-top:4px;">${formatBudget(Potree.settings.pointBudget)}</div>
		</div>

		<div style="${sLabel}">COLOR MODE</div>
		<select id="sidebar_color_mode" style="${sSelect}">
			<option value="rgba">RGB</option>
			${isWebGPU ? `
			<option value="intensity">Intensity</option>
			<option value="elevation">Elevation</option>
			<!-- <option value="classification">Classification</option> -->
			<!-- <option value="return number">Return Number</option> -->
			<!-- <option value="number of returns">Number of Returns</option> -->
			` : `
			<option value="rgba" disabled>Other modes unavailable in WebGL</option>
			`}
		</select>

		<div style="${sLabel}">TOOLS</div>
		<div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:6px;">
			<button id="btn_fit" style="${sBtn}">Fit to Screen</button>
			<button id="btn_fpv" style="${sBtn}">First Person View</button>
			<button id="btn_bbox" style="${sBtn}">Show Bounding Boxes</button>
		</div>
	`;

	// Collapsed toggle tab (visible when sidebar is hidden)
	let elToggleTab = document.createElement("div");
	elToggleTab.id = "sidebar_toggle_tab";
	elToggleTab.innerHTML = "&#9654;";
	let toggleTop = window.matchMedia("(max-width: 768px)").matches ? "60px" : "12px";
	elToggleTab.style.cssText = `
		position: absolute; top: ${toggleTop}; left: 0; z-index: 1000;
		background: rgba(255,255,255,0.88); color: #000; border: 1px solid #e2e8f0;
		border-left: none; border-radius: 0 6px 6px 0;
		width: 36px; height: 44px; display: none;
		align-items: center; justify-content: center;
		cursor: pointer; font-size: 16px;
		backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
		box-shadow: 4px 0 12px rgba(0,0,0,0.06);
	`;

	let isMobile = window.matchMedia("(max-width: 768px)").matches;

	elPotree.style.display = "grid";
	elPotree.style.position = "relative";

	if(isMobile){
		// Mobile: sidebar overlays on top of canvas
		elPotree.style.gridTemplateColumns = "1fr";
		elSidebar.style.position = "absolute";
		elSidebar.style.top = "0";
		elSidebar.style.left = "0";
		elSidebar.style.width = "280px";
		elSidebar.style.height = "100%";
		elSidebar.style.zIndex = "999";
		elSidebar.style.boxShadow = "2px 0 12px rgba(0,0,0,0.1)";
	}else{
		elPotree.style.gridTemplateColumns = `${sidebarWidth} 1fr`;
	}

	elPotree.prepend(elSidebar);
	elPotree.appendChild(elToggleTab);

	// Set initial dropdown values
	elSidebar.querySelector("#sidebar_color_mode").value = Potree.settings.attribute;

	// --- Event handlers ---

	let isOpen = true;

	function collapseSidebar() {
		isOpen = false;
		elSidebar.style.display = "none";
		if(!isMobile){
			elPotree.style.gridTemplateColumns = "1fr";
		}
		elToggleTab.style.display = "flex";
	}

	function expandSidebar() {
		isOpen = true;
		elSidebar.style.display = "";
		if(!isMobile){
			elPotree.style.gridTemplateColumns = `${sidebarWidth} 1fr`;
		}
		elToggleTab.style.display = "none";
	}

	elSidebar.querySelector("#sidebar_close").addEventListener("click", collapseSidebar);
	elToggleTab.addEventListener("click", expandSidebar);

	// Close sidebar when tapping outside on mobile
	if(isMobile){
		document.addEventListener("click", (e) => {
			if(isOpen && !elSidebar.contains(e.target) && e.target !== elToggleTab){
				collapseSidebar();
			}
		});
		document.addEventListener("touchstart", (e) => {
			if(isOpen && !elSidebar.contains(e.target) && e.target !== elToggleTab){
				collapseSidebar();
			}
		});
	}

	// Point size slider
	let sldPointSize = elSidebar.querySelector("#sld_point_size");
	let lblPointSize = elSidebar.querySelector("#lbl_point_size");
	sldPointSize.addEventListener("input", () => {
		let val = parseInt(sldPointSize.value);
		Potree.settings.pointSize = val;
		lblPointSize.textContent = val;
	});

	// Point budget slider (log scale)
	let sldBudget = elSidebar.querySelector("#sld_point_budget");
	let lblBudget = elSidebar.querySelector("#lbl_point_budget");
	sldBudget.addEventListener("input", () => {
		let logVal = Number(sldBudget.value) / 100;
		let budget = Math.round(Math.pow(10, logVal));
		Potree.settings.pointBudget = budget;
		lblBudget.textContent = formatBudget(budget);
	});

	// Color mode
	elSidebar.querySelector("#sidebar_color_mode").addEventListener("change", (e) => {
		Potree.settings.attribute = e.target.value;
		if (e.target.value === "intensity") {
			Potree.settings.gradient = GRAYSCALE;
		} else if (Potree.settings.gradient === GRAYSCALE) {
			Potree.settings.gradient = SPECTRAL;
		}
	});

	// Fit to screen
	elSidebar.querySelector("#btn_fit").addEventListener("click", () => {
		let octrees = potree.scene.root.children.filter(c => c.constructor.name === "PointCloudOctree");
		if (octrees.length > 0) {
			potree.controls.zoomTo(octrees[0]);
		}
	});

	// First Person View toggle
	let btnFpv = elSidebar.querySelector("#btn_fpv");
	let fpvOrbitRef = null;

	function updateFpvButton(){
		if(potree.controls instanceof FirstPersonControls){
			btnFpv.textContent = "Orbit View";
			btnFpv.style.background = "#3B82F6"; btnFpv.style.color = "#fff";
		}else{
			btnFpv.textContent = "First Person View";
			btnFpv.style.background = "#f1f5f9"; btnFpv.style.color = "#000";
		}
	}

	btnFpv.addEventListener("click", () => {
		if(potree.controls instanceof FirstPersonControls){
			if(fpvOrbitRef){
				potree.setControls(fpvOrbitRef);
			}
		}else{
			fpvOrbitRef = potree.controls;
			let fpv = potree._firstPersonControls;
			fpv.setFromOrbitControls(potree.controls);
			potree.setControls(fpv);
		}
		updateFpvButton();
	});

	// Bounding box toggle
	let btnBbox = elSidebar.querySelector("#btn_bbox");
	function updateBboxButton(){
		if(Potree.settings.showBoundingBox){
			btnBbox.textContent = "Hide Bounding Boxes";
			btnBbox.style.background = "#3B82F6"; btnBbox.style.color = "#fff";
		}else{
			btnBbox.textContent = "Show Bounding Boxes";
			btnBbox.style.background = "#f1f5f9"; btnBbox.style.color = "#000";
		}
	}
	updateBboxButton();
	btnBbox.addEventListener("click", () => {
		Potree.settings.showBoundingBox = !Potree.settings.showBoundingBox;
		updateBboxButton();
	});

	// Sync button and orbitRef when controls change via F-key or other means
	let origSetControls = potree.setControls;
	potree.setControls = (newControls) => {
		// Track the orbit controls so the button can restore them
		if(newControls instanceof FirstPersonControls && !(potree.controls instanceof FirstPersonControls)){
			fpvOrbitRef = potree.controls;
		}
		origSetControls(newControls);
		updateFpvButton();
	};

	// --- Live stats update ---
	let statVisible = elSidebar.querySelector("#stat_visible");
	let statFps = elSidebar.querySelector("#stat_fps");
	let statBudgetEl = elSidebar.querySelector("#stat_budget");
	let statGpuMem = elSidebar.querySelector("#stat_gpu_mem");
	let statLoading = elSidebar.querySelector("#stat_loading");
	let statQueued = elSidebar.querySelector("#stat_queued");

	function updateStats() {
		statVisible.textContent = formatNumber(Potree.state.numVisiblePoints);
		statFps.textContent = Potree.state.fps;
		statBudgetEl.textContent = formatBudget(Potree.settings.pointBudget);
		statGpuMem.textContent = Potree.state.gpuMemoryMB + " MB";
		statLoading.textContent = nodesLoading;
		let totalQueued = 0;
		let octrees = potree.scene.root.children.filter(c => c.constructor.name === "PointCloudOctree");
		for (let oc of octrees) totalQueued += oc.nodesQueued || 0;
		statQueued.textContent = totalQueued;

		requestAnimationFrame(updateStats);
	}
	updateStats();

	// Dataset switching
	elSidebar.querySelector("#sidebar_dataset").addEventListener("change", (e) => {
		let index = parseInt(e.target.value);
		if (Potree.loadDataset) {
			Potree.loadDataset(index);
		}
	});

	let sidebar = {
		elContainer: elPotree,
		potree,
		sections: [],
		elSidebar,
		toggle: () => {
			if (isOpen) {
				collapseSidebar();
			} else {
				expandSidebar();
			}
		},
	};

	return sidebar;
}
