/**
 * Potree Global Loader
 *
 * Imports Potree modules and exposes them on window.
 * Does NOT call Potree.init() — that must be done by the viewer component
 * after the canvas element exists in the DOM.
 */

import { Potree, PotreeLoader, SplatType, Vector3 } from "potree";
import { installSidebar } from "sidebar";
import "range-select";

window.Potree = Potree;
window.PotreeLoader = PotreeLoader;
window.SplatType = SplatType;
window.PotreeVector3 = Vector3;
window.installPotreeSidebar = installSidebar;

window.__potreeReady = true;
window.dispatchEvent(new Event("potree-ready"));

console.log("[Potree] Global loader complete — Potree is available on window");
