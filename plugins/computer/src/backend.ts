export interface DesktopElement {
  ref: string;
  role: string;
  name: string;
}

/**
 * What the helper's desktop tool needs from a display. The real backend uses the accessibility tree first and a
 * screenshot only when the tree is not enough; it is not built yet (the desk-daemon is not ready), so the tool is
 * written against this port and a fake.
 */
export interface DesktopBackend {
  /** The accessibility tree as compact text, one element per line with its ref. */
  tree(): Promise<{ text: string; elements: DesktopElement[] }>;
  screenshot(): Promise<{ path: string; mediaType: string }>;
  click(target: { ref: string } | { x: number; y: number }): Promise<void>;
  drag(x: number, y: number, toX: number, toY: number): Promise<void>;
  /** Holds the left button down along the points, in order: a stroke for drawing by hand (at most 500 points). */
  path(points: readonly { x: number; y: number }[]): Promise<void>;
  /** Starts a desktop program on this display and returns at once (the bare desktop has no menu or terminal to start one from). */
  launch(program: string, args: readonly string[]): Promise<void>;
  type(text: string): Promise<void>;
  /** Sets the value of an element directly through the accessibility interface (no pointer, no typing). */
  set(ref: string, text: string): Promise<void>;
  key(key: string): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
}
