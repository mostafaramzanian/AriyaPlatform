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
import { ModuleRegistryService } from './module-registry.service';
import { ModuleHealthService } from './module-health.service';
import { ModuleClient } from './module-client.service';
import {
  CORE_MODULE_CONTRACT,
  MODULE_HEARTBEAT_INTERVAL_MS,
  MODULE_PROTOCOL_VERSION,
  MODULE_STALE_AFTER_MS,
} from './module.contract';
import {
  DECLARED_CONFLICT_POLICIES,
  DEFAULT_CONFLICT_POLICY,
  PROVISIONING_STEPS,
} from './module-foundations';
import {
  CapabilityCredentialResponseDto,
  CapabilityCredentialSecretResponseDto,
  CreateModuleRegistrationDto,
  InvokeModuleDto,
  UpdateModuleRegistrationDto,
  toCapabilityCredentialResponse,
  toCapabilityCredentialSecretResponse,
} from './dto/module.dto';

/**
 * Phase 49M §31/§32: the ADMIN module-registry surface.
 *
 * EVERY ROUTE HERE IS AUTHENTICATED AND PERMISSION-GATED, exactly like
 * `IntegrationController` (49L) and `AIConfigController` (49J-0): reads require
 * `admin.modules.read` (which OPERATIONS_ADMIN holds, so it can diagnose reachability), and
 * writes, credential rotation, the connection test and the diagnostic invoke require
 * `admin.modules.manage`.
 *
 * THE MODULE-FACING ROUTES LIVE IN A SEPARATE CONTROLLER
 * (`module-registration.controller.ts`) because their authentication is HMAC rather than JWT.
 * Keeping the two in one class would mean `@Public()` routes sitting among permission-gated
 * siblings — the exact shape in which someone later copies a handler and forgets which
 * authentication applied. Same reasoning, same split as 49L's callback controller.
 *
 * THE TEST AND INVOKE ENDPOINTS ARE WRITE-LEVEL even though neither mutates a registry row: the
 * test sends a real signed request to operator infrastructure, and the invoke causes a side
 * effect inside another module. Gating either on the read permission would let a read-only role
 * act on a remote system.
 *
 * NO ROUTE RETURNS A STORED CREDENTIAL. `POST :id/credential` returns the credential it just
 * GENERATED, once; every other response goes through `toPublicRegistration`, which structurally
 * cannot emit one.
 */
