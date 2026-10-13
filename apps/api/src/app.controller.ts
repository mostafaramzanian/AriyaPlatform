import { Controller, Get, Post, Body } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AppService } from './app.service';
import { NotificationPublisher } from './notifications/notification.publisher';
import { Public } from './auth/decorators/public.decorator';

@ApiTags('Health')
@Controller()
export class AppController {
  constructor(
    private readonly appService: AppService,
    private readonly notificationPublisher: NotificationPublisher,
  ) {}

  @Public()
  @Get('/health')
  @ApiOperation({ summary: 'Health check endpoint' })
  getHealth() {
    return this.appService.getHealth();
  }

  @Public()
  @Get()
  @ApiOperation({ summary: 'API root' })
  getRoot() {
    return {
      message: 'Aria ERP API',
      version: '1.0.0',
      docs: '/api/v1/docs',
    };
  }

  @Public()
  @Post('/test-notification')
  @ApiOperation({ summary: 'Test notification publisher (Phase A validation)' })
  async testNotification(@Body() data: Record<string, unknown> = {}) {
    const payload = {
      eventType: 'test.event',
      timestamp: new Date().toISOString(),
      data: data,
    };
    await this.notificationPublisher.publish('test.event', payload);
    return {
      status: 'published',
      event: 'test.event',
      payload,
    };
  }
}
