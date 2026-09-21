import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import {
  NoticesController,
  PublicMetaController,
  SuperNoticesController,
} from './notices.controller';
import { NoticesService } from './notices.service';

@Module({
  imports: [DatabaseModule],
  controllers: [NoticesController, PublicMetaController, SuperNoticesController],
  providers: [NoticesService],
})
export class NoticesModule {}
