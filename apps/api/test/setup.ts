/**
 * E2E Test Setup
 * Runs before each test suite
 */
import * as fs from 'fs';
import { createRequire } from 'node:module';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import {
  INestApplication,
  ValidationPipe,
  UnprocessableEntityException,
  WebSocketAdapter,
} from '@nestjs/common';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from '../src/app.module';
import { TOKEN_JWKS_PATH } from '../src/platform/auth/token-contract';
import { ValidationError } from 'class-validator';

/**
 * Structural shapes for the route dump below: the members this test harness
 * actually reads off Nest's private container, with nothing invented. Nest
 * exposes no public API for the module graph, so the dump reaches in — but it
 * reaches in with a typed keyhole instead of `any`.
 */
interface DumpModuleEntry {
  metatype?: { name?: string } | null;
  name?: string;
  controllers?: ReadonlyMap<{ name?: string }, unknown>;
  providers?: ReadonlyMap<{ name?: string }, unknown>;
  imports?: ReadonlyMap<{ name?: string }, unknown>;
}

interface DumpModuleRow {
  name: string;
  controllers: string[];
  providers: string[];
  imports: string[];
}

interface NestInternals {
  container?: { getModules?: () => Map<unknown, DumpModuleEntry> };
  _moduleRef?: { container?: { getModules?: () => Map<unknown, DumpModuleEntry> } };
}

/** What `beforeAll` publishes into the shared Jest global context. */
interface TestAppGlobal {
  __TEST_APP__?: INestApplication;
}

let app: INestApplication;

beforeAll(async () => {
  console.log('[E2E] Setting up test application (production bootstrap)...');

  // Normalize MinIO env for local E2E runs: ensure MINIO_HOST/PORT are set
  if (!process.env.MINIO_HOST) {
    if (process.env.MINIO_ENDPOINT) {
      const m = process.env.MINIO_ENDPOINT.match(/^(?:https?:\/\/)?([^:/]+)(?::(\d+))?$/);
      if (m) {
        process.env.MINIO_HOST = m[1];
        if (m[2]) process.env.MINIO_PORT = m[2];
      }
    }
  }

  // Default to localhost if nothing provided (tests expect accessible MinIO on localhost)
  process.env.MINIO_HOST = process.env.MINIO_HOST || 'localhost';
  process.env.MINIO_PORT = process.env.MINIO_PORT || '9000';

  // Create app the EXACT same way production does
  app = await NestFactory.create(AppModule, { bufferLogs: true });

  // Apply exact same pipes as production (main.ts)
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      forbidUnknownValues: true,
      transform: true,
      stopAtFirstError: false,
      transformOptions: { enableImplicitConversion: true },
      exceptionFactory: (errors: ValidationError[]) => {
        const details = errors.map((error) => ({
          property: error.property,
          constraints: error.constraints,
          children: error.children?.map((child) => child.property),
        }));
        return new UnprocessableEntityException({
          code: 'VALIDATION_FAILED',
          message: 'Validation failed',
          details,
        });
      },
    }),
  );

  // Phase 51-HR-2: the WebSocket adapter MUST be selected here, exactly as `main.ts`
  // does. `MessagingModule` registers a real gateway, and Nest's `SocketModule` loads
  // `@nestjs/platform-socket.io` whenever a gateway exists and no IoAdapter was
  // installed — and that package is deliberately NOT a dependency of this project
  // (Phase 49F chose raw `ws` via `@nestjs/platform-ws`). Without this line,
  // `app.listen()` below calls `process.exit(1)` and EVERY E2E suite in this folder
  // dies during bootstrap, before a single test runs.
  app.useWebSocketAdapter(new WsAdapter(app) as unknown as WebSocketAdapter);

  // Set exact same prefix as production.
  //
  // Phase 52-ARCH-3C: `main.ts` excludes `TOKEN_JWKS_PATH` (`/.well-known/jwks.json`) from
  // that prefix, because the JWKS document is a contract for OTHER runtimes — a verifier
  // points `JWT_JWKS_URI` at it — and a well-known location belongs at the root. The
  // exclusion is mirrored here so this harness cannot serve the document at a URL
  // production never serves: without it, an E2E assertion written against
  // `/api/v1/.well-known/jwks.json` would pass here and 404 in production.
  app.setGlobalPrefix('api/v1', { exclude: [TOKEN_JWKS_PATH] });

  // CRITICAL: Must call app.listen() (with port 0 for random) to actually register routes on Express adapter
  // app.init() does NOT register routes - it only initializes modules
  // Production uses app.listen(3001), so tests must too to get the same behavior
  // Use IPv4 localhost explicitly (127.0.0.1) to avoid IPv6 issues with Supertest
  const server = await app.listen(0, '127.0.0.1');
  const address = server.address();
  console.log('[E2E] App listening on:', address);
  console.log('[E2E] Server instance:', typeof server, server ? 'defined' : 'undefined');

  // Dump runtime routes for verification
  try {
    const internals = app as unknown as NestInternals;
    const container = internals.container || (internals._moduleRef && internals._moduleRef.container);
    const modules: DumpModuleRow[] = [];
    const registeredRoutes: string[] = [];

    // Get modules
    if (container && typeof container.getModules === 'function') {
      for (const m of container.getModules().values()) {
        try {
          const name = m.metatype?.name || (m.name || 'AnonymousModule');
          const controllers = Array.from((m.controllers && m.controllers.keys && m.controllers.keys()) || []).map((c) => (c && c.name) || String(c));
          const providers = Array.from((m.providers && m.providers.keys && m.providers.keys()) || []).map((p) => (p && p.name) || String(p));
          const imports = Array.from((m.imports && m.imports.keys && m.imports.keys()) || []).map((i) => (i && i.name) || String(i));
          modules.push({ name, controllers, providers, imports });
        } catch {
          // ignore
        }
      }
    }

    // Get adapter routes
    try {
      const adapter = app.getHttpAdapter();
      const inst = adapter?.getInstance();
      if (inst && inst._router && Array.isArray(inst._router.stack)) {
        for (const layer of inst._router.stack) {
          if (layer && layer.route && layer.route.path) {
            const methods = Object.keys(layer.route.methods || {}).map((m) => m.toUpperCase()).join(',');
            registeredRoutes.push(`${methods} ${layer.route.path}`);
          }
        }
      }
    } catch {
      // ignore route collection errors
    }

    const dump = {
      nodeEnv: process.env.NODE_ENV,
      registeredRoutes,
      moduleGraph: modules,
      timestamp: new Date().toISOString(),
    };
    try {
      fs.writeFileSync('/tmp/testing_module_dump.json', JSON.stringify(dump, null, 2));
    } catch {
      fs.writeFileSync('./testing_module_dump.json', JSON.stringify(dump, null, 2));
    }
    console.log('[E2E] Runtime route dump written. Total routes:', registeredRoutes.length);
    if (registeredRoutes.length === 0) {
      console.log('[E2E] WARNING: No routes registered on adapter!');
    }
  } catch (err) {
    console.log('[E2E] Failed to write route dump', err && (err as Error).stack ? (err as Error).stack : err);
  }

  // Store app in global context for tests
  (global as unknown as TestAppGlobal).__TEST_APP__ = app;

  console.log('[E2E] Test application ready');
});

