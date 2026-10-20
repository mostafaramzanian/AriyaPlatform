import { Provider } from '@nestjs/common';
import { RuntimeId } from '../runtime-datasources';
import { RUNTIME_ID } from './health-tokens';
import { HealthService } from './health.service';
import { DatasourceHealthProbe } from './datasource-health.probe';
import { createDatasourceProbeProviders } from './datasource-probe.registry';
import { InfrastructureHealthProbe } from './infrastructure-health.probe';
import { ReadinessEvaluator } from './readiness.evaluator';
import { RevocationFeedProbe } from './revocation-feed.probe';

/**
 * Phase ARCH-1.3: the ONLY place that binds a concrete runtime to the health graph.
 * Phase ARCH-2: it also DERIVES the datasource probe registry from the policy.
 *
 * Every runtime health module calls this, so the runtime identity, the probe set and
 * the evaluator can never be assembled inconsistently — a module cannot provide a
 * `RUNTIME_ID` of one runtime with a controller whose service evaluates a different
 * policy, because there is no second code path that could.
 *
 * The probe registry is not an argument here, and that is the point: it is computed
 * from `instantiatedDatasources(runtime)`, so the providers a runtime registers are
 * the datasources its policy instantiates. No caller can hand this function a client
 * list, which is what makes "registered == instantiated" a construction property
 * rather than a convention.
 *
 * The Prisma modules are still declared per module in the module's own `imports`,
 * because that is the datasource-instantiation decision the runtime policy controls
 * (see the `health module imports` rule in architecture tests).
 */
export function createHealthProviders(runtime: RuntimeId): Provider[] {
  return [
    HealthService,
    DatasourceHealthProbe,
    InfrastructureHealthProbe,
    // PHASE W3: reports the token-revocation feed posture on every runtime;
    // where no token seam is bound the probe reports `not-configured`.
    RevocationFeedProbe,
    ReadinessEvaluator,
    { provide: RUNTIME_ID, useValue: runtime },
    createDatasourceProbeProviders(runtime),
  ];
}
