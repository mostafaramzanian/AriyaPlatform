import { Controller, Get, Header, NotFoundException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from './decorators/public.decorator';
import {
  JWKS_CACHE_CONTROL,
  TokenJwksPublisher,
  type TokenJwksDocument,
} from '../platform/auth/token-jwks';

/**
 * Phase 52-ARCH-3C §B7: `GET /.well-known/jwks.json` — the ONE venue where this platform
 * publishes the public half of its token signing keys.
 *
 * WHY THIS CONTROLLER SITS IN `auth/` AND NOT IN THE TOKEN SEAM
 * ------------------------------------------------------------
 * The DOCUMENT is a projection of the key set, which the seam owns (`platform/auth/token-jwks.ts`
 * builds it, and both publication and verification apply the same retirement rule). Serving it,
 * though, is a Core act: Core issues the tokens, so Core is the publisher — and `platform/auth`
 * must stay bindable by a runtime that has no Core at all. `architecture-boundaries.spec.ts`
 * enforces exactly that (the seam may not import `auth/`, `tenant/`, `messaging/`, `modules/` or
 * `database/`), and `@Public()` lives here. So the seam decides WHAT may be published and this
 * file decides that THIS runtime publishes it: a business runtime that binds the seam exposes no
 * JWKS route, which is what "Core is the authoritative publisher" means in wiring rather than in
 * a comment. Core's `AuthModule` registers it.
 *
 * PUBLIC BY DESIGN, READ-ONLY BY CONSTRUCTION
 * ------------------------------------------
 * `@Public()` because a JWKS document is what a verifier needs BEFORE it can authenticate
 * anything: requiring a token in order to fetch the keys that verify tokens is a circle. It is
 * read-only because there is nothing to write — the document is derived from this process's own
 * configuration, so no request can add, remove or alter a key, and no route here accepts a body.
 * Only public material is exposed: `toPublishedJwk` builds each entry field by field, so a private
 * component cannot reach the response even if one were configured.
 *
 * THE PATH IS A CONTRACT, WHICH IS WHY IT IS EXCLUDED FROM THE API PREFIX
 * ---------------------------------------------------------------------
 * Verifiers point `JWT_JWKS_URI` at this URL (see `.env.example`), so it is served from the root
 * rather than under `api/v1` (`main.ts` excludes exactly `TOKEN_JWKS_PATH` from the global
 * prefix). The path lives in one constant so the controller, the bootstrap and the documentation
 * cannot disagree about it.
 *
 * WHAT A 404 MEANS HERE
 * ---------------------
 * `JWKS_NOT_CONFIGURED` is returned when this process holds no public key material of its own — a
 * deployment on the shared secret, or a verifier whose keys come from someone else's JWKS
 * endpoint. That is a statement about this process, not about the platform: Core's own deployment
 * publishes a document. An empty `keys` array is deliberately never returned, because a verifier
 * would have to read "no keys" as an answer rather than as an absence.
 */
@ApiTags('Token')
@Controller('.well-known')
export class TokenJwksController {
  constructor(private readonly publisher: TokenJwksPublisher) {}

  @Public()
  @Get('jwks.json')
  @Header('Cache-Control', JWKS_CACHE_CONTROL)
  @ApiOperation({ summary: 'Public signing keys (JWKS) of the token issuer' })
  @ApiResponse({ status: 200, description: 'The public keys this deployment publishes' })
  @ApiResponse({ status: 404, description: 'This deployment publishes no signing keys' })
  getJwks(): TokenJwksDocument {
    const document = this.publisher.document();

    if (!document) {
      throw new NotFoundException({
        code: 'JWKS_NOT_CONFIGURED',
        message:
          'This deployment publishes no signing keys: it holds no public key material of its own (no JWT_SIGNING_KEYS and no JWT_ASYMMETRIC_PUBLIC_KEY with a key id).',
      });
    }

    return document;
  }
}
