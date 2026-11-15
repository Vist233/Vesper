// Settles the model's wire format by asking it (docs/11 D8). Run inside the box:
//   docker exec ogb-box node /opt/ogb/image/check-model.mjs
// The key comes from COMMANDCODE_API_KEY and is never printed. Optional: OGB_MODEL_BASE_URL, OGB_MODEL.
const base = (process.env.OGB_MODEL_BASE_URL || "https://api.commandcode.ai/provider/v1").replace(/\/$/, "");
const model = process.env.OGB_MODEL || "deepseek/deepseek-v4.1-flash";
const key = process.env.COMMANDCODE_API_KEY;
if (!key) throw new Error("COMMANDCODE_API_KEY is not set");
const headersSeen = new Set();
const post = async (body) => {
  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, ...body }),
  });
  for (const [name, value] of response.headers) if (name === "retry-after" || name.startsWith("x-ratelimit")) headersSeen.add(`${name}: ${value}`);
  return { response, text: await response.text() };
};
const show = (label, value) => console.log(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
const tools = [{ type: "function", function: { name: "get_time", description: "Current time in a city.", parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } } }];
const ask = [{ role: "user", content: "What time is it in Paris? Use the tool." }];

// 1. Streaming with a tool call.
const first = await post({ messages: ask, tools, stream: true, stream_options: { include_usage: true }, max_tokens: 400 });
show("stream status", first.response.status);
show("stream content-type", first.response.headers.get("content-type"));
const lines = first.text.split("\n").filter((line) => line.trim() !== "");
lines.slice(0, 3).forEach((line, i) => show(`raw line ${i + 1}`, line.slice(0, 300)));
const fields = new Set();
const calls = [];
let finish = null;
let usage = null;
for (const line of lines) {
  if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
  let chunk;
  try { chunk = JSON.parse(line.slice(5)); } catch { continue; }
  usage = chunk.usage ?? usage;
  const choice = chunk.choices?.[0];
  finish = choice?.finish_reason ?? finish;
  for (const name of Object.keys(choice?.delta ?? {})) fields.add(name);
  for (const call of choice?.delta?.tool_calls ?? []) {
    calls[call.index ?? 0] ??= { id: call.id, type: "function", function: { name: "", arguments: "" } };
    calls[call.index ?? 0].function.name += call.function?.name ?? "";
    calls[call.index ?? 0].function.arguments += call.function?.arguments ?? "";
    calls[call.index ?? 0].id ??= call.id;
  }
}
show("delta fields", [...fields]);
show("finish_reason", finish);
show("usage", usage);
show("tool calls", calls);

// 2. The tool round without reasoning_content.
if (calls.length > 0) {
  const second = await post({ messages: [...ask, { role: "assistant", content: null, tool_calls: calls }, { role: "tool", tool_call_id: calls[0].id, content: "14:05" }], tools, max_tokens: 200 });
  show("second request (tool result, no reasoning_content) status", second.response.status);
  show("second request body", second.text.slice(0, 400));
} else show("second request", "skipped: the model made no tool call");

// 3. Errors the runtime will meet.
const huge = await post({ messages: ask, max_tokens: 10_000_000 });
show("oversized max_tokens", { status: huge.response.status, body: huge.text.slice(0, 500) });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
const image = await post({ messages: [{ role: "user", content: [{ type: "text", text: "What is in this image?" }, { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }] }], max_tokens: 50 });
show("image input", { status: image.response.status, body: image.text.slice(0, 500) });

// 4. Limits and context length.
show("retry-after / rate-limit headers", [...headersSeen]);
try {
  const listing = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } });
  const entry = (await listing.json()).data?.find((item) => item.id === model);
  const found = Object.entries(entry ?? {}).filter(([name]) => /context|window|max.*(token|length)/i.test(name));
  show("context length from /models", found.length > 0 ? Object.fromEntries(found) : `not reported (status ${listing.status}, ${entry ? "model listed" : "model not listed"})`);
} catch (error) {
  show("context length from /models", `not available: ${error.message}`);
}
