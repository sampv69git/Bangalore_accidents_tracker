/**
 * Unit tests for POST /api/reports endpoint
 *
 * **Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5, 7.6**
 *
 * Tests JWT authentication, field validation, coordinate bounds,
 * and successful report insertion via a mock Supabase client.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';

const TEST_JWT_SECRET = 'test-jwt-secret-for-reports';

/** Helper: Create a valid HS256 JWT */
function createJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(signingInput)
    .digest('base64url');
  return `${headerB64}.${payloadB64}.${signature}`;
}

/** Replicates validateJwt middleware for isolated testing */
function createValidateJwt(secret) {
  return function validateJwt(req, res, next) {
    const auth = req.headers.authorization || '';
    if (!auth || !auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'missing authentication credentials' });
    }
    const token = auth.slice(7);

    if (token.startsWith('devtoken_')) {
      const userId = token.slice('devtoken_'.length) || 'anonymous-dev-user';
      req.jwtPayload = {
        sub: userId,
        role: 'authenticated',
        app_metadata: { role: 'authenticated' },
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600
      };
      return next();
    }

    try {
      const parts = token.split('.');
      if (parts.length !== 3) {
        return res.status(401).json({ error: 'Authentication failed' });
      }
      const [headerB64, payloadB64, signatureB64] = parts;
      const signingInput = `${headerB64}.${payloadB64}`;
      const expectedSig = crypto
        .createHmac('sha256', secret)
        .update(signingInput)
        .digest('base64url');
      const sigBuf = Buffer.from(signatureB64, 'base64url');
      const expectedBuf = Buffer.from(expectedSig, 'base64url');
      if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        return res.status(401).json({ error: 'Authentication failed' });
      }
      let payload;
      try {
        payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
      } catch {
        return res.status(401).json({ error: 'Authentication failed' });
      }
      if (payload.exp) {
        const now = Math.floor(Date.now() / 1000);
        if (now > payload.exp + 30) {
          return res.status(401).json({ error: 'Authentication failed' });
        }
      }
      req.jwtPayload = payload;
      next();
    } catch {
      return res.status(401).json({ error: 'Authentication failed' });
    }
  };
}

/** Replicates validateReportFields from server/index.js */
function validateReportFields(body) {
  const errors = [];
  const { latitude, longitude, location, area, severity, date, description } = body || {};

  if (latitude === undefined || latitude === null || latitude === '') {
    errors.push('latitude is required');
  } else {
    const lat = parseFloat(latitude);
    if (isNaN(lat) || lat < 12.5 || lat > 13.5) {
      errors.push('latitude must be between 12.5 and 13.5 (Bangalore metropolitan region)');
    }
  }

  if (longitude === undefined || longitude === null || longitude === '') {
    errors.push('longitude is required');
  } else {
    const lng = parseFloat(longitude);
    if (isNaN(lng) || lng < 77.0 || lng > 78.2) {
      errors.push('longitude must be between 77.0 and 78.2 (Bangalore metropolitan region)');
    }
  }

  if (!location || typeof location !== 'string' || location.trim().length === 0) {
    errors.push('location is required');
  } else if (location.trim().length > 100) {
    errors.push('location must be between 1 and 100 characters');
  }

  if (!area || typeof area !== 'string' || area.trim().length === 0) {
    errors.push('area is required');
  } else if (area.trim().length > 60) {
    errors.push('area must be between 1 and 60 characters');
  }

  if (!severity) {
    errors.push('severity is required');
  } else if (!['fatal', 'serious', 'minor'].includes(severity)) {
    errors.push('severity must be one of: fatal, serious, minor');
  }

  if (!date) {
    errors.push('date is required');
  }

  if (!description || typeof description !== 'string' || description.trim().length === 0) {
    errors.push('description is required');
  } else if (description.trim().length < 20) {
    errors.push('description must be between 20 and 500 characters');
  } else if (description.trim().length > 500) {
    errors.push('description must be between 20 and 500 characters');
  }

  return { valid: errors.length === 0, errors };
}

