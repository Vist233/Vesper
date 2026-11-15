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
  type(text: string): Promise<void>;
  /** Sets the value of an element directly through the accessibility interface (no pointer, no typing). */
  set(ref: string, text: string): Promise<void>;
  key(key: string): Promise<void>;
  scroll(dx: number, dy: number): Promise<void>;
}
