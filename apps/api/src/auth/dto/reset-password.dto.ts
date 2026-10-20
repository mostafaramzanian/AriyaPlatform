import { IsEmail, IsString, Matches, MinLength } from 'class-validator';

/**
 * The reset form: the address the code was sent to, the six-digit code, and the new password.
 *
 * WHY THE EMAIL IS PART OF THE BODY. The code is looked up under the ACCOUNT, so the endpoint
 * needs to know whose code is being submitted — and a six-digit value cannot identify a row on
 * its own (two accounts can receive the same digits, and a unique column would then reject the
 * second one). The address is the key; the code is the proof.
 *
 * `code` IS VALIDATED AS EXACTLY SIX DIGITS, not merely as a string: the shape is part of the
 * contract, so a client that sends a link token, a padded value or a Persian-digit string (the
 * web form normalizes digits BEFORE sending) is refused by the framework rather than by a
 * database miss. `newPassword` keeps the platform's existing minimum of eight characters —
 * the same bound `ResetPasswordDto` always had and `RegisterDto` enforces.
 */
export class ResetPasswordDto {
  @IsEmail()
  email!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'code must be exactly six digits' })
  code!: string;

  @IsString()
  @MinLength(8)
  newPassword!: string;
}
