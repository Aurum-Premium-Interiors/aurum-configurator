/**
 * Aurum kitchen configurator -> Google Sheet "Aurum configurator leads"
 *
 * What it does:
 *  1. Every lead becomes one row on the first tab. Columns are matched by the header in row 1;
 *     a field without a column gets a new column at the end. Fields starting with "_" are never written.
 *  2. Anonymous step counts go to a "Funnel" tab, with a "Funnel summary" tab that counts visitors per step.
 *  3. Anna gets a short notification email for every lead.
 *  4. The client gets a confirmation email with their choices and starting budget, in their language.
 *
 * Spam protection (v0.4). This endpoint is public, so anyone can POST to it. Therefore:
 *  - The client email is written HERE, from the published data.json (SITE_DATA_URL). The browser only sends
 *    answer ids, a style id and a number; never a subject, a text or a recipient other than the lead's own address.
 *    Nobody can use this script to send their own text from the Aurum account.
 *  - A hidden field that only bots fill in, and a minimum time on the form, drop automated submissions silently.
 *  - At most one confirmation per email address per 6 hours, and at most MAX_CLIENT_EMAILS_PER_DAY in total.
 *  - A name that looks like a link is left out of the greeting.
 *
 * Setup: Extensions > Apps Script, paste this file into Code.gs. Project Settings > Script properties:
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS   (optional; never put the token in this file or in git)
 * Set SITE_DATA_URL below to the live data.json. Save. Deploy > Manage deployments > edit > Version: New version
 * (the URL stays the same, so data.json -> contact.leadEndpoint does not change).
 * Until SITE_DATA_URL is set, leads are still saved and Anna is notified, but no client email is sent.
 */

var SITE_DATA_URL = "";                         // e.g. "https://configurator.auruminteriors.nl/data.json"
var NOTIFY_EMAIL = "anna@auruminteriors.nl";    // Gets a message for every new lead. "" switches it off.
var SEND_CLIENT_EMAIL = true;                   // Confirmation email to the client. false switches it off.
var REPLY_TO = "anna@auruminteriors.nl";        // Where the client's reply lands.
var SENDER_NAME = "Aurum Premium Interiors";
var MAX_CLIENT_EMAILS_PER_DAY = 40;             // Hard cap on confirmations per day, whatever happens.
var MIN_FILL_MS = 3000;                         // A person needs longer than this to fill in the form.
var MAX_BODY = 20000;                           // Characters; a real lead is about 3,000.

// Telegram push for every new lead, from Script properties (see Setup). Empty switches it off.
// TELEGRAM_CHAT_IDS can hold several ids (Anna, Mathieu, a group), separated by commas.
// Setup: create the bot with @BotFather, put its token in the script properties, send the bot any message,
// then run telegramFindChatId once (select it at the top, press Run) and copy the id from the log.
// Switching Telegram on means lead details go to Telegram too: add that to the privacy statement first.
function prop_(name) { return PropertiesService.getScriptProperties().getProperty(name) || ""; }

function doGet() {
  return ContentService.createTextOutput("Aurum configurator endpoint is running.");
}

