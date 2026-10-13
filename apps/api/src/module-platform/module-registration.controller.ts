import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { ModuleRegistryService } from './module-registry.service';
import {
  MODULE_ID_HEADER,
  MODULE_REQUEST_HEADER,
  MODULE_SIGNATURE_HEADER,
  MODULE_TIMESTAMP_HEADER,
  isSecretExpired,
  verifyModuleRequest,
} from './module-signature';
import { DeregisterModuleDto, ModuleHeartbeatDto, RegisterModuleDto } from './dto/module.dto';

/**
 * Phase 49M §7/§8/§19: the MODULE-FACING surface — registration, heartbeat, deregistration.
 *
 * WHY THIS IS A SEPARATE CONTROLLER FROM `ModuleRegistryController`
 * ----------------------------------------------------------------
 * Because its authentication mechanism is different, and mixing the two in one class is how a
 * later edit ends up with an accidentally-public admin route. Every route in
 * `ModuleRegistryController` is JWT + `@Roles`. Every route here is `@Public()` — which does NOT
 * mean unauthenticated. It means the JWT guard is bypassed because a module has no Aria user,
 * and authentication is instead an HMAC signature verified below BEFORE any state is touched.
 * Identical reasoning, identical structure to 49L's `IntegrationCallbackController`.
 *
 * THE FULL LIST OF WHAT IS CHECKED, IN ORDER, AND WHY THE ORDER MATTERS:
 *   1. the `moduleId` HEADER is present and matches the BODY — a mismatch is rejected rather than
 *      one of the two being preferred;
 *   2. a REGISTRATION EXISTS for that module — an unknown module is rejected without a second
 *      query, so this route cannot be used to enumerate;
 *   3. a CREDENTIAL is stored, decryptable and UNEXPIRED — without it there is nothing to verify
 *      against, and accepting unsigned input "because no credential is configured" is the classic
 *      way a signature check becomes optional;
 *   4. the TIMESTAMP is within ±5 minutes (inside `verifyModuleRequest`, checked before the HMAC
 *      so stale floods cost nothing);
 *   5. the SIGNATURE matches, compared in constant time, over a canonical string that COVERS the
 *      moduleId, the requestId and the tenant slot;
 *   6. only then does the registry act — and what it can do is bounded by the service, which
 *      never reads `enabled`, `tenantScope` or `tenantIds` from the request.
 *
 * EVERY REJECTION IS 401 WITH THE SAME MESSAGE. Distinguishing "unknown module" from "no
 * credential" from "bad signature" would turn this endpoint into an oracle for which modules
 * exist. The REASON is logged for the operator.
 *
 * THE RAW BODY PROBLEM, STATED HONESTLY AND IDENTICALLY TO 49L: the signature is verified over
 * `JSON.stringify(dto)` — the DTO after validation — not over the exact received bytes, because
 * this application configures no raw-body parser and adding one globally would change request
 * handling for every existing route. A sender must therefore serialise canonically (fields in DTO
 * order, no extra whitespace); `forbidNonWhitelisted` guarantees no extra property survives, so
 * the reconstruction is exact for any well-formed sender. Recorded as a deferred hardening item
 * in the closure report rather than described as byte-exact.
 */
@Controller('modules')
export class ModuleRegistrationController {
  private readonly logger = new Logger(ModuleRegistrationController.name);

  constructor(
    private readonly registry: ModuleRegistryService,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * A module announces itself or re-announces after a restart (§7).
   *
   * 200, not 201: the operation is an UPSERT on `instanceId`, so a re-announcement creates
   * nothing, and a module cannot tell from the status code whether it was the first.
   */
  @Public()
  @Post('register')
  @HttpCode(200)
  async register(@Req() req: ExRequest, @Body() dto: RegisterModuleDto) {
    await this.authenticate(req, dto.moduleId, dto);

    return this.registry.registerInstance(dto);
  }

  /** Refreshes liveness (§14). Not audited — see `ModuleRegistryService.heartbeat`. */
  @Public()
  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@Req() req: ExRequest, @Body() dto: ModuleHeartbeatDto) {
    const moduleId = await this.authenticate(req, undefined, dto);

    return this.registry.heartbeat(moduleId, dto.instanceId, dto.state);
  }

  /** A module announces its own shutdown (§15). */
  @Public()
  @Post('deregister')
  @HttpCode(200)
  async deregister(@Req() req: ExRequest, @Body() dto: DeregisterModuleDto) {
    const moduleId = await this.authenticate(req, undefined, dto);

    return this.registry.deregisterInstance(moduleId, dto.instanceId);
  }

