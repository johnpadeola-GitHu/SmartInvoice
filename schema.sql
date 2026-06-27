-- SmartInvoice Pro — Cloudflare D1 Schema
-- Run with: wrangler d1 execute smartinvoice --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS agents (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  phone          TEXT    NOT NULL UNIQUE,
  market         TEXT    NOT NULL,
  referral_code  TEXT    NOT NULL UNIQUE,
  photo_url      TEXT,
  total_sales    INTEGER NOT NULL DEFAULT 0,
  total_revenue  INTEGER NOT NULL DEFAULT 0,
  total_earnings INTEGER NOT NULL DEFAULT 0,
  balance        INTEGER NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reference           TEXT    NOT NULL UNIQUE,
  agent_phone         TEXT,
  plan                TEXT    NOT NULL,
  amount              INTEGER NOT NULL,
  email               TEXT    NOT NULL,
  customer_name       TEXT,
  status              TEXT    NOT NULL DEFAULT 'pending',
  commission          INTEGER NOT NULL DEFAULT 0,
  metadata            TEXT,
  webhook_received_at TEXT,
  created_at          TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reference   TEXT NOT NULL UNIQUE,
  license_key TEXT NOT NULL UNIQUE,
  plan        TEXT NOT NULL,
  email       TEXT NOT NULL,
  issued_at   TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payouts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_phone TEXT    NOT NULL,
  amount      INTEGER NOT NULL,
  status      TEXT    NOT NULL DEFAULT 'pending',
  note        TEXT,
  created_at  TEXT    NOT NULL,
  paid_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
CREATE INDEX IF NOT EXISTS idx_payments_agent     ON payments(agent_phone);
CREATE INDEX IF NOT EXISTS idx_payments_status    ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_created   ON payments(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_licenses_reference ON licenses(reference);
CREATE INDEX IF NOT EXISTS idx_payouts_agent      ON payouts(agent_phone);
CREATE INDEX IF NOT EXISTS idx_payouts_status     ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_agents_active      ON agents(is_active);