function inferZone(area) {
  const s = String(area || '').toLowerCase();
  if (!s) return 'Central';
  if (/east|whitefield|kr puram|indiranagar|marathahalli/.test(s)) return 'East';
  if (/north|hebbal|yelahanka/.test(s)) return 'North';
  if (/south|jayanagar|jp nagar|bannerghatta/.test(s)) return 'South';
  if (/west|rajajinagar|vijayanagar/.test(s)) return 'West';
  if (/central|mg road|majestic/.test(s)) return 'Central';
  return 'Other';
}

/**
 * Creates a test Express app with the POST /api/reports endpoint
 * that uses a mock Supabase client.
 */
function createReportsApp(mockSupabase) {
  const app = express();
  app.use(express.json());
  const validateJwt = createValidateJwt(TEST_JWT_SECRET);

  app.post('/api/reports', validateJwt, async (req, res) => {
    try {
      const validation = validateReportFields(req.body);
      if (!validation.valid) {
        return res.status(400).json({ error: 'Validation failed', errors: validation.errors });
      }

      const { latitude, longitude, location, area, severity, date, description } = req.body;
      const lat = parseFloat(latitude);
      const lng = parseFloat(longitude);
      const reporterId = req.jwtPayload.sub;

      let nextId;
      try {
        const { data: maxRows, error: maxErr } = await mockSupabase
          .from('accidents')
          .select('id')
          .order('id', { ascending: false })
          .limit(1);
        if (!maxErr && maxRows && maxRows.length) {
          const maxIdNum = parseInt(maxRows[0].id, 10);
          nextId = Number.isNaN(maxIdNum) ? `rpt_${Date.now()}` : (maxIdNum + 1).toString();
        } else {
          nextId = `rpt_${Date.now()}`;
        }
      } catch {
        nextId = `rpt_${Date.now()}`;
      }

      const wkt = `SRID=4326;POINT(${lng} ${lat})`;

      const newRecord = {
        id: nextId,
        title: `User Report: ${location.trim()}`,
        source: 'User Report',
        link: null,
        location: location.trim(),
        area: area.trim(),
        zone: inferZone(area),
        severity,
        score: severity === 'fatal' ? 10 : severity === 'serious' ? 5 : 1,
        date_raw: date,
        accident_date: date,
        has_coords: true,
        geom: wkt,
        status: 'pending',
        reporter_id: reporterId,
        description: description.trim()
      };

      const { error } = await mockSupabase.from('accidents').insert(newRecord);
      if (error) {
        return res.status(500).json({ error: 'Report could not be saved' });
      }

      return res.status(201).json({ id: nextId });
    } catch (e) {
      return res.status(500).json({ error: 'Report could not be saved' });
    }
  });

  return app;
}

/** Valid report body for reuse in tests */
function validReportBody() {
  return {
    latitude: 12.9716,
    longitude: 77.5946,
    location: 'MG Road near Trinity Circle',
    area: 'Central Bangalore',
    severity: 'serious',
    date: '2024-01-15',
    description: 'A two-vehicle collision occurred at the junction causing serious injuries'
  };
}

function createValidToken(sub = 'user-123') {
  const payload = { sub, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 };
  return createJwt(payload, TEST_JWT_SECRET);
}

