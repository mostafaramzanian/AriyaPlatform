/**
 * AuthTokenEntity represents JWT token response structure
 * Returned from auth endpoints
 */
export class AuthTokenEntity {
  accessToken!: string;
  refreshToken?: string;
  expiresIn!: number; // seconds
  tokenType: string = 'Bearer';
  refreshTokenExpiresIn?: number; // seconds
}
