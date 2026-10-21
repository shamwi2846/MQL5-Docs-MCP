// Small configuration shared by the indexer, the ranking and the checks.
import { readFileSync } from "node:fs";
import { join } from "node:path";

const configFile = (name) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "config", name), "utf8"));

// Pages whose tables repeat constants defined elsewhere ("List of MQL5 Constants").
export const SUMMARY_PAGES = new Set(configFile("summary-pages.json").pages);

export const loadBaseline = () => configFile("baseline.json");

// Phrase expansions for questions ("open a trade" adds OrderSend, CTrade::Buy ...).
export const EXPANSIONS = configFile("expansions.json").expansions;
