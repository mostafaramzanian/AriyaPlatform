import { Controller, Post, Body, Request, UseGuards, Get, Query, HttpCode, UseInterceptors, Param } from '@nestjs/common';
import { Request as ExRequest } from 'express';
import { AuthService } from './auth.service';
import type { JwtSessionUser, LoginRequest } from './auth.types';
import { LocalAuthGuard } from './guards/local-auth.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RegisterDto } from './dto/register.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { BlogResponseInterceptor } from '../modules/cms/blog/blog-response.interceptor';

@ApiTags('Auth')
@UseInterceptors(BlogResponseInterceptor)
@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({ summary: 'Register new user' })
  @ApiResponse({ status: 201, description: 'User registered successfully' })
  @ApiResponse({ status: 400, description: 'Invalid input' })
  @ApiResponse({ status: 409, description: 'Email already in use' })
  async register(@Body() createUserDto: RegisterDto) {
    return this.authService.register(createUserDto);
  }

  @Public()
  @UseGuards(LocalAuthGuard)
  @Post('login')
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, description: 'Login successful' })
  @ApiResponse({ status: 401, description: 'Invalid credentials' })
  @HttpCode(200)
  async login(@Request() req: LoginRequest) {
    const ipAddress = this.getClientIp(req);
    return this.authService.login(req.user, ipAddress);
  }

  @Public()
  @Post('refresh')
  @ApiOperation({ summary: 'Refresh access token' })
  @ApiResponse({ status: 200, description: 'Token refreshed' })
  @ApiResponse({ status: 401, description: 'Invalid refresh token' })
  @HttpCode(200)
  async refresh(@Body() body: RefreshTokenDto) {
    return this.authService.refreshTokens(body.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout')
  @ApiOperation({ summary: 'Logout current user' })
  @ApiResponse({ status: 200, description: 'Logout successful' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @HttpCode(200)
  async logout(@CurrentUser() user: JwtSessionUser) {
    return this.authService.logout(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('logout-all')
  @ApiOperation({ summary: 'Logout all active sessions for the current user' })
  @ApiResponse({ status: 200, description: 'All active sessions revoked' })
  @HttpCode(200)
  async logoutAll(@CurrentUser() user: JwtSessionUser) {
    return this.authService.logoutAll(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('sessions')
  @ApiOperation({ summary: 'List active sessions for the current user' })
  @ApiResponse({ status: 200, description: 'Session list' })
  async listSessions(@CurrentUser() user: JwtSessionUser) {
    return this.authService.listSessions(user.sub);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Post('sessions/:id/revoke')
  @ApiOperation({ summary: 'Revoke one session for the current user' })
  @ApiResponse({ status: 200, description: 'Session revoked' })
  @HttpCode(200)
  async revokeSession(@CurrentUser() user: JwtSessionUser, @Param('id') sessionId: string) {
    return this.authService.revokeSession(user.sub, sessionId);
  }

  @Public()
  @Post('forgot-password')
  @ApiOperation({ summary: 'Email a six-digit password-reset code' })
  @ApiResponse({
    status: 200,
    description:
      'Always 200: a code was emailed if the address exists, and the answer never says which',
  })
  @ApiResponse({ status: 429, description: 'Too many requests (per-IP rate limit)' })
  @HttpCode(200)
  async forgotPassword(@Body() body: ForgotPasswordDto) {
    return this.authService.requestPasswordReset(body.email);
  }

  @Public()
  @Post('reset-password')
  @ApiOperation({ summary: 'Set a new password with the emailed code' })
  @ApiResponse({ status: 200, description: 'Password reset successful' })
  @ApiResponse({ status: 400, description: 'Invalid or expired reset code' })
  @ApiResponse({ status: 429, description: 'Too many requests (per-IP rate limit)' })
  @HttpCode(200)
  async resetPassword(@Body() body: ResetPasswordDto) {
    return this.authService.resetPassword(body.email, body.code, body.newPassword);
  }

  @Public()
  @Get('verify-email')
  @ApiOperation({ summary: 'Verify email address' })
  @ApiResponse({ status: 200, description: 'Email verified successfully' })
  @ApiResponse({ status: 400, description: 'Invalid or expired token' })
  async verifyEmail(@Query() query: VerifyEmailDto) {
    return this.authService.verifyEmail(query.token);
  }

  @Public()
  @Post('resend-verification')
  @ApiOperation({ summary: 'Resend verification email' })
  @ApiResponse({ status: 200, description: 'Verification email sent if account exists' })
  @HttpCode(200)
  async resendVerification(@Body() body: ResendVerificationDto) {
    return this.authService.resendVerificationEmail(body.email);
  }

  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth()
  @Get('me')
  @ApiOperation({ summary: 'Get current user profile' })
  @ApiResponse({ status: 200, description: 'Current user data' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  async getCurrentUser(@CurrentUser() user: JwtSessionUser) {
    return user;
  }

  private getClientIp(req: ExRequest): string {
    return (
      (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() ||
      (req.socket?.remoteAddress as string) ||
      'unknown'
    );
  }
}
