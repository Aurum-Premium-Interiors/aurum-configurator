/*
 * Aurum configurator: the "from" price (L1).
 *
 * One function, used by the page (window.AurumPricing) and by tools/check-pricing.mjs (require/import),
 * so the website and the reference check can never disagree.
 *
 * All parameters live in pricing.json: SELL prices including 21% BTW only. Cost prices, margins and hours
 * never go in this repo (aurum-calculatie). How each number was derived is documented internally in
 * 0003-Aurum/Prijsboek/configurator-L1-parameters.md.
 *
 *   cabinets = per metre x metres x layout x island x fronts     (carcass, steel drawers, design, production,
 *                                                                 delivery and installation)
 *   worktop  = per metre x (metres x share of length) + fitting
 *   drawers  = wood surcharge per drawer x (metres x drawers per metre)
 *   + appliances (market price per package) + sink + tap
 *   x priceFactor (a commercial adjustment on top of the derived parameters; 1 = none)
 *   -> rounded DOWN to roundTo, never below minimumFrom.
 *
 * The result is deliberately a lower bound: it must never be higher than an L3 quote for the same layout.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.AurumPricing = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function pick(table, key, name) {
    if (!table || !(key in table)) throw new Error("pricing.json has no " + name + " for '" + key + "'");
    return Number(table[key]);
  }

  // answers: { meters, shape, island, front_shape, front_material, worktop, appliance_path, appliance_tier,
  //            hardware, sink, tap }
  // Returns null when the length is unknown, otherwise { total, raw, parts }.
  function compute(p, a) {
    var m = Number(a.meters);
    if (!isFinite(m) || m <= 0) return null;

    var fronts = p.fronts[a.front_shape];
    var cabinets = p.cabinets.perMetre * m
      * pick(p.layout, a.shape, "layout")
      * pick(p.island, a.island, "island")
      * pick(fronts, a.front_material, "front " + a.front_shape);

    var worktop = pick(p.worktop.perMetre, a.worktop, "worktop") * m * p.worktop.shareOfLength + p.worktop.fitting;
    var drawers = pick(p.drawers.surchargePerDrawer, a.hardware, "drawers") * m * p.drawers.perMetre;

    var appliances;
    if (a.appliance_path === "own") appliances = Number(p.appliances.own);
    else appliances = pick(p.appliances[a.appliance_path], a.appliance_tier, "appliances " + a.appliance_path);

    var sink = pick(p.sink, a.sink, "sink");
    var tap = pick(p.tap, a.tap, "tap");

    var f = p.priceFactor === undefined ? 1 : Number(p.priceFactor);
    var parts = { cabinets: cabinets * f, worktop: worktop * f, drawers: drawers * f, appliances: appliances * f, sink: sink * f, tap: tap * f };
    var raw = parts.cabinets + parts.worktop + parts.drawers + parts.appliances + parts.sink + parts.tap;
    var total = Math.max(Math.floor(raw / p.roundTo) * p.roundTo, p.minimumFrom);
    return { total: total, raw: raw, parts: parts };
  }

  return { compute: compute };
});
