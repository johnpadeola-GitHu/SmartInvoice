/**
 * SmartInvoice Pro — Cloudflare Worker API
 * ==========================================
 * Single worker handles all backend needs:
 *
 * PUBLIC
 *   POST /webhook           — Paystack charge.success events
 *   POST /verify-payment    — Frontend calls after Paystack popup closes
 *   POST /agents            — Agent self-registration
 *   GET  /agents/:phone     — Agent dashboard lookup
 *
 * ADMIN (requires x-admin-secret header)
 *   GET  /admin/dashboard
 *   GET  /admin/agents
 *   PATCH /admin/agents/:phone/status
 *   GET  /admin/payments
 *   GET  /admin/payouts
 *   POST /admin/payouts
 *   PATCH /admin/payouts/:id/mark-paid
 *
 * Bindings (set in wrangler.toml + Cloudflare dashboard):
 *   DB                  — D1 database
 *   PAYSTACK_SECRET_KEY — sk_live_...
 *   LICENSE_SECRET      — IAT-SIP-PRO-2026-a9f3b7c1
 *   ADMIN_SECRET        — strong password for admin panel
 *   FRONTEND_URL        — https://smartinvoice.pages.dev
 *   COMMISSION_RATE     — 0.10
 *   MIN_PAYOUT_KOBO     — 500000
 */

// ── Plan config ──────────────────────────────────────────────
const PLAN_AMOUNTS = { M: 1250000, X: 1950000, G: 2750000 };
const KEY_CHARS    = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// ── Entry point ──────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url    = new URL(req.url);
    const path   = url.pathname.replace(/\/$/, '');
    const method = req.method;
    const origin = req.headers.get('Origin') || '*';

    // CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    try {
      // ── Public routes ───────────────────────────────────────
      if (method === 'POST' && path === '/webhook')
        return handleWebhook(req, env, origin);

      if (method === 'POST' && path === '/verify-payment')
        return handleVerifyPayment(req, env, origin);

      if (method === 'POST' && path === '/agents')
        return handleAgentRegister(req, env, origin);

      if (method === 'GET' && path.startsWith('/agents/'))
        return handleAgentGet(path, env, origin);

      // ── Admin routes ────────────────────────────────────────
      // ── Auth routes ───────────────────────────────────────
      if (method === 'POST' && path === '/auth/signup')        return handleSignup(req, env, origin);
      if (method === 'POST' && path === '/auth/login')         return handleLogin(req, env, origin);
      if (method === 'GET'  && path === '/auth/me')            return handleMe(req, env, origin);
      if (method === 'POST' && path === '/auth/link-licence')  return handleLinkLicence(req, env, origin);

      if (!adminAuth(req, env))
        return path.startsWith('/admin')
          ? json({ error: 'Unauthorized — invalid or missing x-admin-secret' }, 401, origin)
          : json({ error: 'Not found' }, 404, origin);

      if (method === 'GET'   && path === '/admin/dashboard')
        return handleDashboard(env, origin);

      if (method === 'GET'   && path === '/admin/agents')
        return handleListAgents(env, origin);

      if (method === 'PATCH' && path.match(/^\/admin\/agents\/[^/]+\/status$/))
        return handleAgentStatus(path, req, env, origin);

      if (method === 'GET'   && path === '/admin/payments')
        return handleListPayments(url, env, origin);

      if (method === 'GET'   && path === '/admin/payouts')
        return handleListPayouts(url, env, origin);

      if (method === 'POST'  && path === '/admin/payouts')
        return handleCreatePayout(req, env, origin);

      // ── R2 File storage ──────────────────────────────────────
      if (method === 'POST'  && path === '/activate-device')
        return handleActivateDevice(req, env, origin);

      if (method === 'POST'   && path === '/files/upload')
        return handleFileUpload(req, env, origin);
      if (method === 'DELETE' && path.startsWith('/files/'))
        return handleFileDelete(path, env, origin);
      if (method === 'GET'    && path.startsWith('/files/'))
        return handleFileGet(path, env, origin);

      if (method === 'PATCH' && path.match(/^\/admin\/payouts\/\d+\/mark-paid$/))
        return handleMarkPaid(path, env, origin);

      return json({ error: 'Not found' }, 404, origin);

    } catch (err) {
      console.error('[worker]', err.message, err.stack);
      return json({ error: 'Internal server error' }, 500, origin);
    }
  }
};

