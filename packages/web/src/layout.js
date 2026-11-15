// @ts-check
// Where things go: the widths of the rail, the conversation and the docked desk for a window, as pure functions.
// One reason to change: the layout rules of docs/14 section 3.

/** @typedef {"closed" | "chip" | "docked" | "stage"} DeskState */
/** @typedef {{ placement: "split" | "stack" | "sheet", deskW: number, convW: number, railW: number, railDrawer: boolean }} DeskLayout */

export const RAIL_W = 260;
/** On a large screen (a 2K monitor) the contact list gets more room. */
export const RAIL_W_WIDE = 320;
const WIDE_FROM = 1700;
const railWidth = (/** @type {number} */ vw) => (vw >= WIDE_FROM ? RAIL_W_WIDE : RAIL_W);
export const DIVIDER_W = 9;
/** Width of the conversation column while the person has control: the stage takes the rest. */
export const STAGE_CONV_W = 360;
const SHEET_BELOW = 600;
const STACK_BELOW = 920;
const NARROW_BELOW = 1280;
const MIN_DESK = 480;

/** The ranges of docs/14: the desk 480 to 760 (580 on a narrower window), the conversation at least 420 (440 narrower). */
function limits(/** @type {number} */ viewportWidth) {
  const narrow = viewportWidth < NARROW_BELOW;
  return { minDesk: MIN_DESK, maxDesk: narrow ? 580 : 760, minConv: narrow ? 440 : 420 };
}

/** The width the desk gets when the person never dragged the divider: 600 on a wide window, 544 on a narrow one. */
export function defaultDeskW(/** @type {number} */ viewportWidth) {
  return viewportWidth < NARROW_BELOW ? 544 : Math.min(760, Math.max(600, Math.round(viewportWidth * (600 / 1440))));
}

/**
 * Keeps a remembered fraction (desk width over window width) inside what the window allows; anything that is not a number
 * is "not set" and becomes null, so the default for the window applies.
 * @param {unknown} frac
 * @param {number} viewportWidth
 * @returns {number | null}
 */
export function clampDeskFrac(frac, viewportWidth) {
  if (typeof frac !== "number" || !Number.isFinite(frac) || viewportWidth <= 0) return null;
  const { minDesk, maxDesk } = limits(viewportWidth);
  return Math.min(maxDesk / viewportWidth, Math.max(minDesk / viewportWidth, frac));
}

/** The fraction to remember for a desk of `deskW` pixels. */
export function fracOf(/** @type {number} */ deskW, /** @type {number} */ viewportWidth) {
  return clampDeskFrac(deskW / viewportWidth, viewportWidth);
}

/**
 * The columns for this window.
 * - 600 px and wider than 920: a split (rail | conversation | divider | desk). On a window narrower than 1280 the rail
 *   becomes a drawer while a desk is docked, so the conversation keeps its room.
 * - 600 to 920: no split; the desk is a band on top, full width.
 * - below 600: the desk is a full-screen sheet.
 * - `stage` (the person has control): the rail hides, the conversation is a 360 px column and the stage takes the rest.
 * A desk that is `closed` or only a `chip` takes no room.
 * @param {number} viewportWidth
 * @param {boolean} railOpen
 * @param {DeskState} deskState
 * @param {number | null} frac
 * @returns {DeskLayout}
 */
export function deskLayout(viewportWidth, railOpen, deskState, frac) {
  const vw = Math.max(0, Math.round(viewportWidth));
  const placement = vw < SHEET_BELOW ? "sheet" : vw < STACK_BELOW ? "stack" : "split";
  const drawerWindow = vw < STACK_BELOW;
  const open = deskState === "docked" || deskState === "stage";
  if (!open) {
    const railW = railOpen && !drawerWindow ? railWidth(vw) : 0;
    return { placement, deskW: 0, convW: vw - railW, railW, railDrawer: drawerWindow };
  }
  if (placement !== "split") return { placement, deskW: vw, convW: vw, railW: 0, railDrawer: true };
  if (deskState === "stage") return { placement, deskW: vw - STAGE_CONV_W, convW: STAGE_CONV_W, railW: 0, railDrawer: true };
  const { minDesk, maxDesk, minConv } = limits(vw);
  const railDrawer = vw < NARROW_BELOW;
  const railW = railOpen && !railDrawer ? railWidth(vw) : 0;
  const safe = clampDeskFrac(frac, vw); // whatever was remembered, the layout never sees a number it cannot use
  const wanted = safe === null ? defaultDeskW(vw) : Math.round(safe * vw);
  const deskW = Math.max(minDesk, Math.min(wanted, maxDesk, vw - railW - minConv));
  return { placement, deskW, convW: vw - railW - deskW, railW, railDrawer };
}
