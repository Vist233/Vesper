// What the page says about its connection to the box. Pure: the page feeds in what the health poll and the event stream
// report, and gets back the state and the banner text; app.js does the DOM and the two-second delay.

/** @typedef {"live" | "connecting" | "reconnecting" | "starting" | "down" | "unauthorized"} Connection */

/** The banner for a state ("" means none). Shown only after two seconds in that state: a short break is not worth one. */
export const CONNECTION_WORDS = /** @type {Record<Connection, string>} */ ({
  live: "",
  connecting: "",
  reconnecting: "Lost the connection. Catching up as soon as it is back.",
  starting: "Starting up. This takes a few seconds.",
  down: "Can't reach the server. Trying again.",
  unauthorized: "",
});

/**
 * The next state after the health poll answered (`ready` true or false) or failed (`null`).
 * @param {Connection} current
 * @param {{ ready: boolean } | null} health
 * @param {{ selected: boolean, streamLive: boolean }} page
 * @returns {Connection}
 */
export function afterHealth(current, health, page) {
  if (health === null) return "down";
  if (!health.ready) return "starting";
  // Back up: with a session open, only its stream being connected means nothing was missed.
  if (current === "down" || current === "starting") return page.selected && !page.streamLive ? "reconnecting" : "live";
  if (!page.selected && current !== "unauthorized") return "live";
  return current;
}

/**
 * The next state after the event stream of the open session reported. "Starting" and "down" belong to the health poll:
 * the stream cannot clear them, so a live stream alone never hides that the runtime is still starting.
 * @param {Connection} current
 * @param {"live" | "connecting" | "reconnecting" | "unauthorized"} stream
 * @returns {Connection}
 */
export function afterStream(current, stream) {
  if (stream === "unauthorized") return "unauthorized";
  if (current === "down" || current === "starting") return current;
  return stream;
}
