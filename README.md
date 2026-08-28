# Vinted Ledger

A personal dashboard for tracking items you've bought, sold, and are watching on Vinted —
with live extraction from Vinted URLs (no manual copy-typing of listing details).

Two parts:

- **`/site/index.html`** — the dashboard itself. Host this on GitHub Pages.
- **`/worker/worker.js`** — a small Cloudflare Worker that fetches Vinted pages
  server-side (browsers block this directly due to CORS) and returns clean JSON.

---

## 1. Deploy the Worker (does the fetching)

You need a free Cloudflare account.

1. Install Wrangler (Cloudflare's CLI), if you don't have it:
   ```
   npm install -g wrangler
   ```
2. Log in:
   ```
   wrangler login
   ```
3. From the `worker/` folder, deploy:
   ```
   wrangler deploy worker.js --name vinted-extractor
   ```
4. Wrangler will print a URL like:
   ```
   https://vinted-extractor.<your-subdomain>.workers.dev
   ```
   Copy this — you'll paste it into the dashboard's Settings panel.

   (No `wrangler.toml` is required for this single-file worker — `wrangler deploy worker.js` works standalone. If you'd rather use the Cloudflare dashboard instead of the CLI: Workers & Pages → Create → paste the contents of `worker.js` into the editor → Deploy.)

**Optional but recommended:** once deployed, open `worker.js` and change:
```js
const ALLOWED_ORIGIN = "*";
```
to your actual GitHub Pages URL, e.g. `"https://yourusername.github.io"`, then redeploy.
This restricts who can call your Worker. Leaving it as `"*"` works fine for personal use.

---

## 2. Deploy the site (the dashboard)

1. Create a new GitHub repo (public or private).
2. Push the contents of `/site/` to it — `index.html` at the repo root, or in a `/docs` folder.
3. In the repo: **Settings → Pages → Source** → pick the branch/folder containing `index.html`.
4. GitHub gives you a URL like `https://yourusername.github.io/vinted-ledger/`.

Open that URL, click **Settings** in the app, and paste your Worker URL from step 1.

---

## 3. Using it

- **Extract from URL(s)** — paste one or more Vinted item URLs (one per line). Each is fetched
  through your Worker and added with status `watching` and the current asking price.
  Edit any row afterwards to mark it `bought`/`sold` and correct the price — Vinted's public
  page never shows what you actually paid or received, only the listed price, so that part
  is always manual.
- **+ Add item** — for anything without a URL, or historical sales you're logging from memory.
- **Bulk import JSON** — a fallback for pasting pre-extracted JSON (e.g. if Claude fetches
  data for you in chat instead of the Worker).
- **Export JSON** — backs up everything to a file.

Data is stored in your browser via the app's persistent storage — it's tied to your browser
profile, not synced across devices. Use Export/Import to move it, or back it up occasionally.

---

## 4. Importing your full order history (bought + sold)

Vinted has no public API for this — but their own web app pulls your order history from
an internal endpoint (`/api/v2/my_orders`) authenticated with your logged-in session. The
Worker now proxies this too, via **Import order history** in the app.

**This uses your real session credentials — a few things worth knowing:**
- Scraping/automation like this isn't officially supported and technically sits outside
  Vinted's ToS, even though it's just you accessing your own data. Personal, low-volume use
  (an occasional import, not a polling bot) is the lowest-risk way to use it.
- Your tokens are saved only in this browser's local app storage, sent only to your own
  Worker, and the Worker forwards them straight to Vinted per-request — nothing is logged
  or stored server-side, and none of it is ever sent to Claude.
- Access tokens expire (typically within a few hours). If a fetch fails, grab fresh values
  and try again — or paste your refresh token too and the Worker will attempt one automatic
  refresh before giving up.

### Getting your tokens (Chrome/Edge DevTools)

1. Log into vinted.co.uk normally in your browser.
2. Open DevTools (`F12` or `Ctrl+Shift+I`) → **Network** tab → reload the page.
3. Filter for `api/v2` and click any request (e.g. `notifications` or `my_orders`).
4. Under **Request Headers**, copy:
   - `authorization` → the part after `Bearer ` is your **access token**
   - `x-csrf-token` → your **CSRF token**
   - `cookie` → the full value is your **cookie header** (paste the whole thing)
5. Optional: DevTools → **Application** tab → Cookies → `vinted.co.uk` → find
   `refresh_token_web` for the **refresh token**.
6. Paste all of these into the app's **Import order history** panel.

These expire — you'll repeat this each time you want a fresh import, unless you're
comfortable scripting the refresh-token flow yourself.

---

## Fix: storage now uses localStorage, not window.storage

Earlier versions of `site/index.html` used `window.storage`, which is a Claude.ai-artifact-only
API — it doesn't exist on a standalone site and silently broke every save (including "Import
order history", which failed with no visible error). This is now fixed: the site uses plain
browser `localStorage`, which is the correct choice for a self-hosted page. If you deployed an
earlier copy, replace `site/index.html` with the current version.

## 5. Importing from Vinted's official data export (HTML/PDF)

Vinted's GDPR export (Settings → **Download your data**) gives you a ZIP of HTML files and PDFs —
there's no published spec for the exact layout, so this feature uses **heuristic pattern-matching**
(finds a price, looks nearby for a date and a title) rather than a guaranteed-correct parser. Every
row goes through a preview step where you can edit or uncheck anything before it's added — nothing
is imported blind.

1. Click **Import export files**.
2. Upload the `index.html` file(s) from the export (any subfolder that lists transactions/orders),
   and/or any PDF invoices included in the export.
3. Click **Parse files** — extracted rows appear in an editable preview table.
4. Fix any title/price/date that came out wrong, set the correct status per row (defaults to
   `sold`), untick anything that isn't really an item, then **Add selected to ledger**.

If a file produces zero rows, open it and check whether prices are formatted differently than
`£12.34` (the parser currently expects `£`/`€`/`$` + two decimals) — let me know the actual format
and the regex in `parseFileImport`'s `PRICE_RE`/`DATE_RE` (in `site/index.html`) can be adjusted.

---

## Notes on extraction accuracy

The Worker tries Vinted's embedded page-data JSON first (most reliable), and falls back to
text-pattern matching if that structure isn't found. Vinted can change its markup at any time
without notice — if a field (e.g. colour or condition) starts coming back empty after a Vinted
site update, open `worker/worker.js` and adjust the regex patterns in `extractItemData()`.
Title, description, and image come from standard meta tags and are the most stable fields.
