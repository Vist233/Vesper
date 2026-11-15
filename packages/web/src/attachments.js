// @ts-check
// Which files the person may add to a message, and what to say when one cannot be. Pure: no DOM, no network.

import { formatBytes } from "./text.js";

/** @typedef {{ name: string, size: number }} Candidate */

/**
 * Splits chosen files into those that can go and those that cannot, with the reason in words. `have` is how many files
 * are already waiting or stored for this session, so the limit is for the session, not for one drop.
 * @param {readonly Candidate[]} chosen
 * @param {number} have
 * @param {{ fileBytes: number, files: number }} limits
 * @returns {{ accepted: Candidate[], rejected: { name: string, reason: string }[] }}
 */
export function checkFiles(chosen, have, limits) {
  /** @type {Candidate[]} */
  const accepted = [];
  /** @type {{ name: string, reason: string }[]} */
  const rejected = [];
  for (const file of chosen) {
    if (!Number.isFinite(file.size) || file.size <= 0) rejected.push({ name: file.name, reason: "is empty" });
    else if (file.size > limits.fileBytes) rejected.push({ name: file.name, reason: `is larger than ${formatBytes(limits.fileBytes)}` });
    else if (have + accepted.length >= limits.files) rejected.push({ name: file.name, reason: `does not fit: a session holds at most ${limits.files} files` });
    else accepted.push(file);
  }
  return { accepted, rejected };
}

/** One sentence for a failed upload, from what the server said. Never quotes the content. */
export function uploadProblem(/** @type {string} */ name, /** @type {number} */ status, /** @type {string} */ message) {
  if (status === 0) return `${name} could not be sent: the server cannot be reached.`;
  if (status === 413) return `${name} is too large for the server.`;
  if (status === 409) return `${name} was not stored: ${message}`;
  if (status === 401) return `${name} was not sent: the access token is missing or wrong.`;
  return `${name} was not stored: ${message || `the server answered ${status}`}`;
}

/** The attachments of a message: the stored name and size of every file that is done. */
export function attachmentsOf(/** @type {readonly { state: string, stored: Candidate | null }[]} */ tray) {
  return tray.flatMap((entry) => (entry.state === "done" && entry.stored ? [{ name: entry.stored.name, size: entry.stored.size }] : []));
}
