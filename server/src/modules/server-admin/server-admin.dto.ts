import { IsString, IsOptional, IsArray, IsNumber, Min } from 'class-validator';

export class BindServerDto {
  @IsString()
  password!: string;

  @IsOptional()
  @IsString()
  token?: string;
}

export class ServerAdminLoginDto {
  @IsString()
  password!: string;
}

export class UpdateServerConfigDto {
  // Agora 凭证已改由 Provider 管理（.../providers），
  // 因此这里不再声明 agoraAppId / agoraAppCertificate / agoraTokenExpireSec。

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

  @IsOptional()
  @IsNumber()
  @Min(0)
  allowLowLatency?: number;
}
