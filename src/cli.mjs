// Commands for people:
//   npm run find -- <query> [query ...]   prints exactly what mql5_find returns
//   npm run docs:update [-- --accept-loss]
//   npm run docs:status
import { dataDir, isEntry, openIndex } from "./data.mjs";

const USAGE = "Usage: npm run find -- <query> [query ...] | npm run docs:update [-- --accept-loss] | npm run docs:status";

// Runs one command and returns its exit code. `update` passes test inputs
// (downloads, unpacker, baseline) through to the updater.
export async function runCommand(command, args, { dir = dataDir(), log = console.log, warn = console.error, update = {} } = {}) {
  if (command === "docs:update") {
    const updater = await import("./docs-update.mjs");
    try {
      await updater.update({ dir, acceptLoss: args.includes("--accept-loss"), log, ...update });
      return 0;
    } catch (error) {
      if (!(error instanceof updater.UpdateError)) throw error;
      warn(error.message);
      return 1;
    }
  }
  if (command !== "find" && command !== "docs:status") {
    warn(USAGE);
    return 2;
  }
  const index = await openIndex(dir);
  if (index.error) {
    warn(index.error);
    return 1;
  }
  try {
    if (command === "find") {
      const { findText } = await import("./find.mjs");
      log(findText(index.db, args, index));
    } else {
      // The pointer the index was opened from, so a concurrent update can't mix two versions.
      const { current, db } = index;
      const count = (sql) => db.prepare(sql).all().map((row) => `${row.key} ${row.n}`).join(", ");
      log(`MQL5 docs downloaded ${current.downloaded} · index ${index.tag} (${current.index}) · format ${current.schema_version}`
        + ` · built by ${current.builder_version}`);
      log(`pages: ${count("select source as key, count(*) as n from pages group by source order by n desc")}`);
      log(`cards: ${count("select kind as key, count(*) as n from cards group by kind order by n desc")}`);
      log(`names: ${db.prepare("select count(*) as n from names").get().n}`);
    }
    return 0;
  } finally {
    index.db.close();
  }
}

if (isEntry(import.meta)) process.exitCode = await runCommand(process.argv[2], process.argv.slice(3));