@Controller('admin/modules')
@UseGuards(JwtAuthGuard)
export class ModuleRegistryController {
  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly health: ModuleHealthService,
    private readonly client: ModuleClient,
  ) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  /**
   * The platform's own descriptor: protocol version, base contract, timings and the declared
   * future-foundation vocabularies (§36/§37/§38).
   *
   * DECLARED BEFORE `:id` DELIBERATELY. Nest matches routes in declaration order, so
   * `GET /admin/modules/platform` would otherwise be swallowed by `GET /admin/modules/:id` and
   * fail its UUID pipe — the same shadowing hazard `UsersController`, `NotificationController`
   * and `IntegrationController` all document.
   *
   * It exists so the admin UI does not hold its own copy of the protocol version, the heartbeat
   * cadence or the conflict-policy list: those are backend facts, and a client copy of them is
   * the classic way a UI keeps offering something the server has changed.
   */
  @Get('platform')
  @Roles(Permissions.ADMIN_MODULES_READ)
  platform() {
    return {
      protocolVersion: MODULE_PROTOCOL_VERSION,
      baseContract: CORE_MODULE_CONTRACT,
      heartbeatIntervalMs: MODULE_HEARTBEAT_INTERVAL_MS,
      staleAfterMs: MODULE_STALE_AFTER_MS,
      // FOUNDATIONS, not features. Returned so an operator can see what the platform is
      // prepared for; nothing in this phase acts on any of them (§36/§37/§38).
      foundations: {
        conflictPolicies: DECLARED_CONFLICT_POLICIES,
        defaultConflictPolicy: DEFAULT_CONFLICT_POLICY,
        provisioningSteps: PROVISIONING_STEPS,
        syncImplemented: false,
        provisioningImplemented: false,
      },
    };
  }

  @Get()
  @Roles(Permissions.ADMIN_MODULES_READ)
  async list() {
    return this.registry.listRegistrations();
  }

  @Get(':id')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async getOne(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.registry.getRegistration(id);
  }

  @Post()
  @HttpCode(201)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async create(@Request() req: ExRequest, @Body() dto: CreateModuleRegistrationDto) {
    return this.registry.createRegistration(this.subject(req), dto);
  }

  /**
   * Partial update. `moduleId` is not accepted (see the DTO): renaming a module would reassign
   * its credential and tenant scope to a different identity.
   */
  @Patch(':id')
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async update(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateModuleRegistrationDto,
  ) {
    return this.registry.updateRegistration(this.subject(req), id, dto);
  }

  @Delete(':id')
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async remove(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.registry.deleteRegistration(this.subject(req), id);
  }

  /**
   * Generates a new shared credential and returns it ONCE (§20/§29).
   *
   * The ONLY route in this phase that returns a credential, and it returns one it CREATED rather
   * than one it read: the operator must paste it into the module's configuration, and no later
   * request can retrieve it. A GET that returned the stored credential would be a different and
   * much worse thing.
   */
  @Post(':id/credential')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async rotateCredential(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.registry.rotateCredential(this.subject(req), id);
  }

  /**
   * Live connection test for ONE instance (§29).
   *
   * Returns 200 with the verdict for BOTH outcomes: a failed probe is not an HTTP error — the
   * request itself succeeded — and mapping it to a 4xx/5xx would make "the module is down"
   * indistinguishable from "this endpoint is broken" for the UI, which needs to render a message
   * either way. Same decision 49L made for its integration test route.
   *
   * THE INSTANCE IS ADDRESSED BY ITS OWN ID, not by a URL. There is no body: nothing about the
   * destination is caller-supplied, so this route cannot be turned into a probe-arbitrary-host
   * tool (§40).
   */
  @Post(':id/instances/:instanceId/test')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async testInstance(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Param('instanceId') instanceId: string,
  ) {
    const verdict = await this.health.probeInstance(instanceId);

    await this.registry.recordConnectionTest(this.subject(req), id, {
      instanceId,
      state: verdict.state,
      endpointReachable: verdict.endpointReachable,
      applicationHealthy: verdict.applicationHealthy,
      errorCode: verdict.errorCode,
    });

    return verdict;
  }

  /**
   * Capability discovery for one logical module (§10).
   *
   * Addressed by `moduleId` rather than by row id, because that is the identity a capability
   * question is about: "what can finance do?" is not a question about a database row.
   */
  @Get('by-module/:moduleId/capabilities')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async capabilities(@Param('moduleId') moduleId: string) {
    return this.registry.describeCapabilities(moduleId);
  }

  /**
   * The capability credentials of one module (ADR-0006 A8).
   *
   * ADDRESSED LIKE `by-module/:moduleId/capabilities` ABOVE, and for the same reason: the question
   * is "which cross-runtime capabilities does this module hold a credential for?", which is a
   * question about a logical module, not about a row.
   *
   * WHAT A READER LEARNS: `hasSecret` and the two timestamps. NOT the credential, not its length,
   * not a masked form of it — `CapabilityCredentialResponseDto` has no field that could carry one,
   * and the runtime assertion in the spec proves the serialised response contains no envelope
   * property. A credential is read back by NOBODY, including SUPER_ADMIN: an operator who loses one
   * rotates it.
   *
   * 404 FOR AN UNREGISTERED MODULE, matching `capabilities`: "this module is not admitted" and
   * "this module holds no capability credentials" are different facts and an operator acting on the
   * first must not be shown the second.
   */
  @Get('by-module/:moduleId/capability-credentials')
  @Roles(Permissions.ADMIN_MODULES_READ)
  async capabilityCredentials(
    @Param('moduleId') moduleId: string,
  ): Promise<CapabilityCredentialResponseDto[]> {
    const rows = await this.registry.listCapabilityCredentials(moduleId);

    // Mapped rather than returned as-is. The projection rebuilds each body field by field, which is
    // what makes the read path's containment a testable property rather than an intention — see
    // `toCapabilityCredentialResponse`.
    return rows.map(toCapabilityCredentialResponse);
  }

  /**
   * Issues, or rotates, ONE capability credential (ADR-0006 A8).
   *
   * PAIR-ADDRESSED, in the path: `(moduleId, capability)` is the identity of the credential, so
   * rotating the identity credential cannot touch the audit one — the composite key is in the URL
   * rather than in a body that a later edit could widen into a bulk operation.
   *
   * THE CAPABILITY IS NOT RE-VALIDATED HERE. It goes to the service, which applies the SAME
   * `isValidContract` the compatibility gate uses, so a malformed descriptor is a 400 from ONE code
   * path. Adding a class-validator rule in this file would have produced a SECOND answer (422) for
   * the same input, and the two would eventually disagree about what a descriptor is.
   *
   * THIS IS THE ONLY ROUTE THAT CAN EMIT A PLAINTEXT CAPABILITY CREDENTIAL, and only the one it
   * just generated. It is gated at write level (`admin.modules.manage`) because issuing a credential
   * grants a module a cross-runtime authority.
   */
  @Post('by-module/:moduleId/capability-credentials/:capability')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async rotateCapabilityCredential(
    @Request() req: ExRequest,
    @Param('moduleId') moduleId: string,
    @Param('capability') capability: string,
  ): Promise<CapabilityCredentialSecretResponseDto> {
    const result = await this.registry.rotateCapabilityCredential(
      this.subject(req),
      moduleId,
      capability,
    );

    // The ONE plaintext response in this controller, and only the value this call generated. It is
    // echoed through the write-path projection so the body is defined next to the read DTO.
    return toCapabilityCredentialSecretResponse(result);
  }

  /**
   * Diagnostic invoke (§29/§31).
   *
   * WHY THIS EXISTS AT ALL: without it, "is this module actually answering business calls?"
   * cannot be answered until a business feature exists to ask. It is the same operator need
   * 49L's manual trigger serves.
   *
   * WHAT MAKES IT SAFE, and each of these is a property rather than a promise:
   *   - AUTHORIZATION IS EVALUATED — `admin.modules.manage`, admin-only;
   *   - THE DESTINATION IS RESOLVED, never supplied: `InvokeModuleDto` has no `url` field, so the
   *     §40 anti-pattern is unexpressible rather than merely refused;
   *   - TENANT CONTEXT IS PRESERVED — taken from the request context inside `ModuleClient`, never
   *     from the body;
   *   - THE PAYLOAD IS BOUNDED — the transport refuses an over-large envelope;
   *   - THE RESULT IS NORMALIZED — the caller gets `ok`/`errorCode`, never a raw upstream body.
   *
   * 200 for both outcomes, for the same reason as the test route: an unavailable module is a
   * state, not a server error.
   */
  @Post('invoke')
  @HttpCode(200)
  @Roles(Permissions.ADMIN_MODULES_MANAGE)
  async invoke(@Body() dto: InvokeModuleDto) {
    return this.client.call({
      moduleId: dto.moduleId,
      contract: dto.contract,
      operation: dto.operation,
      payload: dto.payload,
      timeoutMs: dto.timeoutMs,
    });
  }
}

