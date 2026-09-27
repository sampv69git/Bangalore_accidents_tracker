-- Bangalore Accidents Tracker — PostgreSQL + PostGIS
-- Run once: psql $DATABASE_URL -f Database/schema.sql

-- Enable PostGIS extension for spatial data
CREATE EXTENSION IF NOT EXISTS postgis;

-- Ensure SRID 4326 (WGS 84) exists in spatial_ref_sys
-- This is the standard GPS coordinate system used for lat/lng
INSERT INTO spatial_ref_sys (srid, auth_name, auth_srid, proj4text, srtext)
VALUES (
  4326,
  'EPSG',
  4326,
  '+proj=longlat +datum=WGS84 +no_defs',
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]'
)
ON CONFLICT (srid) DO NOTHING;

-- ─── Main accidents table ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS accidents (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  source        TEXT,
  link          TEXT,
  location      TEXT,
  area          TEXT,
  zone          TEXT,
  severity      TEXT NOT NULL CHECK (severity IN ('fatal', 'serious', 'minor')),
  score         INTEGER CHECK (score >= 1 AND score <= 10),
  date_raw      TEXT,
  accident_date DATE,
  has_coords    BOOLEAN NOT NULL DEFAULT FALSE,
  geom          geometry(Point, 4326),
  status        TEXT NOT NULL DEFAULT 'active',
  reporter_id   TEXT,
  description   TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- ─── Indexes for performance ────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS accidents_geom_gix    ON accidents USING GIST (geom);
CREATE INDEX IF NOT EXISTS accidents_severity_ix ON accidents (severity);
CREATE INDEX IF NOT EXISTS accidents_area_ix     ON accidents (area);
CREATE INDEX IF NOT EXISTS accidents_zone_ix     ON accidents (zone);
CREATE INDEX IF NOT EXISTS accidents_date_ix     ON accidents (accident_date);
CREATE INDEX IF NOT EXISTS accidents_status_ix   ON accidents (status);
CREATE INDEX IF NOT EXISTS accidents_score_ix    ON accidents (score);

COMMENT ON TABLE accidents IS 'News and verified road accident incidents in Bangalore; geom is WGS84 (SRID 4326).';
COMMENT ON COLUMN accidents.geom IS 'PostGIS Point geometry in SRID 4326 (WGS 84 - standard GPS coordinates)';
COMMENT ON COLUMN accidents.score IS 'Severity score 1-10: 1=no injury, 6=1 death, 8=3 deaths, 10=5+ deaths';
COMMENT ON COLUMN accidents.zone IS 'Traffic zone: North, South, East, West, Central, Highway / ORR, Other';
COMMENT ON COLUMN accidents.status IS 'Record status: active (shown on map), pending (awaiting review), hidden (rejected)';

-- ─── Register geometry column in PostGIS metadata ───────────────────────────

-- This ensures the geometry_columns view correctly references our table
SELECT Populate_Geometry_Columns('public.accidents'::regclass);

-- ─── RPC Function: get_accidents_fc ─────────────────────────────────────────
-- Returns a GeoJSON FeatureCollection for the dashboard map

CREATE OR REPLACE FUNCTION get_accidents_fc(
  p_from     TEXT DEFAULT NULL,
  p_to       TEXT DEFAULT NULL,
  p_severity TEXT DEFAULT NULL,
  p_area     TEXT DEFAULT NULL,
  p_zone     TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT jsonb_build_object(
    'type', 'FeatureCollection',
    'features', COALESCE(jsonb_agg(feat), '[]'::jsonb)
  )
  FROM (
    SELECT jsonb_build_object(
      'type', 'Feature',
      'geometry', ST_AsGeoJSON(geom)::jsonb,
      'properties', jsonb_build_object(
        'id',       id,
        'title',    title,
        'source',   source,
        'link',     link,
        'location', location,
        'area',     area,
        'zone',     zone,
        'severity', severity,
        'score',    score,
        'date',     COALESCE(accident_date::TEXT, date_raw, '—'),
        'isUser',   (reporter_id IS NOT NULL)
      )
    ) AS feat
    FROM accidents
    WHERE status = 'active'
      AND has_coords = TRUE
      AND geom IS NOT NULL
      AND (p_from     IS NULL OR accident_date >= p_from::DATE)
      AND (p_to       IS NULL OR accident_date <= p_to::DATE)
      AND (p_severity IS NULL OR severity = p_severity)
      AND (p_area     IS NULL OR area ILIKE '%' || p_area || '%')
      AND (p_zone     IS NULL OR zone = p_zone)
    ORDER BY accident_date DESC NULLS LAST
  ) sub;
$$;

COMMENT ON FUNCTION get_accidents_fc IS 'Returns GeoJSON FeatureCollection of active accidents with spatial filtering';

-- ─── Spatial validation constraint ──────────────────────────────────────────
-- Ensure all geometries are within Bangalore metropolitan region bounding box

ALTER TABLE accidents DROP CONSTRAINT IF EXISTS accidents_geom_bbox;
ALTER TABLE accidents ADD CONSTRAINT accidents_geom_bbox
  CHECK (
    geom IS NULL OR
    ST_Within(geom, ST_MakeEnvelope(77.0, 12.5, 78.2, 13.5, 4326))
  );

COMMENT ON CONSTRAINT accidents_geom_bbox ON accidents IS 'Ensures all points fall within the Bangalore metropolitan bounding box';

-- ─── Analytics RPCs: monthly, by-time, by-area ─────────────────────────────────

CREATE OR REPLACE FUNCTION get_stats_monthly()
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT to_char(date_trunc('month', accident_date), 'YYYY-MM') AS month,
           count(*) AS total,
           sum((severity = 'fatal')::int)    AS fatal,
           sum((severity = 'serious')::int)  AS serious,
           sum((severity = 'minor')::int)    AS minor
    FROM accidents
    WHERE status = 'active' AND geom IS NOT NULL AND accident_date IS NOT NULL
    GROUP BY 1
    ORDER BY 1
  ) t;
$$;

COMMENT ON FUNCTION get_stats_monthly IS 'Monthly totals and severity breakdown for active accidents with coords';

CREATE OR REPLACE FUNCTION get_stats_by_time()
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  WITH parsed AS (
    SELECT
      -- extract hour from date_raw if it contains HH:MM, else NULL
      CASE
        WHEN substring(date_raw from '([0-2][0-9]):([0-5][0-9])') IS NOT NULL
          THEN EXTRACT(hour FROM (substring(date_raw from '([0-2][0-9]):([0-5][0-9])')::time))::int
        ELSE NULL
      END AS hour,
      -- extract day-of-week from accident_date if present (0=Sunday..6=Saturday)
      CASE WHEN accident_date IS NOT NULL THEN EXTRACT(dow FROM accident_date)::int ELSE NULL END AS dow
    FROM accidents
    WHERE status = 'active' AND geom IS NOT NULL
  ),
  hour_counts AS (
    SELECT g.hour, COALESCE(p.cnt,0) AS cnt
    FROM generate_series(0,23) AS g(hour)
    LEFT JOIN (
      SELECT hour, count(*) AS cnt FROM parsed WHERE hour IS NOT NULL GROUP BY hour
    ) p USING (hour)
  ),
  day_counts AS (
    SELECT g.dow, COALESCE(p.cnt,0) AS cnt
    FROM generate_series(0,6) AS g(dow)
    LEFT JOIN (
      SELECT dow, count(*) AS cnt FROM parsed WHERE dow IS NOT NULL GROUP BY dow
    ) p USING (dow)
  ),
  -- joint distribution for the day x hour heatmap; only rows where both are known
  matrix_cells AS (
    SELECT d.dow, h.hour, COALESCE(p.cnt, 0) AS cnt
    FROM generate_series(0,6) AS d(dow)
    CROSS JOIN generate_series(0,23) AS h(hour)
    LEFT JOIN (
      SELECT dow, hour, count(*) AS cnt FROM parsed WHERE dow IS NOT NULL AND hour IS NOT NULL GROUP BY dow, hour
    ) p ON p.dow = d.dow AND p.hour = h.hour
  ),
  matrix_rows AS (
    SELECT dow, jsonb_agg(cnt ORDER BY hour) AS row
    FROM matrix_cells
    GROUP BY dow
  )
  SELECT jsonb_build_object(
    'byHour', (SELECT jsonb_agg(cnt ORDER BY hour) FROM hour_counts),
    'byDay',  (SELECT jsonb_agg(cnt ORDER BY dow) FROM day_counts),
    'matrix', (SELECT jsonb_agg(row ORDER BY dow) FROM matrix_rows)
  );
$$;

COMMENT ON FUNCTION get_stats_by_time IS 'Returns counts grouped by hour (0-23) and day-of-week (0-6) for active accidents with coords; hour parsed from date_raw when possible.';

CREATE OR REPLACE FUNCTION get_stats_by_area()
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT COALESCE(area, 'Unknown') AS area,
           COALESCE(zone, 'Unknown') AS zone,
           count(*) AS total,
           sum((severity = 'fatal')::int)    AS fatal,
           sum((severity = 'serious')::int)  AS serious,
           sum((severity = 'minor')::int)    AS minor
    FROM accidents
    WHERE status = 'active' AND geom IS NOT NULL
    GROUP BY COALESCE(area, 'Unknown'), COALESCE(zone, 'Unknown')
    ORDER BY COALESCE(area, 'Unknown')
  ) t;
