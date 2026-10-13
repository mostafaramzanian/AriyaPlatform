/**
 * RolesGuard
 * Validates that the current user has the required permissions
 * Works in conjunction with @Roles() decorator
 */

import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { PermissionSource } from '../../../platform/auth/permission-source.contract';
import type { TrustedTokenClaims } from '../../../platform/auth/token-contract';

/**
 * Guard that checks if user has required permissions
 * Protected routes use @Roles(...permissions) decorator
 * Public routes use @Public() decorator to bypass this guard
 *
 * Phase 51-HR-ARCH-3A: the guard now asks a PORT (`PermissionSource`) instead of
 * `PermissionService`. The answer depends on the token's trust level — the `perm` claim at
 * asymmetric trust (no Core query at all), Core's cached catalogue for a legacy token — so
 * this guard is no longer, by itself, a reason for a business runtime to hold Core's
 * database. The `@Roles()` contract, the metadata key and the 403 semantics are unchanged.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  private readonly logger = new Logger(RolesGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly permissionSource: PermissionSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // Check if route is public (bypass this guard)
    const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    // Get required permissions from decorator
    // Phase 33N: @Roles() (auth/decorators/roles.decorator.ts) writes metadata
    // under the key 'roles' via SetMetadata('roles', roles). This guard must
    // read that same key. It previously read 'permissions', a key nothing in
    // the codebase ever wrote — every @Roles()-guarded route therefore always
    // fell through to the "no permissions required" branch below, bypassing
    // authorization entirely. All 18 existing @Roles(...) call sites already
    // pass permission-string constants (e.g. Permissions.BLOG_WRITE), which
    // is exactly what this guard expects to receive.
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      'roles',
      [context.getHandler(), context.getClass()],
    );

    // If no permissions required, allow access (rely on JWT guard)
    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    // User must be authenticated (verified by JwtAuthGuard before this runs)
    const user = request.user as Express.User & {
      sub: string;
      claims?: TrustedTokenClaims | null;
    };
    if (!user?.sub) {
      this.logger.warn('Access attempt without user context');
      throw new ForbiddenException('Authentication required');
    }

    try {
      // Phase 51-HR-ARCH-3A: the authority is the PORT, and the port decides from the
      // token's trust level. `user.claims` is the verifier's output, so a payload that
      // never passed verification cannot be mistaken for one that did; absent claims mean
      // "no verified token" and the port answers that case explicitly.
      const userPermissions = await this.permissionSource.getEffectivePermissions(
        user.sub,
        user.claims ?? null,
      );

      // Check if user has at least one required permission
      const hasPermission = requiredPermissions.some((permission) =>
        userPermissions.includes(permission),
      );

      if (!hasPermission) {
        this.logger.warn(
          `Access denied for user ${user.sub}. Required: ${requiredPermissions}, Has: ${userPermissions}`,
        );
        throw new ForbiddenException('Insufficient permissions');
      }

      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      this.logger.error(
        `Error checking permissions for user ${user.sub}: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new ForbiddenException('Permission check failed');
    }
  }
}
