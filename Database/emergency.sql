-- Bangalore Accidents Tracker — Emergency response (hospital capability,
-- hospital accounts, dispatch lifecycle, escalation, live tracking).
--
-- Idempotent: safe to run repeatedly. Requires the `hospitals` and
-- `emergency_alerts` tables from schema.sql. The API applies this file on
-- startup unless EMERGENCY_AUTO_MIGRATE=false; to run it by hand:
--   psql $DATABASE_URL -f Database/emergency.sql

-- ─── Hospitals: capability + live ER status ──────────────────────────────────

ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS osm_type TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS osm_id BIGINT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS facility_type TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS emergency_level TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS level_source TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS beds INTEGER;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS operator_type TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'osm';
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS verified BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS er_status TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS er_status_note TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS er_status_updated_at TIMESTAMPTZ;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS er_status_updated_by TEXT;
ALTER TABLE hospitals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

ALTER TABLE hospitals DROP CONSTRAINT IF EXISTS hospitals_emergency_level_chk;
ALTER TABLE hospitals ADD CONSTRAINT hospitals_emergency_level_chk
  CHECK (emergency_level IS NULL OR emergency_level IN ('trauma', 'emergency', 'general', 'none'));
ALTER TABLE hospitals DROP CONSTRAINT IF EXISTS hospitals_er_status_chk;
ALTER TABLE hospitals ADD CONSTRAINT hospitals_er_status_chk
  CHECK (er_status IS NULL OR er_status IN ('accepting', 'busy', 'diverting'));

CREATE INDEX IF NOT EXISTS hospitals_emergency_level_ix ON hospitals (emergency_level);

COMMENT ON COLUMN hospitals.emergency_level IS 'trauma | emergency | general | none — whether road-accident victims can be routed here';
COMMENT ON COLUMN hospitals.level_source IS 'How emergency_level was decided: osm tag, name-rule, curated list, or admin';
COMMENT ON COLUMN hospitals.er_status IS 'Live ER availability set by the hospital: accepting | busy | diverting (NULL = unknown). Diverting hospitals are skipped by dispatch';
COMMENT ON COLUMN hospitals.verified IS 'An admin confirmed this record; re-seeding will not overwrite it';

-- ─── Hospital accounts (Supabase user → hospital) ────────────────────────────

