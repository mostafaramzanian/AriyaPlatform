import { generateKeyPairSync } from 'crypto';
import { NotFoundException } from '@nestjs/common';
import { PATH_METADATA } from '@nestjs/common/constants';
import { JWKS_CACHE_CONTROL, TokenJwksPublisher } from '../platform/auth/token-jwks';
import { JWKS_CACHE_TTL_MS } from '../platform/auth/token-keyset';
import { TOKEN_JWKS_PATH, TOKEN_ROTATION_OVERLAP_SECONDS } from '../platform/auth/token-contract';
import { TokenPolicy } from '../platform/auth/token-policy';
import { TokenJwksController } from './token-jwks.controller';

/**
 * Phase 52-ARCH-3C §B7: the HTTP surface that publishes this process's public signing keys.
 *
 * The tests are about the three things a verifier and an operator depend on:
 *
 *   * the ROUTE is exactly the contract path, at the root rather than under the versioned API
 *     prefix, and it is PUBLIC — a verifier needs the keys before it can authenticate anything;
 *   * a process that publishes nothing answers 404 with a machine-readable code instead of an
 *     empty document that a verifier would read as "there are no keys";
 *   * the cache header is derived from the verifier's own cache TTL and stays well inside the
 *     rotation window, so no intermediary can serve a document from before a rotation finished.
 */
describe('TokenJwksController', () => {
  const pair = () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
      publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
  };

  const signer = pair();

  const publishingController = () =>
    new TokenJwksController(
      new TokenJwksPublisher(
        new TokenPolicy({
          JWT_SIGNING_KEYS: JSON.stringify([{ kid: 'new', privateKey: signer.privatePem }]),
          JWT_ACTIVE_KEY_ID: 'new',
        })
      )
    );

  it('serves the document the publisher builds, unchanged', () => {
    const document = publishingController().getJwks();

    expect(document.keys).toHaveLength(1);
    expect(document.keys[0]).toMatchObject({ kid: 'new', use: 'sig', alg: 'RS256' });
  });

  it('answers 404 with a machine-readable code when this process publishes nothing', () => {
    const controller = new TokenJwksController(
      new TokenJwksPublisher(new TokenPolicy({ JWT_SECRET: 'shared-secret' }))
    );

    try {
      controller.getJwks();
      throw new Error('expected the controller to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).getResponse()).toMatchObject({
        code: 'JWKS_NOT_CONFIGURED',
      });
    }
  });

  it('is PUBLIC, because a verifier needs the keys before it can authenticate anything', () => {
    expect(Reflect.getMetadata('isPublic', TokenJwksController.prototype.getJwks)).toBe(true);
  });

  it('declares exactly the well-known path, outside the versioned API prefix', () => {
    const controllerPath = Reflect.getMetadata(PATH_METADATA, TokenJwksController) as string;
    const handlerPath = Reflect.getMetadata(
      PATH_METADATA,
      TokenJwksController.prototype.getJwks
    ) as string;

    // The path is a contract for other runtimes (`.env.example` points `JWT_JWKS_URI` at it) and
    // `main.ts` excludes THIS constant from the global prefix, so the three must agree.
    expect(`/${controllerPath}/${handlerPath}`).toBe(TOKEN_JWKS_PATH);
  });

  it('caches for the verifier cache TTL, which is well inside the rotation window', () => {
    expect(JWKS_CACHE_CONTROL).toBe(`public, max-age=${Math.floor(JWKS_CACHE_TTL_MS / 1000)}`);
    // The safety property, as arithmetic: a cache can never outlive an overlap window.
    expect(JWKS_CACHE_TTL_MS / 1000).toBeLessThan(TOKEN_ROTATION_OVERLAP_SECONDS);
  });
});
