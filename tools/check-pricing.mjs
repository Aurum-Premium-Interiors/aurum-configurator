// Checks the configurator's "from" price against real Aurum quotes (the L1 invariant from aurum-calculatie):
// the website may never show MORE than what an L3 quote or a comparable sale for the same layout actually
// came to. A "from" price above a real quote means the parameters are stale.
//
// The reference kitchens hold client names and sold prices, so they live OUTSIDE this repo:
//   node tools/check-pricing.mjs "<OneDrive>/0003-Aurum/Prijsboek/configurator-referenties.json"
// Exit code 1 when a check fails.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { compute } = require(join(here, "..", "site", "pricing.js"));
const pricing = JSON.parse(readFileSync(join(here, "..", "site", "pricing.json"), "utf8"));

const refPath = process.argv[2];
if (!refPath) {
  console.error("Usage: node tools/check-pricing.mjs <configurator-referenties.json>");
  process.exit(2);
}
const refs = JSON.parse(readFileSync(refPath, "utf8")).keukens;
const eur = (n) => "€ " + Math.round(n).toLocaleString("nl-NL");

let failed = 0;
for (const k of refs) {
  const r = compute(pricing, k.antwoorden);
  const w = k.werkelijk || {};
  let verdict = "info";
  let against = "";
  if (w.soort === "L3" || w.soort === "verkocht") {
    against = eur(w.bedrag);
    verdict = r.total <= w.bedrag ? "OK" : "FOUT: vanaf-prijs hoger dan " + w.soort;
  } else if (w.soort === "L2") {
    against = eur(w.van) + " – " + eur(w.tot);
    verdict = r.total <= w.van ? "OK" : "FOUT: vanaf-prijs boven de ondergrens van de L2-band";
  } else if (w.bedrag) {
    against = eur(w.bedrag) + " (" + w.soort + ")";
  } else {
    against = w.soort || "";
  }
  if (verdict.startsWith("FOUT")) failed++;
  console.log(`${verdict.padEnd(4)}  ${k.naam.padEnd(40)} vanaf ${eur(r.total).padStart(10)}   werkelijk ${against}`);
}
if (failed) {
  console.error(`\n${failed} referentie(s) onder de vanaf-prijs: parameters in site/pricing.json zijn verouderd.`);
  process.exit(1);
}