describe('POST /api/reports', () => {
  let app;
  let mockInsert;
  let mockSelect;

  beforeAll(() => {
    // Mock Supabase client with chainable API
    mockInsert = vi.fn().mockResolvedValue({ error: null });
    mockSelect = vi.fn().mockReturnValue({
      order: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue({ data: [{ id: '100' }], error: null })
      })
    });

    const mockSupabase = {
      from: vi.fn((table) => ({
        insert: mockInsert,
        select: mockSelect
      }))
    };

    app = createReportsApp(mockSupabase);
  });

  describe('Authentication (Req 7.3)', () => {
    it('returns 401 when no Authorization header is provided', async () => {
      const res = await request(app)
        .post('/api/reports')
        .send(validReportBody());
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('missing authentication credentials');
    });

    it('returns 401 when Authorization header has invalid token', async () => {
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', 'Bearer invalid.token.here')
        .send(validReportBody());
      expect(res.status).toBe(401);
    });

    it('returns 401 when token is expired beyond clock skew', async () => {
      const payload = { sub: 'user-123', exp: Math.floor(Date.now() / 1000) - 120 };
      const token = createJwt(payload, TEST_JWT_SECRET);
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(validReportBody());
      expect(res.status).toBe(401);
    });

    it('accepts the local dev fallback token format used when Supabase is unavailable', async () => {
      const token = 'devtoken_user-123';
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(validReportBody());
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });
  });

  describe('Field validation (Req 7.6)', () => {
    it('returns 400 when all fields are missing', async () => {
      const token = createValidToken();
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Validation failed');
      expect(res.body.errors).toContain('latitude is required');
      expect(res.body.errors).toContain('longitude is required');
      expect(res.body.errors).toContain('location is required');
      expect(res.body.errors).toContain('area is required');
      expect(res.body.errors).toContain('severity is required');
      expect(res.body.errors).toContain('date is required');
      expect(res.body.errors).toContain('description is required');
    });

    it('returns 400 when description is too short (< 20 chars)', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), description: 'Too short' };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('description must be between 20 and 500 characters');
    });

    it('returns 400 when description is too long (> 500 chars)', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), description: 'A'.repeat(501) };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('description must be between 20 and 500 characters');
    });

    it('returns 400 when location exceeds 100 characters', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), location: 'A'.repeat(101) };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('location must be between 1 and 100 characters');
    });

    it('returns 400 when area exceeds 60 characters', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), area: 'A'.repeat(61) };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('area must be between 1 and 60 characters');
    });

    it('returns 400 when severity is not valid', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), severity: 'critical' };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('severity must be one of: fatal, serious, minor');
    });
  });

  describe('Coordinate bounds validation (Req 7.2)', () => {
    it('returns 400 when latitude is below 12.5', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), latitude: 12.4 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('latitude must be between 12.5 and 13.5 (Bangalore metropolitan region)');
    });

    it('returns 400 when latitude is above 13.5', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), latitude: 13.6 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('latitude must be between 12.5 and 13.5 (Bangalore metropolitan region)');
    });

    it('returns 400 when longitude is below 77.0', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), longitude: 76.9 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('longitude must be between 77.0 and 78.2 (Bangalore metropolitan region)');
    });

    it('returns 400 when longitude is above 78.2', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), longitude: 78.3 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.errors).toContain('longitude must be between 77.0 and 78.2 (Bangalore metropolitan region)');
    });

    it('accepts latitude at boundary 12.5 (inclusive)', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), latitude: 12.5 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(201);
    });

    it('accepts latitude at boundary 13.5 (inclusive)', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), latitude: 13.5 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(201);
    });

    it('accepts longitude at boundary 77.0 (inclusive)', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), longitude: 77.0 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(201);
    });

    it('accepts longitude at boundary 78.2 (inclusive)', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), longitude: 78.2 };
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(201);
    });
  });

  describe('Successful report submission (Req 7.1, 7.4)', () => {
    it('returns 201 with created record ID for valid submission', async () => {
      const token = createValidToken();
      const res = await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(validReportBody());
      expect(res.status).toBe(201);
      expect(res.body.id).toBeDefined();
    });

    it('inserts record with status "pending"', async () => {
      const token = createValidToken();
      await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(validReportBody());
      // Verify the insert was called with status: 'pending'
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'pending' })
      );
    });

    it('inserts record with the reporter user ID from JWT', async () => {
      const token = createValidToken('user-abc-456');
      await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(validReportBody());
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ reporter_id: 'user-abc-456' })
      );
    });

    it('stores geometry as PostGIS Point with SRID 4326', async () => {
      const token = createValidToken();
      const body = { ...validReportBody(), latitude: 12.9716, longitude: 77.5946 };
      await request(app)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(body);
      expect(mockInsert).toHaveBeenCalledWith(
        expect.objectContaining({ geom: 'SRID=4326;POINT(77.5946 12.9716)' })
      );
    });

    it('accepts all three severity values', async () => {
      const token = createValidToken();
      for (const sev of ['fatal', 'serious', 'minor']) {
        const body = { ...validReportBody(), severity: sev };
        const res = await request(app)
          .post('/api/reports')
          .set('Authorization', `Bearer ${token}`)
          .send(body);
        expect(res.status).toBe(201);
      }
    });
  });

  describe('Database error handling (Req 7.5)', () => {
    it('returns 500 when database insert fails', async () => {
      // Create a separate app with a failing mock
      const failingInsert = vi.fn().mockResolvedValue({ error: { message: 'DB connection failed' } });
      const failingSupabase = {
        from: vi.fn(() => ({
          insert: failingInsert,
          select: vi.fn().mockReturnValue({
            order: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue({ data: [{ id: '100' }], error: null })
            })
          })
        }))
      };
      const failApp = createReportsApp(failingSupabase);
      const token = createValidToken();
      const res = await request(failApp)
        .post('/api/reports')
        .set('Authorization', `Bearer ${token}`)
        .send(validReportBody());
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Report could not be saved');
      expect(res.body.id).toBeUndefined();
    });
  });
});