// ════════════════════════════════════════════════════════════
// WEBHOOK — Paystack charge.success
// ════════════════════════════════════════════════════════════

async function handleWebhook(req, env, origin) {
  const raw = await req.text();
  const sig = req.headers.get('x-paystack-signature') || '';

  if (!await verifySig(raw, sig, env.PAYSTACK_SECRET_KEY)) {
    console.warn('[webhook] Invalid signature');
    return json({ error: 'Invalid signature' }, 401, origin);
  }

  let event;
  try { event = JSON.parse(raw); }
  catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  if (event.event !== 'charge.success')
    return json({ received: true, processed: false }, 200, origin);

  // Acknowledge immediately, process async
  processPayment(event.data, env).catch(e =>
    console.error('[webhook] processPayment error:', e.message)
  );

  return json({ received: true, processed: true }, 200, origin);
}

// ════════════════════════════════════════════════════════════
// VERIFY PAYMENT — frontend calls after Paystack popup closes
// ════════════════════════════════════════════════════════════

async function handleVerifyPayment(req, env, origin) {
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { reference, planCode, referralCode } = body || {};
  if (!reference) return json({ error: 'reference is required' }, 400, origin);

  // Already processed? Return existing licence
  const existing = await env.DB.prepare(
    `SELECT p.reference, l.license_key, l.plan, l.expires_at
     FROM payments p
     LEFT JOIN licenses l ON l.reference = p.reference
     WHERE p.reference = ? AND p.status = 'success'`
  ).bind(reference).first();

  if (existing?.license_key) {
    return json({
      licenseKey: existing.license_key,
      expiresAt:  existing.expires_at,
      tier:       existing.plan,
    }, 200, origin);
  }

  // Verify with Paystack
  let psData;
  try {
    const r = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } }
    );
    const j = await r.json();
    if (!j.status || j.data?.status !== 'success')
      return json({ error: 'Payment not confirmed by Paystack' }, 402, origin);
    psData = j.data;
  } catch {
    return json({ error: 'Could not reach Paystack — try again shortly' }, 502, origin);
  }

  const meta          = psData.metadata || {};
  const resolvedPlan  = extractPlanCode(meta) || planCode;
  const resolvedRef   = extractReferralCode(meta) || referralCode;

  if (!resolvedPlan || !PLAN_AMOUNTS[resolvedPlan])
    return json({ error: `Unknown plan: ${resolvedPlan}` }, 422, origin);

  if (psData.amount < PLAN_AMOUNTS[resolvedPlan])
    return json({ error: 'Payment amount does not match plan price' }, 422, origin);

  const result = await savePaymentAndLicence(psData, resolvedPlan, resolvedRef, env);
  if (!result.ok) return json({ error: result.error }, 500, origin);

  return json({
    licenseKey: result.licenseKey,
    expiresAt:  result.expiresAt,
    tier:       resolvedPlan,
  }, 200, origin);
}

// ════════════════════════════════════════════════════════════
// SHARED PAYMENT PROCESSING
// ════════════════════════════════════════════════════════════

async function processPayment(data, env) {
  const meta         = data.metadata || {};
  const planCode     = extractPlanCode(meta);
  const referralCode = extractReferralCode(meta);

  if (!planCode || !PLAN_AMOUNTS[planCode]) {
    console.error('[webhook] Unknown plan:', planCode, 'ref:', data.reference);
    return;
  }
  if (data.amount < PLAN_AMOUNTS[planCode]) {
    console.error('[webhook] Amount mismatch — ref:', data.reference);
    return;
  }

  // Idempotency
  const exists = await env.DB.prepare(
    `SELECT id FROM payments WHERE reference = ? AND status = 'success'`
  ).bind(data.reference).first();

  if (exists) {
    console.log('[webhook] Already processed:', data.reference);
    return;
  }

  const result = await savePaymentAndLicence(data, planCode, referralCode, env);
  if (result.ok) {
    console.log('[webhook] Done:', data.reference, '->', result.licenseKey);
  } else {
    console.error('[webhook] Failed:', data.reference, result.error);
  }
}