function doPost(e) {
  var raw = (e && e.postData && e.postData.contents) || "";
  if (raw.length > MAX_BODY) return json_({ ok: false });
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var data = JSON.parse(raw);
    if (data._type === "event") { logEvent_(data); return json_({ ok: true }); }

    // Bots: answer "ok" so they learn nothing, but keep nothing.
    if (data._hp) return json_({ ok: true });
    if (typeof data._ms === "number" && data._ms < MIN_FILL_MS) return json_({ ok: true });
    if (!isValidEmail_(data["Email"])) return json_({ ok: true });

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheets()[0];
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    Object.keys(data).forEach(function (k) {
      if (k.charAt(0) === "_") return;
      if (headers.indexOf(k) === -1) { headers.push(k); sheet.getRange(1, headers.length).setValue(k); }
    });
    var row = headers.map(function (h) {
      var v = data[h];
      if (v === undefined || v === null) return "";
      if (typeof v === "object") v = JSON.stringify(v);
      if (typeof v === "string") {
        v = v.slice(0, 500);
        if (/^[=+\-@]/.test(v)) return "'" + v; // "+31 6..." must stay text, and no formulas from outside
      }
      return v;
    });
    sheet.appendRow(row);

    // The row is saved first. Each message below runs on its own, so one failing never stops the others.
    try { if (prop_("TELEGRAM_BOT_TOKEN") && prop_("TELEGRAM_CHAT_IDS")) notifyTelegram_(data, ss.getUrl()); } catch (t) { console.error("Telegram: " + t); }
    try { if (NOTIFY_EMAIL) notifyAnna_(data, ss.getUrl()); } catch (m) { console.error("Notify email: " + m); }
    try { if (SEND_CLIENT_EMAIL) sendClientEmail_(data); } catch (c) { console.error("Client email: " + c); }

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- checks ---------- */
function isValidEmail_(v) {
  return typeof v === "string" && v.length <= 120 && /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/.test(v);
}
// A name is greeted only if it looks like a name: no links, no addresses, no markup, not too long.
function cleanName_(v) {
  var s = String(v || "").replace(/\s+/g, " ").trim();
  if (s.length < 2 || s.length > 60) return "";
  if (/https?:|www\.|@|<|>|\/\/|\.[a-z]{2,}(\/|\b)/i.test(s)) return "";
  return s;
}
// The budget can only be a round figure in a sensible range; anything else is shown as "not known".
function cleanBudget_(v) {
  return typeof v === "number" && isFinite(v) && v >= 5000 && v <= 2000000 && v % 100 === 0 ? v : null;
}
// One confirmation per address per 6 hours, and a daily cap overall.
function allowClientEmail_(address) {
  var cache = CacheService.getScriptCache();
  var key = "sent:" + address.toLowerCase();
  if (cache.get(key)) return false;
  var props = PropertiesService.getScriptProperties();
  var dayKey = "mailcount:" + Utilities.formatDate(new Date(), "Europe/Amsterdam", "yyyy-MM-dd");
  var count = Number(props.getProperty(dayKey) || 0);
  if (count >= MAX_CLIENT_EMAILS_PER_DAY) return false;
  props.setProperty(dayKey, String(count + 1));
  cache.put(key, "1", 21600);
  return true;
}

/* ---------- funnel ---------- */
function logEvent_(d) {
  var event = String(d.event || "");
  if (!/^\d{2} [a-z0-9_ ]{1,40}$/i.test(event)) return; // only the configurator's own step names
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Funnel");
  if (!sh) {
    sh = ss.insertSheet("Funnel");
    sh.appendRow(["At", "Session", "Step", "Language", "Source"]);
    sh.setFrozenRows(1);
  }
  var clip = function (v, n) { v = String(v || "").slice(0, n); return /^[=+\-@]/.test(v) ? "'" + v : v; };
  sh.appendRow([new Date().toISOString(), clip(d.session, 12), event, clip(d.lang, 5), clip(d.source, 60)]);
  if (!ss.getSheetByName("Funnel summary")) {
    var sum = ss.insertSheet("Funnel summary");
    sum.getRange("A1").setValue("Visitors per step (each visit counted once per step)");
    sum.getRange("A3").setFormula("=QUERY(Funnel!A:E, \"select C, count(B) where C is not null group by C order by C label C 'Step', count(B) 'Visitors'\", 1)");
  }
}

/* ---------- telegram ---------- */
function notifyTelegram_(data, sheetUrl) {
  var flags = [];
  if (data["Client type"] && data["Client type"] !== "Homeowner") flags.push(data["Client type"]);
  if (data["Priority follow-up"] === "Yes") flags.push("priority");
  var budget = data["Starting budget (EUR)"];
  var lines = [
    "New Aurum lead" + (flags.length ? " (" + flags.join(", ") + ")" : ""),
    "",
    (data["Name"] || "") + (data["Location"] ? ", " + data["Location"] : ""),
    "Style: " + (data["Style"] || ""),
    "Budget: " + (typeof budget === "number" ? "from €" + budget.toLocaleString("nl-NL") : (budget || "not shown")),
    "Timing: " + (data["Timing"] || "Not given"),
    "Phone: " + (data["Phone"] || ""),
    "Email: " + (data["Email"] || ""),
    "Source: " + (data["Source"] || "direct"),
    "",
    sheetUrl
  ];
  var token = prop_("TELEGRAM_BOT_TOKEN");
  prop_("TELEGRAM_CHAT_IDS").split(",").forEach(function (id) {
    id = id.trim();
    if (!id) return;
    UrlFetchApp.fetch("https://api.telegram.org/bot" + token + "/sendMessage", {
      method: "post",
      payload: { chat_id: id, text: lines.join("\n"), disable_web_page_preview: "true" },
      muteHttpExceptions: true
    });
  });
}

// Run once by hand after sending your bot a message: it writes the chat id of everyone who wrote to it to the log.
function telegramFindChatId() {
  var r = UrlFetchApp.fetch("https://api.telegram.org/bot" + prop_("TELEGRAM_BOT_TOKEN") + "/getUpdates", { muteHttpExceptions: true });
  var res = JSON.parse(r.getContentText());
  if (!res.ok) { console.log("Token not accepted: " + r.getContentText()); return; }
  var seen = {};
  res.result.forEach(function (u) {
    var c = (u.message || u.channel_post || {}).chat;
    if (c && !seen[c.id]) { seen[c.id] = 1; console.log("Chat id " + c.id + "  (" + (c.first_name || c.title || "") + ")"); }
  });
  if (!Object.keys(seen).length) console.log("No messages yet. Open your bot in Telegram, press Start or send 'hi', then run this again.");
}

// Run by hand to check the alert reaches your phone, without a real lead.
function telegramTest() {
  notifyTelegram_({ "Name": "Test lead", "Location": "Amsterdam", "Style": "Classic", "Starting budget (EUR)": 52000,
    "Timing": "Within 3 months", "Phone": "+31 6 00000000", "Email": "test@example.com", "Source": "test" },
    SpreadsheetApp.getActiveSpreadsheet().getUrl());
}

/* ---------- emails ---------- */
function notifyAnna_(data, sheetUrl) {
  var flags = [];
  if (data["Client type"] && data["Client type"] !== "Homeowner") flags.push(data["Client type"]);
  if (data["Priority follow-up"] === "Yes") flags.push("priority");
  if (data["Timing"] && data["Timing"] !== "Not given") flags.push(data["Timing"]);
  var clip = function (v) { return String(v || "").slice(0, 200); };
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: "New configurator lead: " + clip(data["Name"]).slice(0, 60) + (flags.length ? " (" + flags.join(", ") + ")" : ""),
    body: [
      "Name: " + clip(data["Name"]),
      "Email: " + clip(data["Email"]),
      "Phone: " + clip(data["Phone"]),
      "Client type: " + clip(data["Client type"]),
      "Timing: " + clip(data["Timing"]),
      "Location: " + clip(data["Location"]),
      "Style: " + clip(data["Style"]),
      "Length: " + clip(data["Length (m)"]),
      "Starting budget: " + clip(data["Starting budget (EUR)"]),
      "Source: " + clip(data["Source"]) + (data["Campaign"] ? " / " + clip(data["Campaign"]) : ""),
      "",
      sheetUrl
    ].join("\n")
  });
}

