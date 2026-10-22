// Loaded into every Node process of the npm tests (NODE_OPTIONS --import).
// Run as claude.exe (a copy of node.exe), it acts as the claude CLI through
// fake-client.mjs: Node itself answers --version, and the first argument
// ("mcp") arrives as the script path. In every other process it blocks
// network access, so the tests prove nothing is downloaded.
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

if (basename(process.execPath).toLowerCase() === "claude.exe") {
  const args = [basename(process.argv[1] ?? ""), ...process.argv.slice(2)];
  process.argv = [process.execPath, "fake-client.mjs", process.env.MQL5_DOCS_TEST_REGISTRY, "claude", ...args];
  await import(pathToFileURL(join(import.meta.dirname, "fake-client.mjs")).href);
  process.exit(process.exitCode ?? 0); // before Node tries to load "mcp" as a script
} else {
  globalThis.fetch = async () => {
    throw new Error("network access is blocked in this test");
  };
}
