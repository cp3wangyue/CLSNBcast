import { IsString, IsOptional, IsArray, IsNumber, IsObject, Min } from 'class-validator';
import type { QualityBitrateConfig } from '../session/session.types';

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
