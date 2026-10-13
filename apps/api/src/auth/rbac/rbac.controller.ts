/**
 * RBAC Controller
 * Endpoints for role and permission management
 */

import {
  Controller,
  Post,
  Get,
  Put,
  Param,
  Body,
  HttpCode,
  UseGuards,
  UseInterceptors,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PermissionDomain } from '../../generated/core-client';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { Roles } from '../decorators/roles.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';
import { Permissions } from './constants/permissions';
import { RoleService } from './services/role.service';
import { PermissionService } from './services/permission.service';
import { StandardResponseInterceptor } from '../../common/interceptors/standard-response.interceptor';
import {
  AssignRoleDto,
  RemoveRoleDto,
  UpdateRolePermissionsDto,
  UserPermissionsResponseDto,
  RoleResponseDto,
  PermissionResponseDto,
} from './dto/rbac.dto';

/**
 * The row shapes the RBAC reads return, declared structurally so this
 * controller depends on the DATA it renders, not on the generated client's
 * classes. Field sets mirror the Prisma `Role`/`Permission` models (and thus
 * `RoleResponseDto`/`PermissionResponseDto`) exactly.
 */
interface RbacRoleRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  hierarchy: number;
}

interface RbacPermissionRow {
  id: string;
  name: string;
  displayName: string;
  description: string | null;
  domain: PermissionDomain;
}

interface RbacRoleWithPermissionsRow extends RbacRoleRow {
  permissions: ReadonlyArray<{ permission: RbacPermissionRow }>;
}

@ApiTags('RBAC')
@Controller('rbac')
@UseGuards(JwtAuthGuard)
@UseInterceptors(StandardResponseInterceptor)
@ApiBearerAuth()
export class RbacController {
  private readonly logger = new Logger(RbacController.name);

  constructor(
    private readonly roleService: RoleService,
    private readonly permissionService: PermissionService,
  ) {}

  /**
   * Get current user's roles and permissions
   */
  @Get()
  @ApiOperation({ summary: 'Get current user permissions and roles' })
  @ApiResponse({ status: 200, description: 'User permissions retrieved' })
  async getCurrentUserPermissions(
    @CurrentUser() user: Express.User & { sub: string },
  ): Promise<UserPermissionsResponseDto> {
    const roles = await this.roleService.getUserRoles(user.sub);
    const permissions = await this.permissionService.getUserPermissions(user.sub);
    const highestRole = await this.roleService.getUserHighestRole(user.sub);

    return {
      userId: user.sub,
      roles: roles.map((ur) => this.mapRoleToDto(ur.role)),
      permissions,
      highestRole: highestRole ? this.mapRoleToDto(highestRole) : null,
    };
  }

  /**
   * Get all available roles
   */
  @Get('roles')
  @Roles(Permissions.ADMIN_ROLES_READ)
  @ApiOperation({ summary: 'Get all roles' })
  @ApiResponse({ status: 200, description: 'All roles retrieved' })
  async getRoles() {
    const roles = await this.permissionService.getRolesWithPermissions();
    return roles.map((role) => this.mapRoleWithPermissionsToDto(role));
  }

  /**
   * Get all permissions
   */
  @Get('permissions')
  @Roles(Permissions.ADMIN_ROLES_PERMISSIONS)
  @ApiOperation({ summary: 'Get all permissions' })
  @ApiResponse({ status: 200, description: 'All permissions retrieved' })
  async getPermissions(): Promise<PermissionResponseDto[]> {
    const permissions = await this.permissionService.getAllPermissions();
    return permissions.map((p) => this.mapPermissionToDto(p));
  }

  /**
   * Get a specific user's permissions
   * Admin only
   */
  @Get(':userId/permissions')
  @Roles(Permissions.ADMIN_ROLES_PERMISSIONS)
  @ApiOperation({ summary: 'Get specific user permissions (Admin only)' })
  @ApiResponse({ status: 200, description: 'User permissions retrieved' })
  async getUserPermissions(
    @Param('userId') userId: string,
  ): Promise<UserPermissionsResponseDto> {
    const roles = await this.roleService.getUserRoles(userId);
    const permissions = await this.permissionService.getUserPermissions(userId);
    const highestRole = await this.roleService.getUserHighestRole(userId);

    return {
      userId,
      roles: roles.map((ur) => this.mapRoleToDto(ur.role)),
      permissions,
      highestRole: highestRole ? this.mapRoleToDto(highestRole) : null,
    };
  }

  /**
   * Get a specific user's roles
   */
  @Get(':userId/roles')
  @Roles(Permissions.ADMIN_ROLES_READ)
  @ApiOperation({ summary: 'Get user roles' })
  @ApiResponse({ status: 200, description: 'User roles retrieved' })
  async getUserRoles(@Param('userId') userId: string) {
    const userRoles = await this.roleService.getUserRoles(userId);
    return userRoles.map((ur) => ({
      id: ur.id,
      userId: ur.userId,
      roleId: ur.roleId,
      role: this.mapRoleToDto(ur.role),
      assignedAt: ur.assignedAt,
    }));
  }

