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
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permissions } from '../auth/rbac/constants/permissions';
import { IntegrationService } from './integration.service';
import { AutomationService } from './automation.service';
import {
  CreateIntegrationDto,
  TriggerAutomationDto,
  UpdateIntegrationDto,
} from './dto/integration.dto';

/**
 * Phase 49L: the ADMIN integration surface.
 *
 * EVERY ROUTE HERE IS AUTHENTICATED AND PERMISSION-GATED, exactly like
 * `AIConfigController`: reads require `admin.integrations.read` (which
 * OPERATIONS_ADMIN holds, so it can diagnose delivery), and writes, the connection
 * test, secret rotation and the manual trigger require
 * `admin.integrations.manage`.
 *
 * The INBOUND callback lives in a separate controller
 * (`integration-callback.controller.ts`) because its authentication is HMAC rather
 * than JWT. Keeping the two in one class would mean one `@Public()` route sitting
 * among permission-gated siblings — the exact shape in which someone later copies a
 * handler and forgets which authentication applied.
 *
 * THE TEST, ROTATE AND TRIGGER ENDPOINTS ARE WRITE-LEVEL even though two of them
 * mutate little: the test sends a real signed request to operator infrastructure,
 * rotation replaces a credential, and the trigger causes an outbound side effect.
 * Gating any of them on the read permission would let a read-only role act.
 *
 * NO ROUTE RETURNS A STORED SECRET. `POST :id/secret` returns the secret it just
 * GENERATED, once; every other response goes through `toPublic`, which structurally
 * cannot emit one.
 */
@Controller('admin/integrations')
@UseGuards(JwtAuthGuard)
export class IntegrationController {
  constructor(
    private readonly integrations: IntegrationService,
    private readonly automation: AutomationService,
  ) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  /**
   * Configured rows plus the registry's descriptors, so the UI never holds its own
   * copy of "which integrations exist".
   */
  @Get()
  @Roles(Permissions.ADMIN_INTEGRATIONS_READ)
  async list() {
    return this.integrations.listConfigs();
  }

  /**
   * Delivery history for the caller's tenant, newest first.
   *
   * DECLARED BEFORE `:id` DELIBERATELY. Nest matches routes in declaration order, so
   * `GET /admin/integrations/executions` would otherwise be swallowed by
   * `GET /admin/integrations/:id` and fail its UUID pipe — the same shadowing hazard
   * `UsersController` and `NotificationController` document.
   */
  @Get('executions')
  @Roles(Permissions.ADMIN_INTEGRATIONS_READ)
  async executions(@Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.integrations.listExecutions({
      limit: limit ? Number(limit) : undefined,
      cursor: cursor || undefined,
    });
  }

  @Get(':id')
  @Roles(Permissions.ADMIN_INTEGRATIONS_READ)
  async getOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.integrations.getConfig(id);
  }

  @Post()
  @HttpCode(201)
  @Roles(Permissions.ADMIN_INTEGRATIONS_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateIntegrationDto) {
    return this.integrations.createConfig(this.subject(req), dto);
  }

  /**
   * Partial update. `integration` is not accepted (see the DTO): retargeting a row
   * would move a secret negotiated with one engine onto another.
   */
  @Patch(':id')
  @Roles(Permissions.ADMIN_INTEGRATIONS_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateIntegrationDto,
  ) {
    return this.integrations.updateConfig(this.subject(req), id, dto);
  }

  @Delete(':id')
  @Roles(Permissions.ADMIN_INTEGRATIONS_MANAGE)
  async remove(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.integrations.deleteConfig(this.subject(req), id);
  }

  /**
   * Generates a new shared secret and returns it ONCE.
   *
   * The ONLY route in this phase that returns a secret, and it returns one it created
   * rather than one it read: the operator must paste it into the engine, and no later
   * request can retrieve it. A GET that returned the stored secret would be a
   * different and much worse thing.
   */
  @Post(':id/secret')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_INTEGRATIONS_MANAGE)
  async rotateSecret(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.integrations.rotateSecret(this.subject(req), id);
  }

  /**
   * Live probe. Returns 200 with `{ status, message }` for BOTH outcomes: a failed
   * probe is not an HTTP error — the request itself succeeded — and mapping it to a
   * 4xx/5xx would make "the engine is down" indistinguishable from "this endpoint is
   * broken" for the UI, which needs to render a message either way.
   */
  @Post(':id/test')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_INTEGRATIONS_MANAGE)
  async test(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.integrations.testConnection(this.subject(req), id);
  }

  /**
   * Manually emits one event (§29).
   *
   * AUTHORIZATION IS EVALUATED (the manage permission), TENANT CONTEXT IS PRESERVED
   * (taken from the request context inside the service, never from the body), THE
   * ACTION IS AUDITABLE (the execution row records the actor) and THE PAYLOAD IS
   * BOUNDED (the envelope size check). There is no `url` field anywhere in
   * `TriggerAutomationDto`, so this route cannot be used as an HTTP proxy — the §29
   * SSRF anti-pattern is unexpressible rather than merely refused.
   *
   * 202, not 201: nothing is created that the caller can address, and the outcome may
   * still be RETRYING when the response is written.
   */
  @Post('trigger')
  @HttpCode(202)
  @Roles(Permissions.ADMIN_INTEGRATIONS_MANAGE)
  async trigger(@Request() req: ExRequest, @Body() dto: TriggerAutomationDto) {
    return this.automation.emit({
      eventType: dto.eventType,
      source: dto.source,
      payload: dto.payload,
      eventId: dto.eventId,
      actor: { type: 'user', id: this.subject(req) },
    });
  }
}

