`markdown

# pointcloud_viewer

Standalone, embeddable 3D point cloud viewer built on Potree 2.x. Drop it in an iframe — no auth, no backend, no build step required.

**WebGPU** on supported browsers, **WebGL** fallback everywhere else. Zero external runtime dependencies.

---

## Install

bash
npm install pointcloud_viewer

## Embed

html

<iframe
 src="/node_modules/pointcloud_viewer/index.html?url=https://cdn.example.com/
scan/metadata.json"
 width="100%"
 height="600"
 allow="fullscreen"
│ </iframe>

---

## URL Parameters

| Parameter        | Description                                    | Default            |
| ---------------- | ---------------------------------------------- | ------------------ |
| `url`            | Path to `metadata.json` **(required)**         | —                  |
| `name`           | Display name shown in the viewer               | `"Point Cloud"`    |
| `projectId`      | Project UUID — enables measurement persistence | —                  |
| `apiBase`        | API base URL for measurement CRUD              | `""` (same-origin) |
| `authToken`      | Bearer token for cross-origin API calls        | —                  |
| `parentOrigin`   | Locks postMessage to a specific origin         | `"*"`              |
| `showBackButton` | Show back navigation button (`1` to enable)    | `0`                |
| `embedded`       | Deprecated alias for `showBackButton`          | —                  |
| `fallback`       | Force WebGL renderer (`1` to force)            | `0`                |

---

## Events (viewer → parent)

Listen for messages from the viewer in the parent page:

js
window.addEventListener("message", (e) => {
if (e.source !== iframe.contentWindow) return;
switch (e.data?.type) {
case "potree-ready":
console.log(Renderer: ${e.data.renderer}); // "webgpu" | "webgl"
     break;
   case "potree-error":
     console.error(${e.data.code}: ${e.data.message});
break;
case "potree-measurement-change":
console.log(e.data.action, e.data.measurement); // "created" | "updated" |
"deleted"
break;
case "potree-navigate-back":
history.back();
break;
}
});

| Event                       | When                                  | Payload                             |
| --------------------------- | ------------------------------------- | ----------------------------------- |
| `potree-ready`              | First frame rendered                  | `{ renderer: "webgpu" \| "webgl" }` |
| `potree-error`              | Viewer fails to initialize            | `{ code, message }`                 |
| `potree-measurement-change` | Measurement saved / renamed / deleted | `{ action, measurement }`           |
| `potree-navigate-back`      | Back button clicked                   | —                                   |

## Messages (parent → viewer)

js
// Refresh auth token at runtime
iframe.contentWindow.postMessage(
{ type: "potree-set-auth-token", token: "new-token" },
"https://yourapp.com"
);

---

## Theming

Override any of the 15 CSS variables to rebrand the viewer:

css
/\* Full dark theme example /
:root {
--potree-accent-color: #10b981;
--potree-sidebar-bg: rgba(15, 23, 42, 0.88);
--potree-text-color: #f1f5f9;
--potree-font-family: 'Inter', system-ui, sans-serif;
}

| Variable                      | Purpose                      | Default                            |
| ----------------------------- | ---------------------------- | ---------------------------------- |
| `--potree-accent-color`       | Primary brand color          | `#3B82F6`                          |
| `--potree-sidebar-bg`         | Sidebar + toolbar background | `rgba(255,255,255,0.85)`           |
| `--potree-sidebar-blur`       | Backdrop blur strength       | `16px`                             |
| `--potree-text-color`         | All sidebar/toolbar text     | `#000`                             |
| `--potree-font-family`        | Viewer font                  | `'Poppins', system-ui, sans-serif` |
| `--potree-surface`            | Dropdown background          | `#fff`                             |
| `--potree-input-bg`           | Input / select background    | `#f8fafc`                          |
| `--potree-button-bg`          | Default button background    | `#f1f5f9`                          |
| `--potree-border-color`       | Subtle dividers              | `rgba(0,0,0,0.1)`                  |
| `--potree-border-strong`      | Input / button borders       | `#e2e8f0`                          |
| `--potree-accent-hover-bg`    | Button hover background      | `#e0e7ff`                          |
| `--potree-accent-tint-soft`   | Row hover tint               | `rgba(59,130,246,0.06)`            |
| `--potree-accent-tint-medium` | Focus box-shadow             | `rgba(59,130,246,0.15)`            |
| `--potree-accent-tint-strong` | Range slider fill            | `rgba(59,130,246,0.4)`             |
| `--potree-row-divider`        | Table row underlines         | `rgba(0,0,0,0.06)`                 |

---

## Browser Support

| Renderer       | Browsers                         |
| -------------- | -------------------------------- |
| WebGPU         | Chrome / Edge ≥ 113, Safari ≥ 18 |
| WebGL fallback | All modern browsers              |

---

## What's Included

- Potree 2.x renderer (WebGPU + WebGL)
- Viewing tools — RGB, Intensity, Elevation, point size, FPV / Orbit
- Measurement system — distance, area, point, vertex editing
- Clip view — volume box, face selection, ortho 2D, interactive gizmo
- Magnifier cursor, dynamic point budget
- All dependencies bundled locally (Three.js, es-module-shims, gl-matrix, proj4, brotli, laz-perf, tween, Poppins)
- GDPR-compliant — no external font or CDN requests
- Fully offline-capable

## What's NOT Included

- Authentication / login
- File upload
- Project dashboard
- Cloud storage integration

---

## Measurement Persistence

To persist measurements to your own backend, pass `apiBase`, `projectId`, and `authToken`:

html

<iframe src="/nodemodules/pointcloud_viewer/index.html
 ?url=https://cdn.example.com/scan/metadata.json
 &apiBase=https://api.example.com
 &projectId=abc-123
 &authToken=eyJhbG...
 &parentOrigin=https://yourapp.com">
</iframe>

Expected endpoints:

GET {apiBase}/api/projects/{projectId}/measurements
POST {apiBase}/api/projects/{projectId}/measurements
PATCH {apiBase}/api/projects/{projectId}/measurements/{id}
DELETE {apiBase}/api/projects/{projectId}/measurements/{id}

Without `projectId`, measurements work locally in memory with no API calls.

---

## License

MIT © Ali Haider, Saad

Built on [Potree](https://github.com/potree/potree) · [Three.js](https://threejs.org) · [laz-perf](https://github.com/connormanning/laz-perf)

---
