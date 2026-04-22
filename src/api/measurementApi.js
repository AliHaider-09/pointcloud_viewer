/**
 * Centralized measurement API for the Potree viewer.
 *
 * Replaces scattered inline fetch() calls in potree-viewer.html.
 * Configured once at viewer init via configure(). If no apiBase is
 * provided, all calls are no-ops (local-only / no persistence mode).
 */

let _apiBase = "";
let _projectId = null;
let _authToken = null;
let _onChange = null;

/**
 * Configure the measurement API.
 * @param {{ apiBase?: string, projectId?: string, authToken?: string }} opts
 *   - apiBase:   base URL for API calls (e.g. "" for same-origin, or "https://api.example.com")
 *   - projectId: current project UUID
 *   - authToken: optional Bearer token (if not using cookie auth)
 */
export function configure({ apiBase, projectId, authToken } = {}) {
  _apiBase = apiBase ?? "";
  _projectId = projectId ?? null;
  _authToken = authToken ?? null;
}

/** Update auth token at runtime (e.g. via postMessage refresh). */
export function setAuthToken(token) {
  _authToken = token;
}

/**
 * Register a listener for measurement CRUD lifecycle events.
 * Fired after every successful save / update / delete with
 * { action: "created"|"updated"|"deleted", measurement }.
 * Only one listener is kept — call with null to unregister.
 */
export function onChange(callback) {
  _onChange = typeof callback === "function" ? callback : null;
}

function _emit(action, measurement) {
  if (_onChange) {
    try { _onChange({ action, measurement }); } catch (_) { /* swallow listener errors */ }
  }
}

// ─── Internal helpers ────────────────────────────────────────────────

function measurementUrl(measurementId) {
  const base = `${_apiBase}/api/projects/${_projectId}/measurements`;
  return measurementId ? `${base}/${measurementId}` : base;
}

function headers() {
  const h = { "Content-Type": "application/json" };
  if (_authToken) {
    h["Authorization"] = `Bearer ${_authToken}`;
  }
  return h;
}

// ─── CRUD ────────────────────────────────────────────────────────────

/**
 * Save a new measurement.
 * @returns {Promise<object|null>} The created measurement object, or null if no projectId.
 */
export async function saveMeasurement(payload) {
  if (!_projectId) return null;
  const res = await fetch(measurementUrl(), {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Save failed: ${res.status}`);
  const measurement = (await res.json()).measurement;
  _emit("created", measurement);
  return measurement;
}

/**
 * Delete a measurement by its DB id.
 */
export async function deleteMeasurement(dbId) {
  if (!_projectId || !dbId) return;
  await fetch(measurementUrl(dbId), {
    method: "DELETE",
    headers: _authToken ? { Authorization: `Bearer ${_authToken}` } : undefined,
  });
  _emit("deleted", { dbId });
}

/**
 * Update a measurement's label.
 * @returns {Promise<object>}
 */
export async function updateMeasurementLabel(dbId, newLabel) {
  if (!_projectId || !dbId) return;
  const res = await fetch(measurementUrl(dbId), {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ label: newLabel }),
  });
  if (!res.ok) throw new Error(`Update failed: ${res.status}`);
  const result = await res.json();
  _emit("updated", { dbId, label: newLabel, ...(result.measurement || {}) });
  return result;
}

/**
 * Load all saved measurements for the current project.
 * @returns {Promise<{ measurements: object[] }>}
 */
export async function loadMeasurements() {
  if (!_projectId) return { measurements: [] };
  const res = await fetch(measurementUrl(), {
    headers: _authToken ? { Authorization: `Bearer ${_authToken}` } : undefined,
  });
  if (!res.ok) {
    console.error("[MeasurementAPI] Failed to load measurements:", res.status);
    return { measurements: [] };
  }
  return await res.json();
}
