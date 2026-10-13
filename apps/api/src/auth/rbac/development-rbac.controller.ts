/**
 * Development RBAC Controller
 * Bootstrap endpoints - ONLY registered in development/test environments
 * NOT included in production builds
 */

import {
  Controller,
  Post,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { RoleService } from './services/role.service';

@ApiTags('RBAC (Development Only)')
@Controller('rbac')
export class DevelopmentRbacController {
  private readonly logger = new Logger(DevelopmentRbacController.name);

  constructor(private readonly roleService: RoleService) {}

  /**
   * Initialize default roles and permissions
   * Bootstrap endpoint - DEVELOPMENT ONLY
   * NOT accessible in production
   */
  @Post('initialize')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Initialize default roles and permissions (DEVELOPMENT ONLY)',
  })
  @ApiResponse({
    status: 200,
    description: 'Roles and permissions initialized',
  })
  async initialize(): Promise<{ message: string }> {
    this.logger.log('Bootstrap endpoint called - initializing default roles');
    await this.roleService.initializeDefaultRoles();
    return { message: 'Default roles and permissions initialized' };
  }
}
