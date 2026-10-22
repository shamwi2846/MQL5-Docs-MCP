// Stand-in for hh.exe in tests: `node fake-hh.mjs -decompile <out> <file.chm>`,
// run from the work folder. The "CHM" is a JSON plan: copy a folder of pages,
// then optionally remove text from pages, cut one page short, write a file
// next to the work folder, or hang. Like hh.exe, it produces nothing for a
// file it can't read.
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [, , flag, out, chm] = process.argv;
let plan = null;
try {
  plan = JSON.parse(readFileSync(chm, "utf8"));
} catch {
  // Unreadable: no output.
}
if (flag === "-decompile" && plan?.copy) {
  cpSync(plan.copy, out, { recursive: true });
  for (const [page, text] of Object.entries(plan.remove ?? {})) {
    writeFileSync(join(out, page), readFileSync(join(out, page), "latin1").replace(text, ""), "latin1");
  }
  if (plan.truncate) writeFileSync(join(out, plan.truncate), "<html><head><title>Cut</title></head><body>");
  if (plan.escape) writeFileSync(join("..", plan.escape), "outside");
} else if (plan?.hang) {
  setTimeout(() => {}, 60_000);
}
