import { SetMetadata } from '@nestjs/common';

/**
 * @Public() decorator marks routes as publicly accessible
 * Routes with this decorator bypass JWT authentication
 * Used on health checks, registration, login, password reset endpoints
 */
export const Public = () => SetMetadata('isPublic', true);
