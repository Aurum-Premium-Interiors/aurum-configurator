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
 * Setup: Extensions > Apps Script, paste this file into Code.gs. The email logo and style
 * photos are read from Drive (see EMAIL_IMAGE_IDS). Save. Deploy > New deployment > Web app,
 * Execute as: Me, Who has access: Anyone. Copy the web app URL into data.json -> contact.leadEndpoint.
 * After changing this code: Deploy > Manage deployments > edit > Version: New version (the URL stays the same).
 */

var NOTIFY_EMAIL = "anna@auruminteriors.nl";   // Gets a message for every new lead. "" switches it off.
var SEND_CLIENT_EMAIL = true;                  // Confirmation email to the client. false switches it off.
var REPLY_TO = "anna@auruminteriors.nl";       // Where the client's reply lands.
var SENDER_NAME = "Aurum Premium Interiors";

// Telegram push for every new lead. Fill in both, or leave "" to switch it off.
// TELEGRAM_CHAT_IDS can hold several ids (Anna, Mathieu, a group), separated by commas.
// Setup: create the bot with @BotFather, paste its token below, send the bot any message,
// then run telegramFindChatId once (select it at the top, press Run) and copy the id from the log.
var TELEGRAM_BOT_TOKEN = "";
var TELEGRAM_CHAT_IDS = "";

function doGet() {
  return ContentService.createTextOutput("Aurum configurator endpoint is running.");
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var data = JSON.parse(e.postData.contents);
    if (data._type === "event") { logEvent_(data); return json_({ ok: true }); }

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
      if (typeof v === "string" && /^[=+\-@]/.test(v)) return "'" + v; // "+31 6..." must stay text
      return v;
    });
    sheet.appendRow(row);

    // The row is saved first. Each message below runs on its own, so one failing never stops the others.
    try { if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_IDS) notifyTelegram_(data, ss.getUrl()); } catch (t) { console.error("Telegram: " + t); }
    try { if (NOTIFY_EMAIL) notifyAnna_(data, ss.getUrl()); } catch (m) { console.error("Notify email: " + m); }
    try { if (SEND_CLIENT_EMAIL && data._email && data._email.to) sendClientEmail_(data._email); } catch (c) { console.error("Client email: " + c); }

    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/* ---------- funnel ---------- */
function logEvent_(d) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName("Funnel");
  if (!sh) {
    sh = ss.insertSheet("Funnel");
    sh.appendRow(["At", "Session", "Step", "Language", "Source"]);
    sh.setFrozenRows(1);
  }
  sh.appendRow([d.at || new Date().toISOString(), d.session || "", d.event || "", d.lang || "", d.source || ""]);
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
  TELEGRAM_CHAT_IDS.split(",").forEach(function (id) {
    id = id.trim();
    if (!id) return;
    UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "post",
      payload: { chat_id: id, text: lines.join("\n"), disable_web_page_preview: "true" },
      muteHttpExceptions: true
    });
  });
}

// Run once by hand after sending your bot a message: it writes the chat id of everyone who wrote to it to the log.
function telegramFindChatId() {
  var r = UrlFetchApp.fetch("https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/getUpdates", { muteHttpExceptions: true });
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
  MailApp.sendEmail({
    to: NOTIFY_EMAIL,
    subject: "New configurator lead: " + (data["Name"] || "") + (flags.length ? " (" + flags.join(", ") + ")" : ""),
    body: [
      "Name: " + (data["Name"] || ""),
      "Email: " + (data["Email"] || ""),
      "Phone: " + (data["Phone"] || ""),
      "Client type: " + (data["Client type"] || ""),
      "Timing: " + (data["Timing"] || ""),
      "Location: " + (data["Location"] || ""),
      "Style: " + (data["Style"] || ""),
      "Length: " + (data["Length (m)"] || ""),
      "Starting budget: " + (data["Starting budget (EUR)"] || ""),
      "Source: " + (data["Source"] || "") + (data["Campaign"] ? " / " + data["Campaign"] : ""),
      "",
      sheetUrl
    ].join("\n")
  });
}

function sendClientEmail_(m) {
  var html = buildClientEmail_(m);
  var plain = buildClientText_(m);
  MailApp.sendEmail({
    to: m.to,
    subject: m.subject,
    body: plain,
    htmlBody: html,
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
  return !!(m.styleId && EMAIL_IMAGE_IDS[m.styleId]);
}
function esc_(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function buildClientText_(m) {
  var t = m.text;
  var lines = [
    t.greeting.replace("{name}", m.name), "",
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
        p(esc_(t.greeting.replace("{name}", m.name))) + p(esc_(t.intro)) +
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

// Navy Aurum logo for the email header (PNG, base64).
