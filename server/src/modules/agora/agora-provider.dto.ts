import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import type { AgoraProviderOwnerType } from '../database/database.service';

/**
 * 超管创建 Provider。
 *
 * `ownerType` 三态都由超管掌控，因此可以创建平台池（`platform`）Provider。
 */
export class CreateAgoraProviderDto {
  @IsIn(['platform', 'space', 'user'])
  ownerType!: AgoraProviderOwnerType;

  /** `space` / `user` 必填；`platform` 必须为空（由服务层校验） */
  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsString()
  name!: string;

  @IsString()
  appId!: string;

  /** 明文入参，服务端加密后落库，永不回传 */
  @IsString()
  appCertificate!: string;

  @IsOptional()
  @IsString()
  customerId?: string | null;

  /** 明文入参，服务端加密后落库，永不回传 */
  @IsOptional()
  @IsString()
  customerSecret?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(24 * 3600)
  tokenExpireSec?: number;

  /** 留空（null）表示不限量 */
  @IsOptional()
  @IsNumber()
  @Min(1)
  monthlyQuotaStandardMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  quotaEnforced?: boolean;

  /** 留空表示不限制可用画质 */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedPresetIds?: string[] | null;

  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * 超管更新 Provider。
 *
 * **刻意不包含 `ownerType` / `ownerId`** —— 归属是身份，不可迁移。
 * `ValidationPipe` 开了 `whitelist`，因此请求里带这两个字段会被直接剥离，
 * 数据层的 `ALLOWED_PROVIDER_COLS` 是第二道防线。
 */
export class UpdateAgoraProviderDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  appId?: string;

  /** 不传表示保持原证书；传值则轮换 */
  @IsOptional()
  @IsString()
  appCertificate?: string;

  @IsOptional()
  @IsString()
  customerId?: string | null;

  /** 不传表示保持原 secret；传值则轮换 */
  @IsOptional()
  @IsString()
  customerSecret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(24 * 3600)
  tokenExpireSec?: number;

  /** 传 null 表示改为不限量 */
  @IsOptional()
  @IsNumber()
  @Min(1)
  monthlyQuotaStandardMinutes?: number | null;

  @IsOptional()
  @IsBoolean()
  quotaEnforced?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  allowedPresetIds?: string[] | null;

  @IsOptional()
  @IsString()
  note?: string;
}

/**
 * 服务器管理员创建自己的 Provider（BYOK）。
 *
 * **刻意不包含 `ownerType` / `ownerId`**：服务端强制写成
 * `ownerType='space'` + `ownerId=该服务器 ID`。否则频道主可以伪造请求创建
 * 平台池 Provider，等于越权占用我们自己的声网账号。
 */
export class CreateSpaceProviderDto {
  @IsString()
  name!: string;

  @IsString()
  appId!: string;

  @IsString()
  appCertificate!: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(24 * 3600)
  tokenExpireSec?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

/** 服务器管理员更新自己的 Provider。归属同样不可改。 */
export class UpdateSpaceProviderDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  appId?: string;

  @IsOptional()
  @IsString()
  appCertificate?: string;

  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(24 * 3600)
  tokenExpireSec?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}
