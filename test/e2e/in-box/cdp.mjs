// Runs INSIDE the container. Reads one JSON request on stdin and prints one JSON result.
//   { port, navigate?: url, calls?: [{ method, params }] }
// It attaches to the first page of the browser on 127.0.0.1:<port> over the DevTools protocol, optionally navigates and waits for load,
// then makes each call on that page and prints the results in order. Large results (screenshots) are returned as is.
let input = "";
for await (const chunk of process.stdin) input += chunk;
const { port, navigate, calls = [] } = JSON.parse(input);

const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
let target = list.find((t) => t.type === "page");
if (!target) target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = () => reject(new Error("cannot open the DevTools socket"));
});
let nextId = 0;
const waiting = new Map();
const events = [];
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) waiting.get(message.id)?.(message);
  else events.push(message.method);
};
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 60_000);
    waiting.set(id, (message) => {
      clearTimeout(timer);
      message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolve(message.result);
    });
    ws.send(JSON.stringify({ id, method, params }));
  });

if (navigate) {
  await send("Page.enable");
  events.length = 0;
  await send("Page.navigate", { url: navigate });
  for (let i = 0; i < 600 && !events.includes("Page.loadEventFired"); i++) await new Promise((r) => setTimeout(r, 50));
}
const results = [];
for (const call of calls) results.push(await send(call.method, call.params));
ws.close();
process.stdout.write(JSON.stringify(results));
