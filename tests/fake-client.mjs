// Stand-in for the claude and codex CLIs in setup tests:
//   node fake-client.mjs <registry.json> <claude|codex> --version | mcp get|add|remove ...
// Entries live in the registry file. registry.fail maps "<client> <verb>"
// to the numbers of the calls that fail (1 = the first such call), so a test
// can fail the new entry's add but let the restoring add succeed.
// registry.unavailable lists clients that act as not installed.
// registry.olderClaude makes claude report a missing entry as Claude Code
// 2.1.114 does. Like the real claude, its -e takes every value up to the
// next option. registry.shadowed[client] lists entries in scopes the shown
// one hides (claude shows local before project before user): removing the
// shown entry reveals the next.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const [, , file, client, ...args] = process.argv;
const registry = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
registry[client] ??= {};
registry.calls ??= {};
const save = () => writeFileSync(file, JSON.stringify(registry, null, 2));
const out = (text) => process.stdout.write(`${text}\n`);

if (registry.unavailable?.includes(client)) {
  process.stderr.write(`'${client}' is not recognized as a command\n`);
  process.exit(1);
}
if (args[0] === "--version") {
  out(`${client} 1.0 (stand-in)`);
  process.exit(0);
}
const [, verb, ...rest] = args;
const key = `${client} ${verb}`;
registry.calls[key] = (registry.calls[key] ?? 0) + 1;
save();
if (registry.fail?.[key]?.includes(registry.calls[key])) {
  process.stderr.write(`${verb} failed (stand-in)\n`);
  process.exit(1);
}
if (verb === "get") {
  const entry = registry[client][rest[0]];
  if (!entry) {
    if (client === "codex") out(`Error: No MCP server named '${rest[0]}' found.`);
    else out(registry.olderClaude ? `No MCP server found with name: ${rest[0]}` : `No MCP server named "${rest[0]}". Configured servers:`);
    process.exit(1);
  }
  if (client === "codex") {
    out(JSON.stringify({ name: rest[0], transport: { type: "stdio", command: entry.command, args: entry.args, env: entry.env } }));
  } else {
    out(`${rest[0]}:\n  Scope: ${entry.scope === "user" ? "User config (available in all your projects)" : "Local config"}\n`
      + `  Status: √ Connected\n  Type: stdio\n  Command: ${entry.command}\n  Args: ${entry.args.join(" ")}\n  Environment:`
      + Object.entries(entry.env ?? {}).map(([name, value]) => `\n    ${name}=${value}`).join(""));
  }
} else if (verb === "remove") {
  delete registry[client][rest[0]];
  const hidden = registry.shadowed?.[client]?.shift();
  if (hidden) registry[client][rest[0]] = hidden;
  save();
} else if (verb === "add") {
  const dash = rest.indexOf("--");
  const options = rest.slice(0, dash);
  const env = {};
  const names = [];
  let scope = null;
  for (let i = 0; i < options.length; i++) {
    if (options[i] === "-s") scope = options[++i];
    else if (options[i] === "-e" || options[i] === "--env") {
      // codex: one value per --env; claude: values up to the next option.
      const values = [];
      do values.push(options[++i]);
      while (client === "claude" && i + 1 < options.length && !options[i + 1].startsWith("-"));
      for (const value of values) {
        const at = value.indexOf("=");
        if (at < 1) {
          process.stderr.write(`Invalid environment variable format: ${value}\n`);
          process.exit(1);
        }
        env[value.slice(0, at)] = value.slice(at + 1);
      }
    } else names.push(options[i]);
  }
  if (names.length !== 1) {
    process.stderr.write("error: missing required argument 'name'\n");
    process.exit(1);
  }
  const [command, ...commandArgs] = rest.slice(dash + 1);
  registry[client][names[0]] = { scope, command, args: commandArgs, env };
  save();
}
