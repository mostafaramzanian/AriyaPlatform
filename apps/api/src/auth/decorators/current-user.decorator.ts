import { ExecutionContext, createParamDecorator } from '@nestjs/common';

/**
 * @CurrentUser() decorator extracts the authenticated user from JWT
 * Usage: getCurrentUser(@CurrentUser() user: any) => {
 *   console.log(user.id, user.email, user.role);
 * }
 */
export const CurrentUser = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
