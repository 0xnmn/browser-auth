import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

/** Synthetic component preview, not an authentication HTTP API. */
export async function startUiPreview(port = 0) {
  const bundle = await build({
    entryPoints: [
      fileURLToPath(
        new URL("../packages/react/examples/gallery.tsx", import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    outdir: "preview",
    format: "esm",
    jsx: "automatic",
  });
  const script = bundle.outputFiles.find((file) =>
    file.path.endsWith(".js"),
  )!.contents;
  const css = bundle.outputFiles.find((file) =>
    file.path.endsWith(".css"),
  )!.contents;
  const server = createServer((request, response) => {
    response.setHeader("cache-control", "no-store");
    if (request.url === "/app.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(script);
    } else if (request.url === "/app.css") {
      response.setHeader("content-type", "text/css");
      response.end(css);
    } else {
      response.setHeader("content-type", "text/html");
      response.end(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser Auth preview</title><link rel="stylesheet" href="/app.css"><style>body{margin:0;background:#f3f5f8;color:#17202a;font:16px/1.5 system-ui}main{max-width:1120px;margin:auto;padding:28px}header{margin-bottom:28px}h1{font-size:32px;margin:8px 0}header p{margin:4px 0;color:#596579}.gallery{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px}.example-label{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:#596579}output{display:block;margin-top:8px;font-size:12px;color:#596579}@media(max-width:850px){.gallery{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:560px){.gallery{grid-template-columns:1fr}main{padding:16px}}</style></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`,
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(port, "0.0.0.0", resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
