# Changelog

All notable changes to this project will be documented in this file.
Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [1.0.0] - 2026-04-22

### Added

- Potree 2.x renderer with WebGPU + WebGL fallback
- Viewing tools: RGB, Intensity, Elevation, point size, FPV/Orbit
- Measurement system: distance, area, point, vertex editing
- Clip view: volume box, face selection, ortho 2D, interactive gizmo
- Configurable measurement API (same-origin, Bearer token, or local-only)
- Auth token support via URL param + runtime postMessage refresh
- Lifecycle events: `potree-ready`, `potree-error`, `potree-measurement-change`, `potree-navigate-back`
- postMessage origin locking via `parentOrigin` param
- `showBackButton` param with `embedded` backward-compat alias
- 15 CSS custom properties for full viewer theming
- All dependencies bundled locally — zero external runtime requests
- GDPR-compliant: no Google Fonts or CDN calls
- Fully offline-capable