// The published data.json: texts, questions, styles and contact details. Cached for an hour.
function siteData_() {
  if (!SITE_DATA_URL) return null;
  var cache = CacheService.getScriptCache();
  var hit = cache.get("sitedata");
  if (hit) return JSON.parse(hit);
  var r = UrlFetchApp.fetch(SITE_DATA_URL + "?v=" + Date.now(), { muteHttpExceptions: true });
  if (r.getResponseCode() !== 200) { console.error("data.json: HTTP " + r.getResponseCode()); return null; }
  var text = r.getContentText();
  try { cache.put("sitedata", text, 3600); } catch (e) { /* larger than the cache limit: fetch each time */ }
  return JSON.parse(text);
}

function euro_(n, lang) {
  var s = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, lang === "nl" ? "." : ",");
  return lang === "nl" ? "€ " + s : "€" + s;
}

// The client's choices as [question, answer] rows, rebuilt from the answer ids with the site's own labels.
// An id that is not in data.json is simply left out, so no free text from the browser reaches the email.
function choiceRows_(c, answers) {
  answers = answers && typeof answers === "object" ? answers : {};
  var label = function (groupId, optionId) {
    var out = "";
    c.questions.forEach(function (q) { q.groups.forEach(function (g) {
      if (g.id === groupId && g.options) g.options.forEach(function (o) { if (o.id === optionId) out = o.label; });
    }); });
    return out;
  };
  return c.questions.map(function (q) {
    var parts = [];
    q.groups.forEach(function (g) {
      if (g.type === "number") {
        if (answers[g.id + "_unknown"] === true) { parts.push(g.unsureSummary || "—"); return; }
        var n = Number(answers[g.id]);
        if (isFinite(n) && n >= g.min && n <= g.max) parts.push(String(Math.round(n * 10) / 10).replace(".", ",") + " " + g.unit);
      } else {
        var l = label(g.id, String(answers[g.id] || ""));
        if (l) parts.push(l);
      }
    });
    return [q.summary, parts.join(", ")];
  });
}

