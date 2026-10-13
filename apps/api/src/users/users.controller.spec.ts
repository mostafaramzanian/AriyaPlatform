import { Test } from '@nestjs/testing';
import { ForbiddenException } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { DirectoryService } from './directory.service';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedPrincipalRequest } from '../auth/auth.types';

const mockRequest = (userId: string) =>
  ({
    user: { sub: userId },
  }) as unknown as AuthenticatedPrincipalRequest;

describe('UsersController', () => {
  let controller: UsersController;
  let usersService: UsersService;
  let directoryService: DirectoryService;
  let permissionService: PermissionService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            findByIdSafe: jest.fn(),
            updateSelfProfile: jest.fn(),
            getLoginHistory: jest.fn(),
          },
        },
        {
          provide: DirectoryService,
          useValue: {
            listDirectory: jest.fn(),
            getDirectoryMember: jest.fn(),
          },
        },
        {
          provide: PermissionService,
          useValue: {
            userHasPermission: jest.fn(),
          },
        },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = moduleRef.get<UsersController>(UsersController);
    usersService = moduleRef.get<UsersService>(UsersService);
    directoryService = moduleRef.get<DirectoryService>(DirectoryService);
    permissionService = moduleRef.get<PermissionService>(PermissionService);
  });

  describe('getProfile', () => {
    it('returns the current user profile', async () => {
      const userId = 'user-1';
      const expected = { id: userId, email: 'user@example.com' };
      (usersService.findByIdSafe as jest.Mock).mockResolvedValue(expected);

      const result = await controller.getProfile(mockRequest(userId));

      expect(result).toEqual(expected);
      expect(usersService.findByIdSafe).toHaveBeenCalledWith(userId);
    });

    it('updates only the current user profile', async () => {
      const userId = 'user-1';
      const payload = { firstName: 'New', lastName: 'Name' };
      const expected = { id: userId, ...payload };
      (usersService.updateSelfProfile as jest.Mock).mockResolvedValue(expected);

      const result = await controller.updateProfile(mockRequest(userId), payload);

      expect(result).toEqual(expected);
      expect(usersService.updateSelfProfile).toHaveBeenCalledWith(userId, payload);
    });

    it('returns login history for the current user only', async () => {
      const userId = 'user-1';
      const expected = [{ id: 'audit-1', action: 'login', success: true }];
      (usersService.getLoginHistory as jest.Mock).mockResolvedValue(expected);

      const result = await controller.getLoginHistory(mockRequest(userId));

      expect(result).toEqual(expected);
      expect(usersService.getLoginHistory).toHaveBeenCalledWith(userId);
    });
  });

  describe('getUser', () => {
    it('allows a user to access their own profile', async () => {
      const userId = 'user-1';
      const expected = { id: userId, email: 'user@example.com' };
      (usersService.findByIdSafe as jest.Mock).mockResolvedValue(expected);

      const result = await controller.getUser(userId, mockRequest(userId));

      expect(result).toEqual(expected);
      expect(usersService.findByIdSafe).toHaveBeenCalledWith(userId);
      expect(permissionService.userHasPermission).not.toHaveBeenCalled();
    });

    it('allows an admin to access another user profile', async () => {
      const adminId = 'admin-1';
      const targetId = 'user-2';
      const expected = { id: targetId, email: 'user2@example.com' };
      (permissionService.userHasPermission as jest.Mock).mockResolvedValue(true);
      (usersService.findByIdSafe as jest.Mock).mockResolvedValue(expected);

      const result = await controller.getUser(targetId, mockRequest(adminId));

      expect(result).toEqual(expected);
      expect(permissionService.userHasPermission).toHaveBeenCalledWith(
        adminId,
        'admin.users.read',
      );
      expect(usersService.findByIdSafe).toHaveBeenCalledWith(targetId);
    });

    it('forbids a non-admin from accessing another user profile', async () => {
      const userId = 'user-1';
      const targetId = 'user-2';
      (permissionService.userHasPermission as jest.Mock).mockResolvedValue(false);

      await expect(controller.getUser(targetId, mockRequest(userId))).rejects.toThrow(
        ForbiddenException,
      );
      expect(usersService.findByIdSafe).not.toHaveBeenCalled();
    });
  });

  describe('health', () => {
    it('returns ok', () => {
      expect(controller.health()).toEqual({ status: 'ok' });
    });
  });

  /**
   * Phase 49D-1: the directory routes delegate straight to DirectoryService,
   * which owns tenant scoping — the controller must not read a tenant from the
   * request or pass one through.
   */
  describe('directory', () => {
    it('delegates the list to DirectoryService with the validated query only', async () => {
      const expected = { items: [], hasMore: false };
      (directoryService.listDirectory as jest.Mock).mockResolvedValue(expected);

      const query = { limit: 20, q: 'بهار' };
      const result = await controller.listDirectory(query);

      expect(result).toBe(expected);
      expect(directoryService.listDirectory).toHaveBeenCalledWith(query);
    });

    it('delegates the detail read to DirectoryService', async () => {
      const expected = { id: 'u1' };
      (directoryService.getDirectoryMember as jest.Mock).mockResolvedValue(expected);

      const result = await controller.getDirectoryMember('u1');

      expect(result).toBe(expected);
      expect(directoryService.getDirectoryMember).toHaveBeenCalledWith('u1');
    });

    it('never consults PermissionService itself — the RolesGuard decides', async () => {
      (directoryService.listDirectory as jest.Mock).mockResolvedValue({
        items: [],
        hasMore: false,
      });

      await controller.listDirectory({});

      expect(permissionService.userHasPermission).not.toHaveBeenCalled();
    });

    it('gates both directory routes on admin.users.read', () => {
      const list = Reflect.getMetadata('roles', UsersController.prototype.listDirectory);
      const detail = Reflect.getMetadata('roles', UsersController.prototype.getDirectoryMember);

      expect(list).toEqual(['admin.users.read']);
      expect(detail).toEqual(['admin.users.read']);
    });

    it('declares the literal directory paths before the parameterised :id route', () => {
      // Nest matches in declaration order, so `directory` must be registered
      // before `:id` or it would be swallowed by it.
      const names = Object.getOwnPropertyNames(UsersController.prototype);
      expect(names.indexOf('listDirectory')).toBeLessThan(names.indexOf('getUser'));
      expect(names.indexOf('getDirectoryMember')).toBeLessThan(names.indexOf('getUser'));
    });
  });
});