  /**
   * The seven-step verification, and the ONLY authentication in this controller.
   *
   * Returns the VERIFIED `moduleId`, which is what every caller above passes to the registry —
   * so the module a request acts as is the one whose credential signed it, never one named in an
   * unverified field.
   *
   * `expectedModuleId` is supplied only by `register`, where the body also carries the id: the
   * two must agree, or a module holding one credential could register an instance under another
   * module's name.
   */
  private async authenticate(
    req: ExRequest,
    expectedModuleId: string | undefined,
    body: unknown,
  ): Promise<string> {
    const presentedModuleId = this.header(req, MODULE_ID_HEADER);
    const presentedSignature = this.header(req, MODULE_SIGNATURE_HEADER);
    const timestamp = this.header(req, MODULE_TIMESTAMP_HEADER);
    const requestId = this.header(req, MODULE_REQUEST_HEADER);

    // (1) Identity must be present and self-consistent.
    if (!presentedModuleId || !presentedSignature || !timestamp || !requestId) {
      this.reject('MISSING_HEADERS', {});
    }

    if (expectedModuleId !== undefined && expectedModuleId !== presentedModuleId) {
      this.reject('MODULE_ID_MISMATCH', { moduleId: presentedModuleId });
    }

    // (2) The module must already be admitted. Selected narrowly: this query returns the
    // credential columns and nothing else it does not need.
    const registration = await this.prisma.moduleRegistration.findUnique({
      where: { moduleId: presentedModuleId },
      select: {
        moduleId: true,
        secretCiphertext: true,
        secretIv: true,
        secretAuthTag: true,
        secretExpiresAt: true,
      },
    });

    if (!registration) {
      this.reject('UNKNOWN_MODULE', { moduleId: presentedModuleId });
    }

    // (3) A credential must exist, decrypt, and not be expired.
    const secret = this.readSecret(registration);

    if (!secret) {
      this.reject('NO_CREDENTIAL', { moduleId: presentedModuleId });
    }

    if (isSecretExpired(registration.secretExpiresAt)) {
      this.reject('CREDENTIAL_EXPIRED', { moduleId: presentedModuleId });
    }

    // (4) + (5). The canonical string covers the module id, the request id and the tenant slot;
    // TENANT IS `null` HERE ON PURPOSE — a module's own registration is a platform-level act, not
    // a tenant-scoped one, and the null marker is a signed value rather than an omission, so a
    // sender cannot smuggle a tenant into a registration by adding a header.
    const verification = verifyModuleRequest(
      secret,
      {
        method: 'POST',
        path: req.path,
        timestamp,
        identity: {
          moduleId: registration.moduleId,
          requestId,
          tenantId: null,
        },
        body: JSON.stringify(body),
      },
      presentedSignature,
    );

    if (!verification.ok) {
      this.reject(verification.reason ?? 'INVALID_SIGNATURE', { moduleId: presentedModuleId });
    }

    return registration.moduleId;
  }

  /** Case-insensitive single header read. Express lower-cases keys; be explicit anyway. */
  private header(req: ExRequest, name: string): string | undefined {
    const value = req.headers[name] ?? req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Logs the reason and throws a UNIFORM 401.
   *
   * Returns `never`, which is what lets the call sites above narrow: after `this.reject(...)`
   * TypeScript knows `registration` and `secret` are non-null, so no non-null assertion is needed
   * anywhere in the method.
   *
   * The reason never reaches the caller. Nothing about the expected signature, the credential, or
   * which of the checks failed is disclosed.
   */
  private reject(reason: string, context: Record<string, unknown>): never {
    this.logger.warn({ ...context, reason }, 'Module request rejected');
    throw new UnauthorizedException('Module request rejected');
  }

  /** Same swallow-and-report behaviour as `ModuleRegistryService.readSecret`. */
  private readSecret(row: {
    secretCiphertext: string | null;
    secretIv: string | null;
    secretAuthTag: string | null;
  }): string | undefined {
    if (!row.secretCiphertext || !row.secretIv || !row.secretAuthTag) return undefined;

    try {
      return this.crypto.decrypt({
        ciphertext: row.secretCiphertext,
        iv: row.secretIv,
        authTag: row.secretAuthTag,
      });
    } catch {
      return undefined;
    }
  }
}