function sendClientEmail_(data) {
  var to = data["Email"];
  var site = siteData_();
  if (!site) { console.warn("Client email not sent: SITE_DATA_URL is empty or data.json did not load."); return; }
  var lang = site.content[data._lang] ? data._lang : (site.defaultLang || "en");
  var c = site.content[lang];
  if (!c || !c.email) return;
  if (!allowClientEmail_(to)) { console.warn("Client email not sent: throttled for this address or daily cap reached."); return; }

  var style = c.styles[data._style] || null;
  var budget = cleanBudget_(data._budget);
  var name = cleanName_(data["Name"]);
  var e = c.email;
  var m = {
    lang: lang,
    to: to,
    name: name,
    subject: (e.subject || "").replace("{style}", style ? style.name : "").replace(/:\s*$/, ""),
    style: style ? style.name : "",
    styleId: style ? data._style : "",
    imageCaption: (c.result && c.result.imageCaption) || "",
    styleDescription: style ? style.description : "",
    budgetKnown: budget !== null,
    budget: budget !== null ? c.budget.prefix + " " + euro_(budget, lang) : "",
    choices: choiceRows_(c, data._answers),
    phone: (site.contact && site.contact.phoneDisplay) || "",
    whatsapp: "https://wa.me/" + ((site.contact && site.contact.whatsapp) || ""),
    text: e
  };
  MailApp.sendEmail({
    to: to,
    subject: m.subject,
    body: buildClientText_(m),
    htmlBody: buildClientEmail_(m),
    name: SENDER_NAME,
    replyTo: REPLY_TO,
    inlineImages: inlineImages_(m)
  });
}

