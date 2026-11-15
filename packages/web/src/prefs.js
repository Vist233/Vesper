// @ts-check
// What the page remembers between visits: the desk's width and whether the person collapsed it. Global, never per session,
// and never the take-over (that comes from the journal). Storage may be missing, full or refused: every read and write is
// guarded, and the page works without it.

import { clampDeskFrac } from "./layout.js";

const KEY = "vesper.desk";

/** @typedef {{ frac: number | null, collapsed: boolean }} DeskPrefs */

/** Reads stored text into preferences; anything unusable gives the defaults. Pure. */
export function parsePrefs(/** @type {unknown} */ raw, /** @type {number} */ viewportWidth) {
  /** @type {DeskPrefs} */
  const prefs = { frac: null, collapsed: false };
  if (typeof raw !== "string") return prefs;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === "object") {
      prefs.frac = clampDeskFrac(value.frac, viewportWidth);
      prefs.collapsed = value.collapsed === true;
    }
  } catch {
    // damaged storage: start again from the defaults
  }
  return prefs;
}

export function loadPrefs(/** @type {number} */ viewportWidth) {
  try {
    return parsePrefs(localStorage.getItem(KEY), viewportWidth);
  } catch {
    return parsePrefs(null, viewportWidth);
  }
}

export function savePrefs(/** @type {DeskPrefs} */ prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ frac: prefs.frac, collapsed: prefs.collapsed }));
  } catch {
    // private mode or full storage: the choice lasts until the page is closed
  }
}