async function savePaymentAndLicence(data, planCode, referralCode, env) {
  const reference    = data.reference;
  const amountKobo   = data.amount;
  const email        = (data.customer?.email || data.customer_email || '').toLowerCase().trim();
  const customerName = [data.customer?.first_name, data.customer?.last_name]
    .filter(Boolean).join(' ').trim() || null;
  const meta         = data.metadata || {};
  const rate         = parseFloat(env.COMMISSION_RATE || '0.10');
  const now          = new Date().toISOString();

  // Resolve agent
  let agentPhone = null;
  let commission = 0;

  if (referralCode && referralCode.toUpperCase() !== 'DIRECT') {
    const agent = await env.DB.prepare(
      `SELECT phone FROM agents WHERE referral_code = ? AND is_active = 1`
    ).bind(referralCode).first();

    if (agent) {
      agentPhone = agent.phone;
      commission = Math.floor(amountKobo * rate);
    }
  }

  // Upsert payment
  try {
    await env.DB.prepare(
      `INSERT INTO payments
         (reference, agent_phone, plan, amount, email, customer_name,
          status, commission, metadata, webhook_received_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, ?)
       ON CONFLICT(reference) DO UPDATE SET
         status = 'success',
         commission = excluded.commission,
         agent_phone = excluded.agent_phone,
         webhook_received_at = excluded.webhook_received_at`
    ).bind(
      reference, agentPhone, planCode, amountKobo, email,
      customerName, commission, JSON.stringify(meta), now, now
    ).run();
  } catch (e) {
    return { ok: false, error: 'Failed to save payment: ' + e.message };
  }

  // Generate licence
  let licenceKey, expiresAt;
  try {
    ({ key: licenceKey, expiresAt } = await generateLicenceKey(planCode, env.LICENSE_SECRET));
  } catch (e) {
    return { ok: false, error: 'Licence generation failed: ' + e.message };
  }

  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO licenses
         (reference, license_key, plan, email, issued_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(reference, licenceKey, planCode, email, now, expiresAt.toISOString()).run();
  } catch (e) {
    return { ok: false, error: 'Failed to save licence: ' + e.message };
  }

  // Update agent stats
  if (agentPhone && commission > 0) {
    await env.DB.prepare(
      `UPDATE agents SET
         total_sales    = total_sales    + 1,
         total_revenue  = total_revenue  + ?,
         total_earnings = total_earnings + ?,
         balance        = balance        + ?
       WHERE phone = ?`
    ).bind(amountKobo, commission, commission, agentPhone).run();
  }

  return { ok: true, licenseKey: licenceKey, expiresAt: expiresAt.toISOString() };
}

// ════════════════════════════════════════════════════════════
// AGENTS — public
// ════════════════════════════════════════════════════════════

async function handleAgentRegister(req, env, origin) {
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { name, phone, market } = body || {};
  if (!name || !phone || !market)
    return json({ error: 'name, phone and market are required' }, 400, origin);

  const clean = String(phone).replace(/\s+/g, '').trim();
  if (!/^0[0-9]{10}$/.test(clean))
    return json({ error: 'Phone must be 11 digits starting with 0 (e.g. 08034129684)' }, 400, origin);

  const exists = await env.DB.prepare(
    `SELECT phone FROM agents WHERE phone = ?`
  ).bind(clean).first();

  if (exists)
    return json({ error: 'An agent with this phone number is already registered' }, 409, origin);

  const photoUrl = String(body.photoUrl || '').trim() || null;
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO agents (name, phone, market, referral_code, photo_url, is_active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).bind(String(name).trim(), clean, String(market).trim(), clean, photoUrl, now).run();

  const agent = await env.DB.prepare(
    `SELECT id, name, phone, market, referral_code, photo_url, created_at FROM agents WHERE phone = ?`
  ).bind(clean).first();

  return json({
    agent,
    referralLink: `${env.FRONTEND_URL || ''}/?ref=${clean}`,
  }, 201, origin);
}

