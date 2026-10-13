import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';

export interface CreateMeetingInput {
  leadId: string;
  scheduledAt: Date;
  duration: number;
  status?: string;
  meetingLink?: string;
}

export interface UpdateMeetingInput {
  scheduledAt?: Date;
  duration?: number;
  status?: string;
  meetingLink?: string;
}

@Injectable()
export class MeetingService {
  constructor(private prisma: PrismaService) {}

  private tenantId(): string {
    const tenantId = RequestContextService.get()?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return tenantId;
  }

  private leadBelongsToTenant(leadId: string) {
    return this.prisma.lead.findFirst({
      where: { id: leadId, tenantId: this.tenantId() },
      select: { id: true },
    });
  }

  async create(input: CreateMeetingInput) {
    const lead = await this.leadBelongsToTenant(input.leadId);
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    return this.prisma.meeting.create({
      data: input,
    });
  }

  async findAll() {
    return this.prisma.meeting.findMany({
      where: {
        lead: { tenantId: this.tenantId() },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const meeting = await this.prisma.meeting.findFirst({
      where: {
        id,
        lead: { tenantId: this.tenantId() },
      },
    });
    if (!meeting) {
      throw new NotFoundException('Meeting not found');
    }
    return meeting;
  }

  async update(id: string, input: UpdateMeetingInput) {
    await this.findById(id);
    return this.prisma.meeting.updateMany({
      where: {
        id,
        lead: { tenantId: this.tenantId() },
      },
      data: input,
    });
  }

  async remove(id: string) {
    await this.findById(id);
    return this.prisma.meeting.deleteMany({
      where: {
        id,
        lead: { tenantId: this.tenantId() },
      },
    });
  }
}
