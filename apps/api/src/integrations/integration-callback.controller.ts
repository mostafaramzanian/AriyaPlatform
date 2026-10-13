import {
  Body,
  Controller,
  HttpCode,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { Public } from '../auth/decorators/public.decorator';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { IntegrationKey } from '../generated/core-client';
import { IntegrationService } from './integration.service';
import { IntegrationProviderRegistry } from './integration-provider.registry';
import {
  EVENT_ID_HEADER,
  IDEMPOTENCY_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  idempotencyKeyFor,
  verifySignature,
} from './integration-signature';
import { IntegrationCallbackDto } from './dto/integration.dto';

/**
 * Phase 49L §24/§25/§26: the inbound callback.
 *
 * WHY THIS IS A SEPARATE CONTROLLER FROM `IntegrationController`
 * -------------------------------------------------------------
 * Because its authentication mechanism is different, and mixing the two in one class
 * is how a later edit ends up with an accidentally-public admin route. Every route in
 * `IntegrationController` is JWT + `@Roles`. The single route here is `@Public()` —
 * which does NOT mean unauthenticated. It means the JWT guard is bypassed because an
 * external engine has no Aria user, and authentication is instead an HMAC signature
 * verified below BEFORE any state is touched.
 *
 * THE FULL LIST OF WHAT IS CHECKED, IN ORDER, AND WHY THE ORDER MATTERS:
 *  1. the integration key is KNOWN (registry) — an unknown one is rejected without a
 *     database read, so this route cannot be used to enumerate;
 *  2. a CONFIG EXISTS and is ENABLED — a disabled integration accepts nothing;
 *  3. a SECRET is stored and decryptable — without it there is nothing to verify
 *     against, and accepting unsigned input "because no secret is configured" is the
 *     classic way a signature check becomes optional;
 *  4. the TIMESTAMP is within ±5 minutes (inside `verifySignature`, checked before the
 *     HMAC so stale floods cost nothing);
 *  5. the SIGNATURE matches, compared in constant time;
 *  6. the IDEMPOTENCY KEY in the header matches the one DERIVED from the stored
 *     execution — so a valid signature cannot be replayed with a substituted key;
 *  7. only then does `IntegrationService.applyCallback` run, and all it can change is
 *     the delivery status of the one execution the event id names.
 *
 * EVERY REJECTION IS 401 WITH THE SAME MESSAGE. Distinguishing "unknown integration"
 * from "no such event" from "bad signature" would turn this endpoint into an oracle
 * for which integrations and events exist. The REASON is logged for the operator.
 *
 * THE RAW BODY PROBLEM, STATED HONESTLY: the signature is verified over
 * `JSON.stringify(dto)` — the DTO after validation — not over the exact received
 * bytes, because this application does not configure a raw-body parser and adding one
 * globally would change request handling for every existing route. The consequence is
 * that a sender must serialise the envelope canonically (fields in DTO order, no
 * extra whitespace); `forbidNonWhitelisted` guarantees no extra property survives, so
 * the reconstruction is exact for any well-formed sender. This is recorded as a
 * deferred hardening item in the closure report rather than described as byte-exact.
 */
@Controller('integrations')
export class IntegrationCallbackController {
  private readonly logger = new Logger(IntegrationCallbackController.name);

  constructor(
    private readonly integrations: IntegrationService,
    private readonly registry: IntegrationProviderRegistry,
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  /**
   * `POST /integrations/:integration/callback`
   *
   * Returns 200 for both a first delivery and a duplicate, with `duplicate: true` on
   * the latter — the §18 contract: "FIRST REQUEST → process; DUPLICATE → return
   * existing outcome safely".
   */
  @Post(':integration/callback')
  @Public()
  @HttpCode(200)
  async callback(
    @Param('integration') integration: string,
    @Body() dto: IntegrationCallbackDto,
    @Req() req: ExRequest,
  ) {
    // (1) Unknown integration: rejected before any database access.
    if (!this.registry.isKnown(integration)) {
      this.reject('UNKNOWN_INTEGRATION', { integration });
    }

    // (2) Config must exist and be enabled.
    const config = await this.prisma.integrationConfig.findUnique({
      where: { integration: integration as IntegrationKey },
    });

    if (!config || !config.enabled) {
      this.reject('INTEGRATION_DISABLED', { integration });
    }

    // (3) A secret must be stored and decryptable. There is no "no secret configured
    // so skip verification" branch anywhere in this method.
    const secret = this.readSecret(config);

    if (!secret) {
      this.reject('NO_SECRET', { integration });
    }

    const timestamp = this.header(req, TIMESTAMP_HEADER);
    const presented = this.header(req, SIGNATURE_HEADER);
    const presentedEventId = this.header(req, EVENT_ID_HEADER);
    const presentedKey = this.header(req, IDEMPOTENCY_HEADER);

    // The signed event id must be the one in the body. Without this a signature over
    // event A could be presented alongside a body naming event B.
    if (presentedEventId && presentedEventId !== dto.eventId) {
      this.reject('EVENT_ID_MISMATCH', { integration });
    }

    // The idempotency key is DERIVED, never trusted: the version comes from the stored
    // execution row, so a sender cannot choose which key its signature covers.
    const execution = await this.prisma.automationExecution.findUnique({
      where: {
        integration_eventId: {
          integration: integration as IntegrationKey,
          eventId: dto.eventId,
        },
      },
      select: { eventVersion: true },
    });

    if (!execution) {
      // Deliberately the SAME rejection as a bad signature: an unknown event and an
      // unauthorized caller must be indistinguishable, or this route reports which
      // events exist to anyone who can guess an id.
      this.reject('UNKNOWN_EVENT', { integration });
    }

    const expectedKey = idempotencyKeyFor(integration, dto.eventId, execution.eventVersion);

    // (6) — checked before the HMAC so a mismatched key costs no computation.
    if (presentedKey && presentedKey !== expectedKey) {
      this.reject('IDEMPOTENCY_MISMATCH', { integration });
    }

    // (4) + (5)
    const verification = verifySignature(
      secret,
      {
        method: 'POST',
        path: req.path,
        timestamp: timestamp ?? '',
        eventId: dto.eventId,
        idempotencyKey: expectedKey,
        body: JSON.stringify(dto),
      },
      presented,
    );

    if (!verification.ok) {
      this.reject(verification.reason ?? 'INVALID_SIGNATURE', { integration });
    }

    // (7) The only state change an external system can cause.
    const result = await this.integrations.applyCallback(integration, dto);

    return {
      accepted: true,
      executionId: result.executionId,
      status: result.status,
      duplicate: result.duplicate,
    };
  }

  /** Case-insensitive single header read. Express lower-cases keys; be explicit anyway. */
  private header(req: ExRequest, name: string): string | undefined {
    const value = req.headers[name] ?? req.headers[name.toLowerCase()];
    return Array.isArray(value) ? value[0] : value;
  }

  /**
   * Logs the reason and throws a UNIFORM 401.
   *
   * Returns `never`, which is what lets the call sites above narrow: after
   * `this.reject(...)` TypeScript knows `config` and `secret` are non-null, so no
   * non-null assertion is needed anywhere in the method.
   *
   * The reason never reaches the caller. Nothing about the expected signature, the
   * secret, or which of the seven checks failed is disclosed.
   */
  private reject(reason: string, context: Record<string, unknown>): never {
    this.logger.warn({ ...context, reason }, 'Integration callback rejected');
    throw new UnauthorizedException('Callback rejected');
  }

  /** Same swallow-and-report behaviour as `IntegrationService.readSecret`. */
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

