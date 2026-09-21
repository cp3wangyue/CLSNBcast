import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { RtcTokenBuilder, RtcRole } from 'agora-token';
import { DatabaseService } from '../database/database.service';
import { AgoraRole, AgoraTokenResponse } from './agora.types';
import { QUALITY_PRESETS } from '../session/session.types';
import { AgoraProviderService } from './agora-provider.service';

/**
 * 签发 Token 所需的会话字段。
 *
 * 用结构化类型而不是直接依赖 `ServerSession` / `ShareSession`：
 * 两个模型（DB 行与内存模型）都满足它，调用方无需做类型转换。
 */
export interface TokenSessionRef {
  id: string;
  channel: string;
  /** 会话创建时固定绑定的 Provider；空串表示未绑定 */
  providerId: string;
  /** 创建时的 App ID 快照，用于检测 Provider 的 App ID 是否被中途改动 */
  agoraAppId: string;
}

@Injectable()
export class AgoraService {
  private readonly logger = new Logger(AgoraService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly providers: AgoraProviderService,
  ) {}

  generateChannelName(sessionShortId: string): string {
    return 'cb_' + sessionShortId;
  }

  /**
   * 用**会话绑定的 Provider** 签发 RTC Token。
   *
   * 🔒 核心不变量：同一 Session 的 publisher 与所有 subscriber 必须使用同一个
   * Provider / App ID / Channel。
   *
   * 因此这里从**会话快照**读取 Provider 与 App ID，而不是实时查服务器配置。
   * 旧实现每次签发都实时读 `servers.agora_app_certificate`，导致管理员在共享进行中
   * 修改 App ID 后，新加入的观众会拿到另一个声网项目的 token、加入同名 channel、
   * 永远看不到画面且没有任何错误提示。现在这种情况会明确报错。
   *
   * 返回结构保持 `{token, channel, uid, appId, expireSec}` 不变，前端无需改动。
   */
  generateToken(session: TokenSessionRef, uid: number, role: AgoraRole): AgoraTokenResponse {
    if (!session.providerId) {
      this.logger.warn(`generateToken: session ${session.id} has no bound provider`);
      throw this.fail('SESSION_PROVIDER_MISSING', '该共享未绑定声网 Provider，请重新发起共享');
    }

    // 明文证书只在这里被取出使用，且只用于本次签发
    const resolved = this.providers.getWithSecrets(session.providerId);
    if (!resolved || !resolved.provider.enabled) {
      this.logger.warn(
        `generateToken: provider ${session.providerId} missing or disabled for session ${session.id}`,
      );
      throw this.fail('PROVIDER_UNAVAILABLE', '该共享使用的声网 Provider 不可用，请重新发起共享');
    }

    const { provider, appCertificate } = resolved;

    // 不变量断言：Provider 的 App ID 必须与会话快照一致。
    // 不一致说明管理员在会话进行中改了 App ID —— 此时继续签发会把观众发到另一个
    // 声网项目，所以宁可明确失败并让用户重新发起共享。
    if (provider.appId !== session.agoraAppId) {
      this.logger.error(
        `App ID drift detected: session=${session.id} snapshot=${session.agoraAppId} ` +
          `provider=${provider.appId} (provider ${provider.id})`,
      );
      throw this.fail('PROVIDER_APPID_CHANGED', '该共享的声网配置已变更，请重新发起共享');
    }

    if (!appCertificate) {
      throw this.fail('PROVIDER_NO_CERTIFICATE', '该声网 Provider 未配置 App Certificate');
    }

    const rtcRole = role === 'publisher' ? RtcRole.PUBLISHER : RtcRole.SUBSCRIBER;
    const token = RtcTokenBuilder.buildTokenWithUid(
      provider.appId,
      appCertificate,
      session.channel,
      uid,
      rtcRole,
      provider.tokenExpireSec,
      provider.tokenExpireSec,
    );

    this.providers.markUsed(provider.id);

    return {
      token,
      channel: session.channel,
      uid,
      appId: provider.appId,
      expireSec: provider.tokenExpireSec,
    };
  }

  /** Get allowed qualities for a server */
  getAllowedQualities(serverId?: string): string[] {
    if (!serverId) return [];
    const server = this.db.getServer(serverId);
    if (!server || !server.bound || server.status !== 'active') return [];
    try {
      const parsed = JSON.parse(server.allowedQualities);
      if (!Array.isArray(parsed)) return [];
      const validKeys = new Set(QUALITY_PRESETS.map(quality => quality.key));
      return [...new Set(parsed.filter((key): key is string => typeof key === 'string' && validKeys.has(key)))];
    } catch {
      this.logger.warn(`Invalid allowed qualities for server ${serverId}`);
      return [];
    }
  }

  private fail(code: string, message: string): HttpException {
    return new HttpException({ message, code }, HttpStatus.BAD_REQUEST);
  }
}
