import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { MeetingService } from './meeting.service';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';

describe('MeetingService', () => {
  let service: MeetingService;
  let prisma: PrismaService;

  const tenantA = 'tenant-a';

  const mockMeeting = (id = 'meeting-1') => ({
    id,
    leadId: 'lead-1',
    scheduledAt: new Date(),
    duration: 30,
    status: 'scheduled',
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        MeetingService,
        {
          provide: PrismaService,
          useValue: {
            lead: { findFirst: jest.fn() },
            meeting: {
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

    service = moduleRef.get<MeetingService>(MeetingService);
    prisma = moduleRef.get<PrismaService>(PrismaService);
  });

  describe('create', () => {
    it('creates a meeting only when the lead belongs to the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValue({ id: 'lead-1' });
      (prisma.meeting.create as jest.Mock).mockResolvedValue(mockMeeting());

      const result = await service.create({
        leadId: 'lead-1',
        scheduledAt: new Date(),
        duration: 30,
      });

      expect(prisma.lead.findFirst).toHaveBeenCalledWith({
        where: { id: 'lead-1', tenantId: tenantA },
        select: { id: true },
      });
      expect(prisma.meeting.create).toHaveBeenCalledWith({
        data: { leadId: 'lead-1', scheduledAt: expect.any(Date), duration: 30 },
      });
      expect(result.id).toBe('meeting-1');
    });

    it('throws NotFoundException when the lead belongs to another tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.lead.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create({ leadId: 'lead-2', scheduledAt: new Date(), duration: 30 }),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.meeting.create).not.toHaveBeenCalled();
    });
  });

  describe('findAll', () => {
    it('returns only meetings whose leads belong to the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.meeting.findMany as jest.Mock).mockResolvedValue([mockMeeting()]);

      const result = await service.findAll();

      expect(prisma.meeting.findMany).toHaveBeenCalledWith({
        where: { lead: { tenantId: tenantA } },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toHaveLength(1);
    });
  });

  describe('findById', () => {
    it('returns meeting when its lead belongs to current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.meeting.findFirst as jest.Mock).mockResolvedValue(mockMeeting());

      const result = await service.findById('meeting-1');

      expect(prisma.meeting.findFirst).toHaveBeenCalledWith({
        where: { id: 'meeting-1', lead: { tenantId: tenantA } },
      });
      expect(result.id).toBe('meeting-1');
    });

    it('throws NotFoundException when meeting lead belongs to another tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.meeting.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findById('meeting-2')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('only updates meetings whose leads belong to the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.meeting.findFirst as jest.Mock).mockResolvedValue(mockMeeting());
      (prisma.meeting.updateMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.update('meeting-1', { duration: 60 });

      expect(prisma.meeting.updateMany).toHaveBeenCalledWith({
        where: { id: 'meeting-1', lead: { tenantId: tenantA } },
        data: { duration: 60 },
      });
    });
  });

  describe('remove', () => {
    it('only deletes meetings whose leads belong to the current tenant', async () => {
      RequestContextService.set({ requestId: 'r1', correlationId: 'c1', startTime: Date.now(), tenantId: tenantA });
      (prisma.meeting.findFirst as jest.Mock).mockResolvedValue(mockMeeting());
      (prisma.meeting.deleteMany as jest.Mock).mockResolvedValue({ count: 1 });

      await service.remove('meeting-1');

      expect(prisma.meeting.deleteMany).toHaveBeenCalledWith({
        where: { id: 'meeting-1', lead: { tenantId: tenantA } },
      });
    });
  });
});