describe('validateReportFields - Unit Tests', () => {
  it('returns valid for a complete valid body', () => {
    const result = validateReportFields(validReportBody());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns errors for empty body', () => {
    const result = validateReportFields({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('validates latitude boundary (exactly 12.5 is valid)', () => {
    const body = { ...validReportBody(), latitude: 12.5 };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('validates latitude boundary (exactly 13.5 is valid)', () => {
    const body = { ...validReportBody(), latitude: 13.5 };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('rejects latitude just outside bounds (12.499)', () => {
    const body = { ...validReportBody(), latitude: 12.499 };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
  });

  it('rejects non-numeric latitude', () => {
    const body = { ...validReportBody(), latitude: 'abc' };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
  });

  it('validates description at exactly 20 chars', () => {
    const body = { ...validReportBody(), description: 'A'.repeat(20) };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('validates description at exactly 500 chars', () => {
    const body = { ...validReportBody(), description: 'A'.repeat(500) };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('rejects description at 19 chars', () => {
    const body = { ...validReportBody(), description: 'A'.repeat(19) };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
  });

  it('rejects whitespace-only location', () => {
    const body = { ...validReportBody(), location: '   ' };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
  });

  it('validates longitude boundary (exactly 77.0 is valid)', () => {
    const body = { ...validReportBody(), longitude: 77.0 };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('validates longitude boundary (exactly 78.2 is valid)', () => {
    const body = { ...validReportBody(), longitude: 78.2 };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('rejects longitude just outside lower bound (76.999)', () => {
    const body = { ...validReportBody(), longitude: 76.999 };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('longitude must be between 77.0 and 78.2 (Bangalore metropolitan region)');
  });

  it('rejects longitude just outside upper bound (78.201)', () => {
    const body = { ...validReportBody(), longitude: 78.201 };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('longitude must be between 77.0 and 78.2 (Bangalore metropolitan region)');
  });

  it('rejects non-numeric longitude', () => {
    const body = { ...validReportBody(), longitude: 'xyz' };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('longitude must be between 77.0 and 78.2 (Bangalore metropolitan region)');
  });

  it('validates location at exactly 100 characters', () => {
    const body = { ...validReportBody(), location: 'A'.repeat(100) };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('validates area at exactly 60 characters', () => {
    const body = { ...validReportBody(), area: 'A'.repeat(60) };
    const result = validateReportFields(body);
    expect(result.valid).toBe(true);
  });

  it('rejects whitespace-only area', () => {
    const body = { ...validReportBody(), area: '   ' };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('area is required');
  });

  it('rejects null latitude', () => {
    const body = { ...validReportBody(), latitude: null };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('latitude is required');
  });

  it('rejects empty string latitude', () => {
    const body = { ...validReportBody(), latitude: '' };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('latitude is required');
  });

  it('rejects undefined longitude', () => {
    const body = { ...validReportBody() };
    delete body.longitude;
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('longitude is required');
  });

  it('rejects invalid severity value', () => {
    const body = { ...validReportBody(), severity: 'critical' };
    const result = validateReportFields(body);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('severity must be one of: fatal, serious, minor');
  });

  it('accepts all valid severity values', () => {
    for (const sev of ['fatal', 'serious', 'minor']) {
      const body = { ...validReportBody(), severity: sev };
      const result = validateReportFields(body);
      expect(result.valid).toBe(true);
    }
  });
});
