import 'reflect-metadata';
import { RbacController } from './rbac.controller';
import { Permissions } from './constants/permissions';

describe('RbacController authorization metadata', () => {
  it('assign-role requires ADMIN_ROLES_ASSIGN', () => {
    const roles = Reflect.getMetadata('roles', RbacController.prototype.assignRole);
    expect(roles).toContain(Permissions.ADMIN_ROLES_ASSIGN);
    expect(roles).not.toContain(Permissions.USERS_UPDATE);
  });

  it('remove-role requires ADMIN_ROLES_REMOVE', () => {
    const roles = Reflect.getMetadata('roles', RbacController.prototype.removeRole);
    expect(roles).toContain(Permissions.ADMIN_ROLES_REMOVE);
    expect(roles).not.toContain(Permissions.USERS_UPDATE);
  });

  it('getAssignableRoles requires ADMIN_ROLES_ASSIGN', () => {
    const roles = Reflect.getMetadata('roles', RbacController.prototype.getAssignableRoles);
    expect(roles).toContain(Permissions.ADMIN_ROLES_ASSIGN);
  });

  it('getUserPermissions requires ADMIN_ROLES_PERMISSIONS', () => {
    const roles = Reflect.getMetadata('roles', RbacController.prototype.getUserPermissions);
    expect(roles).toContain(Permissions.ADMIN_ROLES_PERMISSIONS);
    expect(roles).not.toContain(Permissions.USERS_READ);
  });

  it('getUserRoles requires ADMIN_ROLES_READ', () => {
    const roles = Reflect.getMetadata('roles', RbacController.prototype.getUserRoles);
    expect(roles).toContain(Permissions.ADMIN_ROLES_READ);
    expect(roles).not.toContain(Permissions.USERS_READ);
  });

  it('updateRolePermissions requires ADMIN_ROLES_PERMISSIONS', () => {
    const roles = Reflect.getMetadata('roles', RbacController.prototype.updateRolePermissions);
    expect(roles).toContain(Permissions.ADMIN_ROLES_PERMISSIONS);
  });
});