  /**
   * Assign a role to a user
   * Admin only
   */
  @Post('assign-role')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_ROLES_ASSIGN)
  @ApiOperation({ summary: 'Assign role to user (Admin only)' })
  @ApiResponse({ status: 200, description: 'Role assigned successfully' })
  async assignRole(
    @Body() dto: AssignRoleDto,
    @CurrentUser() user: Express.User & { sub: string },
  ): Promise<{ message: string }> {
    await this.roleService.assignRoleToUser(dto.userId, dto.roleId, user.sub);
    return { message: 'Role assigned successfully' };
  }

  /**
   * Remove a role from a user
   * Admin only
   */
  @Post('remove-role')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_ROLES_REMOVE)
  @ApiOperation({ summary: 'Remove role from user (Admin only)' })
  @ApiResponse({ status: 200, description: 'Role removed successfully' })
  async removeRole(
    @Body() dto: RemoveRoleDto,
    @CurrentUser() user: Express.User & { sub: string },
  ): Promise<{ message: string }> {
    await this.roleService.removeRoleFromUser(dto.userId, dto.roleId, user.sub);
    return { message: 'Role removed successfully' };
  }

  /**
   * Get all available roles
   * Admin only
   */
  @Get('roles/all')
  @Roles(Permissions.ADMIN_ROLES_READ)
  @ApiOperation({ summary: 'Get all roles (Admin only)' })
  @ApiResponse({ status: 200, description: 'All roles retrieved' })
  async getAllRoles() {
    const roles = await this.permissionService.getRolesWithPermissions();
    return roles.map((role) => this.mapRoleWithPermissionsToDto(role));
  }

  /**
   * Get assignable roles for the current user
   */
  @Get('roles/assignable')
  @Roles(Permissions.ADMIN_ROLES_ASSIGN)
  @ApiOperation({ summary: 'Get assignable roles for current user' })
  @ApiResponse({ status: 200, description: 'Assignable roles retrieved' })
  async getAssignableRoles(
    @CurrentUser() user: Express.User & { sub: string },
  ) {
    const roles = await this.roleService.getAssignableRoles(user.sub);
    return roles.map((role) => this.mapRoleToDto(role));
  }

  /**
   * Get all permissions
   * Admin only
   */
  @Get('permissions/all')
  @Roles(Permissions.ADMIN_ROLES_PERMISSIONS)
  @ApiOperation({ summary: 'Get all permissions (Admin only)' })
  @ApiResponse({ status: 200, description: 'All permissions retrieved' })
  async getAllPermissions(): Promise<PermissionResponseDto[]> {
    const permissions = await this.permissionService.getAllPermissions();
    return permissions.map((p) => this.mapPermissionToDto(p));
  }

  /**
   * Update role permissions
   * Super admin only
   */
  @Put('roles/:roleId/permissions')
  @Roles(Permissions.ADMIN_ROLES_PERMISSIONS)
  @ApiOperation({ summary: 'Update role permissions (Admin only)' })
  @ApiResponse({ status: 200, description: 'Role permissions updated' })
  async updateRolePermissions(
    @Param('roleId') roleId: string,
    @Body() dto: UpdateRolePermissionsDto,
    @CurrentUser() user: Express.User & { sub: string },
  ): Promise<{ message: string }> {
    await this.permissionService.updateRolePermissions(roleId, dto.permissionIds, user.sub);
    return { message: 'Role permissions updated successfully' };
  }


  // Helper methods

  /**
   * The row shapes the mappers read — declared structurally so this controller
   * depends on the DATA it renders, not on the generated client's classes.
   * Field sets mirror `RoleResponseDto`/`PermissionResponseDto` exactly.
   */
  private mapRoleToDto(role: RbacRoleRow): RoleResponseDto {
    return {
      id: role.id,
      name: role.name,
      displayName: role.displayName,
      description: role.description,
      hierarchy: role.hierarchy,
    };
  }

  private mapRoleWithPermissionsToDto(role: RbacRoleWithPermissionsRow): RoleResponseDto {
    return {
      id: role.id,
      name: role.name,
      displayName: role.displayName,
      description: role.description,
      hierarchy: role.hierarchy,
      permissions: role.permissions.map((rp) => this.mapPermissionToDto(rp.permission)),
    };
  }

  private mapPermissionToDto(permission: RbacPermissionRow): PermissionResponseDto {
    return {
      id: permission.id,
      name: permission.name,
      displayName: permission.displayName,
      description: permission.description,
      domain: permission.domain,
    };
  }
}