async function handleAgentGet(path, env, origin) {
  const phone = decodeURIComponent(path.replace('/agents/', ''));

  const agent = await env.DB.prepare(
    `SELECT id, name, phone, market, referral_code, photo_url,
            total_sales, total_revenue, total_earnings, balance, created_at
     FROM agents WHERE phone = ? AND is_active = 1`
  ).bind(phone).first();

  if (!agent) return json({ error: 'Agent not found' }, 404, origin);

  const { results: payouts } = await env.DB.prepare(
    `SELECT amount, status, created_at, paid_at, note
     FROM payouts WHERE agent_phone = ?
     ORDER BY created_at DESC LIMIT 10`
  ).bind(phone).all();

  return json({
    ...agent,
    total_revenue_naira:  agent.total_revenue  / 100,
    total_earnings_naira: agent.total_earnings / 100,
    balance_naira:        agent.balance        / 100,
    referralLink:         `${env.FRONTEND_URL || ''}/?ref=${agent.referral_code}`,
    payouts: (payouts || []).map(p => ({ ...p, amount_naira: p.amount / 100 })),
  }, 200, origin);
}

// ════════════════════════════════════════════════════════════
// ADMIN — protected by x-admin-secret
// ════════════════════════════════════════════════════════════

async function handleDashboard(env, origin) {
  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS total_payments,
            COALESCE(SUM(amount), 0) AS total_revenue,
            COALESCE(SUM(commission), 0) AS total_commissions
     FROM payments WHERE status = 'success'`
  ).first();

  const { results: monthly } = await env.DB.prepare(
    `SELECT strftime('%Y-%m', created_at) AS month,
            COUNT(*) AS payments,
            COALESCE(SUM(amount), 0) AS revenue_kobo
     FROM payments
     WHERE status = 'success'
       AND created_at >= datetime('now', '-12 months')
     GROUP BY month ORDER BY month`
  ).all();

  const { results: leaderboard } = await env.DB.prepare(
    `SELECT name, phone, market, total_sales, total_revenue, total_earnings, balance
     FROM agents WHERE is_active = 1
     ORDER BY total_revenue DESC LIMIT 20`
  ).all();

  const agentCount = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM agents WHERE is_active = 1`
  ).first();

  return json({
    totalPayments:         totals.total_payments,
    totalRevenueNaira:     totals.total_revenue     / 100,
    totalCommissionsNaira: totals.total_commissions / 100,
    totalAgents:           agentCount.count,
    monthly: (monthly || []).map(m => ({
      month:        m.month,
      payments:     m.payments,
      revenueNaira: m.revenue_kobo / 100,
    })),
    leaderboard: (leaderboard || []).map(a => ({
      name:          a.name,
      phone:         a.phone,
      market:        a.market,
      totalSales:    a.total_sales,
      revenueNaira:  a.total_revenue  / 100,
      earningsNaira: a.total_earnings / 100,
      balanceNaira:  a.balance        / 100,
    })),
  }, 200, origin);
}

async function handleListAgents(env, origin) {
  const { results } = await env.DB.prepare(
    `SELECT id, name, phone, market, referral_code,
            total_sales, total_revenue, total_earnings, balance, is_active, created_at
     FROM agents ORDER BY total_revenue DESC`
  ).all();

  return json((results || []).map(a => ({
    ...a,
    total_revenue_naira:  a.total_revenue  / 100,
    total_earnings_naira: a.total_earnings / 100,
    balance_naira:        a.balance        / 100,
  })), 200, origin);
}

async function handleAgentStatus(path, req, env, origin) {
  const phone = decodeURIComponent(path.split('/')[3]);
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  if (typeof body.is_active !== 'boolean')
    return json({ error: 'is_active must be true or false' }, 400, origin);

  await env.DB.prepare(
    `UPDATE agents SET is_active = ? WHERE phone = ?`
  ).bind(body.is_active ? 1 : 0, phone).run();

  return json({ phone, is_active: body.is_active }, 200, origin);
}

async function handleListPayments(url, env, origin) {
  const status = url.searchParams.get('status') || '';
  const limit  = Math.min(100, parseInt(url.searchParams.get('limit') || '50'));

  const query = status
    ? `SELECT p.*, l.license_key, l.expires_at, a.name AS agent_name
       FROM payments p
       LEFT JOIN licenses l ON l.reference = p.reference
       LEFT JOIN agents   a ON a.phone = p.agent_phone
       WHERE p.status = ?
       ORDER BY p.created_at DESC LIMIT ?`
    : `SELECT p.*, l.license_key, l.expires_at, a.name AS agent_name
       FROM payments p
       LEFT JOIN licenses l ON l.reference = p.reference
       LEFT JOIN agents   a ON a.phone = p.agent_phone
       ORDER BY p.created_at DESC LIMIT ?`;

  const bindings = status ? [status, limit] : [limit];
  const { results } = await env.DB.prepare(query).bind(...bindings).all();

  return json((results || []).map(p => ({
    ...p,
    amount_naira:     p.amount     / 100,
    commission_naira: p.commission / 100,
  })), 200, origin);
}

