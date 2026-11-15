// @ts-check
// Files between the person's machine and the session's workspace: the tray of files waiting to go with the next message,
// uploads with progress, the Files list with downloads, and what to show in the take-over panel. One reason to change:
// how files move and look. It knows the API and the DOM builders, not the conversation.

import { attachmentsOf, checkFiles, uploadProblem } from "./attachments.js";
import { ApiError, uploadFile } from "./client.js";
import { h } from "./render.js";
import { formatBytes } from "./text.js";

/**
 * @typedef {{ id: number, file: File | null, name: string, size: number, state: "waiting" | "uploading" | "done" | "error", progress: number, error: string, stored: { name: string, size: number, path?: string } | null }} TrayEntry
 * @typedef {{
 *   tray: HTMLElement,
 *   getSession: () => string | null,
 *   limits: () => { fileBytes: number, files: number },
 *   api: { listFiles: (id: string) => Promise<{ files: { name: string }[] }> },
 *   token: () => string | undefined,
 *   report: (error: unknown) => void,
 *   onChange: () => void,
 * }} FilesDeps
 */

/** @param {FilesDeps} deps */
export function createFiles(deps) {
  /** @type {TrayEntry[]} */
  let entries = [];
  let nextId = 1;
  /** @type {Promise<void> | null} */
  let uploading = null;

  function changed() {
    renderTray();
    deps.onChange();
  }

  function renderTray() {
    deps.tray.replaceChildren();
    deps.tray.hidden = entries.length === 0;
    for (const entry of entries) {
      const bar = h("span", { class: "bar-fill" });
      bar.style.width = `${Math.round((entry.state === "done" ? 1 : entry.progress) * 100)}%`;
      const status =
        entry.state === "error"
          ? entry.error
          : entry.state === "waiting"
            ? deps.getSession()
              ? "waiting"
              : "goes with your message"
            : entry.state === "uploading"
              ? "sending"
              : "ready";
      const remove = h("button", { class: "icon", text: "✕", attrs: { type: "button", "aria-label": `Remove ${entry.name}` } });
      remove.addEventListener("click", () => {
        const index = entries.indexOf(entry);
        if (index >= 0) entries.splice(index, 1);
        changed();
      });
      deps.tray.append(
        h("li", { class: `chipfile ${entry.state}` }, [
          h("span", { class: "fname", text: entry.stored?.name ?? entry.name }),
          h("span", { class: "fsize muted", text: formatBytes(entry.size) }),
          h("span", { class: "fstate", text: status }),
          entry.state === "uploading" ? h("span", { class: "bar" }, [bar]) : null,
          remove,
        ]),
      );
    }
  }

  /** Puts chosen files in the tray; those that cannot go are shown with the reason. If there is a session they start to upload at once. */
  function addFiles(/** @type {Iterable<File>} */ chosen) {
    const files = [...chosen];
    const have = entries.filter((entry) => entry.state !== "error").length;
    const { accepted, rejected } = checkFiles(
      files.map((file) => ({ name: file.name, size: file.size })),
      have,
      deps.limits(),
    );
    for (const refusal of rejected)
      entries.push({
        id: nextId++,
        file: null,
        name: refusal.name,
        size: files.find((f) => f.name === refusal.name)?.size ?? 0,
        state: "error",
        progress: 0,
        error: `Not sent: ${refusal.reason.replace(/^is /, "")}`,
        stored: null,
      });
    for (const ok of accepted) {
      const file = files.find((candidate) => candidate.name === ok.name && candidate.size === ok.size);
      if (file) entries.push({ id: nextId++, file, name: file.name, size: file.size, state: "waiting", progress: 0, error: "", stored: null });
    }
    changed();
    const session = deps.getSession();
    if (session) void uploadAll(session);
  }

  /** Sends every waiting file to the session, one after the other. Resolves when none is waiting or sending any more. */
  async function uploadAll(/** @type {string} */ session) {
    const currentEntries = entries;
    while (uploading) await uploading;
    if (currentEntries !== entries) return;
    uploading = uploadWaiting(session, currentEntries);
    try {
      await uploading;
    } finally {
      uploading = null;
    }
  }

  async function uploadWaiting(/** @type {string} */ session, /** @type {TrayEntry[]} */ currentEntries) {
    for (const entry of currentEntries) {
      if (currentEntries !== entries) return;
      if (entry.state !== "waiting" || !entry.file) continue;
      entry.state = "uploading";
      changed();
      try {
        const { file } = await uploadFile({
          session,
          file: entry.file,
          token: deps.token,
          onProgress: (fraction) => {
            entry.progress = fraction;
            renderTray();
          },
        });
        entry.state = "done";
        entry.stored = file;
        entry.file = null; // the bytes are on the other side now; do not keep them in memory
      } catch (error) {
        entry.state = "error";
        entry.error = error instanceof ApiError ? uploadProblem(entry.name, error.status, error.message) : `${entry.name} could not be sent.`;
        if (error instanceof ApiError && error.status === 401) deps.report(error);
      }
      changed();
    }
  }

  return {
    addFiles,
    uploadAll,
    /** Everything the next message needs to carry: stored names and sizes of the files that are done. */
    attachments: () => attachmentsOf(entries),
    count: () => entries.length,
    /** The name of the first file that can still go, for the title of a session made from files alone. */
    firstName: () => entries.find((entry) => entry.state !== "error")?.name,
    pending: () => entries.filter((entry) => entry.state === "waiting" || entry.state === "uploading").length,
    failed: () => entries.filter((entry) => entry.state === "error").length,
    /** After the message went out the files belong to it, not to the tray. */
    clear: () => {
      entries = [];
      changed();
    },
    /** A session was left: files that were only waiting are not carried over to another conversation. */
    reset: () => {
      entries = [];
      changed();
    },
    render: renderTray,
  };
}
