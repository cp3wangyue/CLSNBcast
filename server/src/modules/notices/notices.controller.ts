import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import type { NoticeTargetPage } from '../database/database.service';
import { DatabaseService } from '../database/database.service';
import { NoticesService } from './notices.service';
import { ReorderNoticesDto, WriteNoticeDto } from './notices.dto';

const NOTICE_PAGES = new Set<NoticeTargetPage>(['server_admin', 'share', 'view']);

@Controller('api/notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  list(@Query('page') page: string) {
    if (!NOTICE_PAGES.has(page as NoticeTargetPage)) {
      throw new BadRequestException('无效的通知页面');
    }
    return this.notices.listPublic(page as NoticeTargetPage);
  }
}

@Controller('api/meta')
export class PublicMetaController {
  constructor(private readonly db: DatabaseService) {}

  @Get('admin-migration')
  getAdminMigration() {
    return {
      legacyAdminSunsetAt: this.db.getGlobalConfig().legacyAdminSunsetAt,
      canonicalPlatform: 'kook',
    };
  }
}

@Controller('api/super/notices')
export class SuperNoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  list() {
    return this.notices.listAdmin();
  }

  @Post()
  create(@Body() dto: WriteNoticeDto) {
    return this.notices.create(dto);
  }

  @Put('order')
  reorder(@Body() dto: ReorderNoticesDto) {
    this.notices.reorder(dto.ids);
    return { ok: true };
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: WriteNoticeDto) {
    return this.notices.update(id, dto);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return { ok: this.notices.delete(id) };
  }

  @Post(':id/republish')
  republish(@Param('id') id: string) {
    return this.notices.republish(id);
  }
}
