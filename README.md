# Aurum kitchen configurator: hand-over

A static page, with no build step and no framework. It asks eight questions, shows a kitchen style and a starting budget, and sends each lead to a Google Sheet.

## What's in the folder

- `index.html` is the whole app: HTML, CSS and vanilla JS in one file.
- `data.json` holds all texts (English and Dutch), the questions, the pricing and the contact settings. Content changes go here, not in the code.
- `images/` holds the style photos, material photos and logo. They are loaded by relative path.
- `backend/aurum-leads-apps-script.gs` is a reference copy of the Google Apps Script that receives the leads. It is already deployed, so no action is needed.

## How to put it live

1. Upload the folder as it is to any static location. Two options:
   - A subfolder on the website, for example `auruminteriors.nl/configurator/`.
   - Its own subdomain, for example `configurator.auruminteriors.nl`.

   `index.html` fetches `data.json` from the same folder, so keep the files together. Opening it from `file://` won't work; it needs a web server.
2. To show it inside an existing page, embed it with an iframe:
   ```html
   <iframe src="https://auruminteriors.nl/configurator/" style="width:100%;height:100vh;border:0" title="Aurum kitchen configurator"></iframe>
   ```
   Linking straight to the page also works and is better on mobile.
3. Set `contact.privacyUrl` in `data.json` to the site's privacy page. It is empty now.
4. If the site sends a Content-Security-Policy header, allow:
   - `connect-src https://script.google.com https://script.googleusercontent.com` (for the leads)
   - `font-src https://fonts.gstatic.com` and `style-src https://fonts.googleapis.com` (for the fonts)
   - `script-src https://telegram.org` (only needed for the Telegram mini-app)

## How leads are sent

- When the visitor submits, the page POSTs JSON as `text/plain` with `mode: "no-cors"` to `contact.leadEndpoint` in `data.json`. This is a Google Apps Script web app that is already live.
- The script writes one row to the sheet "Aurum configurator leads", emails Anna, and sends the client a confirmation email.
- The page also sends anonymous step events ("00 opened" … "10 lead sent") to the same endpoint for drop-off counting. They contain no personal data.
- No cookies are set. Progress is kept in `localStorage` for 14 days so a visitor can resume.
- UTM parameters (`utm_source`, `utm_medium`, `utm_campaign`) are read from the URL and saved with the lead. Please keep them on any links or ads that point to the configurator.

## Checking it works

After uploading:
1. Open the live URL. A "Funnel" tab should appear in the Google Sheet within a few seconds.
2. Fill in one test lead, using an email address you can check.
3. Check that a row appears in the sheet and that the confirmation email arrives.

Tell Anna when done so she can delete the test rows.

## Telegram mini-app

The same `index.html` runs as a Telegram WebApp. The Telegram script is loaded but only used when the page is opened inside Telegram. Point the bot's menu button or web app URL to the live address.
