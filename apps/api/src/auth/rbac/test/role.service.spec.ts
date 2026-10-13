/**
 * Role Service Tests
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { RoleService } from '../services/role.service';
import { PermissionService } from '../services/permission.service';
import { PrismaService } from '../../../database/prisma.service';
import { NotificationPublisher } from '../../../notifications/notification.publisher';
import { HierarchyValidationService } from '../services/hierarchy-validation.service';
import { AuditService } from '../../../common/audit.service';

describe('RoleService', () => {
  let service: RoleService;
  let prisma: PrismaService;
  let permissionService: PermissionService;
  let notificationPublisher: NotificationPublisher;
  let auditService: AuditService;

  const mockUser = { id: 'user-1' };
  const mockRole = {
    id: 'role-1',
    name: 'ADMIN',
    displayName: 'Administrator',
    hierarchy: 1,
  };
  const mockAdminRole = {
    id: 'admin-role-1',
    name: 'SUPER_ADMIN',
    displayName: 'Super Administrator',
    hierarchy: 0,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RoleService,
        {
          provide: PrismaService,
          useValue: {
            role: {
              findUnique: jest.fn(),
              findMany: jest.fn(),
              create: jest.fn(),
              count: jest.fn(),
            },
            user: {
              update: jest.fn(),
            },
            userRole: {
              findMany: jest.fn(),
              findUnique: jest.fn(),
              create: jest.fn(),
              delete: jest.fn(),
              count: jest.fn(),
            },
            permission: {
              upsert: jest.fn(),
            },
            rolePermission: {
              create: jest.fn(),
            },
          },
        },

        {
          provide: PermissionService,
          useValue: {
            invalidateUserPermissions: jest.fn(),
          },
        },
        {
          provide: NotificationPublisher,
          useValue: {
            publish: jest.fn(),
          },
        },
        {
          provide: HierarchyValidationService,
          useValue: {
            validateAssignment: jest.fn(),
            validateNoCircularEscalation: jest.fn(),
            validateRemoval: jest.fn(),
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

    service = module.get<RoleService>(RoleService);
    prisma = module.get<PrismaService>(PrismaService);
    permissionService = module.get<PermissionService>(PermissionService);
    notificationPublisher = module.get<NotificationPublisher>(NotificationPublisher);
    auditService = module.get<AuditService>(AuditService);
  });

  describe('assignRoleToUser', () => {
    it('should assign role to user successfully', async () => {
      (prisma.role.findUnique as jest.Mock).mockResolvedValue(mockRole);
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([
        { role: mockAdminRole },
      ]);
      (prisma.userRole.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.userRole.create as jest.Mock).mockResolvedValue({});

      await service.assignRoleToUser(mockUser.id, mockRole.id, 'admin-1');

      expect(prisma.userRole.create).toHaveBeenCalled();
      expect(permissionService.invalidateUserPermissions).toHaveBeenCalledWith(
        mockUser.id,
      );
      expect(notificationPublisher.publish).toHaveBeenCalledWith(
        'rbac.role.assigned',
        expect.any(Object),
      );
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'rbac_role_assigned', resource: 'rbac', success: true }));
    });

    it('should throw if role not found', async () => {
      (prisma.role.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.assignRoleToUser(mockUser.id, mockRole.id, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if user already has role', async () => {
      (prisma.role.findUnique as jest.Mock).mockResolvedValue(mockRole);
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([
        { role: mockAdminRole },
      ]);
      (prisma.userRole.findUnique as jest.Mock).mockResolvedValue({
        id: 'ur-1',
      });

      await expect(
        service.assignRoleToUser(mockUser.id, mockRole.id, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('removeRoleFromUser', () => {
    it('should remove role from user successfully', async () => {
      (prisma.role.findUnique as jest.Mock).mockResolvedValue(mockRole);
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([
        { role: mockAdminRole },
      ]);
      (prisma.userRole.findUnique as jest.Mock).mockResolvedValue({
        id: 'ur-1',
      });
      (prisma.userRole.delete as jest.Mock).mockResolvedValue({});

      await service.removeRoleFromUser(mockUser.id, mockRole.id, 'admin-1');

      expect(prisma.userRole.delete).toHaveBeenCalled();
      expect(notificationPublisher.publish).toHaveBeenCalledWith(
        'rbac.role.removed',
        expect.any(Object),
      );
      expect(auditService.log).toHaveBeenCalledWith(expect.objectContaining({ action: 'rbac_role_removed', resource: 'rbac', success: true }));
    });

    it('should throw if role not found', async () => {
      (prisma.role.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.removeRoleFromUser(mockUser.id, mockRole.id, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should throw if user does not have role', async () => {
      (prisma.role.findUnique as jest.Mock).mockResolvedValue(mockRole);
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([
        { role: mockAdminRole },
      ]);
      (prisma.userRole.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.removeRoleFromUser(mockUser.id, mockRole.id, 'admin-1'),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('getUserRoles', () => {
    it('should return all roles for a user', async () => {
      const userRoles = [
        { id: 'ur-1', userId: mockUser.id, role: mockRole },
        { id: 'ur-2', userId: mockUser.id, role: mockAdminRole },
      ];

      (prisma.userRole.findMany as jest.Mock).mockResolvedValue(userRoles);

      const result = await service.getUserRoles(mockUser.id);

      expect(result).toEqual(userRoles);
      expect(prisma.userRole.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: mockUser.id },
        }),
      );
    });
  });

  describe('getUserHighestRole', () => {
    it('should return user highest role', async () => {
      const userRoles = [{ role: mockAdminRole }];
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue(userRoles);

      const result = await service.getUserHighestRole(mockUser.id);

      expect(result).toEqual(mockAdminRole);
    });

    it('should return null if user has no roles', async () => {
      (prisma.userRole.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.getUserHighestRole(mockUser.id);

      expect(result).toBeNull();
    });
  });

  describe('initializeDefaultRoles', () => {
    it('should skip if roles already initialized', async () => {
      (prisma.role.count as jest.Mock).mockResolvedValue(5);

      await service.initializeDefaultRoles();

      expect(prisma.role.create).not.toHaveBeenCalled();
    });

    it('should initialize default roles if none exist', async () => {
      (prisma.role.count as jest.Mock).mockResolvedValue(0);
      (prisma.permission.upsert as jest.Mock).mockImplementation(async (args: { name: string }) => ({ id: `perm-${args.name}`, name: args.name }));
      (prisma.role.create as jest.Mock).mockResolvedValue(mockRole);
      (prisma.rolePermission.create as jest.Mock).mockResolvedValue({});

      await service.initializeDefaultRoles();

      expect(prisma.role.create).toHaveBeenCalled();
    });
  });
});