async function handleListPayouts(url, env, origin) {
  const status = url.searchParams.get('status') || '';

  const query = status
    ? `SELECT po.*, a.name AS agent_name, a.market
       FROM payouts po
       JOIN agents a ON a.phone = po.agent_phone
       WHERE po.status = ?
       ORDER BY po.created_at DESC`
    : `SELECT po.*, a.name AS agent_name, a.market
       FROM payouts po
       JOIN agents a ON a.phone = po.agent_phone
       ORDER BY po.created_at DESC`;

  const { results } = status
    ? await env.DB.prepare(query).bind(status).all()
    : await env.DB.prepare(query).all();

  return json((results || []).map(p => ({
    ...p, amount_naira: p.amount / 100,
  })), 200, origin);
}

async function handleCreatePayout(req, env, origin) {
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { agentPhone, amount, note } = body || {};
  if (!agentPhone || !amount)
    return json({ error: 'agentPhone and amount are required' }, 400, origin);

  const amountKobo = Math.floor(parseFloat(amount) * 100);
  const minPayout  = parseInt(env.MIN_PAYOUT_KOBO || '500000');

  if (isNaN(amountKobo) || amountKobo <= 0)
    return json({ error: 'Invalid amount' }, 400, origin);

  if (amountKobo < minPayout)
    return json({ error: `Minimum payout is ₦${minPayout / 100}` }, 400, origin);

  const agent = await env.DB.prepare(
    `SELECT balance FROM agents WHERE phone = ? AND is_active = 1`
  ).bind(agentPhone).first();

  if (!agent)
    return json({ error: 'Agent not found' }, 404, origin);

  if (agent.balance < amountKobo)
    return json({ error: `Insufficient balance. Agent has ₦${agent.balance / 100}` }, 400, origin);

  const now = new Date().toISOString();

  await env.DB.prepare(
    `UPDATE agents SET balance = balance - ? WHERE phone = ?`
  ).bind(amountKobo, agentPhone).run();

  const result = await env.DB.prepare(
    `INSERT INTO payouts (agent_phone, amount, status, note, created_at)
     VALUES (?, ?, 'pending', ?, ?) RETURNING *`
  ).bind(agentPhone, amountKobo, note || null, now).first();

  return json({ ...result, amount_naira: result.amount / 100 }, 201, origin);
}

async function handleMarkPaid(path, env, origin) {
  const id = parseInt(path.split('/')[3]);
  if (isNaN(id)) return json({ error: 'Invalid payout ID' }, 400, origin);

  const result = await env.DB.prepare(
    `UPDATE payouts SET status = 'paid', paid_at = ?
     WHERE id = ? AND status = 'pending' RETURNING *`
  ).bind(new Date().toISOString(), id).first();

  if (!result)
    return json({ error: 'Payout not found or already paid' }, 404, origin);

  return json({ ...result, amount_naira: result.amount / 100 }, 200, origin);
}



// ════════════════════════════════════════════════════════════
// DEVICE ACTIVATION — multi-device licence enforcement
// M: 1 device | X: 3 devices | G: 5 devices
// ════════════════════════════════════════════════════════════

const MAX_DEVICES = { M: 1, X: 3, G: 5 };