// Export function to get a direct DB client for tests.
//
// `unknown` on purpose: `createRequire('@prisma/client')` yields the LEGACY
// root-schema client (see the comment below), not the Core `PrismaService` —
// callers that need a specific surface must narrow it themselves rather than
// inherit a lie from an `any` return.
export async function getPrismaService(): Promise<unknown> {
  // Prefer getting Prisma from the running app if available
  // Create a direct PrismaClient connection using CMS_DATABASE_URL or DATABASE_URL
  try {
    const { PrismaClient } = createRequire(__filename)('@prisma/client');
    const dbUrl = process.env.CMS_DATABASE_URL || process.env.DATABASE_URL;
    if (!dbUrl) throw new Error('No CMS_DATABASE_URL or DATABASE_URL available in test env');
    const client = new PrismaClient({ datasources: { db: { url: dbUrl } } });
    await client.$connect();
    return client;
  } catch (err) {
    throw new Error(`Failed to create direct PrismaClient for tests: ${(err as Error).message}`);
  }
}

afterAll(async () => {
  console.log('[E2E] Tearing down test application...');
  if (app) {
    await app.close();
  }
  console.log('[E2E] Test application closed');
});

/**
 * The application `beforeAll` published for the e2e suites — the ONE accessor,
 * so no spec reaches into `global` with its own cast.
 */
export function getTestApp(): INestApplication {
  const holder = global as unknown as TestAppGlobal;
  if (!holder.__TEST_APP__) {
    throw new Error('Test app not initialized');
  }
  return holder.__TEST_APP__;
}

// Utility for making HTTP requests in tests
export function makeRequest() {
  return request(getTestApp().getHttpServer());
}

// Test data utilities
export const testData = {
  users: {
    admin: {
      email: 'admin@test.local',
      password: 'Admin@123456',
      firstName: 'Admin',
      lastName: 'User',
    },
    editor: {
      email: 'editor@test.local',
      password: 'Editor@123456',
      firstName: 'Editor',
      lastName: 'User',
    },
    viewer: {
      email: 'viewer@test.local',
      password: 'Viewer@123456',
      firstName: 'Viewer',
      lastName: 'User',
    },
  },
  blog: {
    post: {
      title: 'Test Blog Post',
      content: '# Test Content\n\nThis is a test blog post.',
      excerpt: 'This is a test blog post.',
      slug: 'test-blog-post',
      featured: false,
      published: false,
    },
  },
};

export class E2ETestHelper {
  static async register(data: string | object) {
    const response = await makeRequest()
      .post('/api/v1/auth/register')
      .send(data);
    return response;
  }

  static async login(email: string, password: string) {
    const response = await makeRequest()
      .post('/api/v1/auth/login')
      .send({ email, password });
    return response;
  }

  static async getWithAuth(url: string, token: string) {
    return makeRequest()
      .get(url)
      .set('Authorization', `Bearer ${token}`);
  }

  static async postWithAuth(url: string, data: string | object, token: string) {
    return makeRequest()
      .post(url)
      .set('Authorization', `Bearer ${token}`)
      .send(data);
  }

  static async patchWithAuth(url: string, data: string | object, token: string) {
    return makeRequest()
      .patch(url)
      .set('Authorization', `Bearer ${token}`)
      .send(data);
  }

  static async deleteWithAuth(url: string, token: string) {
    return makeRequest()
      .delete(url)
      .set('Authorization', `Bearer ${token}`);
  }
}
