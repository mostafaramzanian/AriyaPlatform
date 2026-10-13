import { IsEmail } from 'class-validator';

/**
 * DTO for resending verification email
 * POST /api/v1/auth/resend-verification
 */
export class ResendVerificationDto {
  @IsEmail()
  email!: string;
}
