import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permissions } from '../auth/rbac/constants/permissions';
import { AIConfigService } from './ai-config.service';
import {
  CreateAIProviderConfigDto,
  TestAIProviderConnectionDto,
  UpdateAIProviderConfigDto,
} from './dto/ai-config.dto';

/**
 * Phase 49J-0: AI provider configuration HTTP surface.
 *
 * EVERY route is authenticated AND permission-gated — there is no ungated route
 * here, unlike SurveysController where participation is deliberately open. Nothing
 * about choosing a platform-wide AI provider is an ordinary user capability.
 *
 * The gate is split, matching the two seeded permissions:
 *  - READS (`GET /`, `GET /:id`) require `admin.ai.read`, which OPERATIONS_ADMIN
 *    also holds so it can diagnose which provider is live.
 *  - WRITES and the connection test require `admin.ai.manage`, held by SUPER_ADMIN
 *    and ADMIN only.
 *
 * THE TEST ENDPOINT IS A WRITE-LEVEL OPERATION even though it mutates nothing: it
 * spends money against the operator's provider account and can be handed an
 * unsaved credential. Gating it on `admin.ai.read` would let a read-only role
 * submit arbitrary keys for validation.
 *
 * NO ROUTE RETURNS A CREDENTIAL. The service has exactly one projection and it has
 * no branch that emits the ciphertext, the IV or the tag; a masked GET is therefore
 * a property of the service, not of a filter applied here that a future route could
 * forget.
 *
 * Both permissions ARE seeded in core_db by
 * `20260902120500_seed_ai_permission_grants`, so these gates are real rather than
 * authorization theatre.
 */
@Controller('admin/ai/providers')
@UseGuards(JwtAuthGuard)
export class AIConfigController {
  constructor(private readonly configs: AIConfigService) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  /**
   * The configured rows plus the registry's capability matrix. The matrix travels
   * with the list so the UI never needs its own copy of "which provider can embed"
   * — a copy that would drift the moment a provider is implemented or withdrawn.
   */
  @Get()
  @Roles(Permissions.ADMIN_AI_READ)
  async list() {
    return this.configs.listConfigs();
  }

  @Get(':id')
  @Roles(Permissions.ADMIN_AI_READ)
  async getOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.configs.getConfig(id);
  }

  @Post()
  @HttpCode(201)
  @Roles(Permissions.ADMIN_AI_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateAIProviderConfigDto) {
    return this.configs.createConfig(this.subject(req), dto);
  }

  /**
   * Partial update. `provider` and `capability` are not accepted (see the DTO):
   * retargeting a row would move a credential encrypted for one vendor onto
   * another.
   */
  @Patch(':id')
  @Roles(Permissions.ADMIN_AI_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateAIProviderConfigDto,
  ) {
    return this.configs.updateConfig(this.subject(req), id, dto);
  }

  @Delete(':id')
  @Roles(Permissions.ADMIN_AI_MANAGE)
  async remove(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.configs.deleteConfig(this.subject(req), id);
  }

  /**
   * Live probe against the provider, using a FIXED server-side Persian input.
   *
   * Returns 200 with `{ status: 'SUCCESS' | 'FAILURE', message }` for both
   * outcomes. A failed probe is NOT an HTTP error: the request itself succeeded,
   * and mapping it to a 4xx/5xx would make "the upstream key is wrong"
   * indistinguishable from "this endpoint is broken" for the UI, which needs to
   * render a validation message either way.
   */
  @Post(':id/test')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_AI_MANAGE)
  async test(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: TestAIProviderConnectionDto,
  ) {
    return this.configs.testConnection(this.subject(req), id, dto);
  }
}
