// @ts-check
import { needsInsert, textToKeysyms } from "./text.js";

// The desk panel: a window with the live picture of the session's display. It watches (view ticket, the daemon's bridge
// drops every key and click) and, after Take over, controls (control ticket, a new connection). One reason to change: how the
// picture is connected and shown. It knows noVNC and the gateway's tickets, not the conversation.

/**
 * @typedef {"closed" | "connecting" | "view" | "control" | "failed"} DeskMode
 * @typedef {{
 *   liveView: (id: string) => Promise<{ url: string }>,
 *   takeover: (id: string) => Promise<{ url: string, since: number }>,
 *   handback: (id: string, note: string) => Promise<unknown>,
 *   insertText: (id: string, text: string) => Promise<{ inserted: number }>,
 * }} DeskApi
 * @typedef {{
 *   api: DeskApi,
 *   screen: HTMLElement,
 *   onChange: (mode: DeskMode, message: string) => void,
 *   report: (error: unknown) => void,
 *   hiddenMs?: number,
 *   keyDelayMs?: number,
 *   retryDelaysMs?: number[],
 *   loadViewer?: () => Promise<any>,
 * }} DeskOptions
 */

const VIEWER_URL = "/vendor/novnc/core/rfb.js";

/** @param {DeskOptions} options */
export function createDesk(options) {
  const hiddenMs = options.hiddenMs ?? 30_000;
  const keyDelayMs = options.keyDelayMs ?? 10;
  /** The desk may be asked for before the workspace is awake: a few attempts, slower each time, then the person decides. */
  const retryDelaysMs = options.retryDelaysMs ?? [1000, 2000, 4000, 8000];
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer;
  /** @type {any} */
  let rfb = null;
  /** @type {string | null} */
  let sessionId = null;
  /** @type {DeskMode} */
  let mode = "closed";
  /** Bumped by every connect and disconnect, so a late answer for an old attempt is thrown away. */
  let attempt = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let hiddenTimer;
  let pausedByTab = false;

  const loadViewer = options.loadViewer ?? (async () => (await import(/* @vite-ignore */ VIEWER_URL)).default);

  function set(/** @type {DeskMode} */ next, message = "") {
    mode = next;
    options.onChange(next, message);
  }

  function drop() {
    attempt += 1;
    typing += 1;
    clearTimeout(retryTimer);
    try {
      rfb?.disconnect();
    } catch {
      // already gone
    }
    rfb = null;
    options.screen.replaceChildren();
  }

  /**
   * Connects the picture with a one-time URL: view-only for watching, with input for control. `giveUp` is called when the
   * connection never came up, so the caller can try again; a picture that was up and is then lost is the person's to reopen.
   */
  async function connect(/** @type {string} */ path, /** @type {"view" | "control"} */ kind, /** @type {number} */ mine, /** @type {() => void} */ giveUp) {
    const RFB = await loadViewer();
    if (mine !== attempt) return;
    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const instance = new RFB(options.screen, `${scheme}://${location.host}${path}`, { shared: true });
    rfb = instance;
    let up = false;
    instance.viewOnly = kind === "view"; // a hint for the person; the real enforcement is the daemon's bridge
    instance.scaleViewport = true;
    instance.resizeSession = false;
    instance.addEventListener("connect", () => {
      if (mine !== attempt) return;
      up = true;
      set(kind, "");
      if (kind === "control") instance.focus(); // the keyboard must go to the desktop right after the reconnect
    });
    instance.addEventListener("disconnect", (/** @type {any} */ event) => {
      if (mine !== attempt) return;
      rfb = null;
      if (!up) return giveUp(); // never was up (the workspace is still starting): not a "closed picture", try again
      set("failed", event?.detail?.clean ? "The picture was closed." : "The picture was lost.");
    });
    instance.addEventListener("securityfailure", () => {
      if (mine === attempt) set("failed", "The desktop refused the connection.");
    });
  }

  /** @param {"view" | "control"} kind @param {number} tries */
  async function start(kind, tries = 0) {
    if (!sessionId) return;
    drop();
    const mine = attempt;
    set("connecting", tries > 0 ? "Starting the browser..." : kind === "control" ? "Taking over..." : "Connecting to the desk...");
    /** @type {unknown} */
    let lastError = null;
    const again = () => {
      if (mine !== attempt) return;
      if (tries < retryDelaysMs.length) {
        set("connecting", "Starting the browser...");
        retryTimer = setTimeout(() => void start(kind, tries + 1), retryDelaysMs[tries]);
        return;
      }
      const unavailable = /** @type {any} */ (lastError)?.kind === "unavailable" || lastError === null;
      set("failed", unavailable ? "The browser did not start. Try again." : "The desk could not be opened.");
      if (!unavailable) options.report(lastError);
    };
    try {
      const reply = kind === "control" ? await options.api.takeover(sessionId) : await options.api.liveView(sessionId);
      if (mine !== attempt) return;
      await connect(reply.url, kind, mine, again);
    } catch (error) {
      if (mine !== attempt) return;
      lastError = error;
      again();
    }
  }

  function onVisibility() {
    if (document.hidden) {
      hiddenTimer = setTimeout(() => {
        if (mode === "view" || mode === "control") {
          pausedByTab = true;
          const was = mode;
          drop();
          set("failed", "Paused while this tab was hidden.");
          lastKind = was;
        }
      }, hiddenMs);
    } else {
      clearTimeout(hiddenTimer);
      if (pausedByTab) {
        pausedByTab = false;
        void start(lastKind);
      }
    }
  }
  /** @type {"view" | "control"} */
  let lastKind = "view";
  let typing = 0;
  document.addEventListener("visibilitychange", onVisibility);

  return {
    get mode() {
      return mode;
    },
    /** Opens the desk for a session in view mode (or joins a take-over that is already open). */
    open(/** @type {string} */ id, /** @type {"view" | "control"} */ kind = "view") {
      sessionId = id;
      lastKind = kind;
      return start(kind);
    },
    /** Try again after the attempts ran out or the picture was lost. */
    reconnect() {
      return start(lastKind);
    },
    /** Take over: a new ticket and a new connection, with input. */
    takeover() {
      lastKind = "control";
      return start("control");
    },
    /** Hand back, with the person's note; the desk goes back to watching. */
    async handback(/** @type {string} */ note) {
      const id = sessionId;
      if (!id) return false;
      try {
        await options.api.handback(id, note);
      } catch (error) {
        options.report(error);
        return false;
      }
      if (sessionId !== id) return true; // the person switched sessions meanwhile: the new one's desk is not ours to touch
      lastKind = "view";
      await start("view");
      return true;
    },
    /**
     * Types text into the desktop: ASCII one key at a time (passwords with symbols, it also reaches the address bar), anything
     * else through the page-input route. Only while in control; nothing goes through the X clipboard.
     * Returns how many characters were sent.
     */
    async sendText(/** @type {string} */ text) {
      const instance = rfb;
      if (mode !== "control" || !instance || !sessionId) return 0;
      if (needsInsert(text)) {
        // Chinese and other non-ASCII text does not arrive through the keyboard path of the picture: the whole text goes to the
        // focused field of the page, through the gateway.
        try {
          return (await options.api.insertText(sessionId, text)).inserted;
        } catch (error) {
          options.report(error);
          return 0;
        }
      }
      const mine = ++typing;
      const keysyms = textToKeysyms(text);
      let sent = 0;
      for (const keysym of keysyms) {
        if (mine !== typing || rfb !== instance) break; // closed, switched or typed over meanwhile
        instance.sendKey(keysym, null);
        sent += 1;
        await new Promise((resolve) => setTimeout(resolve, keyDelayMs));
      }
      return sent;
    },
    /** Closing disconnects: nothing keeps streaming behind a closed panel. */
    close() {
      drop();
      pausedByTab = false;
      sessionId = null;
      set("closed");
    },
    /** The session changed: the picture of the old one must not stay. */
    switchSession() {
      drop();
      sessionId = null;
      pausedByTab = false;
      set("closed");
    },
    destroy() {
      document.removeEventListener("visibilitychange", onVisibility);
      clearTimeout(hiddenTimer);
      drop();
    },
  };
}