$$;

COMMENT ON FUNCTION get_stats_by_area IS 'Totals and severity breakdown per area+zone for active accidents with coords';

-- Add rejection_reason column for admin moderation
ALTER TABLE accidents ADD COLUMN IF NOT EXISTS rejection_reason TEXT;
ALTER TABLE accidents ADD COLUMN IF NOT EXISTS proof_url TEXT;

COMMENT ON COLUMN accidents.rejection_reason IS 'Optional rejection reason provided by an admin when hiding a reported record';
COMMENT ON COLUMN accidents.proof_url IS 'Supabase Storage URL for user-submitted accident proof';

-- Public proof images are readable on the map/profile, but only authenticated
-- users may upload them. The object name is prefixed with the uploader id.
INSERT INTO storage.buckets (id, name, public)
VALUES ('report-proofs', 'report-proofs', TRUE)
ON CONFLICT (id) DO UPDATE SET public = TRUE;

DROP POLICY IF EXISTS "Authenticated users upload report proofs" ON storage.objects;
CREATE POLICY "Authenticated users upload report proofs"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'report-proofs' AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "Anyone can read report proofs" ON storage.objects;
CREATE POLICY "Anyone can read report proofs"
  ON storage.objects FOR SELECT TO public
  USING (bucket_id = 'report-proofs');

