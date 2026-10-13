import { Logger } from '@nestjs/common';
import { JWKS_CACHE_TTL_MS } from './token-keyset';
import { toPublishedJwk, type PublishedJsonWebKey } from './token-signing-keys';
import { TokenPolicy } from './token-policy';

/**
 * Phase 52-ARCH-3C: the JWKS PUBLISHER — the document verifiers fetch, built from the key set.
 *
 * WHY PUBLICATION IS A SEPARATE CLASS FROM VERIFICATION
 * ----------------------------------------------------
 * `TokenKeySet` answers "which key does this token name?"; this class answers "which keys do we
 * tell the world about?". They read the same configuration and apply the same retirement rule
 * (`isRetired`), and keeping them apart is what lets the two answers differ in one honest way: a
 * runtime that holds no key material of its own publishes nothing, while a runtime that holds
 * keys answers tokens. Neither is allowed to invent a key for the other.
 *
 * WHY CACHING IS PART OF THE CONTRACT AND NOT AN OPTIMISATION
 * ----------------------------------------------------------
 * A rotation window is a promise about TIME: "this key stays published for at least 15
 * minutes". A cache that outlives the window would break that promise from the outside, so the
 * document is served with an explicit `max-age` equal to the verifier's own JWKS cache TTL
 * (`JWKS_CACHE_TTL_MS`, imported rather than repeated). 300s is well inside the 900s window, so
 * no intermediary can serve a document from before the current rotation completed, and the two
 * numbers cannot drift apart because there is only one of each.
 */
export const JWKS_CACHE_CONTROL = `public, max-age=${Math.floor(JWKS_CACHE_TTL_MS / 1000)}`;

/** The document shape. `keys` is never empty: `document()` returns null instead. */
export interface TokenJwksDocument {
  readonly keys: PublishedJsonWebKey[];
}

export class TokenJwksPublisher {
  private readonly logger = new Logger(TokenJwksPublisher.name);

  constructor(
    private readonly policy: TokenPolicy,
    private readonly now: () => number = () => Date.now()
  ) {}

  /**
   * The document, or null when this process publishes nothing.
   *
   * Null is not an error: a verifier-only deployment configured with `JWT_JWKS_URI` holds no key
   * material of its own, and a deployment still on the shared secret holds none at all. The
   * controller turns null into a 404 rather than into an empty document, because `{ keys: [] }`
   * is a STATEMENT about the key set ("there are no keys") that a verifier would read as an
   * answer, while an absent document is the truth: this deployment is not a publisher.
   */
  document(): TokenJwksDocument | null {
    const publishable = this.policy.publishableKeys(this.now());

    if (publishable.length === 0) return null;

    const keys: PublishedJsonWebKey[] = [];

    for (const entry of publishable) {
      try {
        keys.push(toPublishedJwk(entry.kid, entry.publicPem));
      } catch (error) {
        // Conversion is validated at boot for a key set, so reaching this means the static
        // single-key path holds something unreadable. Skipping that one entry keeps an
        // unusable key from taking down the document the other keys are in, and the warning
        // names the kid without echoing any material.
        this.logger.warn(
          `Not publishing kid=${JSON.stringify(entry.kid)}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    return keys.length > 0 ? { keys } : null;
  }
}
