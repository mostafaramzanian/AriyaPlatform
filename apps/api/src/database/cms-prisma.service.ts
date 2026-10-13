import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
// Phase 33J: CMS owns its own Prisma project/client, generated from
// prisma/cms/schema.prisma into node_modules/.prisma/cms-client, reading
// CMS_DATABASE_URL. This is a fully independent database/connection from
// Core's (see prisma.service.ts) — CMS must never share Core's Prisma
// client or physically touch Core's database.
import { PrismaClient } from '../generated/cms-client';

@Injectable()
export class CmsPrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
