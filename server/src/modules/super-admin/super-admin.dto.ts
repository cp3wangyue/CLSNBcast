import { IsString, IsOptional, IsArray, IsNumber, IsObject, IsBoolean, Min, Max, IsIn, IsInt } from 'class-validator';
import type { QualityBitrateConfig } from '../session/session.types';
import type { QualityCodec, QualityOptimizationMode } from '../quality/quality-preset.types';

export class SuperAdminLoginDto {
  @IsString()
  password!: string;
}

export class UpdateGlobalConfigDto {
  @IsOptional()
  @IsString()
  kookBotToken?: string;

  @IsOptional()
  @IsString()
  kookVerifyToken?: string;

  @IsOptional()
  @IsString()
  kookEncryptKey?: string;

  @IsOptional()
  @IsString()
  discordPublicKey?: string;

  @IsOptional()
  @IsString()
  discordBotToken?: string;

  @IsOptional()
  @IsString()
  publicDomain?: string;

  @IsOptional()
  @IsObject()
  qualityBitrates?: QualityBitrateConfig;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  triggerWordLabels?: string[];
}

export class UpdateServerDto {
  // Agora 凭证已改由 Provider 管理（/api/super/providers），
  // 因此这里不再声明 agoraAppId / agoraAppCertificate / agoraTokenExpireSec：
  // ValidationPipe 的 whitelist 会把请求里的这三个字段剥离，服务器记录不再是凭证载体。

  @IsOptional()
  @IsArray()
  allowedQualities?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  enabledTriggerWords?: string[];

  @IsOptional()
  @IsNumber()
  @Min(10)
  idleTimeoutSec?: number;

  @IsOptional()
  @IsNumber()
  @Min(2)
  heartbeatIntervalSec?: number;

  @IsOptional()
  @IsNumber()
  @Min(30)
  noViewerTimeoutSec?: number;

  /** 是否允许共享者开启低延迟模式（1=允许，0=不允许） */
  @IsOptional()
  @IsNumber()
  @Min(0)
  allowLowLatency?: number;
}

/**
 * 新增画质预设。
 *
 * `id` 只能包含小写字母、数字和下划线：它会写入 `servers.allowed_qualities`
 * 并出现在历史会话里，字符集必须稳定。
 */
export class CreateQualityPresetDto {
  @IsString()
  id!: string;

  @IsString()
  label!: string;

  @IsInt()
  @Min(1)
  width!: number;

  @IsInt()
  @Min(1)
  height!: number;

  @IsInt()
  @Min(1)
  @Max(120)
  frameRate!: number;

  /** 留空表示不向 Agora 传递该项 */
  @IsOptional()
  @IsInt()
  @Min(1)
  bitrateMin?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  bitrateMax?: number | null;

  @IsOptional()
  @IsIn(['motion', 'detail'])
  optimizationMode?: QualityOptimizationMode;

  @IsOptional()
  @IsIn(['h264', 'vp8', 'vp9'])
  codec?: QualityCodec;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}

/**
 * 更新画质预设。
 *
 * 刻意**不含 `id`** —— 它被白名单与存量会话引用，写后不可改。
 * ValidationPipe 的 whitelist 会把请求里的 id 直接剥离。
 */
export class UpdateQualityPresetDto {
  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  width?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  height?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(120)
  frameRate?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  bitrateMin?: number | null;

  @IsOptional()
  @IsInt()
  @Min(1)
  bitrateMax?: number | null;

  @IsOptional()
  @IsIn(['motion', 'detail'])
  optimizationMode?: QualityOptimizationMode;

  @IsOptional()
  @IsIn(['h264', 'vp8', 'vp9'])
  codec?: QualityCodec;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
