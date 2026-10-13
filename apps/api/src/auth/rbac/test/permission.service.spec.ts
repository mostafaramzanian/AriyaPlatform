/**
 * Permission Service Tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { PermissionService } from '../services/permission.service';
import { PrismaService } from '../../../database/prisma.service';
import { AuditService } from '../../../common/audit.service';

describe('PermissionService', () => {
  let service: PermissionService;
  let prisma: PrismaService;
  let cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock };
  let auditService: AuditService;

  const mockUser = {
    id: 'user-1',
    email: 'test@example.com',
  };

  const mockRole = {
    id: 'role-1',
    name: 'ADMIN',
    hierarchy: 1,
    permissions: [
      {
        permission: { id: 'perm-1', name: 'users.read', domain: 'USERS' },
      },
      {
        permission: { id: 'perm-2', name: 'leads.create', domain: 'LEADS' },
      },
    ],
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PermissionService,
        {
          provide: PrismaService,
          useValue: {
            userRole: {
              findMany: jest.fn(),
            },
            permission: {
              findMany: jest.fn(),
            },
            role: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
            },
            rolePermission: {
              deleteMany: jest.fn(),
              createMany: jest.fn(),
            },
          },
        },
        {
          provide: CACHE_MANAGER,
          useValue: {
            get: jest.fn(),
            set: jest.fn(),
            del: jest.fn(),
          },
        },
        {
          provide: AuditService,
          useValue: {
            log: jest.fn().mockResolvedValue({ id: 'audit-1' }),
          },
        },
      ],
    }).compile();

    service = module.get<PermissionService>(PermissionService);
    prisma = module.get<PrismaService>(PrismaService);
    cache = module.get(CACHE_MANAGER);
    auditService = module.get<AuditService>(AuditService);
  });

  describe('getUserPermissions', () => {
    it('should return cached permissions if available', async () => {
      const cachedPermissions = ['users.read', 'leads.create'];
      cache.get.mockResolvedValue(cachedPermissions);

      const result = await service.getUserPermissions(mockUser.id);

      expect(result).toEqual(cachedPermissions);
      expect(cache.get).toHaveBeenCalledWith(`user:permissions:${mockUser.id}`);
    });

    it('should fetch and cache permissions if not cached', async () => {
      cache.get.mockResolvedValue(null);
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([
        {
          role: mockRole,
        },
      ]);

      const result = await service.getUserPermissions(mockUser.id);

      expect(result).toContain('users.read');
      expect(result).toContain('leads.create');
      expect(cache.set).toHaveBeenCalled();
    });

    it('should handle multiple roles for a user', async () => {
      cache.get.mockResolvedValue(null);
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([
        {
          role: {
            permissions: [
              { permission: { name: 'users.read' } },
              { permission: { name: 'leads.create' } },
            ],
          },
        },
        {
          role: {
            permissions: [
              { permission: { name: 'blog.write' } },
              { permission: { name: 'users.read' } }, // Duplicate
            ],
          },
        },
      ]);

      const result = await service.getUserPermissions(mockUser.id);

      expect(result).toContain('users.read');
      expect(result).toContain('leads.create');
      expect(result).toContain('blog.write');
      expect(result.length).toBe(3); // No duplicates
    });
  });

  describe('userHasPermission', () => {
    it('should return true if user has permission', async () => {
      const permissions = ['users.read', 'leads.create'];
      jest.spyOn(service, 'getUserPermissions').mockResolvedValue(permissions);

      const result = await service.userHasPermission(mockUser.id, 'users.read');

      expect(result).toBe(true);
    });

    it('should return false if user does not have permission', async () => {
      const permissions = ['users.read'];
      jest.spyOn(service, 'getUserPermissions').mockResolvedValue(permissions);

      const result = await service.userHasPermission(mockUser.id, 'admin.dashboard');

      expect(result).toBe(false);
    });
  });

  describe('userHasAnyPermission', () => {
    it('should return true if user has any of the required permissions', async () => {
      const permissions = ['users.read', 'leads.create'];
      jest.spyOn(service, 'getUserPermissions').mockResolvedValue(permissions);

      const result = await service.userHasAnyPermission(mockUser.id, [
        'admin.dashboard',
        'users.read',
      ]);

      expect(result).toBe(true);
    });

    it('should return false if user has none of the required permissions', async () => {
      const permissions = ['users.read'];
      jest.spyOn(service, 'getUserPermissions').mockResolvedValue(permissions);

      const result = await service.userHasAnyPermission(mockUser.id, [
        'admin.dashboard',
        'blog.publish',
      ]);

      expect(result).toBe(false);
    });
  });

  describe('updateRolePermissions', () => {
    it('should emit role permission change audit when permissions are updated', async () => {
      (prisma.rolePermission.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });
      (prisma.rolePermission.createMany as jest.Mock).mockResolvedValue({ count: 2 });
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([{ userId: 'user-1' }]);
      jest
        .spyOn(service as unknown as Record<string, jest.Mock>, 'invalidateUserPermissions')
        .mockResolvedValue(undefined);

      await service.updateRolePermissions('role-1', ['perm-1', 'perm-2'], 'admin-1');

      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({
        action: 'rbac_role_permissions_updated',
        resource: 'rbac',
        success: true,
      }));
    });
  });

  describe('invalidateUserPermissions', () => {
    it('should delete permission cache for user', async () => {
      await service.invalidateUserPermissions(mockUser.id);

      expect(cache.del).toHaveBeenCalledWith(`user:permissions:${mockUser.id}`);
    });
  });
});