-- The Supabase REST client (PostgREST) cannot accept raw WKT/PostGIS values
-- for a `geometry` column through a JSON insert payload, so user reports
-- saved via supabase.from('accidents').insert(...) are created without a
-- geom. This RPC lets the API backfill the point immediately afterwards so
-- every user-submitted report still gets a map location.
CREATE OR REPLACE FUNCTION set_accident_geom(p_id TEXT, p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION)
RETURNS VOID
LANGUAGE sql
AS $$
  UPDATE accidents
  SET geom = ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)
  WHERE id = p_id;
$$;

COMMENT ON FUNCTION set_accident_geom IS 'Backfills geom for a record inserted via the Supabase client, which cannot pass raw PostGIS WKT through PostgREST';

-- Duplicate detection helper: find nearby records within a radius (meters) on same accident_date
CREATE OR REPLACE FUNCTION find_duplicates(p_id TEXT, p_radius_m FLOAT DEFAULT 100)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  WITH target AS (
    SELECT geom, accident_date FROM accidents WHERE id = p_id
  )
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT a.id, a.title, a.location, a.area, a.zone, a.severity, a.accident_date,
           ST_AsGeoJSON(a.geom)::jsonb AS geometry,
           ST_Distance(a.geom::geography, t.geom::geography) AS distance_m
    FROM accidents a, target t
    WHERE a.id <> p_id
      AND a.geom IS NOT NULL
      AND t.geom IS NOT NULL
      AND (a.accident_date IS NOT DISTINCT FROM t.accident_date)
      AND ST_DWithin(a.geom::geography, t.geom::geography, p_radius_m)
    ORDER BY distance_m ASC
  ) t;
