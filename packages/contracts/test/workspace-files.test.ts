import { describe, expect, it } from "vitest";
import { fromBase64, numberedName, sanitizeFileName, toBase64 } from "../src/workspace-files.ts";

describe("sanitizeFileName", () => {
  it("keeps a plain name and Unicode", () => {
    expect(sanitizeFileName("report.pdf")).toBe("report.pdf");
    expect(sanitizeFileName("你好 报告 (1).txt")).toBe("你好 报告 (1).txt");
  });

  it("keeps only the last path segment, with either separator", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\x\\a.txt")).toBe("a.txt");
    expect(() => sanitizeFileName("a/b/")).toThrow(/empty/);
  });

  it("removes control characters and leading dots", () => {
    expect(sanitizeFileName("a\u0000b\nc.txt")).toBe("abc.txt");
    expect(sanitizeFileName("...hidden")).toBe("hidden");
  });

  it("refuses what is empty after cleaning, and non-strings, without quoting the input", () => {
    for (const bad of ["", "  ", ".", "..", "/", "...", 5, null]) {
      expect(() => sanitizeFileName(bad)).toThrow(/file name/);
    }
  });

  it("shortens a long name to 120 characters and keeps the extension", () => {
    const name = sanitizeFileName(`${"x".repeat(300)}.pdf`);
    expect([...name].length).toBe(120);
    expect(name.endsWith(".pdf")).toBe(true);
    expect([...sanitizeFileName("界".repeat(200))].length).toBe(120);
  });
});

describe("numberedName", () => {
  it("numbers before the extension", () => {
    expect(numberedName("a.pdf", 1)).toBe("a.pdf");
    expect(numberedName("a.pdf", 2)).toBe("a-2.pdf");
    expect(numberedName("archive.tar.gz", 3)).toBe("archive.tar-3.gz");
    expect(numberedName("README", 2)).toBe("README-2");
  });
});

describe("base64", () => {
  it("round trips every byte value and a large buffer", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(Array.from(fromBase64(toBase64(all)))).toEqual(Array.from(all));
    const big = new Uint8Array(3_000_000).map((_, i) => (i * 7) % 256);
    expect(fromBase64(toBase64(big)).every((b, i) => b === big[i])).toBe(true);
    expect(toBase64(new Uint8Array())).toBe("");
  });

  it("refuses text that is not base64", () => {
    expect(() => fromBase64("not base64!")).toThrow(/base64/);
    expect(() => fromBase64(5)).toThrow(/base64/);
  });
});
