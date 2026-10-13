import { Injectable, OnModuleInit, Logger, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { NotificationPublisher } from '../notifications/notification.publisher';

@Injectable()
export class AuditDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditDispatcherService.name);
  private handle: NodeJS.Timeout | null = null;
  private running = false;

  constructor(private readonly prisma: PrismaService, private readonly publisher: NotificationPublisher) {}

  onModuleInit() {
    // start polling loop
    this.running = true;
    this.handle = setInterval(() => void this.processQueue(), 30_000);
    void this.processQueue();
  }

  onModuleDestroy() {
    this.running = false;
    if (this.handle) clearInterval(this.handle);
  }

  async processQueue() {
    if (!this.running) return;
    try {
      const now = new Date();
      const items = await this.prisma.auditDispatch.findMany({ where: { nextAt: { lte: now } }, take: 50 });
      for (const item of items) {
        try {
          const audit = await this.prisma.auditLog.findUnique({ where: { id: item.auditId } });
          if (!audit) {
            await this.prisma.auditDispatch.delete({ where: { id: item.id } });
            continue;
          }
          const channel = `audit.${audit.resourceType}.${audit.action}`.toLowerCase();
          await this.publisher.publish(channel, { auditId: audit.id, resource: audit.resourceType, action: audit.action });
          await this.prisma.auditDispatch.delete({ where: { id: item.id } });
        } catch (err) {
          this.logger.warn({ err }, 'Failed to publish audit dispatch item, incrementing attempts');
          await this.prisma.auditDispatch.update({ where: { id: item.id }, data: { attempts: { increment: 1 }, nextAt: new Date(Date.now() + Math.min(300000, (item.attempts + 1) * 60000)) } });
        }
      }
    } catch (err) {
      this.logger.error({ err }, 'Error processing audit dispatch queue');
    }
  }
}
