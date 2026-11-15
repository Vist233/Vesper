// @ts-check
// Builds DOM nodes for the view model. Text goes in with `textContent` only: there is no innerHTML anywhere in the page,
// so a message that contains markup is shown as the characters it is made of.

import { parseMarkdown } from "./markdown.js";
import { formatBytes, hostOf } from "./text.js";
import { activitySummary, questionMarker } from "./timeline.js";

/** @typedef {import("./model.js").Item} Item */
/** @typedef {Extract<Item, { kind: "tool" }>} ToolItem */

/**
 * @param {string} tag
 * @param {{ class?: string, text?: string, attrs?: Record<string, string> }} [props]
 * @param {(Node | string | null)[]} [children]
 */
export function h(tag, props = {}, children = []) {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  for (const [name, value] of Object.entries(props.attrs ?? {})) el.setAttribute(name, value);
  for (const child of children) if (child !== null) el.append(child);
  return el;
}

const STAR_PATH = "M8 0.5C8.5 4.9 11.1 7.5 15.5 8C11.1 8.5 8.5 11.1 8 15.5C7.5 11.1 4.9 8.5 0.5 8C4.9 7.5 7.5 4.9 8 0.5Z";

/** The star of the identity: a four-point star, coloured by CSS classes (`on`, `needs`, `error`). Built with the DOM, never with markup text. */
export function star(/** @type {string} */ className = "", /** @type {number} */ size = 12) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", `star ${className}`.trim());
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", STAR_PATH);
  svg.append(path);
  return svg;
}

/**
 * @typedef {{
 *   answer: (questionId: string, text: string) => Promise<boolean>,
 *   download: (session: string, name: string) => void,
 *   decide: (approvalId: string, approved: boolean) => void,
 *   openDesk: () => void,
 *   retry: () => void,
 * }} Actions
 */

/**
 * Inline Markdown nodes. A link to a file of this session downloads through the page (the request needs the token);
 * a web link opens in a new tab without telling the site where it came from.
 * @param {import("./markdown.js").Inline[]} inlines
 * @param {Actions} actions
 * @returns {(Node | string)[]}
 */
