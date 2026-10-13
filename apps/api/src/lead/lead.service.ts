import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { RequestContextService } from '../common/request-context.service';

export interface CreateLeadInput {
  email: string;
  name: string;
  company?: string;
  phone?: string;
  industry?: string;
  companySize?: string;
  modulesInterested?: string;
  leadSource: string;
  status?: string;
  userId?: string;
}

export interface UpdateLeadInput {
  email?: string;
  name?: string;
  company?: string;
  phone?: string;
  industry?: string;
  companySize?: string;
  modulesInterested?: string;
  leadSource?: string;
  status?: string;
  userId?: string;
}

@Injectable()
export class LeadService {
  constructor(private prisma: PrismaService) {}

  private tenantId(): string {
    const tenantId = RequestContextService.get()?.tenantId;
    if (!tenantId) {
      throw new ForbiddenException('Tenant context is required');
    }
    return tenantId;
  }

  async create(input: CreateLeadInput) {
    return this.prisma.lead.create({
      data: {
        ...input,
        tenantId: this.tenantId(),
      },
    });
  }

  async findAll() {
    return this.prisma.lead.findMany({
      where: { tenantId: this.tenantId() },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, tenantId: this.tenantId() },
    });
    if (!lead) {
      throw new NotFoundException('Lead not found');
    }
    return lead;
  }

  async update(id: string, input: UpdateLeadInput) {
    await this.findById(id);
    return this.prisma.lead.updateMany({
      where: { id, tenantId: this.tenantId() },
      data: input,
    });
  }

  async remove(id: string) {
    await this.findById(id);
    return this.prisma.lead.deleteMany({
      where: { id, tenantId: this.tenantId() },
    });
  }
}
