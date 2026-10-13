import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase 33J: Core owns its own Prisma project/client, generated from
// prisma/core/schema.prisma into node_modules/.prisma/core-client, reading
// CORE_DATABASE_URL. This is intentionally NOT the same client as CMS's
// (see cms-prisma.service.ts), which owns a fully independent database.
import { PrismaClient } from '../generated/core-client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