// Email images live on Drive, in "Configurator email images (used by the lead script)".
// To swap a photo, upload a new file there with the same name, or change an id below.
var EMAIL_IMAGE_IDS = {
  logo: "1tO7Hygc7618ufXxU9h2kESAIDNkYU4Wa",
  modern: "1BtG4_ND41IozEG_NUTex6mCZVYDsA0Q5",
  scandi_japandi: "1xW9bYe-xUXt7ksb8S0IOOQDOUAQn96XK",
  classic: "14T8xPYJAftzjGg7Sg_osB3zd24iWv6im",
  country: "1ZRr1s4PdAfVGQCDQM88z1TVolCPTpoxC",
  industrial: "1rBmkJ3qpfW6DO1dPb4eodyAAPjfkXY6F"
};
function driveBlob_(id, name) {
  try { return DriveApp.getFileById(id).getBlob().setName(name); } catch (e) { console.error("Image " + name + ": " + e); return null; }
}
function inlineImages_(m) {
  var imgs = {};
  var logo = driveBlob_(EMAIL_IMAGE_IDS.logo, "aurum-logo.png");
  if (logo) imgs.aurumlogo = logo;
  if (hasStylePhoto_(m)) {
    var photo = driveBlob_(EMAIL_IMAGE_IDS[m.styleId], m.styleId + ".jpg");
    if (photo) imgs.stylephoto = photo;
  }
  return imgs;
}
function hasStylePhoto_(m) {
  return !!(m.styleId && EMAIL_IMAGE_IDS.hasOwnProperty(m.styleId) && m.styleId !== "logo");
}
function esc_(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
// "Hello {name}," without a usable name becomes "Hello,".
function greeting_(t, name) {
  return name ? t.greeting.replace("{name}", name) : t.greeting.replace(/\s*\{name\}/, "");
}

function buildClientText_(m) {
  var t = m.text;
  var lines = [
    greeting_(t, m.name), "",
    t.intro, "",
    t.styleLabel + ": " + m.style,
    t.budgetLabel + ": " + (m.budgetKnown ? m.budget : t.budgetUnknown),
    m.budgetKnown ? t.budgetNote : "", "",
    t.choicesLabel + ":"
  ];
  m.choices.forEach(function (c) { lines.push("- " + c[0] + ": " + c[1]); });
  lines.push("", t.nextLabel + ":", t.next, "", t.questions.replace("{phone}", m.phone), "",
    t.signoff, t.signature, t.signatureRole, "", t.footer);
  return lines.join("\n");
}

// Aurum style: stone background #EBEAE7, navy #0F2B44, accent #6E7D8E, hairlines #D6D5D1.
// Serif headings, no bold, no gold, square corners, uppercase labels with wide tracking.
function buildClientEmail_(m) {
  var t = m.text;
  var NAVY = "#0F2B44", STONE = "#EBEAE7", ACCENT = "#6E7D8E", LINE = "#D6D5D1";
  var SERIF = "'Hedvig Letters Serif','Cormorant',Georgia,'Times New Roman',serif";
  var SANS = "'Inter','Helvetica Neue',Arial,sans-serif";
  var label = function (txt) {
    return '<div style="font-family:' + SANS + ';font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:' + ACCENT + ';font-weight:400;margin:0 0 10px 0;">' + esc_(txt) + '</div>';
  };
  var rows = m.choices.map(function (c) {
    return '<tr>' +
      '<td style="padding:11px 0;border-bottom:1px solid ' + LINE + ';font-family:' + SANS + ';font-size:14px;color:' + ACCENT + ';vertical-align:top;width:42%;">' + esc_(c[0]) + '</td>' +
      '<td style="padding:11px 0;border-bottom:1px solid ' + LINE + ';font-family:' + SANS + ';font-size:14px;color:' + NAVY + ';vertical-align:top;text-align:right;">' + esc_(c[1]) + '</td>' +
      '</tr>';
  }).join("");
  var budgetHtml = m.budgetKnown
    ? '<div style="font-family:' + SERIF + ';font-size:44px;line-height:1.1;color:' + NAVY + ';font-weight:400;">' + esc_(m.budget) + '</div>' +
      '<p style="font-family:' + SANS + ';font-size:13.5px;line-height:1.6;color:' + ACCENT + ';margin:12px 0 0 0;">' + esc_(t.budgetNote) + '</p>'
    : '<p style="font-family:' + SANS + ';font-size:15px;line-height:1.6;color:' + NAVY + ';margin:0;">' + esc_(t.budgetUnknown) + '</p>';
  var section = function (inner) {
    return '<tr><td style="padding:30px 48px 0 48px;"><div style="border-top:1px solid ' + LINE + ';padding-top:28px;">' + inner + '</div></td></tr>';
  };
  var p = function (txt) {
    return '<p style="font-family:' + SANS + ';font-size:15px;line-height:1.6;color:' + NAVY + ';margin:0 0 14px 0;">' + txt + '</p>';
  };
  var questions = esc_(t.questions).replace("{phone}",
    '<a href="' + esc_(m.whatsapp) + '" style="color:' + NAVY + ';text-decoration:underline;">' + esc_(m.phone) + '</a>');

  return '<!doctype html><html lang="' + esc_(m.lang) + '"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc_(m.subject) + '</title></head>' +
    '<body style="margin:0;padding:0;background:' + STONE + ';">' +
    '<div style="display:none;max-height:0;overflow:hidden;opacity:0;">' + esc_(t.preheader) + '</div>' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + STONE + ';"><tr><td align="center" style="padding:40px 16px;">' +
    '<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:' + STONE + ';">' +
      // logo
      '<tr><td align="center" style="padding:8px 48px 40px 48px;"><img src="cid:aurumlogo" width="132" alt="Aurum Premium Interiors" style="display:block;width:132px;height:auto;border:0;"></td></tr>' +
      // headline
      '<tr><td style="padding:0 48px;">' + label(t.kicker) +
        '<h1 style="font-family:' + SERIF + ';font-size:36px;line-height:1.15;color:' + NAVY + ';font-weight:400;margin:0 0 26px 0;">' + esc_(t.styleLabel) + ': <em style="font-style:italic;">' + esc_(m.style) + '</em></h1>' +
      '</td></tr>' +
      // style photo, straight under the headline
      (hasStylePhoto_(m)
        ? '<tr><td style="padding:0 48px 26px 48px;">' +
            '<img src="cid:stylephoto" width="504" alt="' + esc_(m.style) + '" style="display:block;width:100%;max-width:504px;height:auto;border:0;">' +
            (m.imageCaption ? '<div style="font-family:' + SANS + ';font-size:12px;font-style:italic;color:' + ACCENT + ';margin-top:8px;">' + esc_(m.imageCaption) + '</div>' : '') +
          '</td></tr>'
        : '') +
      '<tr><td style="padding:0 48px;">' +
        p(esc_(greeting_(t, m.name))) + p(esc_(t.intro)) +
        (m.styleDescription ? '<p style="font-family:' + SERIF + ';font-style:italic;font-size:18px;line-height:1.5;color:' + NAVY + ';margin:6px 0 0 0;">' + esc_(m.styleDescription) + '</p>' : '') +
      '</td></tr>' +
      section(label(t.budgetLabel) + budgetHtml) +
      section(label(t.choicesLabel) + '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + rows + '</table>') +
      section(label(t.nextLabel) + p(esc_(t.next)) + p(questions)) +
      // signature
      '<tr><td style="padding:22px 48px 0 48px;">' +
        p(esc_(t.signoff)) +
        '<div style="font-family:' + SERIF + ';font-size:22px;color:' + NAVY + ';font-weight:400;">' + esc_(t.signature) + '</div>' +
        '<div style="font-family:' + SANS + ';font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:' + ACCENT + ';margin-top:6px;">' + esc_(t.signatureRole) + '</div>' +
      '</td></tr>' +
      // footer
      '<tr><td style="padding:44px 48px 8px 48px;"><div style="border-top:1px solid ' + LINE + ';padding-top:22px;font-family:' + SANS + ';font-size:12px;line-height:1.6;color:' + ACCENT + ';">' +
        'Aurum Premium Interiors &middot; Oudelandsdijkje 4, 1141 PH Monnickendam &middot; <a href="https://auruminteriors.nl" style="color:' + ACCENT + ';">auruminteriors.nl</a><br>' + esc_(t.footer) +
      '</div></td></tr>' +
    '</table></td></tr></table></body></html>';
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
