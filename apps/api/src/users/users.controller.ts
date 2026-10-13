import { createRequire } from 'node:module';
import {
  Controller,
  Get,
  Param,
  Query,
  UseGuards,
  Request,
  ForbiddenException,
  Patch,
  Body,
  Post,
  Delete,
  UseInterceptors,
  UploadedFile,
  BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { UsersService, type UploadedAvatarFile } from './users.service';
import type { AuthenticatedPrincipalRequest } from '../auth/auth.types';
import { DirectoryService } from './directory.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PermissionService } from '../auth/rbac/services/permission.service';
import { Permissions } from '../auth/rbac/constants/permissions';
import { UpdateUserProfileDto } from './dto/update-user-profile.dto';
import { DirectoryQueryDto } from './dto/directory-query.dto';
// Kept lazy exactly as before: multer ships CommonJS with no installed type
// declarations, so a static import would change both resolution and typing.
// createRequire is the sanctioned CJS bridge for that case. The `any` here is
// the require'd CJS module itself (multer ships no installed type
// declarations) — same one-line scope as CheckRequestController's bridge.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const multer: any = createRequire(__filename)('multer');

@Controller('users')
export class UsersController {
  constructor(
    private usersService: UsersService,
    private directoryService: DirectoryService,
    private permissionService: PermissionService,
  ) {}


  @UseGuards(JwtAuthGuard)
  @Get('me')
  getProfile(@Request() req: AuthenticatedPrincipalRequest) {
    return this.usersService.findByIdSafe(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Patch('me')
  async updateProfile(@Request() req: AuthenticatedPrincipalRequest, @Body() dto: UpdateUserProfileDto) {
    return this.usersService.updateSelfProfile(req.user.sub, dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me/login-history')
  async getLoginHistory(@Request() req: AuthenticatedPrincipalRequest) {
    return this.usersService.getLoginHistory(req.user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @Post('me/avatar')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: multer.memoryStorage(),
      limits: { fileSize: 10 * 1024 * 1024 },
    }),
  )
  async uploadAvatar(@Request() req: AuthenticatedPrincipalRequest, @UploadedFile() file: UploadedAvatarFile) {
    if (!file) throw new BadRequestException('Avatar file is required');
    return this.usersService.uploadAvatar(req.user.sub, file);
  }

  @UseGuards(JwtAuthGuard)
  @Delete('me/avatar')
  async removeAvatar(@Request() req: AuthenticatedPrincipalRequest) {
    return this.usersService.removeAvatar(req.user.sub);
  }

  /**
   * Phase 49D-1: Organization Directory list.
   *
   * MUST stay declared above `@Get(':id')` — Nest matches routes in declaration
   * order, so a later literal path would be shadowed by the parameterised one.
   * (`@Get('health')` at the bottom of this controller is already dead for
   * exactly that reason; it is left untouched here as out-of-scope.)
   *
   * Authorization: `admin.users.read`. `Permissions.USERS_READ` ('users.read')
   * exists in the TypeScript constant catalogue but has no row in the
   * `Permission` table and no role grant, so gating on it would deny every
   * caller. `admin.users.read` is the closest already-approved permission —
   * "Read user information" — and is the same gate `GET /users/:id` uses. No new
   * permission is created here.
   */
  @UseGuards(JwtAuthGuard)
  @Roles(Permissions.ADMIN_USERS_READ)
  @Get('directory')
  async listDirectory(@Query() query: DirectoryQueryDto) {
    return this.directoryService.listDirectory(query);
  }

  @UseGuards(JwtAuthGuard)
  @Roles(Permissions.ADMIN_USERS_READ)
  @Get('directory/:id')
  async getDirectoryMember(@Param('id') id: string) {
    return this.directoryService.getDirectoryMember(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get(':id')
  async getUser(@Param('id') id: string, @Request() req: AuthenticatedPrincipalRequest) {
    const currentUserId = req.user.sub;
    if (id !== currentUserId) {
      const isAdmin = await this.permissionService.userHasPermission(
        currentUserId,
        Permissions.ADMIN_USERS_READ,
      );
      if (!isAdmin) {
        throw new ForbiddenException('Cannot access other user profiles');
      }
    }
    return this.usersService.findByIdSafe(id);
  }

  // Public endpoint for testing
  @Get('health')
  health() {
    return { status: 'ok' };
  }
}
