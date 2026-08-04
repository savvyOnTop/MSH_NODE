import { scrubPhi } from './phi-scrubber.js';

describe('scrubPhi', () => {
  it('redacts PHI-named keys at any depth', () => {
    const out = scrubPhi({
      patient_name: 'John Doe',
      dob: '01/02/1960',
      nested: { phone_number: '2125551234', mrn: 'A123', medical_ref_no: 'B9' },
      list: [{ email: 'a@b.com' }],
    }) as {
      patient_name: string;
      dob: string;
      nested: Record<string, string>;
      list: Record<string, string>[];
    };

    expect(out.patient_name).toBe('[REDACTED]');
    expect(out.dob).toBe('[REDACTED]');
    expect(out.nested['phone_number']).toBe('[REDACTED]');
    expect(out.nested['mrn']).toBe('[REDACTED]');
    expect(out.nested['medical_ref_no']).toBe('[REDACTED]');
    expect(out.list[0]?.['email']).toBe('[REDACTED]');
  });

  it('masks identifier-shaped values under innocent keys', () => {
    const out = scrubPhi({
      note: 'call me at 212-555-1234 re SSN 123-45-6789 born 01/02/1960',
    }) as Record<string, string>;
    expect(out['note']).not.toContain('212-555-1234');
    expect(out['note']).not.toContain('123-45-6789');
    expect(out['note']).not.toContain('01/02/1960');
  });

  it('leaves clinical non-PHI intact', () => {
    const out = scrubPhi({
      caseId: 'c-1',
      stage: 'under_review',
      heart_rate: 98,
      status: 'Accepted',
    }) as Record<string, unknown>;
    expect(out).toEqual({
      caseId: 'c-1',
      stage: 'under_review',
      heart_rate: 98,
      status: 'Accepted',
    });
  });

  it('handles errors, arrays, depth limits without throwing', () => {
    const err = new Error('patient phone 2125551234');
    const out = scrubPhi(err) as Record<string, string>;
    expect(out['message']).not.toContain('2125551234');

    let deep: Record<string, unknown> = { v: 'x' };
    for (let i = 0; i < 20; i += 1) deep = { child: deep };
    expect(() => scrubPhi(deep)).not.toThrow();
  });
});
