# pointcloud_viewer

Standalone, embeddable 3D point cloud viewer built on Potree 2.x. Drop it in an iframe — no auth, no backend, no build step required.

**WebGPU** on supported browsers (Chrome/Edge ≥ 113), **WebGL** fallback everywhere else. Zero external runtime dependencies — all libraries bundled locally.

---

## Install

```bash
npm install @alihaider_719/pointcloud-viewer
```

---

## Important — Must Be Served via HTTP

The viewer uses ES modules and `importmap`, which **do not work when opened as a local file** (`file://`). You must serve the package through an HTTP server.

### Quick local test (no install needed)

```bash
# Using npx serve
npx serve node_modules/@alihaider_719/pointcloud-viewer

# Using Python
python -m http.server 3001 --directory node_modules/@alihaider_719/pointcloud-viewer

# Using Node.js http-server
npx http-server node_modules/@alihaider_719/pointcloud-viewer -p 3001
```

Then open in Chrome or Edge:

```
http://localhost:3001/demo.html
```

Or load any point cloud directly:

```
http://localhost:3001/index.html?url=https://your-cdn.com/scan/metadata.json
```

---

## Embed in a Web App

### Vanilla HTML

```html
<iframe
  src="/node_modules/@alihaider_719/pointcloud-viewer/index.html?url=https://your-cdn.com/scan/metadata.json"
  width="100%"
  height="600"
  allow="fullscreen"
></iframe>
```

> The viewer folder must be reachable at the path you reference. If your app serves `node_modules/` statically, the path above works as-is. Otherwise copy the package to your `public/` or `static/` folder.

### React

```jsx
export function PointCloudViewer({ url }) {
  return (
    <iframe
      src={`/pointcloud-viewer/index.html?url=${encodeURIComponent(url)}`}
      style={{ width: '100%', height: '600px', border: 'none' }}
      allow="fullscreen"
      title="Point Cloud Viewer"
    />
  );
}
```

Copy the package into `public/pointcloud-viewer/` so Next.js / Vite serves it statically.

### Vue

```html
<template>
  <iframe
    :src="`/pointcloud-viewer/index.html?url=${encodeURIComponent(url)}`"
    style="width:100%;height:600px;border:none"
    allow="fullscreen"
    title="Point Cloud Viewer"
  />
</template>
```

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
| `fallback`       | Force WebGL renderer (`1` to force)            | `0`                |

---

## Events (viewer → parent)

```js
window.addEventListener('message', (e) => {
  if (e.source !== iframe.contentWindow) return;
  switch (e.data?.type) {
    case 'potree-ready':
      console.log('Renderer:', e.data.renderer); // "webgpu" | "webgl"
      break;
    case 'potree-error':
      console.error(e.data.code, e.data.message);
      break;
    case 'potree-measurement-change':
      console.log(e.data.action, e.data.measurement);
      break;
    case 'potree-navigate-back':
      history.back();
      break;
  }
});
```

| Event                       | When                                  | Payload                             |
| --------------------------- | ------------------------------------- | ----------------------------------- |
| `potree-ready`              | First frame rendered                  | `{ renderer: "webgpu" \| "webgl" }` |
| `potree-error`              | Viewer fails to initialize            | `{ code, message }`                 |
| `potree-measurement-change` | Measurement saved / renamed / deleted | `{ action, measurement }`           |
| `potree-navigate-back`      | Back button clicked                   | —                                   |

## Messages (parent → viewer)

```js
// Refresh auth token at runtime
iframe.contentWindow.postMessage(
  { type: 'potree-set-auth-token', token: 'new-token' },
  'https://yourapp.com'
);
```

---

## Measurement Persistence

To persist measurements to your own backend, pass `apiBase`, `projectId`, and `authToken`:

```html
<iframe src="/pointcloud-viewer/index.html
  ?url=https://cdn.example.com/scan/metadata.json
  &apiBase=https://api.example.com
  &projectId=abc-123
  &authToken=eyJhbG...
  &parentOrigin=https://yourapp.com">
</iframe>
```

Expected endpoints:

```
GET    {apiBase}/api/projects/{projectId}/measurements
POST   {apiBase}/api/projects/{projectId}/measurements
PATCH  {apiBase}/api/projects/{projectId}/measurements/{id}
DELETE {apiBase}/api/projects/{projectId}/measurements/{id}
```

Without `projectId`, measurements work in memory with no API calls.

---

## Theming

Override any of the 15 CSS variables to rebrand the viewer:

```css
/* Full dark theme example */
:root {
  --potree-accent-color: #10b981;
  --potree-sidebar-bg: rgba(15, 23, 42, 0.88);
  --potree-text-color: #f1f5f9;
  --potree-font-family: 'Inter', system-ui, sans-serif;
}
```

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

| Renderer       | Browsers                              |
| -------------- | ------------------------------------- |
| WebGPU         | Chrome / Edge ≥ 113, Safari ≥ 18      |
| WebGL fallback | All other modern browsers (Firefox, etc.) |

---

## What's Included

- Potree 2.x renderer (WebGPU + WebGL)
- Viewing tools — RGB, Intensity, Elevation, point size, FPV / Orbit
- Measurement system — distance, area, point, vertex editing
- Clip view — volume box, face selection, ortho 2D, interactive gizmo
- Magnifier cursor, dynamic point budget, height profile tool
- All dependencies bundled locally (Three.js, es-module-shims, gl-matrix, proj4, brotli, laz-perf, tween, Poppins)
- GDPR-compliant — no external font or CDN requests at runtime
- Fully offline-capable once served

## What's NOT Included

- Authentication / login
- File upload
- Project dashboard
- Cloud storage integration

---

## License

MIT © Ali Haider, Saad

Built on [Potree](https://github.com/potree/potree) · [Three.js](https://threejs.org) · [laz-perf](https://github.com/connormanning/laz-perf)
