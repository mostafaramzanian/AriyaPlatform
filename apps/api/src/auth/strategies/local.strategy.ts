import { Strategy } from 'passport-local';
import { PassportStrategy } from '@nestjs/passport';
import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { AuthService } from '../auth.service';
import { AuditService } from '../../common/audit.service';
import { RequestContextService } from '../../common/request-context.service';

@Injectable()
export class LocalStrategy extends PassportStrategy(Strategy) {
  constructor(
    private authService: AuthService,
    @Optional() private readonly auditService?: AuditService,
  ) {
    super({ usernameField: 'email' });
  }

  async validate(
    email: string,
    password: string,
  ): Promise<NonNullable<Awaited<ReturnType<AuthService['validateUser']>>>> {
    const user = await this.authService.validateUser(email, password);
    if (!user) {
      const ctx = RequestContextService.get();
      await this.auditService?.log({
        requestId: ctx?.requestId ?? 'auth-login',
        correlationId: ctx?.correlationId,
        userId: undefined,
        action: 'login_failed',
        resource: 'auth',
        resourceId: 'login',
        success: false,
        reason: 'invalid_credentials',
        durationMs: ctx ? Date.now() - ctx.startTime : undefined,
      });
      throw new UnauthorizedException('Invalid credentials');
    }
    return user;
  }
}
