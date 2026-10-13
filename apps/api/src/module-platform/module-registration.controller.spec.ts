import { Test } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { ModuleRegistrationController } from './module-registration.controller';

/** The signed module request the register route consumes. */
type RegisterReq = Parameters<ModuleRegistrationController['register']>[0];
import { ModuleRegistryService } from './module-registry.service';
import { PrismaService } from '../database/prisma.service';
import { CryptoService } from '../common/crypto.service';
import {
  MODULE_ID_HEADER,
  MODULE_REQUEST_HEADER,
  MODULE_SIGNATURE_HEADER,
  MODULE_TIMESTAMP_HEADER,
  signModuleRequest,
} from './module-signature';
import { CORE_MODULE_CONTRACT, MODULE_PROTOCOL_VERSION } from './module.contract';

/**
 * Phase 49M §7/§8/§19: the module-facing surface and its HMAC authentication.
 *
 * WHAT THIS FILE PROVES:
 *
 *  - EVERY REJECTION IS AN IDENTICAL 401. Unknown module, missing credential, expired credential,
 *    bad signature and stale timestamp are indistinguishable to the caller, so this endpoint is not
 *    an oracle for which modules exist.
 *  - AUTHENTICATION HAPPENS BEFORE THE DOMAIN. The registry is asserted NOT to be called on any
 *    rejection path — so an unauthenticated request cannot cause a write, a read or an audit row.
 *  - THE ACTING MODULE IS THE SIGNING MODULE. `heartbeat` and `deregister` receive the VERIFIED
 *    module id, never one from the body, so a module holding one credential cannot act as another.
 *  - THE HEADER AND BODY MODULE ID MUST AGREE on registration.
 */

const SECRET = 'k'.repeat(64);
const CIPHER = { ciphertext: 'ENVELOPE', iv: 'IV', authTag: 'TAG' };

const registrationRow = (overrides: Record<string, unknown> = {}) => ({
  moduleId: 'finance',
  secretCiphertext: CIPHER.ciphertext,
  secretIv: CIPHER.iv,
  secretAuthTag: CIPHER.authTag,
  secretExpiresAt: null,
  ...overrides,
});

const registerBody = (overrides: Record<string, unknown> = {}) => ({
  moduleId: 'finance',
  instanceId: 'finance-prod-01',
  version: '1.2.0',
  deploymentMode: 'REMOTE' as const,
  baseUrl: 'https://finance.example.com',
  healthPath: '/health',
  capabilities: ['invoice.read'],
  apiContracts: [CORE_MODULE_CONTRACT],
  eventContracts: [],
  protocolVersion: MODULE_PROTOCOL_VERSION,
  ...overrides,
});

/**
 * Builds a request whose signature is CORRECT for the given body and path.
 *
 * The signature is produced with the same helper the transport uses, so a canonicalisation change
 * breaks this file rather than silently accepting a wrong signature.
 */
const signedRequest = (
  body: unknown,
  overrides: { moduleId?: string; path?: string; timestamp?: string; secret?: string } = {},
) => {
  const moduleId = overrides.moduleId ?? 'finance';
  const path = overrides.path ?? '/api/v1/modules/register';
  const timestamp = overrides.timestamp ?? String(Date.now());
  const requestId = 'req-1';

  const signature = signModuleRequest(overrides.secret ?? SECRET, {
    method: 'POST',
    path,
    timestamp,
    identity: { moduleId, requestId, tenantId: null },
    body: JSON.stringify(body),
  });

  return {
    path,
    headers: {
      [MODULE_ID_HEADER]: moduleId,
      [MODULE_SIGNATURE_HEADER]: signature,
      [MODULE_TIMESTAMP_HEADER]: timestamp,
      [MODULE_REQUEST_HEADER]: requestId,
    },
  } as unknown as RegisterReq;
};

