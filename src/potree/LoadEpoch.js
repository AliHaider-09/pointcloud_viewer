// Shared load epoch counter for stale request cancellation.
// Separated from Potree.js to avoid circular imports with loaders.
export let loadEpoch = 0;
export function incrementEpoch() { return ++loadEpoch; }
