import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  NoticeContentFormat,
  NoticeKind,
  NoticeModalPolicy,
  NoticeTargetPage,
} from '../database/database.service';

export class WriteNoticeDto {
  @IsIn(['banner', 'modal'])
  kind!: NoticeKind;

  @IsOptional()
  @IsIn(['dismissible', 'acknowledgement_required'])
  modalPolicy?: NoticeModalPolicy | null;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @IsIn(['text', 'html'])
  contentFormat!: NoticeContentFormat;

  @IsString()
  @MaxLength(20_000)
  content!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  imageUrl?: string;

  @IsBoolean()
  enabled!: boolean;

  @IsInt()
  @Min(0)
  @Max(100_000)
  sortOrder!: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365 * 24 * 60 * 60)
  repeatAfterSec?: number | null;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  @IsIn(['server_admin', 'share', 'view'], { each: true })
  targets!: NoticeTargetPage[];
}

export class ReorderNoticesDto {
  @IsArray()
  @ArrayMaxSize(1_000)
  @IsString({ each: true })
  ids!: string[];
}
