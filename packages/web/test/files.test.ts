import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { attachmentsOf, checkFiles, uploadProblem } from "../src/attachments.js";
import { ApiError, downloadFile, uploadFile } from "../src/client.js";
import { ago, formatBytes } from "../src/text.js";

const limits = { fileBytes: 25 * 1024 * 1024, files: 20 };

describe("checkFiles", () => {
  it("accepts ordinary files", () => {
    expect(checkFiles([{ name: "a.pdf", size: 10 }], 0, limits)).toEqual({ accepted: [{ name: "a.pdf", size: 10 }], rejected: [] });
  });
  it("refuses an empty file and a file over the limit, with the reason in words", () => {
    const { accepted, rejected } = checkFiles(
      [
        { name: "empty.txt", size: 0 },
        { name: "big.iso", size: limits.fileBytes + 1 },
        { name: "exact.bin", size: limits.fileBytes },
      ],
      0,
      limits,
    );
    expect(accepted.map((f) => f.name)).toEqual(["exact.bin"]);
    expect(rejected).toEqual([
      { name: "empty.txt", reason: "is empty" },
      { name: "big.iso", reason: "is larger than 25 MB" },
    ]);
  });
  it("counts the files the session already holds against the limit of 20", () => {
    const chosen = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, size: 1 }));
    const { accepted, rejected } = checkFiles(chosen, 17, limits);
    expect(accepted).toHaveLength(3);
    expect(rejected.map((r) => r.name)).toEqual(["f3", "f4"]);
    expect(rejected[0]?.reason).toContain("at most 20");
  });
  it("never accepts more than the limits allow, whatever is chosen (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ name: fc.string({ maxLength: 8 }), size: fc.oneof(fc.integer({ min: -5, max: 40_000_000 }), fc.constant(Number.NaN)) }), {
          maxLength: 40,
        }),
        fc.integer({ min: 0, max: 30 }),
        (chosen, have) => {
          const { accepted, rejected } = checkFiles(chosen, have, limits);
          expect(accepted.length + rejected.length).toBe(chosen.length);
          expect(have + accepted.length <= Math.max(have, limits.files)).toBe(true);
          for (const file of accepted) expect(file.size > 0 && file.size <= limits.fileBytes).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("words", () => {
  it("says what went wrong in one sentence for each kind of answer", () => {
    expect(uploadProblem("a.pdf", 0, "")).toBe("a.pdf could not be sent: the server cannot be reached.");
    expect(uploadProblem("a.pdf", 413, "")).toContain("too large");
    expect(uploadProblem("a.pdf", 409, "a session holds at most 20 files")).toContain("at most 20");
    expect(uploadProblem("a.pdf", 401, "")).toContain("token");
    expect(uploadProblem("a.pdf", 500, "")).toContain("500");
  });
  it("sizes and ages", () => {
    expect([0, 812, 1024, 1536, 25 * 1024 * 1024, 1.5 * 1024 ** 3, -1, Number.NaN].map(formatBytes)).toEqual([
      "0 B",
      "812 B",
      "1 KB",
      "1.5 KB",
      "25 MB",
      "1.5 GB",
      "0 B",
      "0 B",
    ]);
    const now = 1_000_000_000;
    expect([0, 30, 300, 7200, 172_800].map((s) => ago(now - s * 1000, now))).toEqual(["just now", "just now", "5 min ago", "2 h ago", "2 days ago"]);
  });
  it("the message carries the stored names of the files that are done, not the ones that failed", () => {
    expect(
      attachmentsOf([
        { state: "done", stored: { name: "a-2.pdf", size: 5 } },
        { state: "error", stored: null },
        { state: "uploading", stored: null },
      ]),
    ).toEqual([{ name: "a-2.pdf", size: 5 }]);
  });
});

class FakeXhr {
  headers: Record<string, string> = {};
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  responseText = "";
  sent: unknown = null;
  url = "";
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send(body: unknown) {
    this.sent = body;
  }
}

describe("uploadFile", () => {
  const file = Object.assign(new Blob(["hello"], { type: "application/pdf" }), { name: "报告 final.pdf" });

  it("sends the raw file with its name percent-encoded in a header, reports progress, and returns the stored file", async () => {
    const xhr = new FakeXhr();
    const progress: number[] = [];
    const done = uploadFile({ session: "s_a", file, token: () => "tok", onProgress: (f) => progress.push(f), xhr: () => xhr as unknown as XMLHttpRequest });
    expect(xhr.url).toBe("/api/sessions/s_a/files");
    expect(xhr.headers["x-file-name"]).toBe(encodeURIComponent("报告 final.pdf"));
    expect(xhr.headers.authorization).toBe("Bearer tok");
    expect(xhr.headers["content-type"]).toBe("application/pdf");
    expect(xhr.sent).toBe(file);
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 4 });
    xhr.upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });
    xhr.upload.onprogress?.({ lengthComputable: true, loaded: 4, total: 4 });
    xhr.status = 201;
    xhr.responseText = JSON.stringify({ file: { name: "报告 final-2.pdf", size: 5, modifiedAt: 1 } });
    xhr.onload?.();
    expect((await done).file.name).toBe("报告 final-2.pdf");
    expect(progress).toEqual([0.25, 1]);
  });

  it("turns a refusal into an ApiError with the status, kind and message", async () => {
    const xhr = new FakeXhr();
    const done = uploadFile({ session: "s_a", file, xhr: () => xhr as unknown as XMLHttpRequest });
    xhr.status = 409;
    xhr.responseText = JSON.stringify({ error: { kind: "conflict", message: "too many files" } });
    xhr.onload?.();
    await expect(done).rejects.toMatchObject({ status: 409, kind: "conflict", message: "too many files" });
  });

  it("an unreadable answer and a dropped connection are errors too", async () => {
    const a = new FakeXhr();
    const first = uploadFile({ session: "s_a", file, xhr: () => a as unknown as XMLHttpRequest });
    a.status = 502;
    a.responseText = "<html>bad gateway</html>";
    a.onload?.();
    await expect(first).rejects.toMatchObject({ status: 502 });
    const b = new FakeXhr();
    const second = uploadFile({ session: "s_a", file, xhr: () => b as unknown as XMLHttpRequest });
    b.onerror?.();
    await expect(second).rejects.toMatchObject({ status: 0, kind: "unreachable" });
    await expect(second).rejects.toBeInstanceOf(ApiError);
  });
});

describe("downloadFile", () => {
  it("asks for the file by its encoded name with the token and returns the bytes", async () => {
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const fake = (async (url: string, init: { headers: Record<string, string> }) => {
      seen.push({ url, headers: init.headers });
      return new Response("data", { status: 200 });
    }) as unknown as typeof fetch;
    const blob = await downloadFile({ session: "s_a", name: "报告 1.pdf", token: () => "t", fetch: fake });
    expect(await blob.text()).toBe("data");
    expect(seen[0]?.url).toBe(`/api/sessions/s_a/files/${encodeURIComponent("报告 1.pdf")}`);
    expect(seen[0]?.headers.authorization).toBe("Bearer t");
  });
  it("reports a missing file and an unreachable server", async () => {
    const missing = (async () =>
      new Response(JSON.stringify({ error: { kind: "not_found", message: "no such file" } }), { status: 404 })) as unknown as typeof fetch;
    await expect(downloadFile({ session: "s_a", name: "x", fetch: missing })).rejects.toMatchObject({ status: 404, kind: "not_found" });
    const down = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await expect(downloadFile({ session: "s_a", name: "x", fetch: down })).rejects.toMatchObject({ status: 0 });
  });
});
