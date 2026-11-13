// Runs backend/Code.gs in Node with fake Google services, to check the spam rules without deploying.
//   node tools/test-lead-script.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const here = dirname(fileURLToPath(import.meta.url));
const code = readFileSync(join(here, "..", "backend", "Code.gs"), "utf8");
const siteData = readFileSync(join(here, "..", "site", "data.json"), "utf8");

function sandbox() {
  const sent = [], rows = [], props = {}, cache = {};
  const sheet = {
    getLastColumn: () => 3, getRange: () => ({ getValues: () => [["Received", "Name", "Email"]], setValue() {}, setFormula() {} }),
    appendRow: (r) => rows.push(r), setFrozenRows() {}
  };
  const ctx = {
    console: { log() {}, warn() {}, error() {} },
    ContentService: { createTextOutput: (s) => ({ setMimeType: () => s, s }), MimeType: { JSON: "json" } },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheets: () => [sheet], getSheetByName: () => sheet, insertSheet: () => sheet, getUrl: () => "sheet-url" }) },
    MailApp: { sendEmail: (m) => sent.push(m) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k] ?? null, setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] ?? null, put: (k, v) => { cache[k] = v; } }) },
    UrlFetchApp: { fetch: () => ({ getResponseCode: () => 200, getContentText: () => siteData }) },
    DriveApp: { getFileById: () => ({ getBlob: () => ({ setName: () => ({}) }) }) },
    Utilities: { formatDate: () => "2026-11-13" },
  };
  vm.createContext(ctx);
  vm.runInContext(code.replace('var SITE_DATA_URL = "";', 'var SITE_DATA_URL = "https://example.test/data.json";'), ctx);
  const post = (obj) => JSON.parse(ctx.doPost({ postData: { contents: JSON.stringify(obj) } }));
  return { ctx, post, sent, rows };
}

const lead = (extra = {}) => ({
  Received: "2026-11-13", Name: "Petra de Vries", Email: "petra@example.nl", Phone: "",
  _lang: "nl", _style: "scandi_japandi", _budget: 48000, _hp: "", _ms: 25000,
  _answers: { location: "noord_holland", stage: "in_design", shape: "straight", island: "yes", meters: "8.2",
    front_shape: "flat", front_material: "veneer", worktop: "ceramic", appliance_path: "built_in",
    appliance_tier: "upper_midrange", hardware: "wood", sink: "stainless", tap: "standard" },
  ...extra,
});

let t = sandbox();
t.post(lead());
assert.equal(t.rows.length, 1, "a real lead is saved");
assert.equal(t.sent.length, 2, "Anna + client email");
const client = t.sent[1];
assert.equal(client.to, "petra@example.nl");
assert.match(client.subject, /Scandinavisch|Scandi|Japandi/i);
assert.match(client.body, /Hallo Petra de Vries,/);
assert.match(client.body, /€ 48\.000/);
assert.match(client.body, /8,2 m/);
console.log("ok  real lead: saved, Anna notified, Dutch confirmation built from data.json");

t = sandbox();
t.post(lead({ _hp: "http://spam" }));
assert.equal(t.rows.length + t.sent.length, 0);
console.log("ok  honeypot filled: nothing saved, nothing sent");

t = sandbox();
t.post(lead({ _ms: 800 }));
assert.equal(t.rows.length + t.sent.length, 0);
console.log("ok  sent within a second: dropped");

t = sandbox();
t.post(lead({ Email: "not-an-address" }));
assert.equal(t.rows.length + t.sent.length, 0);
console.log("ok  invalid email: dropped");

t = sandbox();
t.post(lead({ Email: "victim@example.com", Name: "Cheap pills at www.spam.example",
  _email: { to: "other@example.com", subject: "BUY NOW", text: { intro: "spam text" } },
  _style: "<script>", _budget: 1, _answers: { worktop: "<b>free text</b>", meters: "99999" } }));
const mail = t.sent[1];
assert.equal(mail.to, "victim@example.com", "only the lead's own address");
assert.doesNotMatch(mail.subject + mail.body + mail.htmlBody, /BUY NOW|spam text|spam\.example|free text|<script>/);
assert.match(mail.body, /^Hallo,/);
console.log("ok  forged texts, recipient, style, budget and answers are all ignored");

t = sandbox();
for (let i = 0; i < 3; i++) t.post(lead());
assert.equal(t.sent.filter((m) => m.to === "petra@example.nl").length, 1);
console.log("ok  one confirmation per address per 6 hours");

t = sandbox();
for (let i = 0; i < 60; i++) t.post(lead({ Email: `p${i}@example.nl` }));
assert.equal(t.sent.filter((m) => m.to !== "anna@auruminteriors.nl").length, 40);
console.log("ok  daily cap of 40 confirmations");

t = sandbox();
t.post({ _type: "event", event: "=HYPERLINK(\"x\")", session: "a" });
t.post({ _type: "event", event: "03 layout", session: "abc", lang: "nl", source: "=cmd" });
assert.equal(t.rows.length, 1);
assert.equal(t.rows[0][4], "'=cmd");
console.log("ok  funnel accepts only real step names and neutralises formulas");
