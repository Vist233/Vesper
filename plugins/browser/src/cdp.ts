import type { JsonValue } from "@vesper/contracts";

/** One DevTools page, as `GET /json/list` describes it. */
export interface CdpTarget {
  id: string;
  type: string;
  url: string;
  title: string;
  webSocketDebuggerUrl: string;
}

/** A DevTools connection to one page: a request with its answer. */
export interface CdpConnection {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
}

/** The part of the standard `WebSocket` this file uses; a test passes a fake. */
export interface WebSocketLike {
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface CdpOptions {
  /** The workspace's DevTools address, `http://127.0.0.1:<port>`. */
  cdpUrl: string;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: new (url: string) => WebSocketLike;
  timeoutMs?: number;
}

export interface EvaluateParams {
  expression: string;
  awaitPromise: boolean;
}

export interface CdpEvaluator {
  /** Runs an expression in the page of one tab and returns its value as JSON. A thrown exception becomes an Error with the page's message. */
  evaluate(page: { id?: string; url: string; title: string }, params: EvaluateParams): Promise<JsonValue>;
}

const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}\/?$/;

/**
 * Chrome DevTools `Runtime.evaluate` on the page of a tab (the owner's worker has no action that reads the DOM). Only a
 * loopback address is accepted: this reaches the workspace's own Chromium, nothing else. ASSUMPTION (unverified here): the
 * worker's tab id is a DevTools target id (32 hex), or else the tab is found by its url and title.
 */
export function createCdpEvaluator(options: CdpOptions): CdpEvaluator {
  if (!LOOPBACK.test(options.cdpUrl)) throw new Error("the DevTools address must be http://127.0.0.1:<port>");
  const base = options.cdpUrl.replace(/\/$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  async function targets(): Promise<CdpTarget[]> {
    const response = await doFetch(`${base}/json/list`);
    if (!response.ok) throw new Error(`the browser's DevTools list answered ${response.status}`);
    const list = (await response.json()) as unknown;
    if (!Array.isArray(list)) throw new Error("the browser's DevTools list is not a list");
    return list.filter(
      (t): t is CdpTarget =>
        typeof t === "object" && t !== null && (t as CdpTarget).type === "page" && typeof (t as CdpTarget).webSocketDebuggerUrl === "string",
    );
  }

  function connect(url: string): Promise<CdpConnection> {
    const Impl = options.WebSocketImpl ?? (globalThis as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
    if (!Impl) throw new Error("this runtime has no WebSocket");
    return new Promise((resolve, reject) => {
      const socket = new Impl(url);
      let counter = 0;
      const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
      const fail = (error: Error) => {
        for (const entry of waiting.values()) entry.reject(error);
        waiting.clear();
      };
      socket.onopen = () =>
        resolve({
          request(method, params) {
            const id = ++counter;
            return new Promise((res, rej) => {
              waiting.set(id, { resolve: res, reject: rej });
              socket.send(JSON.stringify({ id, method, params }));
            });
          },
          close: () => socket.close(),
        });
      socket.onmessage = (event) => {
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const entry = message.id === undefined ? undefined : waiting.get(message.id);
        if (!entry || message.id === undefined) return;
        waiting.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message ?? "DevTools reported an error"));
        else entry.resolve(message.result);
      };
      socket.onerror = () => {
        const error = new Error("could not talk to the browser's DevTools");
        fail(error);
        reject(error);
      };
      socket.onclose = () => fail(new Error("the browser closed the DevTools connection"));
    });
  }

  return {
    async evaluate(page, params) {
      const all = await targets();
      const target =
        (page.id ? all.find((t) => t.id === page.id) : undefined) ??
        all.find((t) => t.url === page.url && t.title === page.title) ??
        all.find((t) => t.url === page.url);
      if (!target) throw new Error(`the browser's DevTools list has no page at ${page.url} (the tab may have been closed)`);
      const connection = await connect(target.webSocketDebuggerUrl);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const answer = (await Promise.race([
          connection.request("Runtime.evaluate", { expression: params.expression, returnByValue: true, awaitPromise: params.awaitPromise, userGesture: false }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`the page did not answer within ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
          }),
        ])) as {
          result?: { value?: JsonValue; type?: string; description?: string };
          exceptionDetails?: { text?: string; exception?: { description?: string } };
        };
        if (answer.exceptionDetails) {
          const text = answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text ?? "the expression threw";
          throw new Error(`the expression threw: ${text.split("\n")[0]}`);
        }
        return answer.result?.value ?? null;
      } finally {
        if (timer) clearTimeout(timer);
        connection.close();
      }
    },
  };
}
