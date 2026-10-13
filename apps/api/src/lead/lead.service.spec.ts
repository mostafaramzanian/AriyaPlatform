import { Test } from '@nestjs/testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { LeadService } from './lead.service';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';

describe('LeadService', () => {
  let service: LeadService;
  let prisma: PrismaService;

  const tenantA = 'tenant-a';

  const mockLead = (tenantId: string, id = 'lead-1') => ({
    id,
    email: 'lead@example.com',
    name: 'Lead Name',
    leadSource: 'web',
    tenantId,
    status: 'new',
    userId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        LeadService,
        {
          provide: PrismaService,
          useValue: {
            lead: {
              create: jest.fn(),
              findMany: jest.fn(),
              findFirst: jest.fn(),
              updateMany: jest.fn(),
              deleteMany: jest.fn(),
            },
          },
        },
      ],
    }).compile();

    service = moduleRef.get<LeadService>(LeadService);
    prisma = moduleRef.get<PrismaService>(PrismaService);
  });

  describe('create', () => {
    it('creates a lead scoped to the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.create as jest.Mock).mockResolvedValue(mockLead(tenantA));

      const result = await service.create({
        email: 'lead@example.com',
        name: 'Lead Name',
        leadSource: 'web',
      });

      expect(result.tenantId).toBe(tenantA);
      expect(prisma.lead.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ tenantId: tenantA, email: 'lead@example.com' }),
      });
    });

    it('throws if no tenant context exists', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now() });
      await expect(service.create({ email: 'lead@example.com', name: 'x', leadSource: 'web' })).rejects.toThrow(ForbiddenException);
    });
  });

  describe('findAll', () => {
    it('returns only leads for the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.findMany as jest.Mock).mockResolvedValue([mockLead(tenantA)]);

      const result = await service.findAll();

      expect(prisma.lead.findMany).toHaveBeenCalledWith({
        where: { tenantId: tenantA },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findById', () => {
    it('returns lead when it belongs to current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValue(mockLead(tenantA));

      const result = await service.findById('lead-1');

      expect(prisma.lead.findFirst).toHaveBeenCalledWith({ where: { id: 'lead-1', tenantId: tenantA } });
      expect(result.id).toBe('lead-1');
    });

    it('throws NotFoundException when lead belongs to another tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findById('lead-2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('only updates leads in the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValue(mockLead(tenantA));
      (prisma.lead.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.update('lead-1', { name: 'Updated' });

      expect(prisma.lead.updateMany).toHaveBeenCalledWith({
        where: { id: 'lead-1', tenantId: tenantA },
        data: { name: 'Updated' },
      });
    });
  });

  describe('remove', () => {
    it('only deletes leads in the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValue(mockLead(tenantA));
      (prisma.lead.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.remove('lead-1');

      expect(prisma.lead.deleteMany).toHaveBeenCalledWith({
        where: { id: 'lead-1', tenantId: tenantA },
      });
    });
  });
});
