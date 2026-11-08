const { z } = require('zod');

const PhoneRecordSchema = z.object({
  key: z.string(),
  display: z.string(),
  raw: z.string().optional(),
  e164: z.string().optional(),
  national: z.string().optional(),
});

const ScrapeResultSchema = z.object({
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  emails: z.array(z.string()).default([]),
  phones: z.array(z.string()).default([]),
  phone_records: z.array(PhoneRecordSchema).default([]),
  pages_scanned: z.array(z.string()).default([]),
  extraction_notes: z.array(z.string()).default([]),
  render_used_on: z.array(z.string()).optional(),
});

const ApiResponseSchema = z.object({
  ok: z.boolean(),
  data: ScrapeResultSchema.optional(),
  error: z.string().optional(),
  level: z.number().int().min(0).max(4),
  fallback: z.boolean().optional(),
  warnings: z.array(z.string()).optional(),
});

function validateResult(raw) {
  const warnings = [];

  if (raw.data) {
    if (!raw.data.email && raw.data.emails && raw.data.emails.length === 0) {
      warnings.push('no emails found');
    }
    if (!raw.data.phone && raw.data.phones && raw.data.phones.length === 0) {
      warnings.push('no phones found');
    }
    if (raw.data.pages_scanned && raw.data.pages_scanned.length === 0) {
      warnings.push('no pages were successfully scanned');
    }
  }

  if (raw.error) {
    warnings.push(raw.error);
  }

  try {
    return { ok: true, data: ApiResponseSchema.parse(raw), warnings };
  } catch (err) {
    return { ok: false, error: `validation failed: ${err.message}`, warnings };
  }
}

function detectAnomalies(result) {
  const anomalies = [];

  if (result.emails && result.emails.length > 0) {
    const invalid = result.emails.filter(e => !e.includes('@') || e.length < 5);
    if (invalid.length > 0) {
      anomalies.push(`${invalid.length} suspicious email(s) detected`);
    }
  }

  if (result.phones && result.phones.length > 0) {
    const shortPhones = result.phones.filter(p => p.replace(/\D/g, '').length < 10);
    if (shortPhones.length > 0) {
      anomalies.push(`${shortPhones.length} phone(s) appear incomplete`);
    }
  }

  if (result.render_used_on && result.render_used_on.length > 0 && result.pages_scanned && result.pages_scanned.length === 0) {
    anomalies.push('browser rendered but no pages fully scanned');
  }

  return anomalies;
}

module.exports = { validateResult, detectAnomalies };
