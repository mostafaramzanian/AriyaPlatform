import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Test } from '@nestjs/testing';
import type { ConfigService } from '@nestjs/config';
import { SwaggerModule } from '@nestjs/swagger';
import { BlogController } from '../modules/cms/blog/blog.controller';
import { BlogService } from '../modules/cms/blog/blog.service';
import { AuditService } from './audit.service';
import { setupSwagger } from './setup-swagger';

interface OpenApiOperation {
  security?: Array<Record<string, string[]>>;
  parameters?: Array<{ name?: string }>;
}

interface OpenApiDocument {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { securitySchemes?: Record<string, unknown> };
}

/**
 * Generates the OpenAPI document for the real BlogController and asserts
 * security metadata. Runtime guards are not exercised here.
 */
describe('Blog OpenAPI security (generated document)', () => {
  let doc: OpenApiDocument;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BlogController],
      providers: [
        { provide: BlogService, useValue: {} },
        { provide: CACHE_MANAGER, useValue: {} },
        { provide: AuditService, useValue: {} },
      ],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const createDocumentSpy = jest.spyOn(SwaggerModule, 'createDocument');
    jest.spyOn(SwaggerModule, 'setup').mockImplementation(() => undefined);
    try {
      const configService = {
        get: (key: string) => (key === 'ENABLE_SWAGGER' ? 'true' : undefined),
      } as unknown as ConfigService;
      setupSwagger(app, configService);
      doc = JSON.parse(JSON.stringify(createDocumentSpy.mock.results[0].value));
    } finally {
      jest.restoreAllMocks();
      await app.close();
    }
  });

  it('public blog operations declare no bearer requirement', () => {
    expect(doc.paths['/blog'].get.security).toEqual([]);
    expect(doc.paths['/blog/{slug}'].get.security).toEqual([]);
  });

  // Stage 4 regression: GET /blog/featured was removed from the API contract
  // (its query targeted a non-existent `featured` field and always failed with
  // 500). The path and the list endpoint's `featured` query parameter must both
  // be gone from the OpenAPI document.
  it('the removed /blog/featured endpoint is absent from the contract', () => {
    expect(doc.paths['/blog/featured']).toBeUndefined();
    const listParams = (doc.paths['/blog'].get.parameters ?? []).map((p) => p.name);
    expect(listParams).not.toContain('featured');
  });

  it('protected blog operations keep the bearer requirement', () => {
    expect(doc.paths['/blog/categories'].get.security).toEqual([{ bearer: [] }]);
    expect(doc.paths['/blog/admin'].get.security).toEqual([{ bearer: [] }]);
  });

  it('every referenced security scheme is registered', () => {
    const registered = Object.keys(doc.components?.securitySchemes ?? {});
    const referenced = new Set<string>();
    for (const methods of Object.values(doc.paths)) {
      for (const op of Object.values(methods)) {
        for (const req of op.security ?? []) Object.keys(req).forEach((k) => referenced.add(k));
      }
    }
    expect([...referenced].filter((n) => !registered.includes(n))).toEqual([]);
    expect(registered).toEqual(['bearer']);
  });
});
