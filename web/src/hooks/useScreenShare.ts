import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  IAgoraRTCClient,
  ILocalVideoTrack,
  ILocalAudioTrack,
} from 'agora-rtc-sdk-ng';
import { api } from '../lib/api';
import { installScreenAudioInterceptor } from '../lib/screenAudioCapture';
import type {
  VideoEncoderConfiguration,
  VideoSendStats,
} from '../types';

const AgoraRTC = (window as any).AgoraRTC;
AgoraRTC.setLogLevel(2);

// 安装 getDisplayMedia 劫持器（模块级，仅执行一次）
installScreenAudioInterceptor();

export interface PublishResult {
  success: boolean;
  message?: string;
}

export function useScreenShare(token: string, onTrackEnded?: () => void) {
  const clientRef = useRef<IAgoraRTCClient | null>(null);
  const screenVideoRef = useRef<ILocalVideoTrack | null>(null);
  const screenAudioRef = useRef<ILocalAudioTrack | null>(null);
  const onTrackEndedRef = useRef(onTrackEnded);
  onTrackEndedRef.current = onTrackEnded;
  const [isSharing, setIsSharing] = useState(false);
  const [error, setError] = useState<string>('');
  // 本地预览容器（分享者查看自己的画面，不走声网）
  const localPreviewRef = useRef<HTMLDivElement | null>(null);

  const setLocalPreviewContainer = useCallback((el: HTMLDivElement | null) => {
    localPreviewRef.current = el;
  }, []);

  // 本地预览：当 isSharing 变为 true 且容器已挂载后，播放本地屏幕轨道
  useEffect(() => {
    if (isSharing && localPreviewRef.current && screenVideoRef.current) {
      screenVideoRef.current.play(localPreviewRef.current, { fit: 'contain' });
    }
  }, [isSharing]);

  const publish = useCallback(
    async (opts: {
      /**
       * 编码参数。来自服务端下发的预设，或用户填写的自定义参数。
       *
       * 前端不再自带一份画质档位表 —— 那份副本必须与后端 `QUALITY_PRESETS`
       * 手工同步，是长期的双份真相来源。
       */
      encoderConfig: {
        width: number;
        height: number;
        frameRate: number;
        bitrateMin?: number | null;
        bitrateMax?: number | null;
        optimizationMode?: 'motion' | 'detail';
        codec?: 'h264' | 'vp8' | 'vp9';
        label?: string;
      };
      lowLatency: boolean;
    }) => {
      setError('');
      try {
        if (!(window as any).AgoraRTC) {
          throw new Error('Agora SDK 未加载，请检查网络连接');
        }

        // 1. 先获取 token（不连接服务器）
        const tokenResp = await api.getShareToken(token, 'publisher');

        const {
          width, height, frameRate, bitrateMin, bitrateMax,
          optimizationMode = 'motion', codec = 'h264',
        } = opts.encoderConfig;

        // 2. 先创建屏幕共享轨道（用户选择窗口）
        //    未声明的码率一律不传，由 SDK 与浏览器自行协商。
        const encoderConfig: VideoEncoderConfiguration = {
          width,
          height,
          frameRate,
          ...(bitrateMin != null ? { bitrateMin } : {}),
          ...(bitrateMax != null ? { bitrateMax } : {}),
        };

        // codec 是 client 级参数，必须在 createClient 时确定，运行中不可切换
        const client = opts.lowLatency
          ? AgoraRTC.createClient({ mode: 'rtc', codec })
          : AgoraRTC.createClient({ mode: 'live', codec });

        const screenTrack = await AgoraRTC.createScreenVideoTrack(
          {
            encoderConfig,
            // 两种模式均流畅优先：弱网时允许降低码率或分辨率以尽量保持帧率。
            optimizationMode,
          },
          // ScreenAudioTrackInitConfig：关 3A 保真多声道 + restrictOwnAudio 防回声
          {
            AEC: false,   // 关闭回声消除（媒体音频被当人声处理会失真）
            AGC: false,   // 关闭自动增益
            ANS: false,   // 关闭噪声抑制
            restrictOwnAudio: true,  // 过滤本浏览器标签页音频，防回声
          },
        );

        if (Array.isArray(screenTrack)) {
          screenVideoRef.current = screenTrack[0];
          screenAudioRef.current = screenTrack[1];
        } else {
          screenVideoRef.current = screenTrack as ILocalVideoTrack;
        }

        const tracks: (ILocalVideoTrack | ILocalAudioTrack)[] = [
          screenVideoRef.current,
        ];
        if (screenAudioRef.current) tracks.push(screenAudioRef.current);

        // 3. 用户已选择窗口，现在连接服务器。
        //    极速直播（默认）：mode:'live' + host 角色，观众端用 audience+level:1
        //    低延迟模式：mode:'rtc'，超低延时 400-800ms
        clientRef.current = client;

        // 极速直播共享者必须先切 host 才能 publish
        if (!opts.lowLatency) {
          await client.setClientRole('host');
        }

        await client.join(
          tokenResp.appId,
          tokenResp.channel,
          tokenResp.token || null,
          tokenResp.uid,
        );

        // 4. 发布轨道
        await client.publish(tracks);
        screenVideoRef.current?.on('track-ended', () => {
          // track 意外结束（用户通过浏览器原生 UI 停止、或高分辨率导致资源不足）
          // 通知父组件发送 sharing_stopped，让 session 进入 60 秒恢复宽限期
          stop();
          onTrackEndedRef.current?.();
        });
        setIsSharing(true);
        return { success: true };
      } catch (e: any) {
        // 失败时清理已创建的 Agora 资源，避免泄漏
        await stop();
        let msg = e?.message || String(e);
        // 尝试解析 JSON 格式的错误消息（如 401 share ended）
        try {
          const parsed = JSON.parse(msg);
          if (parsed.message) msg = parsed.message;
        } catch { /* 非 JSON 错误串，保持原文 */ }
        if (msg.includes('PERMISSION_DENIED') || msg.includes('NotAllowedError')) {
          if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
            msg = '屏幕采集需要 HTTPS 环境才能使用。请通过 https:// 域名访问本页面，当前是 ' + location.protocol + '//' + location.host;
          } else {
            msg = '浏览器拒绝了屏幕采集权限，请在弹窗中点击「允许」并选择要共享的窗口/屏幕';
          }
        } else if (msg.includes('share ended') || msg.includes('Unauthorized')) {
          msg = '共享链接已失效（可能因服务器重启或超时），请重新发起共享';
        } else if (msg.includes('NOT_SUPPORTED') || msg.includes('audio') || msg.includes('Audio')) {
          // enable 语义下用户不勾"共享音频"可能抛错
          msg = '请在共享弹窗中勾选「分享音频」，否则无法共享声音';
        }
        setError(msg);
        return { success: false, message: msg };
      }
    },
    [token],
  );

  const stop = useCallback(async () => {
    const client = clientRef.current;
    try {
      screenVideoRef.current?.stop();
      screenAudioRef.current?.stop();
      if (client) await client.leave();
    } catch (e) {
      console.error('leave error', e);
    }
    screenVideoRef.current = null;
    screenAudioRef.current = null;
    clientRef.current = null;
    setIsSharing(false);
  }, []);

  /**
   * 共享开始后动态切换编码参数（分辨率 / 帧率 / 码率），**不重建 Session**。
   *
   * ⚠️ `optimizationMode` 与 `codec` 不能用它切换：
   * - `optimizationMode` 不是 `VideoEncoderConfiguration` 的字段，只在创建 track 时生效；
   * - `codec` 是 client 级参数，改动必须 leave → 重建 client → join → publish，会中断观众画面。
   */
  const setEncoderConfig = useCallback(
    async (config: VideoEncoderConfiguration): Promise<{ success: boolean; message?: string }> => {
      const track = screenVideoRef.current;
      if (!track) {
        return { success: false, message: '当前没有进行中的共享' };
      }
      try {
        await track.setEncoderConfiguration(config);
        return { success: true };
      } catch (e: any) {
        const message = e?.message || String(e);
        setError(message);
        return { success: false, message };
      }
    },
    [],
  );

  /**
   * 采样实际发送统计（默认每秒一次）。
   *
   * 只取我们展示需要的字段，并且全部按「可能缺失」处理：
   * - `sendFrameRate` 在 Firefox 上不可得；
   * - `captureFrameRate` 在 Safari / Firefox 上不可得。
   * 缺字段时对应项为 null，而不是补 0 —— 补 0 会让"实际 0fps"和"拿不到"看起来一样。
   */
  const sampleStats = useCallback(async (): Promise<VideoSendStats | null> => {
    const track = screenVideoRef.current;
    const client = clientRef.current;
    if (!track || !client) return null;
    try {
      const stats = track.getStats() as any;
      return {
        codecType: stats?.codecType ?? null,
        sendFrameRate: stats?.sendFrameRate ?? null,
        captureFrameRate: stats?.captureFrameRate ?? null,
        sendResolutionWidth: stats?.sendResolutionWidth ?? null,
        sendResolutionHeight: stats?.sendResolutionHeight ?? null,
        sendBitrateKbps: stats?.sendBitrate ? Math.round(stats.sendBitrate / 1000) : null,
        sendBytes: stats?.sendBytes ?? null,
        sendRttMs: stats?.sendRttMs ?? null,
        sendJitterMs: stats?.sendJitterMs ?? null,
        sendPacketsLost: stats?.sendPacketsLost ?? null,
        uplinkNetworkQuality: client.getRemoteNetworkQuality
          ? (client as any).uplinkNetworkQuality ?? null
          : null,
        sampledAt: Date.now(),
      };
    } catch {
      // 采样失败不应影响共享本身
      return null;
    }
  }, []);

  return {
    isSharing,
    error,
    publish,
    stop,
    setLocalPreviewContainer,
    setEncoderConfig,
    sampleStats,
  };
}
