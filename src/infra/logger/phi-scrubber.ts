// PHI scrubber applied to every log line at the logger layer, so no module
// can accidentally log PHI (backendMLD Phase 0 rule).
//
// Two mechanisms:
//  1. Key-based: any object key matching PHI_KEY_PATTERN has its value replaced.
//  2. Value-based: string values matching obvious identifier shapes (US phone,
//     SSN, MM/DD/YYYY dates) are masked even under innocent keys.

const PHI_KEY_PATTERN =
  /(patient|_name$|^name$|first_?name|last_?name|dob|birth|phone|mobile|mrn|medical_ref|ssn|address|email|telecom)/i;

const VALUE_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, // US phone
  /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/(19|20)\d{2}\b/g, // MM/DD/YYYY
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function scrubString(value: string): string {
  let out = value;
  for (const pattern of VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export function scrubPhi(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return REDACTED;
  if (typeof input === 'string') return scrubString(input);
  if (input === null || typeof input !== 'object') return input;
  if (input instanceof Error) {
    return {
      type: input.name,
      message: scrubString(input.message),
      stack: input.stack,
    };
  }
  if (Array.isArray(input)) return input.map((v) => scrubPhi(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    out[key] = PHI_KEY_PATTERN.test(key)
      ? REDACTED
      : scrubPhi(value, depth + 1);
  }
  return out;
}
