// Runs a session whose first model turn calls a tool that never returns, sends one signal that the run cannot read,
// prints READY and waits to be killed. The parent test kills it with SIGKILL and restarts the box.
import { createRig, loadPlugins } from "../../src/testing/index.ts";
import { gatedPlugin } from "../helpers.ts";

const [root, pluginRoot] = process.argv.slice(2) as [string, string];
const g = globalThis as Record<string, unknown>;
g.__ogbGate = new Promise(() => {}); // the tool never returns
g.__ogbStarted = () => {};

const rig = createRig({
  root,
  plugins: loadPlugins(gatedPlugin(pluginRoot)),
  profiles: { default: "p", profiles: { p: { plugins: ["demo"], alwaysDeclaredTools: ["gated"] } } },
  script: (_request, index) => (index === 0 ? { toolCalls: [{ name: "gated", args: {} }] } : { text: "unreachable in the child" }),
});
const { id } = await rig.runtime.createSession({ title: "Crash me" });
await rig.runtime.send(id, "start work", "msg-1");
for (let waited = 0; rig.faux.requests.length < 1 && waited < 5000; waited += 20) await new Promise((r) => setTimeout(r, 20));
await new Promise((r) => setTimeout(r, 200)); // let the tool call begin
await rig.runtime.signal(id, { id: "mail-1", source: "plugin:mail", text: "mail during crash" });
console.log(`READY ${id}`);
setInterval(() => {}, 1000);
