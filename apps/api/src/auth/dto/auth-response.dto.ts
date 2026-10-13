/**
 * Standard auth response for all auth endpoints
 * Returned when authentication/token operations succeed
 */
export class AuthResponseDto {
  accessToken!: string;
  refreshToken?: string;
  expiresIn!: number;
  user!: {
    id: string;
    email: string;
    firstName: string;
    lastName: string;
    role: string;
    emailVerified: boolean;
  };
}
