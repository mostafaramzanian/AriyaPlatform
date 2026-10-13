import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ValidationPipe } from '@nestjs/common';
import axios from 'axios';
const FormData = require('form-data');
import * as fs from 'fs';
import * as path from 'path';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true, stopAtFirstError: false }));
  app.setGlobalPrefix('api/v1');
  const server = await app.listen(0, '127.0.0.1');
  const address: any = server.address();
  const port = address.port;
  console.log('[DEBUG] App listening on port', port);

  const base = `http://127.0.0.1:${port}/api/v1`;
  try {
    // init rbac
    const init = await axios.get(`${base}/dev/rbac/init`);
    console.log('[DEBUG] RBAC init status', init.status);

    // login
    const loginResp = await axios.post(`${base}/auth/login`, { email: process.env.E2E_SUPERADMIN_EMAIL || 'admin@localhost', password: process.env.E2E_SUPERADMIN_PASSWORD || 'ChangeMe123!' });
    console.log('[DEBUG] login status', loginResp.status);
    const token = (loginResp.data && (loginResp.data.data?.accessToken ?? loginResp.data.accessToken)) || loginResp.data.accessToken;
    console.log('[DEBUG] token present', !!token);

    // prepare a small png fixture
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=';
    const fixture = Buffer.from(pngBase64, 'base64');
    const tmpPath = path.join(__dirname, 'tmp-test-image.png');
    fs.writeFileSync(tmpPath, fixture);

    // upload media
    const form = new FormData();
    form.append('file', fs.createReadStream(tmpPath));
    const uploadResp = await axios.post(`${base}/media`, form, { headers: { ...form.getHeaders(), Authorization: `Bearer ${token}` }, maxBodyLength: 10_000_000 });
    console.log('[DEBUG] upload status', uploadResp.status);
    const media = uploadResp.data?.data ?? uploadResp.data;
    console.log('[DEBUG] media id', media?.id);

    // attempt to create blog with featuredImageId
    const uniqueSlug = `debug-${Date.now()}`;
    const blogPayload = { title: 'Debug Post for FeaturedImage', content: '# This is test content for debug\n\nLong enough content to pass min length', excerpt: 'debug excerpt', slug: uniqueSlug, featuredImageId: media?.id };

    const blogResp = await axios.post(`${base}/blog`, blogPayload, { headers: { Authorization: `Bearer ${token}` } });
    console.log('[DEBUG] BLOG CREATE STATUS', blogResp.status);
    console.log('[DEBUG] BLOG CREATE BODY', JSON.stringify(blogResp.data, null, 2));
  } catch (err: any) {
    if (err.response) {
      console.error('[DEBUG] RESPONSE STATUS', err.response.status);
      console.error('[DEBUG] RESPONSE BODY', JSON.stringify(err.response.data, null, 2));
    } else {
      console.error('[DEBUG] ERROR', err && err.stack ? err.stack : err);
    }
  } finally {
    try { await app.close(); } catch (e) {}
    try { fs.unlinkSync(path.join(__dirname, 'tmp-test-image.png')); } catch (e) {}
    process.exit(0);
  }
}

bootstrap();
