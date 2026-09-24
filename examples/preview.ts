import { startUiPreview } from "./ui-server.js";

await startUiPreview(4173);
process.stdout.write(
  "Browser Auth synthetic component preview listening on port 4173\n",
);
