# Pabili Mart — Project Notes

Static HTML/JS multi-tenant e-commerce SaaS deployed to Firebase Hosting. Firebase Firestore backend with Cloud Functions (`createTenant` / `deleteTenant` / `getMyTenant` / `generateInviteCode` / `listInviteCodes` / `revokeInviteCode`) in `asia-southeast1`. Filipino neighborhood store / carinderia / café storefronts as a per-tenant service.

Repo: `jason-gitcode/jt-sari-sari-store` · Live URL: `pabilimart.com` (new — replacing `jsminimart.com` during 2026-06-04 cutover; old still serves until the 301 redirect lands) · Branch: `main` (no PRs — push directly).

**Seed tenant note:** The seed tenant slug is `jsminimart` and its store is named "JS Mini Mart" (Jason's actual neighborhood store). Platform-level rebrand from "JS Mini Mart" → "Pabili Mart" only touched platform pages (signup, superadmin, manifest); the seed tenant's storefront branding stayed because that IS his real shop. See [[Domain Swap Checklist - pabilimart.com]] in Obsidian.

## File Map

| File | Purpose |
|------|---------|
| `index.html` | Storefront — product grid, cart, header ticker, rain/closed/maintenance modes |
| `admin.html` | Admin panel — orders, products, dashboard, burger menu (Rain Mode, Store Closed, Maintenance Mode, Logout) |
| `checkout.html` | Order summary page (legacy `.html` URL) |
| `checkout/index.html` | Order summary page (pretty URL `/checkout/`) |
| `sw.js` | Service worker with versioned cache |

**CRITICAL:** `checkout.html` and `checkout/index.html` are duplicates. Any edit to one MUST be applied to the other. They differ only in relative-path links (`href="/"` vs `href="index.html"`).

## Firestore Schema

- `settings/store` — `{ rainMode, storeClosed, maintenanceMode, storeClosedSource: 'auto'|'manual' }`
- `products/*` — `{ id, name, price, category, unit, emoji, available, stock, variants?, ... }`
- `orders/*` — `{ status, customer, address, payment, deliverySchedule, items, subtotal, deliveryFee, total, confirmedItems?, uncheckedItems?, partialRefundRef?, createdAt }`

## Critical Conventions

- **Bump `sw.js` cache version** (e.g. `sari-sari-v4` → `v5`) whenever HTML/JS changes — otherwise customers keep seeing stale cached pages. Current: `sari-sari-v4`.
- **Manila time everywhere** — use `new Date().toLocaleString('en-US', { timeZone: 'Asia/Manila' })` then `.getHours()` for hour-based logic. Never trust device local time.
- **Store hours: 6am–4pm Manila time** (`h >= 16 || h < 6` → closed). Auto-close enforced client-side from `index.html` and both checkout pages, so any visitor triggers the Firestore sync (admin.html tab no longer needs to be open).
- **`storeClosedSource`** — `'manual'` (admin toggle) blocks auto-overwrite; `'auto'` is overwritten when time crosses 4pm/6am.
- **`fmt(n)` helper** — `parseFloat(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })`. Defined in `index.html` and `admin.html`. Always use this for ₱ amounts, not `.toFixed(2)`. (Not present in checkout files — they still use `.toFixed(2)`.)
- **Discord webhook** — `DISCORD_WEBHOOK` constant in both checkout files notifies the owner on new orders.

## Current Business Config

- Delivery fee: **₱45**, free at cart **≥ ₱400**
- COD limit: orders **≥ ₱200** must use GCash (COD is for small orders only)
- Delivery time slots: **10am–2pm · 2pm–6pm · 4pm–7pm** (filtered by Manila hour; auto-selected first available slot)
- Store hours: **6am–4pm** Manila time

These values change occasionally — always read the current code before stating them to the user.

## Workflow Preferences

- User wants edits **committed and pushed to `main`** after each task. Confirm message style only if uncertain; otherwise commit + push directly.
- Commit message style: short subject (~70 char) + 1–2 paragraph body explaining what and why, ending with `Co-Authored-By: Claude <model> <noreply@anthropic.com>` trailer.
- Use HEREDOC for commit messages to preserve formatting.
- Don't add features beyond what's asked. This is a production store — stability matters more than cleverness.

## Common Gotchas

- **Two checkout files** — always edit `checkout.html` AND `checkout/index.html` for the same change.
- **Burger menu additions in admin** — also add CSS for `.hm-item.<name>.active` and `.hm-item.<name>.active:hover` to match existing buttons.
- **Service worker cache** — if a user reports "changes not showing," the cache version probably wasn't bumped.
- **`fmt()` is only in index.html and admin.html** — if you ever use it in checkout files without defining it, prices will break.
- **Nested template literals** — `main.innerHTML = \`... ${cond ? \`inner\` : ''} ...\`` works in modern JS but pre-compute strings outside the template when possible for readability.
