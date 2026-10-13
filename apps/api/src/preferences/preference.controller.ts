import { Body, Controller, Get, Patch, Request, UseGuards } from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PreferenceService } from './preference.service';
import { UpdatePreferenceDto } from './dto/preference.dto';

/**
 * Phase 49K: personalization HTTP surface.
 *
 * TWO ROUTES, BOTH ON `me`. There is no `GET /users/:id/preferences` and no
 * `userId` anywhere in the contract — not in a path, not in a query, not in a body —
 * so no request can be shaped to read or write someone else's settings. The subject is
 * always `req.user.sub`, taken from the JWT the guard already verified, exactly as
 * `UsersController` does for `/users/me` (49D-1) and `CalendarController` for
 * reminders (49I).
 *
 * NO `@Roles(...)` GATE, and that is a decision. Choosing your own theme, density and
 * text scale is an ordinary authenticated-user capability — more so than reading your
 * own notifications, because two of these settings are ACCESSIBILITY settings and
 * gating them behind a permission would make the product unusable for whoever lacked
 * it. Ownership is the authorization edge.
 *
 * NO ADMIN COUNTERPART, deliberately: nothing here lets an administrator read or reset
 * another user's preferences. There is no operational need — a support case is answered
 * by telling the user which toggle to flip — and adding one would turn a personal
 * settings table into a surface for inspecting individuals.
 *
 * NO ROUTE ORDER TRAP: neither path is parameterised, so the shadowing hazard
 * documented on `UsersController` and `NotificationController` cannot arise here.
 */
@Controller('me/preferences')
@UseGuards(JwtAuthGuard)
export class PreferenceController {
  constructor(private readonly preferences: PreferenceService) {}

  private subject(req: ExRequest): string {
    return (req as unknown as { user?: { sub?: string } }).user?.sub as string;
  }

  /**
   * The caller's effective preferences, already filtered by live RBAC.
   *
   * READ-ONLY IN THE STRICT SENSE: a user who has never saved anything gets the
   * code-level defaults and NO ROW IS CREATED. Every authenticated page load hits this
   * route, so creating a row here would turn the first render into a write for every
   * user in the system and destroy the only signal that distinguishes "chose the
   * defaults" from "never chose".
   */
  @Get()
  async getMine(@Request() req: ExRequest) {
    return this.preferences.getMine(this.subject(req));
  }

  /**
   * Partial update. Every field is optional and an omitted one is left untouched, so
   * the client sends only what the user just changed.
   *
   * PATCH rather than PUT because there is no complete representation the client is
   * expected to send back: preferences are a bag of independent settings, and a PUT
   * would make a client that knows about four of them silently reset the fifth to its
   * default. One route rather than one per section (`/theme`, `/dashboard`, …) because
   * the write is a single-row upsert either way, and splitting it would multiply round
   * trips for a settings page that saves several fields at once.
   *
   * Returns the FULL, re-filtered object rather than the changed fields, so the client
   * never has to merge a partial response into its own state and cannot drift from
   * what the server actually stored.
   */
  @Patch()
  async updateMine(@Request() req: ExRequest, @Body() dto: UpdatePreferenceDto) {
    return this.preferences.updateMine(this.subject(req), dto);
  }
}
