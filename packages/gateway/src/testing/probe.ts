import { request as httpRequest, type IncomingHttpHeaders } from "node:http";

export interface Probe {
  /** Plain request with explicit headers (the Host header can be set to anything, which `fetch` forbids). */
  call(
    method: string,
    path: string,
    options?: { headers?: Record<string, string>; body?: string | object; json?: boolean },
  ): Promise<{ status: number; headers: IncomingHttpHeaders; text: string; json: any }>;
  /** Opens an event stream and collects its frames; `close()` hangs up. */
  stream(path: string, headers?: Record<string, string>): EventStreamHandle;
}

export interface EventStreamHandle {
  status: Promise<number>;
  /** Parsed `id`/`data` pairs received so far. */
  readonly frames: { id: number; event: any }[];
  /** Raw text received so far. */
  readonly raw: () => string;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
  /** Stop reading without hanging up (the socket's buffer fills: a slow client). */
  pause(): void;
  resume(): void;
  close(): void;
  readonly closed: Promise<void>;
}

/** A tiny HTTP client for tests that talks to a gateway on loopback with full control over the headers. */
export function startProbe(port: number, defaultHeaders: Record<string, string> = {}): Probe {
  return {
    call(method, path, options = {}) {
      return new Promise((resolve, reject) => {
        const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...defaultHeaders, ...options.headers };
        let payload: string | undefined;
        if (options.body !== undefined) {
          payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
          if (typeof options.body !== "string" || options.json) headers["content-type"] ??= "application/json";
          headers["content-length"] = String(Buffer.byteLength(payload));
        }
        const req = httpRequest({ host: "127.0.0.1", port, method, path, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let json: unknown;
            try {
              json = JSON.parse(text);
            } catch {
              json = undefined;
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
          });
        });
        req.on("error", reject);
        req.end(payload);
      });
    },
    stream(path, headers = {}) {
      const frames: { id: number; event: any }[] = [];
      let raw = "";
      let buffer = "";
      const waiters: (() => void)[] = [];
      let resolveStatus: (status: number) => void = () => {};
      const status = new Promise<number>((resolve) => {
        resolveStatus = resolve;
      });
      let resolveClosed: () => void = () => {};
      const closed = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "GET", path, headers: { host: `127.0.0.1:${port}`, ...defaultHeaders, ...headers } },
        (res) => {
          resolveStatus(res.statusCode ?? 0);
          res.setEncoding("utf8");
          res.on("data", (text: string) => {
            raw += text;
            buffer += text;
            let end = buffer.indexOf("\n\n");
            while (end >= 0) {
              const block = buffer.slice(0, end);
              buffer = buffer.slice(end + 2);
              const id = /^id: (\d+)$/m.exec(block);
              const data = /^data: (.*)$/m.exec(block);
              if (id && data) frames.push({ id: Number(id[1]), event: JSON.parse(data[1] as string) });
              end = buffer.indexOf("\n\n");
            }
            for (const wake of waiters.splice(0)) wake();
          });
          res.on("close", resolveClosed);
          res.on("error", () => {});
          handle.pause = () => res.pause();
          handle.resume = () => res.resume();
        },
      );
      req.on("error", () => {
        resolveStatus(0);
        resolveClosed();
      });
      req.end();
      const handle: EventStreamHandle = {
        status,
        frames,
        raw: () => raw,
        closed,
        pause: () => {},
        resume: () => {},
        close: () => req.destroy(),
        waitFor(count, timeoutMs = 5000) {
          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`waited ${timeoutMs} ms for ${count} frames, have ${frames.length}`)), timeoutMs);
            const check = () => {
              if (frames.length >= count) {
                clearTimeout(timer);
                resolve();
              } else waiters.push(check);
            };
            check();
          });
        },
      };
      return handle;
    },
  };
}
