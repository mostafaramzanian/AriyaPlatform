import { createRequire } from 'node:module';
import { Controller, Post, UseInterceptors, UploadedFile, UseGuards, Req, Get, Param, Delete, Body } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
const multer: any = createRequire(__filename)('multer');
import { MediaService } from './media.service';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { Roles } from '../../../auth/decorators/roles.decorator';
import { Permissions } from '../../../auth/rbac/constants/permissions';

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @Roles(Permissions.BLOG_WRITE)
  @UseInterceptors(FileInterceptor('file', { storage: multer.memoryStorage(), limits: { fileSize: parseInt(process.env.MAX_MEDIA_UPLOAD_BYTES || '10485760', 10) } }))
  async upload(@UploadedFile() file: any, @Req() req: any, @Body() body: any) {
    const userId = req.user?.sub;
    const extras = {
      altText: body?.altText,
      caption: body?.caption,
      tags: Array.isArray(body?.tags) ? body.tags : body?.tags ? [body.tags] : undefined,
      metadata: body?.metadata ? JSON.parse(body.metadata) : undefined,
    };
    const created = await this.mediaService.uploadFile(file, userId, extras);
    return created;
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  @Roles(Permissions.BLOG_WRITE)
  async get(@Param('id') id: string) {
    return this.mediaService.getById(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  @Roles(Permissions.BLOG_WRITE)
  async remove(@Param('id') id: string) {
    return this.mediaService.softDelete(id);
  }
}
