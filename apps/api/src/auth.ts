import { errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export type VerifyFailure = 'invalid_token' | 'expired_token';

export type VerifyResult = { ok: true; email: string } | { ok: false; reason: VerifyFailure };

export type SupabaseJwtKeys = {
  /** The project's legacy JWT secret; verifies `alg: HS256` tokens. */
  secret: string;
  /**
   * Resolver for the project's JWT signing keys (`/auth/v1/.well-known/jwks.json`);
   * verifies `alg: ES256` tokens, which the Supabase CLI issues locally. Without it
   * an asymmetric token is rejected as `invalid_token`.
   */
  jwks?: JWTVerifyGetKey;
};

/**
 * Verify a Supabase access token and return its `email` claim.
 *
 * This is deliberately the only function that knows how tokens are checked.
 * HS256 tokens are verified with the shared secret, ES256 tokens against the
 * JWKS resolver; dropping HS256 later means deleting one branch here and
 * nothing anywhere else.
 */
export async function verifySupabaseJwt(
  token: string,
  keys: SupabaseJwtKeys,
): Promise<VerifyResult> {
  const secret = new TextEncoder().encode(keys.secret);
  const getKey: JWTVerifyGetKey = (header, input) => {
    if (header.alg === 'HS256') return secret;
    if (!keys.jwks) throw new errors.JOSENotSupported(`no key resolver for alg ${header.alg}`);
    return keys.jwks(header, input);
  };

  try {
    // jose only checks `exp` when the claim is present; require it so a token
    // minted without one cannot live forever.
    const { payload } = await jwtVerify(token, getKey, {
      algorithms: ['HS256', 'ES256'],
      requiredClaims: ['exp'],
    });
    if (typeof payload.email !== 'string' || payload.email.length === 0) {
      return { ok: false, reason: 'invalid_token' };
    }
    return { ok: true, email: payload.email };
  } catch (error) {
    if (error instanceof errors.JWTExpired) {
      return { ok: false, reason: 'expired_token' };
    }
    return { ok: false, reason: 'invalid_token' };
  }
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
export function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
