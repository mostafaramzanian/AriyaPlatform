import { Injectable, CanActivate, ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

/**
 * OptionalAuthGuard attempts JWT validation but doesn't fail if missing
 * Used for endpoints that provide different content based on auth status
 * Sets request.user if valid token provided, otherwise leaves undefined
 */
@Injectable()
export class OptionalAuthGuard extends AuthGuard('jwt') implements CanActivate {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    return super.canActivate(context);
  }

  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    // Return user if authenticated, otherwise return null (not unauthorized).
    // `err` is deliberately not read: an optional endpoint degrades to anonymous.
    // The single `as TUser` is the same generic mirror the JWT guard uses —
    // `null` is the documented anonymous principal here, not a type hole.
    return (user || null) as TUser;
  }
}
