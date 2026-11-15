// Runs INSIDE the container: a tiny site for the tests. Not part of the product.
//   /color?c=rrggbb   a page filled with one colour (the screenshots check its pixels)
//   /heavy            ~4000 DOM nodes and a painted canvas, a stand-in for an ordinary web page
//   /login?name=x     sets a persistent cookie "session=<name>" for this host
//   /whoami           echoes the cookie header
import { createServer } from "node:http";

const port = Number(process.env.FIXTURE_PORT ?? 9100);
const page = (body, style = "") => `<!doctype html><meta charset=utf-8><title>fixture</title><style>html,body{margin:0;height:100%}${style}</style>${body}`;
createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/color") {
    const colour = (url.searchParams.get("c") ?? "ff0000").replace(/[^0-9a-f]/gi, "").slice(0, 6);
    res.writeHead(200, { "content-type": "text/html" }).end(page(`<h1 style="color:white">colour ${colour}</h1>`, `body{background:#${colour}}`));
  } else if (url.pathname === "/heavy") {
    const items = Array.from({ length: 4000 }, (_, i) => `<li>item ${i} <b>bold</b></li>`).join("");
    const script =
      "const c=document.getElementById('c'),x=c.getContext('2d');for(let i=0;i<400;i++){x.fillStyle='hsl('+(i*7%360)+',70%,50%)';x.fillRect(i%40*50,Math.floor(i/40)*50,48,48)}";
    res.writeHead(200, { "content-type": "text/html" }).end(page(`<canvas id=c width=2000 height=1000></canvas><ul>${items}</ul><script>${script}</script>`));
  } else if (url.pathname === "/login") {
    res
      .writeHead(200, { "content-type": "text/html", "set-cookie": `session=${url.searchParams.get("name") ?? "anon"}; Max-Age=10000000; Path=/` })
      .end(page("<p>logged in</p>"));
  } else if (url.pathname === "/whoami") {
    res.writeHead(200, { "content-type": "text/plain" }).end(req.headers.cookie ?? "");
  } else {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1");
