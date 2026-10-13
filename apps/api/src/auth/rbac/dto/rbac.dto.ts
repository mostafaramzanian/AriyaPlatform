/**
 * RBAC DTOs
 */

import { IsString, IsArray, IsUUID, IsNotEmpty } from 'class-validator';
import { PermissionDomain } from '../../../generated/core-client';

/**
 * Assign role to user request
 */
export class AssignRoleDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  roleId!: string;
}

/**
 * Remove role from user request
 */
export class RemoveRoleDto {
  @IsUUID()
  userId!: string;

  @IsString()
  @IsNotEmpty()
  roleId!: string;
}

/**
 * Update role permissions request
 */
export class UpdateRolePermissionsDto {
  @IsArray()
  @IsUUID('all', { each: true })
  permissionIds!: string[];
}

/**
 * Role response
 */
export class RoleResponseDto {
  id!: string;
  name!: string;
  displayName!: string;
  description!: string | null;
  hierarchy!: number;
  permissions?: PermissionResponseDto[];
}

/**
 * Permission response
 */
export class PermissionResponseDto {
  id!: string;
  name!: string;
  displayName!: string;
  description!: string | null;
  domain!: PermissionDomain;
}

/**
 * User role response
 */
export class UserRoleResponseDto {
  id!: string;
  userId!: string;
  roleId!: string;
  role!: RoleResponseDto;
  assignedAt!: Date;
}

/**
 * User permissions response
 */
export class UserPermissionsResponseDto {
  userId!: string;
  roles!: RoleResponseDto[];
  permissions!: string[];
  highestRole!: RoleResponseDto | null;
}
