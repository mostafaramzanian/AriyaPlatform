import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface CreateTenantInput {
  code: string;
  status?: string | null;
  region?: string | null;
}

@Injectable()
export class TenantService {
  constructor(private prisma: PrismaService) {}

  async create(input: CreateTenantInput) {
    const existing = await this.prisma.tenant.findUnique({ where: { code: input.code } });
    if (existing) {
      throw new ConflictException('Tenant code already exists');
    }

    return this.prisma.tenant.create({
      data: {
        code: input.code,
        status: input.status ?? null,
        region: input.region ?? null,
      },
    });
  }

  async findById(id: string) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) {
      throw new NotFoundException('Tenant not found');
    }
    return tenant;
  }

  async findByCode(code: string) {
    return this.prisma.tenant.findUnique({ where: { code } });
  }

  async assignUserToTenant(userId: string, tenantId: string) {
    return this.prisma.user.update({
      where: { id: userId },
      data: { tenantId },
    });
  }
}
