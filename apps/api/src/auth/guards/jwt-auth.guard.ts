import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Reflector } from '@nestjs/core';

/**
 * JwtAuthGuard validates JWT tokens in Authorization header
 * Rejects requests with invalid or expired tokens
 * Allows @Public() decorated routes to bypass authentication
 * Sets request.user with decoded JWT payload
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') implements CanActivate {
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    return super.canActivate(context);
  }

  // Passport's own shape: the strategy's failure, the resolved principal (or a
  // falsy value when validation failed), and nothing else — `info` is never read.
  // The generic mirror keeps the override assignable to `AuthGuard('jwt')`'s
  // `<TUser>(err, user, info, ...) => TUser` while typing the inputs here.
  handleRequest<TUser>(err: unknown, user: TUser): TUser {
    if (err || !user) {
      throw err || new UnauthorizedException('Invalid or expired token');
    }
    return user;
  }
}
