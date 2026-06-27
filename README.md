# SmartInvoice Pro

Nigerian SME invoicing SaaS — offline-first PWA with Paystack payments,
agent referral system, and admin dashboard.

## Stack

| Layer    | Service              |
|----------|----------------------|
| Frontend | Cloudflare Pages     |
| Backend  | Cloudflare Workers   |
| Database | Cloudflare D1        |
| Storage  | Cloudflare R2        |
| Auth     | Cloudflare Access    |
| Payments | Paystack             |

---

## Repo Structure

```
smartinvoice-pro/
├── pages/                  ← Cloudflare Pages (frontend)
│   ├── index.html          Main SmartInvoice PWA
│   ├── admin.html          Admin dashboard
│   └── agent-portal.html   Agent registration & referral portal
└── worker/                 ← Cloudflare Worker (backend)
    ├── worker.js           API — webhook, payments, agents, admin
    ├── wrangler.toml       Worker configuration
    └── schema.sql          D1 database schema
```

---

## First-Time Deployment

### 1. Prerequisites

```powershell
npm install -g wrangler
wrangler login
```

### 2. Database (D1)

```powershell
wrangler d1 create smartinvoice
# Copy the database_id → paste into worker/wrangler.toml
```

```powershell
cd worker
wrangler d1 execute smartinvoice --file=schema.sql --remote
```

### 3. File Storage (R2)

```powershell
wrangler r2 bucket create smartinvoice-files
```

Then in Cloudflare Dashboard:
- R2 → smartinvoice-files → Settings → Public Access → Enable
- Copy the public URL → paste into `wrangler.toml` as `R2_PUBLIC_URL`

### 4. Secrets

```powershell
cd worker
wrangler secret put PAYSTACK_SECRET_KEY
wrangler secret put LICENSE_SECRET
wrangler secret put ADMIN_SECRET
```

| Secret | Value |
|--------|-------|
| `PAYSTACK_SECRET_KEY` | `sk_live_...` from Paystack dashboard |
| `LICENSE_SECRET` | `IAT-SIP-PRO-2026-a9f3b7c1` |
| `ADMIN_SECRET` | Any strong password you choose |

### 5. Deploy Worker

```powershell
cd worker
wrangler deploy
# Note the URL: https://smartinvoice-worker.YOUR_SUBDOMAIN.workers.dev
```

### 6. Update HTML files

In `pages/index.html`, `pages/admin.html`, and `pages/agent-portal.html`,
replace:
```
smartinvoice-worker.YOUR_SUBDOMAIN.workers.dev
```
with your actual Worker URL, then commit and push.

Also replace `REPLACE_WITH_YOUR_ADMIN_SECRET` in `admin.html`
with the same value you used for `ADMIN_SECRET` above.

### 7. Deploy Pages

In Cloudflare Dashboard → Workers & Pages → Create application → Pages → Connect to Git:
- Select this repo
- Build command: *(leave empty)*
- Build output directory: `pages`

Cloudflare Pages will auto-deploy on every push to `main`.

### 8. Paystack Webhook

In Paystack Dashboard → Settings → Webhooks:
```
https://smartinvoice-worker.YOUR_SUBDOMAIN.workers.dev/webhook
```

### 9. Protect admin.html with Cloudflare Access

Zero Trust → Access → Applications → Add → Self-hosted:
- Domain: `smartinvoice.pages.dev/admin.html`
- Identity: One-time PIN (email OTP — free, no extra setup)
- Policy: allow your email address

---

## Redeployment

After any code change:
```powershell
# Worker changes
cd worker
wrangler deploy

# Pages changes — just push to GitHub
git add .
git commit -m "Update"
git push
```
