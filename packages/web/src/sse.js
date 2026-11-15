// @ts-check
// A reader for text/event-stream. The page uses `fetch` instead of `EventSource` because `EventSource` cannot send the
// bearer token or a Last-Event-ID of our choosing; this is the part of the standard that we then need ourselves.

/**
 * @typedef {{ id: string | undefined, event: string, data: string }} SseFrame
 */

/**
 * Feed it text in pieces of any size; it calls `onFrame` for every complete event. Lines end with \n, \r\n or \r.
 * Comment lines (": ping") and `retry:` are not events; `onActivity` is told about every piece, so a watchdog can see
 * that the connection is alive. A frame without data is dropped, as the standard says.
 * @param {(frame: SseFrame) => void} onFrame
 * @param {{ onRetry?: (ms: number) => void }} [options]
 */
export function createSseParser(onFrame, options = {}) {
  let pending = "";
  let skipLineFeed = false;
  /** @type {string | undefined} */
  let id;
  let event = "";
  /** @type {string[]} */
  let data = [];

  const line = (/** @type {string} */ text) => {
    if (text === "") {
      if (data.length > 0) onFrame({ id, event: event || "message", data: data.join("\n") });
      event = "";
      data = [];
      return; // `id` persists until changed, as in the standard
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "id") {
      if (!value.includes("\0")) id = value;
    } else if (field === "event") event = value;
    else if (field === "retry" && /^\d+$/.test(value)) options.onRetry?.(Number(value));
  };

  return {
    feed(/** @type {string} */ chunk) {
      let text = chunk;
      if (skipLineFeed && text.startsWith("\n")) text = text.slice(1);
      skipLineFeed = false;
      pending += text;
      let start = 0;
      for (let i = 0; i < pending.length; i++) {
        const c = pending[i];
        if (c !== "\n" && c !== "\r") continue;
        line(pending.slice(start, i));
        if (c === "\r") {
          if (pending[i + 1] === "\n") i += 1;
          else if (i + 1 === pending.length) skipLineFeed = true; // the \n of a \r\n may arrive in the next piece
        }
        start = i + 1;
      }
      pending = pending.slice(start);
    },
  };
}
