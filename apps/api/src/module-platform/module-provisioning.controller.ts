import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Permissions } from '../auth/rbac/constants/permissions';
import { ModuleProvisioningService } from './module-provisioning.service';
import { ProvisioningProviderRegistry } from './provisioning-provider.registry';
import {
  MODULE_OPERATIONAL_STATES,
  TERMINAL_OPERATIONAL_STATES,
  allowedTransitions,
} from './module-operational-state';
import { RequestProvisioningDto } from './dto/provisioning.dto';

/**
 * Phase 49M-1: the ADMIN provisioning surface.
 *
 * A SEPARATE CONTROLLER FROM `ModuleRegistryController`, for the reason 49M gives for
 * splitting registration out: one class, one authentication story, one permission story.
 * The registry controller manages the LOGICAL module and its credentials; this one drives
 * DEPLOYMENTS. Mixing them would put provisioning routes among the registry's and make
 * "which of these can change what is running?" a question you answer by reading decorators.
 *
 * NO NEW PERMISSION. `admin.modules.manage` gates every action and `admin.modules.read`
 * gates every read — both already exist, both are already seeded, and all three role grants
 * are untouched. A `admin.provisioning.*` permission would have meant a new seed migration
 * and a new grant for a capability the existing pair already describes exactly.
 *
 * EVERY ACTION IS `202`, NEVER `200`. The response is an execution id, because the work
 * outlives the request: holding a connection open across a download, a digest pass and a
 * health probe converts a browser timeout into an unknown deployment state.
 *
 * NO ROUTE ACCEPTS A STATE. `RequestProvisioningDto` has no `operationalState` field, so an
 * administrator cannot assign `ACTIVE` directly — they request an ACTION and the transition
 * table decides whether the implied state change is legal. That rule is unexpressible here
 * rather than merely refused.
 *
 * NO ROUTE ACCEPTS A URL, A HOST, A COMMAND OR A CREDENTIAL. The destination is a
 * `targetKey` resolved to a row; the artifact is a release version resolved to an object
 * key. Both anti-patterns are absent from the DTO rather than validated against.
 */
@Controller('admin/modules/provisioning')
@UseGuards(JwtAuthGuard)
export class ModuleProvisioningController {
  constructor(
    private readonly provisioning: ModuleProvisioningService,
    private readonly providers: ProvisioningProviderRegistry,
  ) {}

  private subject(req: ExRequest): string {
    return (req as { user?: { sub?: string } }).user?.sub ?? '';
  }

  /**
   * What this control plane can actually do.
   *
   * DECLARED BEFORE ANY `:id` ROUTE. Nest matches in declaration order, so a later
   * `:executionId` would swallow `GET .../capabilities` and fail its UUID pipe — the same
   * shadowing hazard `ModuleRegistryController` documents for `GET /platform`.
   *
   * IT REPORTS UNAVAILABILITY HONESTLY. `REMOTE_AGENT` appears with `available: false` and
   * every action listed as unsupported, so the UI disables those controls instead of
   * offering an action that can only ever return `PROVIDER_UNAVAILABLE`. Omitting it would
   * hide a declared target type an operator can see in the database.
   */
  @Get('capabilities')
  @Roles(Permissions.ADMIN_MODULES_READ)
  capabilities() {
    return {
      // TRUE, and scoped precisely: the 49M-1 control plane exists. This is deliberately
      // NOT the same claim as `foundations.provisioningImplemented` on
      // `GET /admin/modules/platform`, which reports 49M's four-step `ModuleProvisioner`
      // extension point and stays false because nothing implements that interface.
      controlPlaneImplemented: true,
      targets: this.providers.list(),
      operationalStates: MODULE_OPERATIONAL_STATES,
      terminalStates: TERMINAL_OPERATIONAL_STATES,
      // The transition table, projected so the UI derives available actions from the
      // backend's rule rather than keeping its own copy — the reason
      // `GET /admin/modules/platform` returns the conflict-policy list.
      transitions: Object.fromEntries(
        MODULE_OPERATIONAL_STATES.map((state) => [state, allowedTransitions(state)]),
      ),
    };
  }

  /**
   * Request one provisioning action.
   *
   * 202 FOR BOTH ACCEPTANCE AND DE-DUPLICATION, because both mean "there is an execution you
   * can poll". A refusal is also 202 with `accepted: false` and a code, following the same
   * decision 49M made for its connection test: the REQUEST succeeded, and mapping an
   * operator-fixable state to a 4xx would make "the target is disabled" indistinguishable
   * from "this endpoint is broken".
   */
  @Post('request')
  @HttpCode(202)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async request(@Request() req: ExRequest, @Body() dto: RequestProvisioningDto) {
    return this.provisioning.request(this.subject(req), {
      moduleId: dto.moduleId,
      action: dto.action,
      targetKey: dto.targetKey,
      instanceKey: dto.instanceKey,
      releaseVersion: dto.releaseVersion,
      requestKey: dto.requestKey,
    });
  }

  /**
   * Run an accepted execution now.
   *
   * WHY THIS IS AN EXPLICIT ROUTE rather than fire-and-forget inside `request`: the claim is
   * a conditional `UPDATE`, so running is idempotent and safe to trigger from anywhere —
   * this route, a future timer, or a test. Exposing it keeps the async path OBSERVABLE
   * instead of hiding it behind a `void promise` that swallows its own failures.
   *
   * MANAGE-LEVEL, because it changes what is running.
   */
  @Post('executions/:executionId/run')
  @HttpCode(202)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async run(@Param('executionId', new ParseUUIDPipe({ version: '4' })) executionId: string) {
    const code = await this.provisioning.runExecution(executionId);
    return { executionId, code };
  }

  /** One execution. The polling target for the 202. */
  @Get('executions/:executionId')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async execution(@Param('executionId', new ParseUUIDPipe({ version: '4' })) executionId: string) {
    return this.provisioning.getExecution(executionId);
  }

  /**
   * Execution history for one logical module, newest first.
   *
   * Addressed by `moduleId` rather than by row id, for the reason 49M's capability route
   * gives: "what has been deployed to finance?" is not a question about a database row.
   */
  @Get('by-module/:moduleId/executions')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async history(@Param('moduleId') moduleId: string, @Query('take') take?: string) {
    // Parsed here, CLAMPED in the service, so a hostile `take=999999` is bounded by the
    // service's own ceiling rather than trusted from the query string.
    const parsed = take ? Number.parseInt(take, 10) : undefined;

    return this.provisioning.listExecutions(
      moduleId,
      Number.isSafeInteger(parsed) ? (parsed as number) : undefined,
    );
  }
}
