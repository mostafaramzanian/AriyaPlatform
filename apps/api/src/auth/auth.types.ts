import type { Request as ExRequest } from 'express';

/**
 * The identity passport's LocalStrategy leaves on `req.user` at login: the
 * validated user row (see `AuthService.validateUser`, which strips
 * `passwordHash`), plus the optional session metadata the login path reads.
 */
export interface PassportLoginUser {
  readonly id: string;
  readonly email: string;
  readonly rememberMe?: boolean;
  readonly userAgent?: string;
}

/** A request carrying the passport login principal (`LocalAuthGuard` attaches it). */
export type LoginRequest = ExRequest & { user: PassportLoginUser };

/**
 * The principal `JwtStrategy.validate` attaches on JWT-guarded routes. `sub`
 * is always present (the strategy rejects any token without it) — the same
 * contract `rbac.controller.ts` already asserts with `Express.User & { sub: string }`.
 */
export interface JwtSessionUser {
  readonly sub: string;
  readonly userId?: string;
  readonly email?: string | null;
}

/** A request carrying the JWT principal passport attached, if any. */
export type AuthenticatedRequest = ExRequest & { user?: JwtSessionUser };

/**
 * A request on a JWT-guarded route: `JwtAuthGuard` has already resolved the
 * principal, so `user` is present and `sub` is set (the strategy rejects any
 * token without it). Handlers may read `req.user.sub` directly.
 */
export type AuthenticatedPrincipalRequest = ExRequest & { user: JwtSessionUser };
