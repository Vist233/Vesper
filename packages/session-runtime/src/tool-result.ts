import type { ToolResult } from "sakura-agent";

/** A tool result holding one text, an error when `isError`. */
export const text = (value: string, isError = false): ToolResult => ({ content: [{ type: "text", text: value }], ...(isError ? { isError } : {}) });
