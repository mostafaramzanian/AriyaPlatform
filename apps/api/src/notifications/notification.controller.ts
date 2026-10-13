import { Controller, Get, HttpCode, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { NotificationService } from './notification.service';
import { NotificationQueryDto } from './dto/notification-query.dto';

/**
 * Phase 49E: Notification Center HTTP surface.
 *
 * Every route is authenticated and implicitly scoped to the caller — the
 * recipient is always `req.user.sub`. There is deliberately:
 *
 *  - no `@Roles(...)` gate: notifications are personal, not an administered
 *    resource. An admin has no more access to another user's notifications than
 *    anyone else (Phase 49E §15), so a permission gate would be misleading.
 *  - no create/update/delete route: clients may never author notifications.
 *    `NotificationService.createForUser` is server-side only (§12).
 *  - no recipient or tenant parameter anywhere in the contract.
 *
 * Route ORDER matters in Nest: the literal `unread-count` and `read-all` paths
 * are declared before any parameterised path so they can never be shadowed —
 * the same trap documented on UsersController in 49D-1.
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  @Get()
  async list(@Request() req: ExRequest, @Query() query: NotificationQueryDto) {
    return this.notificationService.listNotifications(this.subject(req), query);
  }

  @Get('unread-count')
  async unreadCount(@Request() req: ExRequest) {
    return this.notificationService.getUnreadCount(this.subject(req));
  }

  /**
   * POST (not PATCH) to match the approved 49E contract. 200 rather than 201:
   * nothing is created, and the operation is idempotent.
   */
  @Post('read-all')
  @HttpCode(200)
  async markAllRead(@Request() req: ExRequest) {
    return this.notificationService.markAllRead(this.subject(req));
  }

  @Post(':id/read')
  @HttpCode(200)
  async markRead(@Request() req: ExRequest, @Param('id') id: string) {
    return this.notificationService.markRead(this.subject(req), id);
  }
}