describe('ModuleRegistrationController', () => {
  let controller: ModuleRegistrationController;
  let registry: { registerInstance: jest.Mock; heartbeat: jest.Mock; deregisterInstance: jest.Mock };
  let prisma: { moduleRegistration: { findUnique: jest.Mock } };
  let crypto: { decrypt: jest.Mock };

  beforeEach(async () => {
    registry = {
      registerInstance: jest.fn().mockResolvedValue({ accepted: true }),
      heartbeat: jest.fn().mockResolvedValue({ acknowledged: true }),
      deregisterInstance: jest.fn().mockResolvedValue({ deregistered: true }),
    };

    prisma = {
      moduleRegistration: { findUnique: jest.fn().mockResolvedValue(registrationRow()) },
    };

    crypto = { decrypt: jest.fn().mockReturnValue(SECRET) };

    const moduleRef = await Test.createTestingModule({
      controllers: [ModuleRegistrationController],
      providers: [
        { provide: ModuleRegistryService, useValue: registry },
        { provide: PrismaService, useValue: prisma },
        { provide: CryptoService, useValue: crypto },
      ],
    }).compile();

    controller = moduleRef.get(ModuleRegistrationController);
  });

  it('accepts a correctly signed registration', async () => {
    const body = registerBody();

    await controller.register(signedRequest(body), body);

    expect(registry.registerInstance).toHaveBeenCalledWith(body);
  });

  describe('rejections are uniform and reach no domain code', () => {
    const expectRejected = async (act: () => Promise<unknown>) => {
      await expect(act()).rejects.toThrow(UnauthorizedException);

      // THE IMPORTANT HALF: nothing was registered, no heartbeat recorded, nothing deregistered.
      expect(registry.registerInstance).not.toHaveBeenCalled();
      expect(registry.heartbeat).not.toHaveBeenCalled();
      expect(registry.deregisterInstance).not.toHaveBeenCalled();
    };

    it('rejects a request with no signature headers', async () => {
      const body = registerBody();

      await expectRejected(() => controller.register({ path: '/x', headers: {} } as unknown as RegisterReq, body));

      // Not even a database read: an unsigned request cannot be used to probe which modules exist.
      expect(prisma.moduleRegistration.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a header/body module-id mismatch', async () => {
      const body = registerBody({ moduleId: 'other' });

      await expectRejected(() => controller.register(signedRequest(body), body));
    });

    it('rejects an unknown module', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(null);
      const body = registerBody();

      await expectRejected(() => controller.register(signedRequest(body), body));
    });

    it('rejects a module with no stored credential', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ secretCiphertext: null, secretIv: null, secretAuthTag: null }),
      );
      const body = registerBody();

      // Refused rather than accepted-unsigned: "no credential configured" is not a reason to skip
      // verification.
      await expectRejected(() => controller.register(signedRequest(body), body));
    });

    it('rejects a module whose credential has EXPIRED (§20)', async () => {
      prisma.moduleRegistration.findUnique.mockResolvedValue(
        registrationRow({ secretExpiresAt: new Date(Date.now() - 1_000) }),
      );
      const body = registerBody();

      await expectRejected(() => controller.register(signedRequest(body), body));
    });

    it('rejects a credential that fails to decrypt', async () => {
      crypto.decrypt.mockImplementation(() => {
        throw new Error('bad key');
      });
      const body = registerBody();

      await expectRejected(() => controller.register(signedRequest(body), body));
    });

    it('rejects a signature made with the wrong secret', async () => {
      const body = registerBody();

      await expectRejected(() =>
        controller.register(signedRequest(body, { secret: 'z'.repeat(64) }), body),
      );
    });

    it('rejects a signature over a DIFFERENT body', async () => {
      const signed = signedRequest(registerBody());

      // Signature computed for the original body; a tampered body must not verify.
      await expectRejected(() =>
        controller.register(signed, registerBody({ instanceId: 'finance-prod-99' })),
      );
    });

    it('rejects a stale timestamp', async () => {
      const body = registerBody();
      const stale = String(Date.now() - 10 * 60 * 1000);

      await expectRejected(() => controller.register(signedRequest(body, { timestamp: stale }), body));
    });

    it('uses the SAME message for every rejection', async () => {
      // An oracle that distinguishes "unknown module" from "bad signature" tells an attacker which
      // modules exist.
      const messages: string[] = [];
      const body = registerBody();

      prisma.moduleRegistration.findUnique.mockResolvedValue(null);
      await controller.register(signedRequest(body), body).catch((err) => messages.push(err.message));

      prisma.moduleRegistration.findUnique.mockResolvedValue(registrationRow());
      await controller
        .register(signedRequest(body, { secret: 'z'.repeat(64) }), body)
        .catch((err) => messages.push(err.message));

      expect(messages).toHaveLength(2);
      expect(messages[0]).toBe(messages[1]);
    });
  });

  describe('the acting module is the SIGNING module', () => {
    it('passes the verified module id to heartbeat, not one from the body', async () => {
      const body = { instanceId: 'finance-prod-01', state: 'HEALTHY' as const };
      const signed = signedRequest(body, { path: '/api/v1/modules/heartbeat' });

      await controller.heartbeat(signed, body);

      expect(registry.heartbeat).toHaveBeenCalledWith('finance', 'finance-prod-01', 'HEALTHY');
    });

    it('passes the verified module id to deregister', async () => {
      const body = { instanceId: 'finance-prod-01' };
      const signed = signedRequest(body, { path: '/api/v1/modules/deregister' });

      await controller.deregister(signed, body);

      expect(registry.deregisterInstance).toHaveBeenCalledWith('finance', 'finance-prod-01');
    });

    it('cannot be replayed from one endpoint onto another', async () => {
      // The PATH is part of the canonical string, so a heartbeat signature is not a deregistration
      // signature.
      const body = { instanceId: 'finance-prod-01' };
      const signedForHeartbeat = signedRequest(body, { path: '/api/v1/modules/heartbeat' });

      // A spread of a typed express Request loses the `this`-predicated
      // methods, so the forged object is asserted once at this deliberate
      // tamper boundary — the rejection itself is what this test proves.
      const forged = {
        ...signedForHeartbeat,
        path: '/api/v1/modules/deregister',
      } as unknown as RegisterReq;

      await expect(controller.deregister(forged, body)).rejects.toThrow(UnauthorizedException);
    });
  });
});