CREATE TABLE IF NOT EXISTS hospital_users (
  user_id     TEXT PRIMARY KEY,
  hospital_id TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE,
  email       TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hospital_users_hospital_ix ON hospital_users (hospital_id);
COMMENT ON TABLE hospital_users IS 'Links a Supabase auth user (role=hospital) to the hospital they respond for';

-- ─── Emergency alerts: dispatch lifecycle ────────────────────────────────────

ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS priority TEXT DEFAULT 'urgent';
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'sos';
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS report_id TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS reporter_id TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS reporter_phone TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS accuracy_m DOUBLE PRECISION;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS triage JSONB DEFAULT '{}'::jsonb;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS note TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS vision_severity TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS vision_description TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS photo_count INTEGER DEFAULT 0;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS track_token_hashes TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS crew_token_hashes TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS report_count INTEGER DEFAULT 1;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS accepted_hospital_id TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS accepted_hospital_name TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS accepted_by TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS on_scene_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS transporting_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS close_outcome TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS escalation_round INTEGER DEFAULT 0;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS next_escalation_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS escalation_exhausted_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS ambulance_lat DOUBLE PRECISION;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS ambulance_lng DOUBLE PRECISION;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS ambulance_accuracy_m DOUBLE PRECISION;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS ambulance_updated_at TIMESTAMPTZ;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS ambulance_eta_min DOUBLE PRECISION;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS ambulance_eta_source TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS is_drill BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE emergency_alerts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

-- The first version only had new/acknowledged.
ALTER TABLE emergency_alerts DROP CONSTRAINT IF EXISTS emergency_alerts_status_chk;
UPDATE emergency_alerts SET status = 'accepted' WHERE status = 'acknowledged';
UPDATE emergency_alerts SET status = 'new' WHERE status IS NULL;
ALTER TABLE emergency_alerts ADD CONSTRAINT emergency_alerts_status_chk
  CHECK (status IN ('new', 'accepted', 'dispatched', 'on_scene', 'transporting', 'closed', 'cancelled'));
ALTER TABLE emergency_alerts DROP CONSTRAINT IF EXISTS emergency_alerts_priority_chk;
ALTER TABLE emergency_alerts ADD CONSTRAINT emergency_alerts_priority_chk
  CHECK (priority IN ('critical', 'urgent', 'standard'));

CREATE INDEX IF NOT EXISTS emergency_alerts_status_ix ON emergency_alerts (status);
CREATE INDEX IF NOT EXISTS emergency_alerts_escalation_ix ON emergency_alerts (next_escalation_at) WHERE status = 'new';
CREATE INDEX IF NOT EXISTS emergency_alerts_accepted_hospital_ix ON emergency_alerts (accepted_hospital_id);

COMMENT ON COLUMN emergency_alerts.status IS 'new → accepted → dispatched → on_scene → transporting → closed, or cancelled';
COMMENT ON COLUMN emergency_alerts.priority IS 'critical | urgent | standard — from bystander triage (+ photo estimate)';
COMMENT ON COLUMN emergency_alerts.track_token_hashes IS 'SHA-256 of the reporter tracking tokens (one per merged report); tokens are never stored';
COMMENT ON COLUMN emergency_alerts.crew_token_hashes IS 'SHA-256 of ambulance-crew link tokens issued by the accepting hospital';
COMMENT ON COLUMN emergency_alerts.is_drill IS 'Simulated alert (scripts/simulate-emergencies.mjs); excluded from metrics by default';

-- Which hospitals were offered an alert, in which escalation round, and how they answered.
CREATE TABLE IF NOT EXISTS emergency_alert_targets (
  alert_id       TEXT NOT NULL REFERENCES emergency_alerts(id) ON DELETE CASCADE,
  hospital_id    TEXT NOT NULL,
  hospital_name  TEXT,
  round          INTEGER NOT NULL,
  distance_km    DOUBLE PRECISION,
  eta_min        DOUBLE PRECISION,
  eta_source     TEXT,
  rank_score     DOUBLE PRECISION,
  response       TEXT NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'accepted', 'declined', 'missed')),
  decline_reason TEXT,
  notified_at    TIMESTAMPTZ DEFAULT now(),
  responded_at   TIMESTAMPTZ,
  notify_result  JSONB,
  PRIMARY KEY (alert_id, hospital_id)
);
CREATE INDEX IF NOT EXISTS emergency_alert_targets_hospital_ix ON emergency_alert_targets (hospital_id, notified_at DESC);

-- Timeline of everything that happened to an alert (audit trail + metrics).
CREATE TABLE IF NOT EXISTS emergency_alert_events (
  id          BIGSERIAL PRIMARY KEY,
  alert_id    TEXT NOT NULL REFERENCES emergency_alerts(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  actor       TEXT,
  hospital_id TEXT,
  data        JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emergency_alert_events_alert_ix ON emergency_alert_events (alert_id, created_at);

-- Scene photos are private (victims may be identifiable): stored here and only
-- served to the reporter, notified hospitals and admins through the API.
CREATE TABLE IF NOT EXISTS emergency_alert_photos (
  id         BIGSERIAL PRIMARY KEY,
  alert_id   TEXT NOT NULL REFERENCES emergency_alerts(id) ON DELETE CASCADE,
  mime       TEXT NOT NULL,
  bytes      BYTEA NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS emergency_alert_photos_alert_ix ON emergency_alert_photos (alert_id);

-- ─── RPC: nearest hospitals (now with capability + live status) ──────────────

CREATE OR REPLACE FUNCTION get_nearest_hospitals(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION, p_limit INT DEFAULT 5)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT id, name, phone, address, facility_type, emergency_level, er_status,
           ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng,
           ST_Distance(location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)::double precision / 1000 AS distance_km
    FROM hospitals
    WHERE location IS NOT NULL
    ORDER BY location <-> ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography
    LIMIT p_limit
  ) t;
$$;

COMMENT ON FUNCTION get_nearest_hospitals IS 'Return nearest hospitals ordered by distance (km), with emergency capability and ER status';

-- ─── Row Level Security ──────────────────────────────────────────────────────
-- These tables hold reporter tokens, phone numbers and scene photos. The API
-- connects as the database owner (bypasses RLS); with RLS on and no policies,
-- the public anon / authenticated REST roles cannot read or write them.
ALTER TABLE hospital_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_alert_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_alert_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE emergency_alert_photos ENABLE ROW LEVEL SECURITY;
