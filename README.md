# Aurum kitchen configurator

A static page, with no build step and no framework. It asks eight questions, shows a kitchen style and a
starting budget ("from" price, incl. 21% btw), and sends each lead to a Google Sheet. Built by Anya;
pricing backbone, spam protection and privacy page added in v0.4 (13-11-2026).

## What's in the repo

| Path | What | Who edits it |
|---|---|---|
| `site/index.html` | the whole app: HTML, CSS and vanilla JS | Anya |
| `site/data.json` | all texts (EN and NL), questions, styles, contact settings | Anya / Anna |
| `site/pricing.json` | the price parameters: **sell prices incl. btw only** | Mathieu |
| `site/pricing.js` | the price formula, shared by the page and the check | Mathieu |
| `site/privacy.html` | privacy statement, NL (`#nl`) and EN (`#en`) | Mathieu |
| `site/images/` | style, material and logo images | Anya |
| `backend/Code.gs` | the Google Apps Script that receives the leads | Mathieu |
| `tools/` | checks: price references, lead-script spam rules | — |

Deploy the **`site/` folder only**.

## This repo may be public. Keep it that way

Everything in `site/` is readable by every visitor anyway. That only stays harmless if these never get committed,
not even once (git history is public too):

- cost prices, margins, hours, the pricing worksheet, any `CALC` or `KOSTPRIJS` file
- client names or sold prices (the reference kitchens live in `0003-Aurum/Prijsboek/configurator-referenties.json`)
- tokens or passwords: the Telegram token goes in the Apps Script *Script properties*, never in `Code.gs`

`.gitignore` blocks spreadsheets and CSV files as a safety net.

## Running it locally

```
python -m http.server 5173 --directory site
```
then open http://localhost:5173. Opening `index.html` from `file://` does not work.

## Prices

```
cabinets = per metre x metres x layout x island x fronts
worktop  = per metre x (metres x 0.8) + fitting
drawers  = wood surcharge per drawer x (metres x 2.3)
+ appliances (market price per package) + sink + tap
-> rounded down to 1,000, never below minimumFrom
```

The figure is a **lower bound**: it must never be higher than a real Aurum quote for the same layout. After
every new L3 quote, add it to `configurator-referenties.json` and run:

```
node tools/check-pricing.mjs "<OneDrive>/0003-Aurum/Prijsboek/configurator-referenties.json"
```

A `FOUT` line means `site/pricing.json` is out of date. How each parameter was derived is in
`0003-Aurum/Prijsboek/configurator-L1-parameters.md` (internal).

## Leads and the Apps Script

- On submit the page POSTs JSON as `text/plain` with `mode: "no-cors"` to `contact.leadEndpoint` in `data.json`.
- The script writes one row to "Aurum configurator leads", emails Anna, and emails the client a confirmation.
- **The client email is written by the script**, from the live `data.json` (`SITE_DATA_URL` in `Code.gs`).
  The browser sends only answer ids, a style id and a number, so nobody can use the endpoint to send their own
  text from the Aurum account. Plus: a hidden bot field, a minimum time on the form, one confirmation per
  address per 6 hours, at most 40 a day. `node tools/test-lead-script.mjs` checks all of it.
- Anonymous step events ("00 opened" … "10 lead sent") go to the "Funnel" tab. No personal data.
- No cookies. Progress is kept in `localStorage` for 14 days so a visitor can resume.
- UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`) are saved with the lead. Keep them on ad links.

### After changing `Code.gs`

1. Paste it into the Apps Script project (Extensions > Apps Script).
2. Set `SITE_DATA_URL` to the live `data.json`. Until it is set, leads are saved and Anna is notified, but the
   client gets no confirmation.
3. Deploy > Manage deployments > edit > Version: New version. The URL stays the same.

## Putting it live

1. Publish `site/` as a subfolder (`auruminteriors.nl/configurator/`) or a subdomain
   (`configurator.auruminteriors.nl`). Cloudflare Pages, Netlify or GitHub Pages (public repo) all work.
2. Embed with an iframe if needed:
   ```html
   <iframe src="https://configurator.auruminteriors.nl/" style="width:100%;height:100vh;border:0" title="Aurum kitchen configurator"></iframe>
   ```
   Linking straight to the page is better on mobile.
3. Link `privacy.html` from the website footer too.
4. If the site sends a Content-Security-Policy header, allow `connect-src https://script.google.com
   https://script.googleusercontent.com`, `font-src https://fonts.gstatic.com`, `style-src
   https://fonts.googleapis.com` and, for Telegram, `script-src https://telegram.org`.

## Checking it works

1. Open the live URL. A "Funnel" tab should appear in the Google Sheet within a few seconds.
2. Fill in one test lead with an address you can check, and take more than 3 seconds over the form.
3. Check the row in the sheet and the confirmation email, in both languages.

## Telegram mini-app

The same `index.html` runs as a Telegram WebApp. Point the bot's menu button or web app URL to the live address.
Switching on the Telegram lead alert sends lead details through Telegram: add that to `privacy.html` first.
