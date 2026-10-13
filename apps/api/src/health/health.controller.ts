import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { HealthService } from './health.service';
import { Public } from '../auth/decorators/public.decorator';
import { RUNTIME_ID } from './health-tokens';
import { RuntimeId } from '../runtime-datasources';

@Controller()
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private healthService: HealthService,
    @Inject(RUNTIME_ID) private readonly runtimeId: RuntimeId
  ) {}

  /** Liveness of the process itself. Touches no dependency, by design. */
  @Public()
  @Get('health')
  @HttpCode(HttpStatus.OK)
  health() {
    return { runtime: this.runtimeId, status: 'ok', timestamp: new Date().toISOString() };
  }

  /** Liveness, in the form load balancers expect. */
  @Public()
  @Get('live')
  @HttpCode(HttpStatus.OK)
  live() {
    return { runtime: this.runtimeId, status: 'alive', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness — and the HTTP status is the answer.
   *
   * ARCH-1.3 changed this endpoint's contract deliberately. It used to answer HTTP
   * 200 with `status: 'not-ready'` in the body, which means every orchestrator,
   * load balancer and dependency manager that reads STATUS CODES saw a healthy
   * process while the runtime was telling anyone who parsed the body that it could
   * not serve. A readiness endpoint whose status code never varies cannot gate
   * traffic.
   *
   * Now: 200 when ready, 503 when not ready, and the report is the body in both
   * cases (the same shape, so a caller parses one contract).
   *
   * The body carries the discrete probe states — `ok` / `failed` /
   * `not-configured` / `not-used` per dependency — but NOT free-text probe
   * details, because this endpoint is intentionally unauthenticated. Error text
   * (which can name schemas or hosts) goes to the log via the line below.
   */
  @Public()
  @Get('ready')
  async ready() {
    const report = await this.healthService.getReadinessStatus();

    const body = {
      runtime: this.runtimeId,
      status: report.healthy ? 'ready' : 'not-ready',
      timestamp: new Date().toISOString(),
      checks: report.checks,
      requirements: report.requirements,
      statuses: report.statuses,
      notConfigured: report.notConfigured,
      optionalDegraded: report.optionalDegraded,
      blocking: report.blocking,
    };

    if (!report.healthy) {
      // Server-side only. The response body never carries probe error text.
      this.logger.warn({
        runtime: this.runtimeId,
        blocking: report.blocking,
        details: Object.fromEntries(report.blocking.map((key) => [key, report.details[key]])),
      });
      throw new ServiceUnavailableException(body);
    }

    return body;
  }
}
