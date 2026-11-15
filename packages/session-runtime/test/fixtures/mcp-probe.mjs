// A minimal MCP server (newline-delimited JSON-RPC on stdio) with one tool, `probe`, for tests of how reviews see tool calls.
import { createInterface } from "node:readline";

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return; // notifications
  if (message.method === "initialize")
    reply(message.id, { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "probe", version: "1" } });
  else if (message.method === "tools/list") {
    reply(message.id, {
      tools: [
        { name: "probe", description: "Reads a named target and reports it", inputSchema: { type: "object", properties: { target: { type: "string" } } } },
      ],
    });
  } else if (message.method === "tools/call") reply(message.id, { content: [{ type: "text", text: `probed ${JSON.stringify(message.params.arguments)}` }] });
  else reply(message.id, {});
});
