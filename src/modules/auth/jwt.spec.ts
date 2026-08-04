import { SignJWT } from 'jose';
import { signAccessToken, verifyAccessToken } from './jwt.js';

const CLAIMS = {
  sub: '019f0000-0000-7000-8000-000000000001',
  tid: '019f0000-0000-7000-8000-000000000002',
  sid: 'session-abc',
};

describe('access JWT', () => {
  it('round-trips sub/tid/sid', async () => {
    const token = await signAccessToken(CLAIMS);
    const claims = await verifyAccessToken(token);
    expect(claims).toEqual(CLAIMS);
  });

  it('rejects a tampered token', async () => {
    const token = await signAccessToken(CLAIMS);
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(
      Buffer.from(p as string, 'base64url').toString(),
    ) as Record<string, unknown>;
    payload['tid'] = '019f0000-0000-7000-8000-00000000dead';
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    await expect(verifyAccessToken(forged)).rejects.toThrow();
  });

  it('rejects an expired token', async () => {
    const secret = new TextEncoder().encode(process.env['AUTH_JWT_SECRET']);
    const expired = await new SignJWT({ tid: CLAIMS.tid, sid: CLAIMS.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(CLAIMS.sub)
      .setIssuer('cathaid-api')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(secret);
    await expect(verifyAccessToken(expired)).rejects.toThrow();
  });

  it('rejects a foreign issuer', async () => {
    const secret = new TextEncoder().encode(process.env['AUTH_JWT_SECRET']);
    const foreign = await new SignJWT({ tid: CLAIMS.tid, sid: CLAIMS.sid })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(CLAIMS.sub)
      .setIssuer('evil-issuer')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    await expect(verifyAccessToken(foreign)).rejects.toThrow();
  });

  it('rejects tokens missing required claims', async () => {
    const secret = new TextEncoder().encode(process.env['AUTH_JWT_SECRET']);
    const incomplete = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(CLAIMS.sub)
      .setIssuer('cathaid-api')
      .setIssuedAt()
      .setExpirationTime('15m')
      .sign(secret);
    await expect(verifyAccessToken(incomplete)).rejects.toThrow();
  });
});
