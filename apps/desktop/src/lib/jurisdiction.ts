import { logAudit } from "./audit";
import { prefs } from "./prefs";

/** Cantonal-law scope: `commune` is reserved for a future municipal-law
 * milestone and always null today (see docs/swiss-legal-rag.md). */
export interface Jurisdiction {
  canton: string | null;
  commune: null;
}

const DEFAULT_JURISDICTION: Jurisdiction = { canton: null, commune: null };

// Cantons with an ingested corpus, matching the backend's coverage. Widen
// this list as corpus.yaml grows (Phase 2).
export const COVERED_CANTONS = ["BE", "SG"] as const;

export function getJurisdiction(): Jurisdiction {
  return prefs.get("jurisdiction", DEFAULT_JURISDICTION);
}

export function setJurisdiction(next: Jurisdiction): void {
  const from = getJurisdiction();
  prefs.set("jurisdiction", next);
  logAudit("settings.jurisdiction", { from, to: next });
}

// All 26 cantons, official endonyms (the language the canton itself uses in
// its official name — not translated per UI locale).
export const CANTONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: "ZH", name: "Zürich" },
  { code: "BE", name: "Bern" },
  { code: "LU", name: "Luzern" },
  { code: "UR", name: "Uri" },
  { code: "SZ", name: "Schwyz" },
  { code: "OW", name: "Obwalden" },
  { code: "NW", name: "Nidwalden" },
  { code: "GL", name: "Glarus" },
  { code: "ZG", name: "Zug" },
  { code: "FR", name: "Fribourg" },
  { code: "SO", name: "Solothurn" },
  { code: "BS", name: "Basel-Stadt" },
  { code: "BL", name: "Basel-Landschaft" },
  { code: "SH", name: "Schaffhausen" },
  { code: "AR", name: "Appenzell Ausserrhoden" },
  { code: "AI", name: "Appenzell Innerrhoden" },
  { code: "SG", name: "St. Gallen" },
  { code: "GR", name: "Graubünden" },
  { code: "AG", name: "Aargau" },
  { code: "TG", name: "Thurgau" },
  { code: "TI", name: "Ticino" },
  { code: "VD", name: "Vaud" },
  { code: "VS", name: "Valais" },
  { code: "NE", name: "Neuchâtel" },
  { code: "GE", name: "Genève" },
  { code: "JU", name: "Jura" },
];
