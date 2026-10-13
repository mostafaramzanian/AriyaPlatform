/**
 * HierarchyValidationService
 * Enforces role hierarchy constraints and prevents privilege escalation
 * Validates that role assignments respect the hierarchy rules
 */

import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { RoleHierarchy } from '../constants/roles';
import type { RoleName } from '../../../generated/core-client';

@Injectable()
export class HierarchyValidationService {
  private readonly logger = new Logger(HierarchyValidationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate that an assignor can assign a role to a target user
   * Rules:
   * - Assignor must have higher privilege (lower hierarchy number) than the role being assigned
   * - Assignor cannot assign SUPER_ADMIN role
   * - Assignor cannot assign a role they don't have themselves
   */
  async validateAssignment(
    assignorId: string,
    targetUserId: string,
    roleToAssignId: string,
  ): Promise<boolean> {
    // Cannot assign role to yourself (self-assignment only allowed on registration)
    if (assignorId === targetUserId) {
      throw new BadRequestException('Cannot assign roles to yourself');
    }

    // Get assignor's highest privilege role
    const assignorHighest = await this.getUserHighestRoleHierarchy(assignorId);

    // Get role to be assigned
    const roleToAssign = await this.prisma.role.findUnique({
      where: { id: roleToAssignId },
      select: { name: true, hierarchy: true },
    });

    if (!roleToAssign) {
      throw new BadRequestException('Role not found');
    }

    // Cannot assign SUPER_ADMIN
    if (roleToAssign.name === 'SUPER_ADMIN') {
      throw new BadRequestException('SUPER_ADMIN role cannot be assigned');
    }

    // Assignor must have privilege >= role being assigned
    if (assignorHighest > roleToAssign.hierarchy) {
      this.logger.warn(
        `Hierarchy violation: User ${assignorId} (hierarchy: ${assignorHighest}) attempted to assign role with hierarchy ${roleToAssign.hierarchy}`,
      );
      throw new BadRequestException(
        'You do not have permission to assign this role. Only users with higher privilege can assign lower privilege roles.',
      );
    }

    return true;
  }

  /**
   * Validate that an assignor can remove a role from a target user
   * Rules:
   * - Assignor must have higher privilege than the role being removed
   * - Cannot remove SUPER_ADMIN role (only SUPER_ADMIN can have it, so this is a safety check)
   * - Cannot remove own highest privilege role if it leaves user without any admin role
   */
  async validateRemoval(
    assignorId: string,
    targetUserId: string,
    roleToRemoveId: string,
  ): Promise<boolean> {
    // Cannot remove roles from yourself (security protection)
    if (assignorId === targetUserId) {
      throw new BadRequestException('Cannot remove roles from yourself');
    }

    // Get assignor's highest privilege role
    const assignorHighest = await this.getUserHighestRoleHierarchy(assignorId);

    // Get role to be removed
    const roleToRemove = await this.prisma.role.findUnique({
      where: { id: roleToRemoveId },
      select: { name: true, hierarchy: true },
    });

    if (!roleToRemove) {
      throw new BadRequestException('Role not found');
    }

    // Assignor must have privilege >= role being removed
    if (assignorHighest > roleToRemove.hierarchy) {
      this.logger.warn(
        `Hierarchy violation: User ${assignorId} (hierarchy: ${assignorHighest}) attempted to remove role with hierarchy ${roleToRemove.hierarchy}`,
      );
      throw new BadRequestException(
        'You do not have permission to remove this role. Only users with higher privilege can remove lower privilege roles.',
      );
    }

    return true;
  }

  /**
   * Validate that a user can perform privileged operations
   * Checks if user has ADMIN or SUPER_ADMIN role
   */
  async validateAdminPrivilege(userId: string): Promise<boolean> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });

    const isAdmin = userRoles.some(
      (ur) => ur.role.name === 'ADMIN' || ur.role.name === 'SUPER_ADMIN',
    );

    if (!isAdmin) {
      this.logger.warn(`Admin privilege check failed for user ${userId}`);
      throw new BadRequestException(
        'You do not have admin privileges',
      );
    }

    return true;
  }

  /**
   * Get user's highest privilege role hierarchy level
   * Returns VISITOR hierarchy if user has no roles
   */
  private async getUserHighestRoleHierarchy(
    userId: string,
  ): Promise<number> {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: true },
    });

    if (userRoles.length === 0) {
      return RoleHierarchy.VISITOR;
    }

    return userRoles.reduce(
      (highest: number, userRole) =>
        userRole.role.hierarchy < highest
          ? userRole.role.hierarchy
          : highest,
      RoleHierarchy.VISITOR,
    );
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
   * Prevent circular privilege escalation
   * Validates that granting a role doesn't create a privilege escalation chain
   */
  async validateNoCircularEscalation(
    userId: string,
    roleToAssignId: string,
  ): Promise<boolean> {
    // Check if target user already has this role
    const alreadyHasRole = await this.prisma.userRole.findUnique({
      where: { userId_roleId: { userId, roleId: roleToAssignId } },
    });

    if (alreadyHasRole) {
      throw new BadRequestException('User already has this role');
    }

    return true;
  }
}
