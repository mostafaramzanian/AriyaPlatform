/**
 * RoleService
 * Manages roles and user-role assignments
 * Publishes events for role changes
 */

import { Injectable, BadRequestException, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { NotificationPublisher } from '../../../notifications/notification.publisher';
import { HierarchyValidationService } from './hierarchy-validation.service';
import { PermissionService } from './permission.service';
import { PermissionDomain, RoleName } from '../../../generated/core-client';
import { AuditService } from '../../../common/audit.service';
import { RequestContextService } from '../../../common/request-context.service';

@Injectable()
export class RoleService {
  private readonly logger = new Logger(RoleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissionService: PermissionService,
    private readonly notificationPublisher: NotificationPublisher,
    private readonly hierarchyValidation: HierarchyValidationService,
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
   * Assign a role to a user
   * Only users with higher hierarchy can assign roles to lower hierarchy
   */
  async assignRoleToUser(
    userId: string,
    roleId: string,
    assignedBy: string,
  ): Promise<void> {
    // Validate hierarchy constraints
    await this.hierarchyValidation.validateAssignment(
      assignedBy,
      userId,
      roleId,
    );

    // Validate no circular escalation
    await this.hierarchyValidation.validateNoCircularEscalation(
      userId,
      roleId,
    );

    // Get the role being assigned for event publishing
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!role) {
      throw new BadRequestException('Role not found');
    }

    // Prevent duplicate assignment
    const existing = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId, roleId } },
    });

    if (existing) {
      throw new BadRequestException('User already has this role');
    }

    // Assign role
    await this.prisma.userRole.create({
      data: {
        userId,
        roleId,
        assignedBy,
      },
    });

    // Invalidate user permissions cache
    await this.permissionService.invalidateUserPermissions(userId);

    // Increment tokenVersion to invalidate old JWTs
    await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    // Publish event
    await this.notificationPublisher.publish('rbac.role.assigned', {
      userId,
      roleId,
      roleName: role.name,
      assignedBy,
      timestamp: new Date(),
    });

    await this.emitAudit({
      action: 'rbac_role_assigned',
      userId: assignedBy,
      resourceId: userId,
      success: true,
      reason: 'role_assignment_success',
    });

    this.logger.log(`Role ${role.name} assigned to user ${userId} by ${assignedBy}`);
  }

  /**
   * Remove a role from a user
   */
  async removeRoleFromUser(
    userId: string,
    roleId: string,
    removedBy: string,
  ): Promise<void> {
    // Validate hierarchy constraints
    await this.hierarchyValidation.validateRemoval(removedBy, userId, roleId);

    // Get the role being removed
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
    });

    if (!role) {
      throw new BadRequestException('Role not found');
    }

    // Check if user has the role
    const userRole = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId, roleId } },
    });

    if (!userRole) {
      throw new BadRequestException('User does not have this role');
    }

    // Remove role
    await this.prisma.userRole.delete({
      where: { userId_roleId: { userId, roleId } },
    });

    // Invalidate user permissions cache
    await this.permissionService.invalidateUserPermissions(userId);

    // Increment tokenVersion to invalidate old JWTs
    await this.prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } },
    });

    // Publish event
    await this.notificationPublisher.publish('rbac.role.removed', {
      userId,
      roleId,
      roleName: role.name,
      removedBy,
      timestamp: new Date(),
    });

    await this.emitAudit({
      action: 'rbac_role_removed',
      userId: removedBy,
      resourceId: userId,
      success: true,
      reason: 'role_removal_success',
    });

    this.logger.log(`Role ${role.name} removed from user ${userId} by ${removedBy}`);
  }

  /**
   * Get all roles for a user
   */
  async getUserRoles(userId: string) {
    return this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
      orderBy: { role: { hierarchy: 'asc' } },
    });
  }

  /**
   * Get user's highest privilege role
   */
  async getUserHighestRole(userId: string) {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
      orderBy: { role: { hierarchy: 'asc' } },
      take: 1,
    });

    return userRoles[0]?.role || null;
  }

  /**
   * Check if user has a specific role
   */
  async userHasRole(userId: string, roleName: string): Promise<boolean> {
    const userRole = await this.prisma.userRole.findFirst({
      where: {
        userId,
        role: { name: roleName as RoleName },
      },
    });

    return !!userRole;
  }

  /**
   * Get all users with a specific role
   */
  async getUsersWithRole(roleId: string) {
    return this.prisma.userRole.findMany({
      where: { roleId },
      include: { user: true },
    });
  }

  /**
   * Get available roles that a user can assign (their hierarchy and below)
   */
  async getAssignableRoles(userId: string) {
    const userHighestRole = await this.getUserHighestRole(userId);

    if (!userHighestRole) {
      throw new BadRequestException('User has no roles');
    }

    return this.prisma.role.findMany({
      where: {
        hierarchy: { gte: userHighestRole.hierarchy },
      },
      orderBy: { hierarchy: 'asc' },
    });
  }

  /**
   * Initialize default roles and permissions (run on startup or migration)
   */
  async initializeDefaultRoles(): Promise<void> {
    // Check if roles already exist
    const existingRoles = await this.prisma.role.count();
    if (existingRoles > 0) {
      this.logger.debug('Default roles already initialized');
      return;
    }

    this.logger.log('Initializing default roles and permissions');

    // Create all permissions first
    const permissionData: Array<{ name: string; domain: PermissionDomain; displayName: string }> = [
      // Users domain
      { name: 'users.read', domain: 'USERS' as PermissionDomain, displayName: 'Read Users' },
      { name: 'users.create', domain: 'USERS' as PermissionDomain, displayName: 'Create Users' },
      { name: 'users.update', domain: 'USERS' as PermissionDomain, displayName: 'Update Users' },
      { name: 'users.delete', domain: 'USERS' as PermissionDomain, displayName: 'Delete Users' },

      // Leads domain
      { name: 'leads.read', domain: 'LEADS' as PermissionDomain, displayName: 'Read Leads' },
      { name: 'leads.create', domain: 'LEADS' as PermissionDomain, displayName: 'Create Leads' },
      { name: 'leads.update', domain: 'LEADS' as PermissionDomain, displayName: 'Update Leads' },
      { name: 'leads.assign', domain: 'LEADS' as PermissionDomain, displayName: 'Assign Leads' },
      { name: 'leads.delete', domain: 'LEADS' as PermissionDomain, displayName: 'Delete Leads' },

      // Meetings domain
      { name: 'meetings.read', domain: 'MEETINGS' as PermissionDomain, displayName: 'Read Meetings' },
      { name: 'meetings.schedule', domain: 'MEETINGS' as PermissionDomain, displayName: 'Schedule Meetings' },
      { name: 'meetings.cancel', domain: 'MEETINGS' as PermissionDomain, displayName: 'Cancel Meetings' },

      // Blog domain
      { name: 'blog.read', domain: 'BLOG' as PermissionDomain, displayName: 'Read Blog' },
      { name: 'blog.write', domain: 'BLOG' as PermissionDomain, displayName: 'Write Blog' },
      { name: 'blog.publish', domain: 'BLOG' as PermissionDomain, displayName: 'Publish Blog' },
      { name: 'blog.delete', domain: 'BLOG' as PermissionDomain, displayName: 'Delete Blog' },

      // Admin domain
      { name: 'admin.dashboard', domain: 'ADMIN' as PermissionDomain, displayName: 'Admin Dashboard' },
      { name: 'admin.settings', domain: 'ADMIN' as PermissionDomain, displayName: 'Admin Settings' },
      { name: 'admin.audit', domain: 'ADMIN' as PermissionDomain, displayName: 'Audit Logs' },

      // Partner domain
      { name: 'partner.dashboard', domain: 'PARTNER' as PermissionDomain, displayName: 'Partner Dashboard' },
      { name: 'partner.deals', domain: 'PARTNER' as PermissionDomain, displayName: 'Partner Deals' },
      { name: 'partner.revenue', domain: 'PARTNER' as PermissionDomain, displayName: 'Partner Revenue' },

      // Customer domain
      { name: 'customer.dashboard', domain: 'CUSTOMER' as PermissionDomain, displayName: 'Customer Dashboard' },
      { name: 'customer.profile', domain: 'CUSTOMER' as PermissionDomain, displayName: 'Customer Profile' },

      // Support domain
      { name: 'support.tickets', domain: 'SUPPORT' as PermissionDomain, displayName: 'Support Tickets' },
      { name: 'support.downloads', domain: 'SUPPORT' as PermissionDomain, displayName: 'Support Downloads' },
    ];

    // Create permissions
    const permissions = await Promise.all(
      permissionData.map((perm) =>
        this.prisma.permission.upsert({
          where: { name: perm.name },
          update: {},
          create: perm,
        }),
      ),
    );

    const permissionMap = Object.fromEntries(
      // `as const`: `fromEntries` needs the tuple form, not a widened array.
      permissions.map((p) => [p.name, p.id] as const),
    );

    // Create default roles with their permissions
    const roles: Array<{ name: RoleName; displayName: string; description: string; hierarchy: number; permissions: string[] }> = [
      {
        name: 'SUPER_ADMIN' as RoleName,
        displayName: 'Super Administrator',
        description: 'Full system access',
        hierarchy: 0,
        permissions: Object.keys(permissionMap),
      },
      {
        name: 'ADMIN' as RoleName,
        displayName: 'Administrator',
        description: 'Administrative access',
        hierarchy: 1,
        permissions: [
          'users.read', 'users.create', 'users.update', 'users.delete',
          'leads.read', 'leads.create', 'leads.update', 'leads.assign', 'leads.delete',
          'meetings.read', 'meetings.schedule', 'meetings.cancel',
          'blog.read', 'blog.write', 'blog.publish', 'blog.delete',
          'admin.dashboard', 'admin.settings', 'admin.audit',
        ],
      },
      {
        name: 'PARTNER' as RoleName,
        displayName: 'Partner',
        description: 'Partner access',
        hierarchy: 2,
        permissions: [
          'leads.read', 'leads.assign',
          'meetings.read', 'meetings.schedule', 'meetings.cancel',
          'partner.dashboard', 'partner.deals', 'partner.revenue',
          'blog.read',
        ],
      },
      {
        name: 'CUSTOMER' as RoleName,
        displayName: 'Customer',
        description: 'Customer access',
        hierarchy: 3,
        permissions: [
          'leads.read', 'meetings.read', 'meetings.schedule',
          'customer.dashboard', 'customer.profile',
          'support.tickets', 'support.downloads',
          'blog.read',
        ],
      },
      {
        name: 'EMPLOYEE' as RoleName,
        displayName: 'Employee',
        description: 'Employee access',
        hierarchy: 4,
        permissions: [
          'leads.read', 'meetings.read', 'blog.read',
        ],
      },
      {
        name: 'VISITOR' as RoleName,
        displayName: 'Visitor',
        description: 'Public visitor access',
        hierarchy: 5,
        permissions: ['blog.read'],
      },
    ];

    for (const roleData of roles) {
      const { permissions: permissionNames, ...roleInfo } = roleData;
      const role = await this.prisma.role.create({
        data: roleInfo,
      });

      // Create role-permission mappings
      await Promise.all(
        permissionNames.map((permName) =>
          this.prisma.rolePermission.create({
            data: {
              roleId: role.id,
              permissionId: permissionMap[permName],
            },
          }),
        ),
      );
    }

    this.logger.log('Default roles and permissions initialized successfully');
  }
}