$$;

COMMENT ON FUNCTION find_duplicates IS 'Return nearby accidents within radius in meters that share the same accident_date as the target id';

-- ─── Hospitals & Emergency Alerts ────────────────────────────────────────
-- Base tables only. Emergency capability, hospital accounts, the dispatch
-- lifecycle, escalation and live tracking are added by Database/emergency.sql
-- (applied automatically by the API on startup).

CREATE TABLE IF NOT EXISTS hospitals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  webhook_url TEXT,
  address TEXT,
  location geography(Point, 4326),
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS hospitals_location_gix ON hospitals USING GIST (location);
COMMENT ON TABLE hospitals IS 'Emergency hospital locations and contact information';

CREATE TABLE IF NOT EXISTS emergency_alerts (
  id TEXT PRIMARY KEY,
  photo_url TEXT,
  lat DOUBLE PRECISION,
  lng DOUBLE PRECISION,
  address TEXT,
  severity TEXT CHECK (severity IN ('fatal','serious','minor')) DEFAULT 'minor',
  description TEXT,
  status TEXT DEFAULT 'new',
  notified_hospital_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS emergency_alerts_created_idx ON emergency_alerts (created_at DESC);
COMMENT ON TABLE emergency_alerts IS 'Submitted emergency alerts for hospitals; notified_hospital_ids stores list of hospital ids notified';

-- RPC: nearest hospitals using PostGIS KNN distance operator
CREATE OR REPLACE FUNCTION get_nearest_hospitals(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION, p_limit INT DEFAULT 5)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT id, name, phone, address, ST_Distance(location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography)::double precision/1000 AS distance_km
    FROM hospitals
    WHERE location IS NOT NULL
    ORDER BY location <-> ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)
    LIMIT p_limit
  ) t;
$$;

COMMENT ON FUNCTION get_nearest_hospitals IS 'Return nearest hospitals ordered by distance (km)';

-- Duplicate detection by arbitrary point: find nearby accidents within radius (meters)
CREATE OR REPLACE FUNCTION find_duplicates_by_point(p_lat DOUBLE PRECISION, p_lng DOUBLE PRECISION, p_radius_m FLOAT DEFAULT 100, p_date DATE DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(jsonb_agg(row_to_json(t)), '[]'::jsonb) FROM (
    SELECT a.id, a.title, a.location, a.area, a.zone, a.severity, a.accident_date,
           ST_AsGeoJSON(a.geom)::jsonb AS geometry,
           ST_Distance(a.geom::geography, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) AS distance_m
    FROM accidents a
    WHERE a.geom IS NOT NULL
      AND ST_DWithin(a.geom::geography, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography, p_radius_m)
      AND (p_date IS NULL OR a.accident_date IS NOT DISTINCT FROM p_date)
    ORDER BY distance_m ASC
  ) t;
$$;

COMMENT ON FUNCTION find_duplicates_by_point IS 'Return nearby accidents within radius from an arbitrary lat/lng; optionally match accident_date';

-- ─── AI features: report integrity (duplicate / spam / fake-image checks) ──────
-- Optional: the API also keeps these results in server/.cache/integrity.json, so
-- everything works before this runs. Running it lets results live in the database.

ALTER TABLE accidents ADD COLUMN IF NOT EXISTS integrity JSONB;
ALTER TABLE accidents ADD COLUMN IF NOT EXISTS image_phash TEXT;

CREATE INDEX IF NOT EXISTS accidents_image_phash_ix ON accidents (image_phash);

COMMENT ON COLUMN accidents.integrity IS 'Latest automated integrity check (semantic duplicates, spam score, photo forensics) — decision support for moderators';
COMMENT ON COLUMN accidents.image_phash IS '64-bit perceptual difference hash (hex) of the proof photo, used to spot the same photo reused across reports';
