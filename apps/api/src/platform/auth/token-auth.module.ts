import { Injectable, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { TokenIssuer } from './token-issuer';
import { TokenJwksPublisher } from './token-jwks';
import { TokenKeySet } from './token-keyset';
import { TokenPolicy } from './token-policy';
import {
  InMemoryRevocationRegistry,
  RevocationFeed,
  TokenRevocationRegistry,
  UnwiredRevocationFeed,
} from './token-revocation';
import { TokenVerifier } from './token-verifier';

/**
 * Phase 51-HR-ARCH-3A: the token-auth seam.
 *
 * WHAT A CONSUMER GETS
 * --------------------
 * `TokenVerifier` (verify a token), `TokenIssuer` (mint one), `TokenPolicy` (what this
 * process accepts) and `TokenRevocationRegistry` (the deny-set and its reported posture).
 * `PermissionSource` and `TenantResolver` are declared beside this module but bound by
 * the runtime that owns them (the combined runtime binds Core's implementations), because
 * "which authority resolves a tenant" is a runtime-policy decision, not a token decision.
 *
 * WHY `JwtModule.register({})` HAS NO SECRET
 * -----------------------------------------
 * Every key this platform uses is passed EXPLICITLY at the call site: a public key for
 * RS256 verification, the configured signing key for RS256 issuance, the shared secret for
 * the legacy bridge. An ambient module-level secret is exactly the pattern that let two
 * verifiers drift apart in the first place; with none registered, a call that forgets its
 * key fails loudly instead of silently using "the" secret.
 *
 * WHERE THE CLAIM-ONLY IMPLEMENTATIONS GO
 * --------------------------------------
 * `TokenPermissionSource` and `ClaimsTenantResolver` (in this folder) are what a runtime
 * with NO Core database binds. They are deliberately NOT registered here, because this
 * module is consumed by the combined runtime, which needs Core's catalogue for legacy
 * tokens and therefore binds `CorePermissionSource` and `CoreTenantResolver` instead.
 * Registering both would leave a dead provider in every deployment and make "which one is
 * in effect?" a question about registration order.
 *
 * WHAT THIS MODULE DOES FOR PUBLICATION (Phase 52-ARCH-3C)
 * --------------------------------------------------------
 * `TokenJwksPublisher` — exported above — is the seam's answer to "which keys may be published,
 * and when": it reads `TokenPolicy.signingKeys` and applies the same `isRetired` rule the verifier
 * applies, so publication and verification cannot disagree about which keys are in play. The
 * ROUTE (`GET /.well-known/jwks.json`) is deliberately NOT declared here: serving it is a Core act
 * — Core issues the tokens, so Core publishes the keys — while the seam must stay bindable by a
 * runtime with no Core at all, which `architecture-boundaries.spec.ts` enforces by refusing any
 * seam import from `auth/`. Core's `AuthModule` registers `TokenJwksController`, which is why that
 * controller lives beside `AuthController`. A runtime that binds only the seam therefore publishes
 * nothing, and one that holds no key material of its own answers 404 (`JWKS_NOT_CONFIGURED`)
 * rather than an empty document that a verifier would read as an answer.
 */
/**
 * Writes this process's token posture to the boot log, once.
 *
 * A security-relevant switch that can only be answered by reading the environment is a
 * switch nobody audits. One line states which algorithm is accepted, where the key comes
 * from, whether this process can sign, the accepted lifetime bound, and whether the
 * revocation feed is wired — so "was that incident during the bridge or after it?" is
 * answerable from the log.
 */
@Injectable()
export class TokenPostureLogger implements OnModuleInit {
  private readonly logger = new Logger('TokenPosture');

  constructor(
    private readonly policy: TokenPolicy,
    private readonly revocation: TokenRevocationRegistry,
  ) {}

  onModuleInit(): void {
    this.logger.log(`Token acceptance: ${this.policy.describe()}`);
    this.logger.log(`Revocation: ${this.revocation.describe()}`);
  }
}

@Module({
  imports: [ConfigModule, JwtModule.register({})],
  providers: [
    {
      provide: TokenPolicy,
      useFactory: (config: ConfigService) => TokenPolicy.fromConfig(config),
      inject: [ConfigService],
    },
    {
      provide: TokenKeySet,
      useFactory: (policy: TokenPolicy) => new TokenKeySet(policy),
      inject: [TokenPolicy],
    },
    {
      provide: TokenJwksPublisher,
      // A factory for the same reason as `TokenVerifier`: the constructor takes an optional
      // CLOCK, and `emitDecoratorMetadata` would have Nest resolve `Function` as a dependency.
      useFactory: (policy: TokenPolicy) => new TokenJwksPublisher(policy),
      inject: [TokenPolicy],
    },
    {
      provide: TokenRevocationRegistry,
      useFactory: (policy: TokenPolicy) =>
        new InMemoryRevocationRegistry(policy.maxAcceptedTtlSeconds),
      inject: [TokenPolicy],
    },
    {
      provide: RevocationFeed,
      // A transport, when one exists, must ALSO be started during module init and stopped
      // on shutdown. The unwired feed needs neither: it has nothing to subscribe to.
      useFactory: (registry: TokenRevocationRegistry) => new UnwiredRevocationFeed(registry),
      inject: [TokenRevocationRegistry],
    },
    {
      provide: TokenVerifier,
      // A factory, not a class provider, because the verifier's constructor takes an
      // optional CLOCK (injectable in tests, `Date.now` in production). `emitDecoratorMetadata`
      // emits that parameter as `Function`, so Nest would try to resolve it as a dependency and
      // the module would not boot — a default value does not keep Nest out of it. Building the
      // instance here keeps the seam for tests without inventing a DI token for a clock.
      useFactory: (
        jwt: JwtService,
        policy: TokenPolicy,
        keySet: TokenKeySet,
        revocation: TokenRevocationRegistry,
      ) => new TokenVerifier(jwt, policy, keySet, revocation),
      inject: [JwtService, TokenPolicy, TokenKeySet, TokenRevocationRegistry],
    },
    TokenIssuer,
    TokenPostureLogger,
  ],
  exports: [
    TokenPolicy,
    TokenKeySet,
    TokenVerifier,
    TokenIssuer,
    // Phase 52-ARCH-3C: exported because the ROUTE that publishes this process's public keys is
    // registered by the runtime that issues tokens (Core's `AuthModule`), not by the seam — the
    // seam may not import `auth/`, and publication is a Core act. See `token-jwks.ts`.
    TokenJwksPublisher,
    TokenRevocationRegistry,
    RevocationFeed,
  ],
})
export class TokenAuthModule {}
