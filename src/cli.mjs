// Commands for people: `npm run find -- <query> [query ...]` prints exactly
// what mql5_find returns, from the same code and the same index.
import { openIndex } from "./data.mjs";
import { findText } from "./find.mjs";

const [command, ...args] = process.argv.slice(2);
if (command !== "find") {
  console.error("Usage: npm run find -- <query> [query ...]");
  process.exit(2);
}
const index = await openIndex();
if (index.error) {
  console.error(index.error);
  process.exit(1);
}
console.log(findText(index.db, args, index));
index.db.close();