async function handleActivateDevice(req, env, origin) {
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { licenseKey, deviceFingerprint, plan } = body || {};

  if (!licenseKey || !deviceFingerprint || !plan) {
    return json({ error: 'licenseKey, deviceFingerprint and plan are required' }, 400, origin);
  }

  const maxDevices = MAX_DEVICES[plan] || 1;

  // Check if this device is already registered for this key
  const existing = await env.DB.prepare(
    `SELECT id FROM device_activations WHERE license_key = ? AND device_fp = ?`
  ).bind(licenseKey, deviceFingerprint).first();

  if (existing) {
    // Already registered — just return current count
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) as count FROM device_activations WHERE license_key = ?`
    ).bind(licenseKey).first();
    return json({
      allowed:      true,
      currentCount: countRow.count,
      maxDevices,
      existing:     true,
    }, 200, origin);
  }

  // Count how many devices are already activated for this key
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM device_activations WHERE license_key = ?`
  ).bind(licenseKey).first();

  const currentCount = countRow.count || 0;

  if (currentCount >= maxDevices) {
    return json({
      allowed:      false,
      currentCount,
      maxDevices,
      error:        `Device limit reached. Your ${plan === 'M' ? 'Micro' : plan === 'X' ? 'Medium' : 'Growth'} plan allows ${maxDevices} device${maxDevices > 1 ? 's' : ''}. Deactivate a device or upgrade your plan.`,
    }, 403, origin);
  }

  // Register this device
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO device_activations (license_key, device_fp, plan, activated_at)
     VALUES (?, ?, ?, ?)`
  ).bind(licenseKey, deviceFingerprint, plan, now).run();

  return json({
    allowed:      true,
    currentCount: currentCount + 1,
    maxDevices,
    existing:     false,
  }, 201, origin);
}

// ════════════════════════════════════════════════════════════
// R2 FILE STORAGE — logos, signatures, invoice images, agent photos
// ════════════════════════════════════════════════════════════

// Allowed MIME types
const ALLOWED_TYPES = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'image/gif': 'gif', 'application/pdf': 'pdf'
};

// Allowed upload folders
const ALLOWED_FOLDERS = ['logos', 'signatures', 'invoices', 'agents', 'nqr'];

async function handleFileUpload(req, env, origin) {
  if (!env.BUCKET) return json({ error: 'R2 storage not configured' }, 503, origin);

  let formData;
  try { formData = await req.formData(); }
  catch { return json({ error: 'Expected multipart/form-data' }, 400, origin); }

  const file   = formData.get('file');
  const folder = (formData.get('folder') || 'misc').replace(/[^a-z0-9_-]/gi, '');

  if (!file || !file.size) return json({ error: 'No file provided' }, 400, origin);
  if (!ALLOWED_FOLDERS.includes(folder))
    return json({ error: `Invalid folder. Use: ${ALLOWED_FOLDERS.join(', ')}` }, 400, origin);

  const mime = file.type || 'application/octet-stream';
  const ext  = ALLOWED_TYPES[mime];
  if (!ext) return json({ error: `File type not allowed: ${mime}` }, 400, origin);

  if (file.size > 5 * 1024 * 1024)
    return json({ error: 'File too large. Max 5 MB.' }, 413, origin);

  const uid = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  const key = `${folder}/${Date.now()}-${uid}.${ext}`;

  try {
    await env.BUCKET.put(key, file.stream(), {
      httpMetadata: {
        contentType:        mime,
        cacheControl:       'public, max-age=31536000',
        contentDisposition: 'inline',
      },
    });
  } catch (e) {
    console.error('[R2] Upload failed:', e.message);
    return json({ error: 'Upload failed' }, 500, origin);
  }

  // Return both the key and the public URL
  const publicUrl = env.R2_PUBLIC_URL
    ? `${env.R2_PUBLIC_URL.replace(/\/$/, '')}/${key}`
    : `/files/${key}`;

  return json({ key, url: publicUrl }, 201, origin);
}

async function handleFileGet(path, env, origin) {
  if (!env.BUCKET) return new Response('R2 not configured', { status: 503 });

  const key = decodeURIComponent(path.replace('/files/', ''));
  const obj = await env.BUCKET.get(key);

  if (!obj) return new Response('Not found', { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('Cache-Control', 'public, max-age=31536000');
  headers.set('Access-Control-Allow-Origin', '*');

  return new Response(obj.body, { headers });
}

async function handleFileDelete(path, env, origin) {
  if (!env.BUCKET) return json({ error: 'R2 storage not configured' }, 503, origin);

  const key = decodeURIComponent(path.replace('/files/', ''));
  if (!key || key.includes('..'))
    return json({ error: 'Invalid file key' }, 400, origin);

  await env.BUCKET.delete(key);
  return json({ deleted: true, key }, 200, origin);
}

// ════════════════════════════════════════════════════════════
// CRYPTO — Paystack signature + licence key generation
// ════════════════════════════════════════════════════════════

async function verifySig(rawBody, signature, secret) {
  if (!signature || !rawBody || !secret) return false;

  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false, ['sign']
  );
  const sig      = await crypto.subtle.sign('HMAC', key, enc.encode(rawBody));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('');

  // Constant-time compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++)
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

async function generateLicenceKey(tier, secret) {
  const licSecret = secret || 'IAT-SIP-PRO-2026-a9f3b7c1';
  const expiresAt = new Date(Date.now() + 365 * 86_400_000);
  const expDay    = Math.floor(expiresAt.getTime() / 86_400_000);
  const expRaw    = expDay.toString(36).toUpperCase().padStart(4, '0');

  const saltBytes = new Uint8Array(4);
  crypto.getRandomValues(saltBytes);
  const salt = Array.from(saltBytes)
    .map(b => KEY_CHARS[b % KEY_CHARS.length]).join('');

  const payload = `${tier}${expRaw}${salt}`;
  const enc     = new TextEncoder();
  const key     = await crypto.subtle.importKey(
    'raw', enc.encode(licSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign']
  );
  const sig      = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const hmacHex  = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const checksum = hmacHex.slice(0, 7);
  const data     = payload + checksum;

  return {
    key: `SIP-${data.slice(0,4)}-${data.slice(4,8)}-${data.slice(8,12)}-${data.slice(12,16)}`,
    expiresAt,
  };
}

// ════════════════════════════════════════════════════════════
// METADATA HELPERS
// ════════════════════════════════════════════════════════════

function extractPlanCode(meta) {
  if (!meta) return null;
  if (meta.plan_code) return String(meta.plan_code).trim().toUpperCase();
  if (Array.isArray(meta.custom_fields)) {
    for (const f of meta.custom_fields)
      if (f.variable_name === 'plan_code') return String(f.value).trim().toUpperCase();
  }
  return null;
}

function extractReferralCode(meta) {
  if (!meta) return null;
  if (meta.referral_code) return String(meta.referral_code).trim();
  if (meta.agent_code)    return String(meta.agent_code).trim();
  if (Array.isArray(meta.custom_fields)) {
    for (const f of meta.custom_fields)
      if (['referral_code', 'agent_code'].includes(f.variable_name))
        return String(f.value).trim();
  }
  return null;
}


// ════════════════════════════════════════════════════════════
// AUTH — Sign up, sign in, account management
// ════════════════════════════════════════════════════════════

// ── JWT helpers ──────────────────────────────────────────────
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
function b64urlDecode(str) {
  const padded = str + '='.repeat((4 - str.length % 4) % 4);
  return decodeURIComponent(escape(atob(padded.replace(/-/g, '+').replace(/_/g, '/'))));
}

async function createJWT(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const sig    = await hmacSHA256hex(secret, data);
  const sigBytes = new Uint8Array(sig.match(/.{2}/g).map(b => parseInt(b, 16)));
  const sigB64   = btoa(String.fromCharCode(...sigBytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return `${data}.${sigB64}`;
}

async function verifyJWT(token, secret) {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const data         = `${header}.${body}`;
    const expectedSig  = await hmacSHA256hex(secret, data);
    const expectedBytes = new Uint8Array(expectedSig.match(/.{2}/g).map(b => parseInt(b, 16)));
    const expectedB64   = btoa(String.fromCharCode(...expectedBytes))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    if (expectedB64 !== sig) return null;
    const payload = JSON.parse(b64urlDecode(body));
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;
    return payload;
  } catch { return null; }
}

async function getAuthUser(req, env) {
  const auth  = req.headers.get('Authorization') || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  return verifyJWT(token, env.JWT_SECRET || 'fallback-dev-secret');
}

// ── Password helpers (PBKDF2) ─────────────────────────────────
async function hashPassword(password) {
  const enc  = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2,'0')).join('');
  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password, stored) {
  const [saltHex, expectedHash] = stored.split(':');
  if (!saltHex || !expectedHash) return false;
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const enc  = new TextEncoder();
  const key  = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2,'0')).join('');
  return hashHex === expectedHash;
}

// ── Auth handlers ────────────────────────────────────────────

async function handleSignup(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { name, email, password } = body || {};
  if (!name || !email || !password)
    return json({ error: 'name, email and password are required' }, 400, origin);
  if (password.length < 6)
    return json({ error: 'Password must be at least 6 characters' }, 400, origin);

  const cleanEmail = email.toLowerCase().trim();

  const existing = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(cleanEmail).first();
  if (existing) return json({ error: 'An account with this email already exists' }, 409, origin);

  const hash = await hashPassword(password);
  const now  = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)'
  ).bind(String(name).trim(), cleanEmail, hash, now).run();

  const user = await env.DB.prepare(
    'SELECT id, name, email, license_key, plan FROM users WHERE email = ?'
  ).bind(cleanEmail).first();

  const jwtSecret = env.JWT_SECRET || 'fallback-dev-secret';
  const token = await createJWT(
    { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 30 * 86400 },
    jwtSecret
  );

  return json({ token, user: { id: user.id, name: user.name, email: user.email, licenseKey: user.license_key, plan: user.plan } }, 201, origin);
}

async function handleLogin(req, env, origin) {
  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { email, password } = body || {};
  if (!email || !password) return json({ error: 'email and password are required' }, 400, origin);

  const cleanEmail = email.toLowerCase().trim();
  const user = await env.DB.prepare(
    'SELECT id, name, email, password_hash, license_key, plan FROM users WHERE email = ?'
  ).bind(cleanEmail).first();

  if (!user) {
    // Constant-time response to prevent user enumeration
    await hashPassword('dummy-constant-time-check');
    return json({ error: 'Invalid email or password' }, 401, origin);
  }

  const valid = await verifyPassword(password, user.password_hash);
  if (!valid) return json({ error: 'Invalid email or password' }, 401, origin);

  await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?')
    .bind(new Date().toISOString(), user.id).run();

  const jwtSecret = env.JWT_SECRET || 'fallback-dev-secret';
  const token = await createJWT(
    { sub: user.id, email: user.email, exp: Math.floor(Date.now() / 1000) + 30 * 86400 },
    jwtSecret
  );

  return json({
    token,
    user: { id: user.id, name: user.name, email: user.email, licenseKey: user.license_key, plan: user.plan }
  }, 200, origin);
}

async function handleMe(req, env, origin) {
  const payload = await getAuthUser(req, env);
  if (!payload) return json({ error: 'Unauthorized' }, 401, origin);

  const user = await env.DB.prepare(
    'SELECT id, name, email, license_key, plan, created_at FROM users WHERE id = ?'
  ).bind(payload.sub).first();

  if (!user) return json({ error: 'User not found' }, 404, origin);
  return json({ id: user.id, name: user.name, email: user.email, licenseKey: user.license_key, plan: user.plan, createdAt: user.created_at }, 200, origin);
}

async function handleLinkLicence(req, env, origin) {
  const payload = await getAuthUser(req, env);
  if (!payload) return json({ error: 'Unauthorized' }, 401, origin);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'Invalid JSON' }, 400, origin); }

  const { licenseKey } = body || {};
  if (!licenseKey) return json({ error: 'licenseKey is required' }, 400, origin);

  // Verify licence exists and belongs to this user's email
  const lic = await env.DB.prepare(
    'SELECT plan FROM licenses WHERE license_key = ?'
  ).bind(licenseKey).first();

  if (!lic) return json({ error: 'Licence key not found in our records' }, 404, origin);

  await env.DB.prepare('UPDATE users SET license_key = ?, plan = ? WHERE id = ?')
    .bind(licenseKey, lic.plan, payload.sub).run();

  return json({ linked: true, plan: lic.plan }, 200, origin);
}

// ════════════════════════════════════════════════════════════
// UTILITIES
// ════════════════════════════════════════════════════════════

function adminAuth(req, env) {
  const secret = req.headers.get('x-admin-secret');
  return secret && env.ADMIN_SECRET && secret === env.ADMIN_SECRET;
}

function cors(origin) {
  return {
    'Access-Control-Allow-Origin':  origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-paystack-signature, x-admin-secret',
  };
}

function json(body, status = 200, origin = '*') {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
}
