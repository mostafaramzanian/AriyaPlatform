import { Controller, Get, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { Public } from '../decorators/public.decorator';
import { RoleService } from './services/role.service';

@ApiTags('RBAC (Development Only)')
@Controller('dev/rbac')
export class DevRbacCompatController {
  constructor(private readonly roleService: RoleService) {}

  @Get('init')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Compatibility: initialize RBAC (dev)' })
  @ApiResponse({ status: 200, description: 'Roles and permissions initialized' })
  async init() {
    await this.roleService.initializeDefaultRoles();
    return { message: 'Default roles and permissions initialized (compat)' };
  }
}