function inlineNodes(inlines, actions) {
  return inlines.map((node) => {
    switch (node.type) {
      case "text":
        return node.text;
      case "br":
        return h("br");
      case "code":
        return h("code", { text: node.text });
      case "strong":
      case "em":
        return h(node.type, {}, inlineNodes(node.children, actions));
      case "link": {
        const file = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/files\/([^\s()/?#]+)$/.exec(node.href);
        if (!file) return h("a", { attrs: { href: node.href, target: "_blank", rel: "noopener noreferrer" } }, inlineNodes(node.children, actions));
        let name = "";
        try {
          name = decodeURIComponent(/** @type {string} */ (file[2]));
        } catch {
          return h("span", {}, inlineNodes(node.children, actions));
        }
        if (!name || /[\\/]/.test(name)) return h("span", {}, inlineNodes(node.children, actions));
        const link = h("a", { attrs: { href: node.href, download: name } }, inlineNodes(node.children, actions));
        link.addEventListener("click", (event) => {
          event.preventDefault();
          actions.download(/** @type {string} */ (file[1]), name);
        });
        return link;
      }
      default:
        return "";
    }
  });
}

/** The agent's finished message as Markdown, built with the DOM (markdown.js reads it; nothing is parsed as HTML). */
function richText(/** @type {string} */ text, /** @type {Actions} */ actions) {
  const box = h("div", { class: "text md" });
  for (const block of parseMarkdown(text)) {
    switch (block.type) {
      case "code":
        box.append(h("pre", { class: "code" }, [h("code", { text: block.text })]));
        break;
      case "hr":
        box.append(h("hr"));
        break;
      case "h":
        box.append(h(`h${Math.min(6, block.level + 2)}`, {}, inlineNodes(block.inlines, actions)));
        break;
      case "ul":
      case "ol":
        box.append(
          h(
            block.type,
            block.type === "ol" && block.start !== 1 ? { attrs: { start: String(block.start) } } : {},
            block.items.map((item) => h("li", {}, inlineNodes(item, actions))),
          ),
        );
        break;
      case "quote":
        box.append(h("blockquote", {}, inlineNodes(block.inlines, actions)));
        break;
      default:
        box.append(h("p", {}, inlineNodes(block.inlines, actions)));
    }
  }
  return box;
}

/**
 * One non-tool entry. `update` brings it up to date after the item changed (a question was answered, an approval decided).
 * @param {Item} item
 * @param {Actions} actions
 * @param {{ pinned?: boolean }} [options]
 * @returns {{ el: HTMLLIElement, update: (item: Item) => void }}
 */
export function renderItem(item, actions, options = {}) {
  const li = /** @type {HTMLLIElement} */ (h("li"));
  li.dataset.kind = item.kind;
  switch (item.kind) {
    case "user":
      li.append(h("div", { class: "bubble", text: item.text }));
      if (item.attachments.length > 0)
        li.append(
          h(
            "ul",
            { class: "attached", attrs: { "aria-label": "Attached files" } },
            item.attachments.map((file) => h("li", { text: `${file.name} · ${formatBytes(file.size)}`, attrs: { title: file.path || file.name } })),
          ),
        );
      return { el: li, update() {} };
    case "assistant":
      li.append(h("div", { class: "agent" }, [richText(item.text, actions)]));
      return { el: li, update() {} };
    case "say":
      li.append(h("div", { class: "agent say" }, [h("span", { class: "who", text: "Message for you" }), richText(item.text, actions)]));
      return { el: li, update() {} };
    case "signal": {
      // A bot's own scheduled wake-up reads as such, not as a raw system signal.
      const wake = item.source === "system" ? /^Scheduled job \S+ \(([^)]*)\)\.(?: It is late:[^.]*\.)? ?([\s\S]*)$/.exec(item.text) : null;
      if (wake) {
        li.append(h("div", { class: "signal wake", text: `Woke up on schedule (${wake[1]}): ${(wake[2] ?? "").replace(/\s+/g, " ").slice(0, 160)}` }));
        return { el: li, update() {} };
      }
      li.append(
        h("div", {
          class: "signal",
          text: `${item.source} (${item.trust === "trusted" ? "trusted" : "not trusted"}): ${item.text.replace(/\s+/g, " ").slice(0, 160)}`,
        }),
      );
      return { el: li, update() {} };
    }
    case "note":
      return renderNote(li, item, actions);
    case "question":
      return options.pinned ? renderQuestion(li, item, actions, options) : renderMarker(li, item);
    case "approval":
      return options.pinned ? renderApproval(li, item, actions) : renderMarker(li, item);
    default:
      return { el: li, update() {} };
  }
}

/** The timeline's one-line memory of a question or an approval; the card itself is pinned above the composer. */
function renderMarker(/** @type {HTMLLIElement} */ li, /** @type {Item} */ item) {
  const line = h("div", { class: "marker" });
  const text = h("span");
  line.append(star(), text);
  li.append(line);
  const update = (/** @type {Item} */ next) => {
    text.textContent = questionMarker(next);
  };
  update(item);
  return { el: li, update };
}

/** @param {HTMLLIElement} li @param {Extract<Item, { kind: "note" }>} item @param {Actions} actions */
function renderNote(li, item, actions) {
  const box = h("div", { class: `notice${item.level === "error" ? " error" : ""}`, attrs: { role: item.level === "error" ? "alert" : "note" } }, [
    h("span", { text: item.text }),
  ]);
  if (item.retryable) {
    const retry = h("button", { text: "Retry", attrs: { type: "button" } });
    retry.addEventListener("click", () => actions.retry());
    box.append(retry);
  }
  li.append(box);
  return { el: li, update() {} };
}

/** @param {HTMLLIElement} li @param {Extract<Item, { kind: "question" }>} item @param {Actions} actions @param {{ pinned?: boolean }} options */
function renderQuestion(li, item, actions, options) {
  const login = item.ask === "login";
  const box = h("div", { class: "card" });
  const head = h("div", { class: "head" }, [star(), h("strong", { text: login ? "Sign in for me" : "I have a question" })]);
  const origin = h("div", { class: "muted small", text: item.where ? hostOf(item.where) : "" });
  origin.hidden = !item.where;
  const body = h("div", { class: "plain", text: item.question });
  const field = /** @type {HTMLTextAreaElement} */ (h("textarea", { attrs: { rows: "2", "aria-label": `Your answer to: ${item.question.slice(0, 80)}` } }));
  field.hidden = true;
  const answer = /** @type {HTMLButtonElement} */ (h("button", { text: "Answer", attrs: { type: "button" } }));
  const buttons = h("div", { class: "buttons" });
  if (login) {
    const desk = h("button", { class: "primary", text: "Open the browser", attrs: { type: "button" } });
    desk.addEventListener("click", () => actions.openDesk());
    buttons.append(desk);
  }
  buttons.append(answer);
  answer.addEventListener("click", async () => {
    if (field.hidden) {
      field.hidden = false; // the answer box opens on demand; a login card is first about the browser
      field.focus();
      return;
    }
    const text = field.value.trim();
    if (text) {
      answer.disabled = true;
      try {
        if ((await actions.answer(item.id, text)) && field.value.trim() === text) field.value = "";
      } finally {
        answer.disabled = false;
      }
    }
  });
  if (!login) field.hidden = false;
  box.append(head, origin, body, field, buttons);
  li.append(box);
  if (options.pinned) li.dataset.pinned = "true";
  const update = (/** @type {Item} */ next) => {
    if (next.kind !== "question") return;
    box.classList.toggle("done", next.answered);
    buttons.hidden = next.answered;
    if (next.answered) field.hidden = true;
  };
  update(item);
  return { el: li, update };
}

/** @param {HTMLLIElement} li @param {Extract<Item, { kind: "approval" }>} item @param {Actions} actions */
function renderApproval(li, item, actions) {
  const box = h("div", { class: "card", attrs: { role: "group" } });
  const heading = h("strong");
  const head = h("div", { class: "head" }, [star(), heading]);
  const what = h("pre", { class: "code" });
  const allow = h("button", { class: "primary", text: "Allow", attrs: { type: "button" } });
  const deny = h("button", { text: "Deny", attrs: { type: "button" } });
  allow.addEventListener("click", () => actions.decide(item.id, true));
  deny.addEventListener("click", () => actions.decide(item.id, false));
  const buttons = h("div", { class: "buttons" }, [allow, deny]);
  box.append(head, what, buttons);
  li.append(box);
  const update = (/** @type {Item} */ next) => {
    if (next.kind !== "approval") return;
    box.setAttribute("aria-label", `Approval for ${next.tool}`);
    heading.textContent = next.status === "pending" ? `Allow this? ${next.tool}` : questionMarker(next);
    what.textContent = next.args;
    what.hidden = next.args === "";
    buttons.hidden = next.status !== "pending";
    box.classList.toggle("done", next.status !== "pending");
  };
  update(item);
  return { el: li, update };
}

/**
 * One quiet line for a block of tool calls (owner's items 3 and 9): a small spinner and what the agent is doing while it
 * works, then "Worked 2m · 5 steps". No inputs, outputs or failure counts here: those are in the logs for whoever runs the box.
 * @param {string} key
 * @param {readonly ToolItem[]} tools
 */
export function renderActivity(key, tools) {
  const summary = activitySummary(tools);
  const li = /** @type {HTMLLIElement} */ (h("li"));
  li.dataset.kind = "activity";
  li.dataset.key = key;
  const line = h("div", { class: `activity${summary.running ? " running" : ""}` }, [
    h("span", { class: "spinner", attrs: { "aria-hidden": "true" } }),
    h("span", { class: "label", text: summary.label }),
  ]);
  if (!summary.running && summary.waiting > 0) line.append(h("span", { class: "waiting", text: `· ${summary.waiting} waiting for you` }));
  li.append(line);
  return li;
}
