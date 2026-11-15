import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { clampDeskFrac, defaultDeskW, deskLayout, fracOf, STAGE_CONV_W } from "../src/layout.js";

describe("deskLayout", () => {
  it("1440: rail 260, desk 600, conversation 580", () => {
    expect(deskLayout(1440, true, "docked", null)).toEqual({ placement: "split", deskW: 600, convW: 580, railW: 260, railDrawer: false });
  });
  it("1024: the rail becomes a drawer, desk 544, conversation 480", () => {
    expect(deskLayout(1024, true, "docked", null)).toEqual({ placement: "split", deskW: 544, convW: 480, railW: 0, railDrawer: true });
  });
  it("920: the narrowest split still gives the conversation 440", () => {
    const layout = deskLayout(920, true, "docked", null);
    expect(layout).toMatchObject({ placement: "split", deskW: 480, convW: 440 });
  });
  it("800: no split, the desk is a band on top, full width", () => {
    expect(deskLayout(800, true, "docked", null)).toEqual({ placement: "stack", deskW: 800, convW: 800, railW: 0, railDrawer: true });
  });
  it("599: a full-screen sheet", () => {
    expect(deskLayout(599, false, "docked", null)).toMatchObject({ placement: "sheet", deskW: 599, convW: 599 });
  });
  it("a closed desk or a chip takes no room; the rail keeps its 260 when there is room", () => {
    for (const state of ["closed", "chip"] as const) {
      expect(deskLayout(1440, true, state, null)).toMatchObject({ deskW: 0, convW: 1180, railW: 260 });
      expect(deskLayout(1440, false, state, null)).toMatchObject({ deskW: 0, convW: 1440, railW: 0 });
      expect(deskLayout(800, true, state, null)).toMatchObject({ deskW: 0, railW: 0, railDrawer: true });
    }
  });
  it("take-over: rail hidden, conversation 360, the stage takes the rest (1080 at 1440)", () => {
    expect(deskLayout(1440, true, "stage", null)).toEqual({ placement: "split", deskW: 1080, convW: STAGE_CONV_W, railW: 0, railDrawer: true });
  });
  it("a remembered fraction is used and clamped to what the window allows", () => {
    expect(deskLayout(1440, true, "docked", 0.5).deskW).toBe(720);
    expect(deskLayout(1440, true, "docked", 0.9).deskW).toBe(760);
    expect(deskLayout(1440, true, "docked", 0.1).deskW).toBe(480);
    expect(deskLayout(1440, false, "docked", 0.5).convW).toBe(720);
  });
  it("the conversation keeps at least 420 (440 on a narrow window) in a split, whatever the fraction (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 920, max: 3000 }),
        fc.boolean(),
        fc.option(fc.double({ min: 0, max: 1, noNaN: true }), { nil: null }),
        (vw, railOpen, frac) => {
          const layout = deskLayout(vw, railOpen, "docked", frac);
          expect(layout.placement).toBe("split");
          expect(layout.convW).toBeGreaterThanOrEqual(vw < 1280 ? 440 : 420);
          expect(layout.deskW).toBeGreaterThanOrEqual(480);
          expect(layout.railW + layout.convW + layout.deskW).toBe(vw);
        },
      ),
      { numRuns: 400 },
    );
  });
  it("never produces a negative or NaN width, for any window and state (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 4000 }),
        fc.boolean(),
        fc.constantFrom("closed", "chip", "docked", "stage"),
        fc.option(fc.double({ noNaN: false }), { nil: null }),
        (vw, railOpen, state, frac) => {
          const layout = deskLayout(vw, railOpen, state, frac);
          for (const value of [layout.deskW, layout.convW, layout.railW]) {
            expect(Number.isFinite(value)).toBe(true);
            expect(value).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("clampDeskFrac, fracOf and defaultDeskW", () => {
  it("keeps a fraction inside the window's range and rejects what is not a number", () => {
    expect(clampDeskFrac(0.5, 1440)).toBeCloseTo(0.5);
    expect(clampDeskFrac(2, 1440)).toBeCloseTo(760 / 1440);
    expect(clampDeskFrac(0, 1440)).toBeCloseTo(480 / 1440);
    expect(clampDeskFrac(0.9, 1024)).toBeCloseTo(580 / 1024);
    for (const bad of [Number.NaN, "0.4", null, undefined, Number.POSITIVE_INFINITY, {}]) expect(clampDeskFrac(bad, 1440)).toBeNull();
    expect(clampDeskFrac(0.4, 0)).toBeNull();
  });
  it("remembers a width as a fraction that gives the same width back", () => {
    const frac = fracOf(640, 1440);
    expect(deskLayout(1440, true, "docked", frac).deskW).toBe(640);
  });
  it("the default is 600 on a wide window and 544 on a narrow one", () => {
    expect(defaultDeskW(1440)).toBe(600);
    expect(defaultDeskW(1024)).toBe(544);
    expect(defaultDeskW(2560)).toBe(760);
  });
});
