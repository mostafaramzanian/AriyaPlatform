import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ReminderService } from './reminder.service';
import {
  CalendarMonthQueryDto,
  CreateReminderDto,
  ReminderQueryDto,
  UpdateReminderDto,
} from './dto/reminder.dto';

/**
 * Phase 49I: Calendar / Reminders HTTP surface.
 *
 * Every route is authenticated and the actor is always `req.user.sub`. There is no
 * owner, recipient or tenant parameter anywhere in the contract, so no route can be
 * made to act on behalf of someone else.
 *
 * NO `@Roles(...)` GATE ANYWHERE, and that is a decision rather than an omission:
 * keeping one's own reminders is an ordinary authenticated-user capability, exactly
 * as reading one's own notifications (49E) or conversations (49F) is. Ownership is
 * the authorization edge and it is enforced server-side on every read and write.
 * Unlike 49H there is no administrative counterpart to gate — there is no
 * organization calendar in this phase — so no permission is introduced or seeded.
 *
 * Route ORDER matters in Nest: the literal `today`, `month` and `reminders` paths are
 * declared before the parameterised `reminders/:id` ones so they can never be
 * shadowed — the same trap documented on UsersController (49D-1) and
 * NotificationController (49E).
 *
 * The date contract is `YYYY/MM/DD` Jalali with Latin digits, validated by shape in
 * the DTO and by calendar semantics in the service. No route accepts a timestamp, an
 * offset or a timezone name: `Asia/Tehran` is applied server-side and the client
 * cannot influence it.
 */
@Controller('calendar')
@UseGuards(JwtAuthGuard)
export class CalendarController {
  constructor(private readonly reminders: ReminderService) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  /**
   * Server-authoritative today, for the sidebar date chip.
   *
   * Deliberately a server value: a browser-computed date would disagree with the
   * instant a reminder is stored against whenever the two disagree about the zone,
   * and the chip is the entry point to scheduling.
   */
  @Get('today')
  async today(@Request() req: ExRequest) {
    return this.reminders.getToday(this.subject(req));
  }

  /** One Jalali month: the grid, today, and a per-day reminder count. */
  @Get('month')
  async month(@Request() req: ExRequest, @Query() query: CalendarMonthQueryDto) {
    return this.reminders.getMonth(this.subject(req), query);
  }

  /**
   * Two bounded modes, chosen by the presence of `date`:
   *  - `?date=1405/08/18` → every reminder on that Jalali day.
   *  - no `date` → the upcoming list, `limit`-capped.
   *
   * There is no unbounded "all reminders" mode.
   */
  @Get('reminders')
  async listReminders(@Request() req: ExRequest, @Query() query: ReminderQueryDto) {
    const userId = this.subject(req);

    if (query.date !== undefined) {
      return this.reminders.listRemindersForDay(userId, query.date);
    }

    return this.reminders.listUpcomingReminders(userId, query);
  }

  @Post('reminders')
  @HttpCode(201)
  async createReminder(@Request() req: ExRequest, @Body() dto: CreateReminderDto) {
    return this.reminders.createReminder(this.subject(req), dto);
  }

  @Get('reminders/:id')
  async getReminder(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.reminders.getReminder(this.subject(req), id);
  }

  /**
   * Partial update, including enable/disable and rescheduling. A single route rather
   * than a separate `:id/status` one (unlike 49G's ticket lifecycle) because a
   * reminder has no state machine: `enabled` is a plain boolean with no transition
   * rules, no history row and no audit event.
   */
  @Patch('reminders/:id')
  async updateReminder(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateReminderDto,
  ) {
    return this.reminders.updateReminder(this.subject(req), id, dto);
  }

  @Delete('reminders/:id')
  async deleteReminder(
    @Request() req: ExRequest,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.reminders.deleteReminder(this.subject(req), id);
  }
}
