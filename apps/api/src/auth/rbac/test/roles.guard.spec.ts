/**
 * Roles Guard Tests
 */

import { ExecutionContext, ForbiddenException, Controller } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from '../guards/roles.guard';
import { PermissionSource } from '../../../platform/auth/permission-source.contract';
import { Roles } from '../../decorators/roles.decorator';
import { Public } from '../../decorators/public.decorator';
import { Permissions } from '../constants/permissions';

describe('RolesGuard', () => {
  let guard: RolesGuard;
  let reflector: Reflector;
  let permissionSource: PermissionSource;

  const mockExecutionContext = {
    getHandler: jest.fn(),
    getClass: jest.fn(),
    switchToHttp: jest.fn().mockReturnValue({ getRequest: () => mockRequest }) as unknown as jest.Mock,
  } as unknown as ExecutionContext;

  const mockRequest: { user: { sub: string } | null } = {
    user: { sub: 'user-123' },
  };

  beforeEach(() => {
    const mockReflector = { getAllAndOverride: jest.fn() } as unknown as Reflector;
    // Phase 51-HR-ARCH-3A: the guard asks the PERMISSION SOURCE port, not `PermissionService`.
    // The port is what makes the answer depend on the token's trust level, and this double
    // stands in for either binding (Core's catalogue or the claim-only one).
    const mockPermissionSource = { getEffectivePermissions: jest.fn() } as unknown as PermissionSource;

    reflector = mockReflector;
    permissionSource = mockPermissionSource;
    guard = new RolesGuard(reflector, permissionSource);
  });

  describe('canActivate', () => {
    it('should allow access to public routes', async () => {
      (reflector.getAllAndOverride as jest.Mock)
        .mockReturnValueOnce(true) // isPublic = true
        .mockReturnValueOnce([]); // permissions = []

      const result = await guard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
    });

    it('should allow access if no permissions required', async () => {
      (reflector.getAllAndOverride as jest.Mock)
        .mockReturnValueOnce(false) // isPublic = false
        .mockReturnValueOnce(null); // permissions = null

      const result = await guard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
    });

    it('should deny access if user is not authenticated', async () => {
      mockRequest.user = null;
            (mockExecutionContext.switchToHttp as jest.Mock).mockReturnValue({
        getRequest: () => mockRequest,
      });

      (reflector.getAllAndOverride as jest.Mock)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(['users.read']);

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow access if user has required permission', async () => {
      mockRequest.user = { sub: 'user-123' };
            (mockExecutionContext.switchToHttp as jest.Mock).mockReturnValue({
        getRequest: () => mockRequest,
      });

      (reflector.getAllAndOverride as jest.Mock)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(['users.read']);

      (permissionSource.getEffectivePermissions as jest.Mock).mockResolvedValue([
        'users.read',
        'users.create',
      ]);

      const result = await guard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
    });

    it('should deny access if user does not have required permission', async () => {
      mockRequest.user = { sub: 'user-123' };
            (mockExecutionContext.switchToHttp as jest.Mock).mockReturnValue({
        getRequest: () => mockRequest,
      });

      (reflector.getAllAndOverride as jest.Mock)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(['admin.dashboard']);

      (permissionSource.getEffectivePermissions as jest.Mock).mockResolvedValue([
        'users.read',
      ]);

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('should allow access if user has any required permission', async () => {
      mockRequest.user = { sub: 'user-123' };
            (mockExecutionContext.switchToHttp as jest.Mock).mockReturnValue({
        getRequest: () => mockRequest,
      });

      (reflector.getAllAndOverride as jest.Mock)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(['users.read', 'admin.dashboard']);

      (permissionSource.getEffectivePermissions as jest.Mock).mockResolvedValue([
        'users.read',
      ]);

      const result = await guard.canActivate(mockExecutionContext);

      expect(result).toBe(true);
    });

    it('should handle permission service errors', async () => {
      mockRequest.user = { sub: 'user-123' };
            (mockExecutionContext.switchToHttp as jest.Mock).mockReturnValue({
        getRequest: () => mockRequest,
      });

      (reflector.getAllAndOverride as jest.Mock)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(['users.read']);

      (permissionSource.getEffectivePermissions as jest.Mock).mockRejectedValue(
        new Error('Database error'),
      );

      await expect(guard.canActivate(mockExecutionContext)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });

  /**
   * Phase 33N regression coverage.
   *
   * The tests above mock `reflector.getAllAndOverride` directly with a
   * positional sequence of return values, regardless of which metadata key
   * is actually requested. That is exactly why they kept passing while the
   * production code had a real bug: RolesGuard was reading a 'permissions'
   * metadata key that no decorator in the codebase ever wrote (@Roles()
   * writes 'roles'), so authorization was silently bypassed on every
   * @Roles()-guarded route. See Phase 33M/33N reports.
   *
   * This suite uses a REAL Reflector against a REAL class decorated with the
   * REAL @Roles()/@Public() decorators, so it fails if the guard's metadata
   * key and the decorator's metadata key ever diverge again.
   */
  describe('canActivate (real decorator metadata, not mocked)', () => {
    @Controller()
    class TestController {
      @Roles(Permissions.BLOG_WRITE)
      protectedHandler() {}

      noDecoratorHandler() {}

      @Public()
      publicHandler() {}
    }

    function contextFor(
      handlerName: keyof TestController,
      user: { sub?: string } | null = { sub: 'user-123' },
    ) {
      const request = { user };
      return {
        getHandler: () =>
          (TestController.prototype as unknown as Record<keyof TestController, unknown>)[
            handlerName
          ],
        getClass: () => TestController,
        switchToHttp: () => ({ getRequest: () => request }),
      } as unknown as ExecutionContext;
    }

    let realGuard: RolesGuard;
    let mockPermissionSource: Pick<PermissionSource, 'getEffectivePermissions'> & { getEffectivePermissions: jest.Mock };

    beforeEach(() => {
      mockPermissionSource = { getEffectivePermissions: jest.fn() };
      // Real Reflector: exercises the actual metadata written by the real
      // @Roles()/@Public() decorators, via the real NestJS reflection APIs.
      realGuard = new RolesGuard(new Reflector(), mockPermissionSource as unknown as PermissionSource);
    });

    it('denies a user with zero permissions on a @Roles(BLOG_WRITE) route', async () => {
      mockPermissionSource.getEffectivePermissions.mockResolvedValue([]);

      await expect(
        realGuard.canActivate(contextFor('protectedHandler')),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows a user who actually has the required permission', async () => {
      mockPermissionSource.getEffectivePermissions.mockResolvedValue([Permissions.BLOG_WRITE]);

      await expect(
        realGuard.canActivate(contextFor('protectedHandler')),
      ).resolves.toBe(true);
    });

    it('denies a user with unrelated permissions on a @Roles(BLOG_WRITE) route', async () => {
      mockPermissionSource.getEffectivePermissions.mockResolvedValue([Permissions.BLOG_READ]);

      await expect(
        realGuard.canActivate(contextFor('protectedHandler')),
      ).rejects.toThrow(ForbiddenException);
    });

    it('allows access to a handler with no @Roles() decorator at all', async () => {
      await expect(
        realGuard.canActivate(contextFor('noDecoratorHandler')),
      ).resolves.toBe(true);
      expect(mockPermissionSource.getEffectivePermissions).not.toHaveBeenCalled();
    });

    it('allows access to a @Public() route without checking permissions', async () => {
      await expect(
        realGuard.canActivate(contextFor('publicHandler')),
      ).resolves.toBe(true);
      expect(mockPermissionSource.getEffectivePermissions).not.toHaveBeenCalled();
    });
  });
});
