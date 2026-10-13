import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { REDIS_CLIENT } from '../common/redis.module';
import {
  INFRASTRUCTURE_SERVICES,
  InfrastructureService,
  Requirement,
  RuntimeId,
  runtimePolicy,
} from '../runtime-datasources';
import { RUNTIME_ID } from './health-tokens';
import { INFRASTRUCTURE_CHECK_KEYS, ProbeResult, sanitizeDetail } from './health.contract';

const PROBE_TIMEOUT_MS = 3000;

/**
 * Phase ARCH-1.3: probes optional infrastructure (Redis / RabbitMQ / MinIO).
 *
 * Three rules this class exists to enforce:
 *
 *  1. NOTHING IS INVENTED. There is no fallback broker address and no fallback
 *     credential: an unset RABBITMQ_URL is reported as `not-configured`, never as
 *     a connection attempt to a hard-coded `amqp://user:password@host:port`. A
 *     hard-coded credential in source is a credential leak even when the value is
 *     a development default, and it also makes "not configured" indistinguishable
 *     from "configured and down" — the state an operator most needs to tell apart.
 *  2. NO SECOND CONNECTION. Redis is probed through the single canonical
 *     REDIS_CLIENT provider (`RedisModule`, `@Global()`); this probe never
 *     constructs its own client, so a health poll cannot multiply connections.
 *     RabbitMQ is probed with a bare TCP connect, so health never competes with
 *     the application's managed AMQP connection lifecycle.
 *  3. NEVER FATAL BY DEFAULT. Every probe returns a result and nothing throws.
 *     Whether a failure blocks readiness is the evaluator's decision, taken from
 *     the runtime policy, not this class's.
 */
@Injectable()
export class InfrastructureHealthProbe {
  constructor(
    @Inject(RUNTIME_ID) private readonly runtimeId: RuntimeId,
    @Optional() @Inject(REDIS_CLIENT) private readonly redisClient?: Redis
  ) {}

  async probeAll(): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];
    for (const service of INFRASTRUCTURE_SERVICES) {
      results.push(await this.probe(service));
    }
    return results;
  }

  async probe(service: InfrastructureService): Promise<ProbeResult> {
    switch (service) {
      case 'redis':
        return this.probeRedis();
      case 'rabbitmq':
        return this.probeRabbitMQ();
      case 'minio':
        return this.probeMinIO();
      default:
        return this.result(service, 'failed', 'unknown infrastructure service');
    }
  }

  async probeRedis(): Promise<ProbeResult> {
    const requirement = this.requirement('redis');
    if (requirement === 'not-used') {
      return this.result('redis', 'not-used', null);
    }

    if (!this.redisClient) {
      // The canonical provider is missing from this health graph: report it
      // instead of opening a second connection from inside a health check.
      const configured = Boolean(process.env.REDIS_URL?.trim());
      return this.result(
        'redis',
        configured || requirement === 'required' ? 'failed' : 'not-configured',
        configured ? 'REDIS_CLIENT is not provided by this runtime' : 'REDIS_URL is not configured'
      );
    }

    // Bounded: a PING issued while Redis is unreachable can wait in the client's
    // offline queue indefinitely. An unanswered PING within PROBE_TIMEOUT_MS is a
    // failed check, so readiness returns 503 instead of hanging the request.
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Redis PING timed out after ${PROBE_TIMEOUT_MS}ms`)),
        PROBE_TIMEOUT_MS
      );
    });
    try {
      const pong = await Promise.race([this.redisClient.ping(), timeout]);
      return pong === 'PONG'
        ? this.result('redis', 'ok', null)
        : this.result('redis', 'failed', 'unexpected PING reply');
    } catch (err) {
      return this.result('redis', 'failed', sanitizeDetail(err));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async probeRabbitMQ(): Promise<ProbeResult> {
    const requirement = this.requirement('rabbitmq');
    if (requirement === 'not-used') {
      return this.result('rabbitmq', 'not-used', null);
    }

    const url = process.env.RABBITMQ_URL?.trim();
    if (!url) {
      return this.result(
        'rabbitmq',
        requirement === 'optional' ? 'not-configured' : 'failed',
        'RABBITMQ_URL is not configured'
      );
    }

    let host: string;
    let port: number;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      port = Number(parsed.port) || 5672;
    } catch {
      // The offending value may carry credentials, so the detail is fixed text.
      return this.result('rabbitmq', 'failed', 'RABBITMQ_URL is not a valid AMQP URL');
    }

    const reachable = await this.tcpProbe(host, port);
    return reachable
      ? this.result('rabbitmq', 'ok', null)
      : this.result('rabbitmq', 'failed', `no TCP connection to the AMQP broker on port ${port}`);
  }

  async probeMinIO(): Promise<ProbeResult> {
    const requirement = this.requirement('minio');
    if (requirement === 'not-used') {
      return this.result('minio', 'not-used', null);
    }

    const endpoint = process.env.MINIO_ENDPOINT?.trim();
    if (!endpoint) {
      return this.result(
        'minio',
        requirement === 'optional' ? 'not-configured' : 'failed',
        'MINIO_ENDPOINT is not configured'
      );
    }

    // Compose supplies a bare `host:port` for MINIO_ENDPOINT while the probe needs
    // a URL. Normalizing here (instead of in one caller) keeps the probe usable
    // from any runtime without depending on how the operator wrote the value.
    const base = /^https?:\/\//i.test(endpoint) ? endpoint : `http://${endpoint}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
      const resp = await fetch(`${base}/minio/health/live`, { signal: controller.signal });
      // 403/404 still prove the endpoint answered, which is all this probe claims.
      const ok = resp.ok || resp.status === 403 || resp.status === 404;
      return ok
        ? this.result('minio', 'ok', null)
        : this.result('minio', 'failed', `HTTP ${resp.status}`);
    } catch (err) {
      return this.result('minio', 'failed', sanitizeDetail(err));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private tcpProbe(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      void import('net').then((net) => {
        const socket = net.createConnection({ host, port });
        const done = (value: boolean) => {
          socket.removeAllListeners();
          socket.destroy();
          resolve(value);
        };
        socket.setTimeout(PROBE_TIMEOUT_MS);
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
      });
    });
  }

  private requirement(service: InfrastructureService): Requirement {
    return runtimePolicy(this.runtimeId).infrastructure[service];
  }

  private result(
    service: InfrastructureService,
    status: ProbeResult['status'],
    detail: string | null
  ): ProbeResult {
    return {
      key: INFRASTRUCTURE_CHECK_KEYS[service],
      status,
      requirement: this.requirement(service),
      detail,
    };
  }
}
