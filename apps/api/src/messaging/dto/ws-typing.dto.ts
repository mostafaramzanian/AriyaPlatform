import { Type } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';

/**
 * Phase 49F: `typing.start` / `typing.stop` payload.
 *
 * Kept separate from the message DTOs because typing is ephemeral — never
 * persisted, never audited, and carrying no body — so it must not share a shape
 * with anything that writes to the database.
 */
export class WsTypingDto {
  @IsUUID('4')
  conversationId!: string;

  /**
   * Optional: the event name already implies the state. Present so a client can be
   * explicit, and coerced to a real boolean so a string `"false"` cannot be read
   * as truthy.
   */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isTyping?: boolean;
}
