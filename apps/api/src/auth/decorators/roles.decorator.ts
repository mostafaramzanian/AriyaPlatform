import { SetMetadata } from '@nestjs/common';

/**
 * @Roles() decorator marks routes that require specific roles
 * Phase B.2: Used with RolesGuard to enforce role-based access control
 * Usage: @Roles('Admin', 'Customer')
 */
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);
