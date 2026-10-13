/**
 * PermissionService
 * Manages permission lookups with Redis caching
 * Cache TTL: 15 minutes for user permissions, 1 hour for role hierarchy
 *
 * Production Hardening (Phase B.2.1):
 * - Multi-level cache invalidation strategy
 * - Distributed-safe cache operations
 * - Structured logging for audit trails
 * - Prevents stale permission access
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { PrismaService } from '../../../database/prisma.service';
import { PermissionDomain } from '../../../generated/core-client';
import { Cache } from 'cache-manager';
import { AuditService } from '../../../common/audit.service';
import { RequestContextService } from '../../../common/request-context.service';

const USER_PERMISSIONS_CACHE_KEY_PREFIX = 'user:permissions:';
const ROLE_PERMISSIONS_CACHE_KEY_PREFIX = 'role:permissions:';
const ROLE_HIERARCHY_CACHE_KEY = 'role:hierarchy';
const USER_ROLES_CACHE_KEY_PREFIX = 'user:roles:';
const USER_PERMISSIONS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

@Injectable()
export class PermissionService {
  private readonly logger = new Logger(PermissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
    @Optional() private readonly auditService?: AuditService,
  ) {}

  private async emitAudit(opts: {
    action: string;
    userId?: string | null;
    resourceId: string;
    success: boolean;
    reason?: string;
  }) {
    if (!this.auditService) return;
    const ctx = RequestContextService.get();
    await this.auditService.log({
      requestId: ctx?.requestId ?? `rbac-${Date.now()}`,
      correlationId: ctx?.correlationId,
      userId: opts.userId ?? undefined,
      action: opts.action,
      resource: 'rbac',
      resourceId: opts.resourceId,
      success: opts.success,
      reason: opts.reason,
      durationMs: ctx ? Date.now() - ctx.startTime : undefined,
    });
  }

  /**
   * Get all permissions for a user across all their roles
   * Results are cached for performance
   */
  async getUserPermissions(userId: string): Promise<string[]> {
    const cacheKey = USER_PERMISSIONS_CACHE_KEY_PREFIX + userId;

    // Try cache first
    const cached = await this.cacheManager.get<string[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // Get user's roles
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: {
        role: {
          include: {
            permissions: {
              include: {
                permission: true,
              },
            },
          },
        },
      },
    });

    // Collect all permissions from all roles (deduplicated)
    const permissionsSet = new Set<string>();

    for (const userRole of userRoles) {
      for (const rolePermission of userRole.role.permissions) {
        permissionsSet.add(rolePermission.permission.name);
      }
    }

    const permissions = Array.from(permissionsSet);

    // Cache the result
    await this.cacheManager.set(cacheKey, permissions, USER_PERMISSIONS_CACHE_TTL);

    this.logger.debug(
      `Loaded ${permissions.length} permissions for user ${userId}`,
    );

    return permissions;
  }

  /**
   * Check if a user has a specific permission
   */
  async userHasPermission(userId: string, permission: string): Promise<boolean> {
    const permissions = await this.getUserPermissions(userId);
    return permissions.includes(permission);
  }

  /**
   * Check if a user has any of the required permissions
   */
  async userHasAnyPermission(
    userId: string,
    permissions: string[],
  ): Promise<boolean> {
    const userPermissions = await this.getUserPermissions(userId);
    return permissions.some((permission) => userPermissions.includes(permission));
  }

  /**
   * Check if a user has all required permissions
   */
  async userHasAllPermissions(
    userId: string,
    permissions: string[],
  ): Promise<boolean> {
    const userPermissions = await this.getUserPermissions(userId);
    return permissions.every((permission) => userPermissions.includes(permission));
  }

  /**
   * Invalidate user permission cache (call after role changes)
   * Phase B.2.1: Hardened - structured logging with audit context
   */
  async invalidateUserPermissions(userId: string, reason?: string): Promise<void> {
    const cacheKey = USER_PERMISSIONS_CACHE_KEY_PREFIX + userId;
    await this.cacheManager.del(cacheKey);
    
    this.logger.log({
      action: 'cache.invalidate.user_permissions',
      userId,
      reason: reason || 'role_change',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Invalidate role permission cache
   * Phase B.2.1: Hardened - prevents stale role-permission mappings
   */
  async invalidateRolePermissions(roleId: string): Promise<void> {
    const cacheKey = ROLE_PERMISSIONS_CACHE_KEY_PREFIX + roleId;
    await this.cacheManager.del(cacheKey);
    
    this.logger.log({
      action: 'cache.invalidate.role_permissions',
      roleId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Invalidate role hierarchy cache
   * Phase B.2.1: Hardened - used when roles are added/removed
   */
  async invalidateHierarchyCache(): Promise<void> {
    await this.cacheManager.del(ROLE_HIERARCHY_CACHE_KEY);
    
    this.logger.log({
      action: 'cache.invalidate.hierarchy',
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Invalidate all user role caches
   * Phase B.2.1: Hardened - prevents stale role information
   */
  async invalidateUserRoles(userId: string): Promise<void> {
    const cacheKey = USER_ROLES_CACHE_KEY_PREFIX + userId;
    await this.cacheManager.del(cacheKey);
    
    this.logger.log({
      action: 'cache.invalidate.user_roles',
      userId,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Invalidate all affected users when role permissions change
   * Phase B.2.1: Hardened - batch operation for performance
   * Returns count of invalidated users
   */
  async invalidateAllAffectedUsers(roleId: string): Promise<number> {
    try {
      const usersWithRole = await this.prisma.userRole.findMany({
        where: { roleId },
        select: { userId: true },
      });

      const affectedUsers = usersWithRole.length;
      
      // Batch invalidate all users
      for (const { userId } of usersWithRole) {
        await this.invalidateUserPermissions(userId, 'role_permissions_updated');
        await this.invalidateUserRoles(userId);
      }

      // Invalidate role cache
      await this.invalidateRolePermissions(roleId);

      this.logger.log({
        action: 'cache.invalidate.affected_users',
        roleId,
        affectedUsers,
        timestamp: new Date().toISOString(),
      });

      return affectedUsers;
    } catch (error) {
      this.logger.error({
        action: 'cache.invalidate.affected_users.error',
        roleId,
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Emergency cache clear (use cautiously)
   * Phase B.2.1: Hardened - only use if cache is suspected compromised
   */
  async emergencyCacheClear(): Promise<{ cleared: number }> {
    try {
      // Get all cache keys matching our prefixes
      const allKeys = ['user:permissions:*', 'role:permissions:*', 'user:roles:*', ROLE_HIERARCHY_CACHE_KEY];
      
      let cleared = 0;
      for (const pattern of allKeys) {
        if (pattern.includes('*')) {
          // Note: Redis pattern deletion would require direct Redis client
          // For now, we'll rely on TTL expiration
          this.logger.warn({
            action: 'cache.emergency_clear.pattern_not_supported',
            pattern,
            message: 'Use Redis client directly for pattern deletion',
          });
        } else {
          await this.cacheManager.del(pattern);
          cleared++;
        }
      }

      this.logger.warn({
        action: 'cache.emergency_clear',
        cleared,
        timestamp: new Date().toISOString(),
      });

      return { cleared };
    } catch (error) {
      this.logger.error({
        action: 'cache.emergency_clear.error',
        error: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      });
      throw error;
    }
  }

  /**
   * Get all permissions (for admin UI)
   */
  async getAllPermissions() {
    return this.prisma.permission.findMany({
      orderBy: [{ domain: 'asc' }, { name: 'asc' }],
    });
  }

  /**
   * Get permissions by domain
   */
  async getPermissionsByDomain(domain: PermissionDomain) {
    return this.prisma.permission.findMany({
      where: { domain },
      orderBy: { name: 'asc' },
    });
  }

  /**
   * Get all roles with their permissions (for admin UI)
   */
  async getRolesWithPermissions() {
    return this.prisma.role.findMany({
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
      orderBy: { hierarchy: 'asc' },
    });
  }

  /**
   * Get a role with its permissions
   */
  async getRoleWithPermissions(roleId: string) {
    return this.prisma.role.findUnique({
      where: { id: roleId },
      include: {
        permissions: {
          include: {
            permission: true,
          },
        },
      },
    });
  }

  /**
   * Update role permissions (admin only)
   * Invalidates cache for all users with this role
   */
  async updateRolePermissions(
    roleId: string,
    permissionIds: string[],
    actorUserId?: string,
  ): Promise<void> {
    // Delete existing role-permission mappings
    await this.prisma.rolePermission.deleteMany({
      where: { roleId },
    });

    // Create new mappings
    await this.prisma.rolePermission.createMany({
      data: permissionIds.map((permissionId) => ({
        roleId,
        permissionId,
      })),
    });

    // Invalidate cache for all users with this role
    const usersWithRole = await this.prisma.userRole.findMany({
      where: { roleId },
      select: { userId: true },
    });

    for (const { userId } of usersWithRole) {
      await this.invalidateUserPermissions(userId);
    }

    await this.emitAudit({
      action: 'rbac_role_permissions_updated',
      userId: actorUserId ?? RequestContextService.get()?.userId,
      resourceId: roleId,
      success: true,
      reason: 'role_permissions_updated',
    });

    this.logger.debug(`Updated permissions for role ${roleId}`);
  }

  /**
   * Invalidate role hierarchy cache
   */
  async invalidateRoleHierarchyCache(): Promise<void> {
    await this.cacheManager.del(ROLE_HIERARCHY_CACHE_KEY);
    this.logger.debug('Invalidated role hierarchy cache');
  }
}
