import { Test } from '@nestjs/testing';
import { Controller, Get, Post, Patch, Delete, Body, Param, ExecutionContext, CanActivate, INestApplication } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { Request } from 'express';
import request from 'supertest';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaModule } from '../src/database/prisma.module';
import { LeadModule } from '../src/lead/lead.module';
import { MeetingModule } from '../src/meeting/meeting.module';
import { LeadService, type CreateLeadInput, type UpdateLeadInput } from '../src/lead/lead.service';
import { MeetingService, type CreateMeetingInput, type UpdateMeetingInput } from '../src/meeting/meeting.service';
import { TenantContextInterceptor } from '../src/tenant/tenant-context.interceptor';
import { TenantModule } from '../src/tenant/tenant.module';

class TenantTestGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    const userId = req.headers['x-user-id'] as string;
    if (userId) {
      (req as unknown as { user: { userId: string } }).user = { userId };
    }
    return true;
  }
}

@Controller('test-leads')
class LeadTestController {
  constructor(private leadService: LeadService, private meetingService: MeetingService) {}

  @Post()
  create(@Body() body: CreateLeadInput) {
    return this.leadService.create(body);
  }

  @Get()
  findAll() {
    return this.leadService.findAll();
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.leadService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateLeadInput) {
    return this.leadService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.leadService.remove(id);
  }

  @Post(':leadId/meetings')
  createMeeting(@Param('leadId') leadId: string, @Body() body: Omit<CreateMeetingInput, 'leadId'>) {
    return this.meetingService.create({ leadId, ...body });
  }
}

@Controller('test-meetings')
class MeetingTestController {
  constructor(private meetingService: MeetingService) {}

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.meetingService.findById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: UpdateMeetingInput) {
    return this.meetingService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.meetingService.remove(id);
  }
}

describe('Lead/Meeting Tenant Isolation E2E', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  let tenantAId: string;
  let tenantBId: string;
  let userAId: string;
  let userBId: string;
  let leadAId: string;
  let meetingAId: string;

  const now = Date.now();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      // Phase 51-HR-ARCH-3A: the interceptor injects the `TenantResolver` PORT now, so the
      // module that binds it has to be in this trimmed graph. `TenantModule` binds
      // `CoreTenantResolver` — the same Core-database resolution this suite has always
      // described; the seam changed who owns the query, not what it answers.
      imports: [LeadModule, MeetingModule, PrismaModule, TenantModule],
      controllers: [LeadTestController, MeetingTestController],
      providers: [
        TenantContextInterceptor,
        { provide: APP_INTERCEPTOR, useClass: TenantContextInterceptor },
        { provide: APP_GUARD, useClass: TenantTestGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);

    const tenantA = await prisma.tenant.create({ data: { code: `lead-tenant-a-${now}` } });
    const tenantB = await prisma.tenant.create({ data: { code: `lead-tenant-b-${now}` } });
    tenantAId = tenantA.id;
    tenantBId = tenantB.id;

    const userA = await prisma.user.create({
      data: {
        email: `lead-user-a-${now}@test.local`,
        passwordHash: 'hash',
        tenantId: tenantAId,
      },
    });
    const userB = await prisma.user.create({
      data: {
        email: `lead-user-b-${now}@test.local`,
        passwordHash: 'hash',
        tenantId: tenantBId,
      },
    });
    userAId = userA.id;
    userBId = userB.id;
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.meeting.deleteMany({ where: { lead: { tenantId: { in: [tenantAId, tenantBId] } } } });
      await prisma.lead.deleteMany({ where: { tenantId: { in: [tenantAId, tenantBId] } } });
      await prisma.user.deleteMany({ where: { id: { in: [userAId, userBId] } } });
      await prisma.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    }
    if (app) await app.close();
  });

  it('Tenant A creates a lead', async () => {
    const res = await request(app.getHttpServer())
      .post('/test-leads')
      .set('x-user-id', userAId)
      .send({ email: 'a@lead.com', name: 'Lead A', leadSource: 'web' });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(tenantAId);
    leadAId = res.body.id;
  });

  it('Tenant A can read and list its own lead', async () => {
    const get = await request(app.getHttpServer())
      .get(`/test-leads/${leadAId}`)
      .set('x-user-id', userAId);

    expect(get.status).toBe(200);
    expect(get.body.id).toBe(leadAId);

    const list = await request(app.getHttpServer())
      .get('/test-leads')
      .set('x-user-id', userAId);

    expect(list.status).toBe(200);
    expect(list.body).toEqual(expect.arrayContaining([expect.objectContaining({ id: leadAId })]));
  });

  it('Tenant B cannot read Tenant A lead', async () => {
    const res = await request(app.getHttpServer())
      .get(`/test-leads/${leadAId}`)
      .set('x-user-id', userBId);

    expect(res.status).toBe(404);
  });

  it('Tenant B cannot list Tenant A lead', async () => {
    const res = await request(app.getHttpServer())
      .get('/test-leads')
      .set('x-user-id', userBId);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('Tenant B cannot update Tenant A lead', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/test-leads/${leadAId}`)
      .set('x-user-id', userBId)
      .send({ name: 'Hijacked' });

    expect(res.status).toBe(404);

    const verify = await request(app.getHttpServer())
      .get(`/test-leads/${leadAId}`)
      .set('x-user-id', userAId);

    expect(verify.body.name).not.toBe('Hijacked');
  });

  it('Tenant B cannot delete Tenant A lead', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/test-leads/${leadAId}`)
      .set('x-user-id', userBId);

    expect(res.status).toBe(404);

    const verify = await request(app.getHttpServer())
      .get(`/test-leads/${leadAId}`)
      .set('x-user-id', userAId);

    expect(verify.status).toBe(200);
  });

  it('Tenant A creates a meeting under its lead', async () => {
    const res = await request(app.getHttpServer())
      .post(`/test-leads/${leadAId}/meetings`)
      .set('x-user-id', userAId)
      .send({ scheduledAt: new Date().toISOString(), duration: 30 });

    expect(res.status).toBe(201);
    meetingAId = res.body.id;
  });

  it('Tenant B cannot read Tenant A meeting', async () => {
    const res = await request(app.getHttpServer())
      .get(`/test-meetings/${meetingAId}`)
      .set('x-user-id', userBId);

    expect(res.status).toBe(404);
  });

  it('Tenant B cannot update Tenant A meeting', async () => {
    const res = await request(app.getHttpServer())
      .patch(`/test-meetings/${meetingAId}`)
      .set('x-user-id', userBId)
      .send({ duration: 999 });

    expect(res.status).toBe(404);
  });

  it('Tenant B cannot delete Tenant A meeting', async () => {
    const res = await request(app.getHttpServer())
      .delete(`/test-meetings/${meetingAId}`)
      .set('x-user-id', userBId);

    expect(res.status).toBe(404);
  });

  it('Tenant B cannot create a meeting under Tenant A lead', async () => {
    const res = await request(app.getHttpServer())
      .post(`/test-leads/${leadAId}/meetings`)
      .set('x-user-id', userBId)
      .send({ scheduledAt: new Date().toISOString(), duration: 30 });

    expect(res.status).toBe(404);
  });
});
