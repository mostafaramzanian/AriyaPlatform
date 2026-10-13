import { createRequire } from 'node:module';
import { makeRequest, testData, getTestApp } from './setup';
import type { IStorageProvider } from '../src/storage/i-storage.provider';
import { SEED_ADMIN_EMAIL, SEED_ADMIN_PASSWORD, SEED_ADMIN_USER_ID } from './fixtures/seed-environment';
import * as fs from 'fs';
import * as path from 'path';

/** The MinIO-internal client surface this best-effort probe reads (stat-only). */
interface MinioStatClient {
  statObject(
    bucket: string,
    key: string,
    callback: (err: Error | null, info: unknown) => void,
  ): void;
}

describe('Media Live E2E', () => {
  const fixtureDir = path.join(__dirname, 'fixtures');
  const fixturePath = path.join(fixtureDir, 'test-image.png');
  let adminToken: string;
  let adminId: string;
  let createdMediaId: string;
  let createdBlogId: string;

  beforeAll(async () => {
    // ensure fixture exists
    if (!fs.existsSync(fixtureDir)) fs.mkdirSync(fixtureDir, { recursive: true });
    // 1x1 PNG base64
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
    fs.writeFileSync(fixturePath, Buffer.from(pngBase64, 'base64'));

    // Ensure RBAC initialized (dev compatibility endpoint)
    await makeRequest().get('/api/v1/dev/rbac/init');

    const adminEmail = SEED_ADMIN_EMAIL;
    const adminPassword = SEED_ADMIN_PASSWORD;

    // Phase 51-HR-ARCH-3A: the ADMIN role link MUST exist BEFORE the login below.
    // Login resolves the `perm` claim through PermissionService.getUserPermissions(),
    // which CACHES its answer for 15 minutes (key `user:permissions:<userId>`) —
    // including an EMPTY answer. Granting the role after login therefore left this
    // process holding the empty set for the whole run (RolesGuard logged "Access
    // denied ... Has:" with nothing after it) no matter what the database said
    // afterwards. Resolving the user by email first removes that ordering hazard.
    // This is test-only DB setup; production assigns roles through the RBAC service,
    // whose own invalidation path keeps the cache honest.
    try {
      // Use core DB Prisma client to assign ADMIN role (test-only)
      const { PrismaClient } = createRequire(__filename)('@prisma/client');
      const coreUrl = process.env.CORE_DATABASE_URL || process.env.DATABASE_URL;
      const corePrisma = new PrismaClient({ datasources: { db: { url: coreUrl } } });
      await corePrisma.$connect();
      const adminUser = await corePrisma.user.findUnique({ where: { email: adminEmail } });
      const adminRole = await corePrisma.role.findUnique({ where: { name: 'ADMIN' } });
      if (adminUser && adminRole) {
        await corePrisma.userRole.upsert({
          where: { userId_roleId: { userId: adminUser.id, roleId: adminRole.id } },
          update: {},
          create: { id: `test-${adminUser.id}-admin-role`, userId: adminUser.id, roleId: adminRole.id, assignedBy: null, assignedAt: new Date() },
        });
      }
      await corePrisma.$disconnect();
    } catch (e) {
      console.warn('Failed to assign ADMIN role via core Prisma in test:', e);
    }

    // Use seeded super-admin account for permissions, now that its role link exists.
    const login = await makeRequest()
      .post('/api/v1/auth/login')
      .send({ email: adminEmail, password: adminPassword });

    expect(login.status).toBe(200);
    const loginBody = login.body.data ?? login.body;
    adminToken = loginBody.accessToken;
    // Prefer returned id, but fall back to seeded super-admin id. The ADMIN role link
    // for this same user was already ensured ABOVE, before the login that resolves
    // (and caches) the `perm` claim. The fallback is the shared seed constant rather
    // than a re-typed literal (GAP-8).
    adminId = loginBody.id || SEED_ADMIN_USER_ID;
  });

  afterAll(async () => {
    // cleanup created blog/media via admin endpoints if present
    if (createdBlogId) {
      await makeRequest()
        .delete(`/api/v1/blog/${createdBlogId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }

    if (createdMediaId) {
      await makeRequest()
        .delete(`/api/v1/media/${createdMediaId}`)
        .set('Authorization', `Bearer ${adminToken}`);
    }

    // remove fixture
    try { fs.unlinkSync(fixturePath); } catch { /* fixture may already be gone */ }
  });

  it('POST /media without auth should return 401', async () => {
    const res = await makeRequest()
      .post('/api/v1/media')
      .attach('file', fixturePath);
    expect(res.status).toBe(401);
  });

  it('Authorized upload should succeed and object exist in MinIO', async () => {
    const res = await makeRequest()
      .post('/api/v1/media')
      .set('Authorization', `Bearer ${adminToken}`)
      .attach('file', fixturePath);

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(res.body).toBeDefined();
    const respBody = res.body.data ?? res.body;
    expect(respBody).toBeDefined();
    const media = respBody;
    expect(media.id).toBeDefined();
    expect(media.mimeType).toBeDefined();
    expect(media.size).toBeDefined();
    expect(media.uploadedBy).toBeDefined();
    expect(media.uploadedBy).toBe(adminId);

    createdMediaId = media.id;

    // Verify object exists in MinIO using storage provider available on server instance
    // Access storage provider from the harness accessor (same instance the app serves).
    const app = getTestApp();
    const storage: IStorageProvider = app.get('IStorageProvider');
    // storage likely returns a URL for media.url and storage key in media.path
    expect(media.path || media.url).toBeDefined();
    const key = media.path ? media.path : (media.url || '').split('/').slice(-2).join('/');

    // attempt to stat object using internal client (best-effort; if not available, skip with note)
    const client = (storage as unknown as { client?: MinioStatClient }).client;
    const bucket = (storage as unknown as { bucket?: string }).bucket;
    let statOk = false;
    if (client && bucket && key) {
      // statObject uses callback API; promisify
      const stat = () => new Promise((resolve, reject) => {
        try {
          client.statObject(bucket, key, (err: Error | null, info: unknown) => {
            if (err) return reject(err);
            resolve(info);
          });
        } catch (e) { reject(e); }
      });
      try {
        const info = await stat();
        expect(info).toBeDefined();
        statOk = true;
      } catch (err: unknown) {
        // If stat failed, record but do not fail the test here — fail later if necessary
        console.warn('MinIO statObject failed:', err);
      }
    } else {
      console.warn('MinIO client not accessible from test runtime; cannot stat object directly');
    }

    expect(statOk).toBe(true);
  }, 30000);

  it('GET /media/:id returns metadata', async () => {
    const res = await makeRequest()
      .get(`/api/v1/media/${createdMediaId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(res.status).toBe(200);
    const respBody = res.body.data ?? res.body;
    expect(respBody).toBeDefined();
    expect(respBody.id).toBe(createdMediaId);
  });

  it('Attach media as featuredImage to blog and verify', async () => {
    const uniqueSlug = `${testData.blog.post.slug}-${Date.now()}`;
    const blogPayload = {
      title: testData.blog.post.title,
      content: testData.blog.post.content,
      excerpt: testData.blog.post.excerpt,
      slug: uniqueSlug,
      featuredImageId: createdMediaId,
    };
    const res = await makeRequest()
      .post('/api/v1/blog')
      .set('Authorization', `Bearer ${adminToken}`)
      .send(blogPayload);

    console.log('BLOG CREATE RESPONSE', JSON.stringify(res.body));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    const blog = res.body.data ?? res.body;
    expect(blog).toBeDefined();
    expect(blog.id).toBeDefined();
    createdBlogId = blog.id;

    const getRes = await makeRequest()
      .get(`/api/v1/blog/admin/${createdBlogId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    expect(getRes.status).toBe(200);
    const getBody = getRes.body.data ?? getRes.body;
    expect(getBody).toBeDefined();
    expect(getBody.featuredImageId).toBe(createdMediaId);
    expect(getBody.featuredImage).toBeDefined();
  });

  it('DELETE /media/:id soft-deletes and subsequent GET behaves as deleted', async () => {
    const delRes = await makeRequest()
      .delete(`/api/v1/media/${createdMediaId}`)
      .set('Authorization', `Bearer ${adminToken}`);
    expect(delRes.status).toBeGreaterThanOrEqual(200);
    expect(delRes.status).toBeLessThan(300);

    const getRes = await makeRequest()
      .get(`/api/v1/media/${createdMediaId}`)
      .set('Authorization', `Bearer ${adminToken}`);

    // project may return 404 or specific deleted semantics; assert not 200
    expect(getRes.status).not.toBe(200);
  });
});
