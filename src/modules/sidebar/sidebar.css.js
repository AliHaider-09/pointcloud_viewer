
export const css = `

#potree_sidebar {
	background: #1a1a2e;
	color: #ffffff;
	font-family: 'Segoe UI', Calibri, sans-serif;
	font-size: 14px;
	overflow-y: auto;
	overflow-x: hidden;
	height: 100dvh;
	height: 100vh;
	box-sizing: border-box;
	padding: 16px;
	width: 100%;
	display: flex;
	flex-direction: column;
}

#potree_sidebar > * {
	flex-shrink: 0;
}

.sidebar-title-bar {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-bottom: 12px;
}

.sidebar-title {
	font-size: 18px;
	font-weight: bold;
	color: #ffffff;
}

.sidebar-close-btn {
	background: none;
	border: none;
	color: #888;
	font-size: 20px;
	cursor: pointer;
	padding: 0 4px;
	line-height: 1;
}
.sidebar-close-btn:hover {
	color: #fff;
}

.sidebar-gpu-badge {
	background: #2a7a5a;
	color: #fff;
	border-radius: 20px;
	padding: 6px 14px;
	font-size: 12px;
	text-align: center;
	margin-bottom: 16px;
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	align-self: stretch;
}

.sidebar-section-label {
	font-size: 11px;
	font-weight: 600;
	color: #888;
	text-transform: uppercase;
	letter-spacing: 1px;
	margin-top: 16px;
	margin-bottom: 6px;
}

.sidebar-select {
	width: 100%;
	padding: 8px 10px;
	background: #2a2a3e;
	color: #fff;
	border: 1px solid #3a3a5e;
	border-radius: 6px;
	font-size: 13px;
	cursor: pointer;
	appearance: auto;
}

.sidebar-stats {
	margin: 12px 0;
	font-size: 13px;
	line-height: 1.8;
}

.sidebar-stats .stat-label {
	color: #aaa;
}

.sidebar-stats .stat-value {
	color: #fff;
	font-weight: bold;
}

.sidebar-slider-container {
	margin-bottom: 4px;
}

.sidebar-slider {
	width: 100%;
	height: 6px;
	-webkit-appearance: none;
	appearance: none;
	background: #3a3a5e;
	border-radius: 3px;
	outline: none;
	cursor: pointer;
}

.sidebar-slider::-webkit-slider-thumb {
	-webkit-appearance: none;
	appearance: none;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: #4a90d9;
	cursor: pointer;
}

.sidebar-slider-value {
	font-size: 13px;
	color: #ccc;
	margin-top: 4px;
}

.sidebar-checkbox-row {
	display: flex;
	align-items: center;
	gap: 8px;
	margin-top: 4px;
}

.sidebar-checkbox-row input[type="checkbox"] {
	width: 16px;
	height: 16px;
	accent-color: #4a90d9;
	cursor: pointer;
}

.sidebar-checkbox-row label {
	font-size: 13px;
	color: #ccc;
	cursor: pointer;
}

.sidebar-tools {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
	margin-top: 6px;
}

.sidebar-tool-btn {
	background: #2a2a3e;
	color: #ccc;
	border: 1px solid #3a3a5e;
	border-radius: 6px;
	padding: 8px 14px;
	font-size: 13px;
	cursor: pointer;
	transition: background 0.15s;
}

.sidebar-tool-btn:hover {
	background: #3a3a5e;
	color: #fff;
}

`;
