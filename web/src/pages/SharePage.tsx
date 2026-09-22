import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AlertTriangle, Loader2, Link2, CheckCircle2, Monitor, Zap, ZapOff, Clock, TriangleAlert } from 'lucide-react';
import { api } from '../lib/api';
import { useSessionSSE } from '../hooks/useSessionSSE';
import { useScreenShare } from '../hooks/useScreenShare';
import { copyToClipboard, cn } from '../lib/utils';
import type {
  SessionInfo,
  QualityPresetOption,
  QualitySnapshot,
  CustomQualityInput,
  QualityIssue,
  QualityOptimizationMode,
  QualityCodec,
  QualityLimits,
} from '../types';
import { validateCustomQuality } from '../lib/qualityValidation';
import { NoticeBanners } from '../components/notices/NoticeCenter';

// ===== Cookie 工具 =====
const CID_KEY = 'clsnbcast_cid';
const ACTIVE_KEY = 'clsnbcast_active';

/** 把表单里的字符串草稿解析成数值入参；空串表示「不传该项」。 */
function parseCustomDraft(draft: {
  width: string; height: string; frameRate: string;
  bitrateMin: string; bitrateMax: string;
  optimizationMode: QualityOptimizationMode; codec: QualityCodec;
}): CustomQualityInput {
  const toInt = (value: string) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : Number.NaN;
  };
  return {
    width: toInt(draft.width),
    height: toInt(draft.height),
    frameRate: toInt(draft.frameRate),
    bitrateMin: draft.bitrateMin.trim() === '' ? null : toInt(draft.bitrateMin),
    bitrateMax: draft.bitrateMax.trim() === '' ? null : toInt(draft.bitrateMax),
    optimizationMode: draft.optimizationMode,
    codec: draft.codec,
  };
}

function CustomQualityForm({
  draft, onChange, disabled, rejections, warnings,
}: {
  draft: {
    width: string; height: string; frameRate: string;
    bitrateMin: string; bitrateMax: string;
    optimizationMode: QualityOptimizationMode; codec: QualityCodec;
  };
  onChange: (next: {
    width: string; height: string; frameRate: string;
    bitrateMin: string; bitrateMax: string;
    optimizationMode: QualityOptimizationMode; codec: QualityCodec;
  }) => void;
  disabled: boolean;
  rejections: QualityIssue[];
  warnings: QualityIssue[];
}) {
  const set = (key: keyof typeof draft) => (value: string) => onChange({ ...draft, [key]: value });
  const invalidFields = new Set(rejections.map((issue) => issue.field));

  const field = (key: 'width' | 'height' | 'frameRate' | 'bitrateMin' | 'bitrateMax', label: string, placeholder?: string) => (
    <label className="block">
      <span className="text-xs text-muted mb-1 block">{label}</span>
      <input
        type="number"
        value={draft[key]}
        onChange={(e) => set(key)(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className={cn(
          'w-full bg-white/5 border rounded-lg px-3 py-2 text-sm disabled:opacity-50',
          invalidFields.has(key) ? 'border-red-400/60' : 'border-white/10',
        )}
      />
    </label>
  );

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {field('width', '宽度')}
        {field('height', '高度')}
        {field('frameRate', '帧率')}
        {field('bitrateMin', '最低码率 Kbps（留空=不传）')}
        {field('bitrateMax', '最高码率 Kbps（留空=不传）')}
        <label className="block">
          <span className="text-xs text-muted mb-1 block">优化模式</span>
          <select
            value={draft.optimizationMode}
            onChange={(e) => set('optimizationMode')(e.target.value)}
            disabled={disabled}
            className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
          >
            <option value="motion">motion（流畅优先）</option>
            <option value="detail">detail（画质优先）</option>
          </select>
        </label>
      </div>

      <label className="block">
        <span className="text-xs text-muted mb-1 block">编码格式</span>
        <select
          value={draft.codec}
          onChange={(e) => set('codec')(e.target.value)}
          disabled={disabled}
          className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
        >
          <option value="h264">H.264</option>
          <option value="vp8">VP8</option>
          <option value="vp9">VP9（Beta）</option>
        </select>
      </label>

      {/* 结构性错误：必须修正 */}
      {rejections.length > 0 && (
        <ul className="text-xs text-red-300 space-y-0.5">
          {rejections.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>· {issue.message}</li>
          ))}
        </ul>
      )}

      {/* 风险提示：只提示，不修改用户输入 */}
      {warnings.length > 0 && (
        <ul className="text-xs text-yellow-300 space-y-0.5">
          {warnings.map((issue, index) => (
            <li key={`${issue.code}-${index}`}>· {issue.message}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function getCookie(name: string): string | null {
  const m = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return m ? m[2] : null;
}
function setCookie(name: string, value: string, days: number): void {
  const d = new Date();
  d.setTime(d.getTime() + days * 86400000);
  document.cookie = name + '=' + value + ';path=/;expires=' + d.toUTCString();
}
function getClientId(): string {
  let id = getCookie(CID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    setCookie(CID_KEY, id, 365);
  }
  return id;
}
function getActiveShare(): string | null {
  return getCookie(ACTIVE_KEY);
}
function setActiveShare(token: string): void {
  setCookie(ACTIVE_KEY, token, 1);
}
function clearActiveShare(): void {
  setCookie(ACTIVE_KEY, '', 0);
}

export default function SharePage() {
  const [params] = useSearchParams();
  const token = params.get('t') || '';
  const clientId = useRef(getClientId()).current;
  const [info, setInfo] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [lowLatency, setLowLatency] = useState(false);
  const [liveSwitching, setLiveSwitching] = useState(false);
  const [liveError, setLiveError] = useState('');
  /** 运行中可调项（optimizationMode / codec 不支持运行中切换） */
  const [liveDraft, setLiveDraft] = useState({
    width: '1920',
    height: '1080',
    frameRate: '30',
    bitrateMin: '',
    bitrateMax: '',
  });
  const [copied, setCopied] = useState(false);
  const [allowedQualities, setAllowedQualities] = useState<string[]>([]);
  /** 服务端下发的画质预设（替代原先前端硬编码的 QUALITY_OPTIONS） */
  const [presets, setPresets] = useState<QualityPresetOption[]>([]);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);
  const [useCustom, setUseCustom] = useState(false);
  const [customDraft, setCustomDraft] = useState({
    width: '1920',
    height: '1080',
    frameRate: '30',
    bitrateMin: '',
    bitrateMax: '',
    optimizationMode: 'motion' as QualityOptimizationMode,
    codec: 'h264' as QualityCodec,
  });
  /** 前端即时校验出的提示（含 reject / warn） */
  const [shareError, setShareError] = useState('');
  /** 服务端回传的风险提示：只展示，不修改用户输入 */
  const [qualityWarnings, setQualityWarnings] = useState<QualityIssue[]>([]);
  /** 开始共享后服务端确认的生效快照 */
  const [activeSnapshot, setActiveSnapshot] = useState<QualitySnapshot | null>(null);
  const [idleCountdown, setIdleCountdown] = useState<number | null>(null);
  const [noViewerCountdown, setNoViewerCountdown] = useState<number | null>(null);
  const idleDeadlineRef = useRef<number | null>(null);
  const noViewerDeadlineRef = useRef<number | null>(null);

  const socket = useSessionSSE(token, 'publisher');
  const screenShare = useScreenShare(token, () => {
    socket.stopSharing();
  });
  const stopRef = useRef(screenShare.stop);
  stopRef.current = screenShare.stop;

  useEffect(() => {
    if (!token) { setLoadError('缺少分享令牌'); setLoading(false); return; }
    api.getShareInfo(token)
      .then((data) => {
        setInfo(data);
        // 画质预设改由服务端下发，并与服务器的白名单取交集
        const allowed = (data.qualityPresets ?? []).filter((preset) =>
          (data.allowedQualities ?? []).includes(preset.id),
        );
        setPresets(allowed);
        setAllowedQualities(allowed.map((preset) => preset.id));
        setSelectedPresetId(allowed.length > 0 ? allowed[0].id : null);
        // 恢复已持久化的低延迟模式
        if (data.lowLatency) setLowLatency(true);
        setLoading(false);

        // 清理 stale active cookie：服务器重新部署后旧 session 已失效，
        // 但浏览器 Cookie 仍保存旧 token，会导致误报"请先停止其他共享"
        const staleActive = getActiveShare();
        if (staleActive && staleActive !== token) {
          api.getShareInfo(staleActive)
            .then((staleInfo) => {
              if (staleInfo.status === 'ended') clearActiveShare();
            })
            .catch(() => { clearActiveShare(); });
        }
      })
      .catch((e) => { setLoadError(e.message || '加载失败'); setLoading(false); });
	  }, [token]);

	  // 未共享屏幕倒计时：基于绝对时间戳，避免后台/节能模式下 setTimeout 节流导致与服务器不同步
  useEffect(() => {
    if (socket.idleRemainingSec != null && socket.idleRemainingSec > 0) {
      idleDeadlineRef.current = Date.now() + socket.idleRemainingSec * 1000;
    } else {
      idleDeadlineRef.current = null;
    }
  }, [socket.idleRemainingSec]);

  useEffect(() => {
    if (idleDeadlineRef.current == null) {
      setIdleCountdown(null);
      return;
    }
    const tick = () => {
      const remain = Math.max(0, Math.ceil((idleDeadlineRef.current! - Date.now()) / 1000));
      setIdleCountdown(remain);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [socket.idleRemainingSec]);

  // 无人观看自动结束倒计时（同样基于绝对时间戳）
  useEffect(() => {
    if (socket.noViewerRemainingSec != null && socket.noViewerRemainingSec > 0) {
      noViewerDeadlineRef.current = Date.now() + socket.noViewerRemainingSec * 1000;
    } else {
      noViewerDeadlineRef.current = null;
    }
  }, [socket.noViewerRemainingSec]);

  useEffect(() => {
    if (noViewerDeadlineRef.current == null) {
      setNoViewerCountdown(null);
      return;
    }
    const tick = () => {
      const remain = Math.max(0, Math.ceil((noViewerDeadlineRef.current! - Date.now()) / 1000));
      setNoViewerCountdown(remain);
    };
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [socket.noViewerRemainingSec]);

  // 派生值：必须在 handleStart 之前声明，否则闭包里会用到未初始化的块级变量
  const selectedPreset = useMemo(
    () => presets.find((preset) => preset.id === selectedPresetId) ?? null,
    [presets, selectedPresetId],
  );

  // 本机即时校验：与服务端同一套规则，只为即时反馈，服务端仍会再校验一次
  const customIssues = useMemo(
    () => (useCustom ? validateCustomQuality(parseCustomDraft(customDraft), info?.qualityLimits) : []),
    [useCustom, customDraft, info?.qualityLimits],
  );
  const customRejections = customIssues.filter((issue) => issue.severity === 'reject');
  const customWarnings = customIssues.filter((issue) => issue.severity === 'warn');
  const canStart = useCustom ? customRejections.length === 0 : !!selectedPreset;

  const handleStart = useCallback(async () => {
    setShareError('');
    setQualityWarnings([]);

    const active = getActiveShare();
    if (active && active !== token) {
      setShareError('您正在另一个会话中共享，请先停止那个共享再开始新的。');
      return;
    }

    // 自定义模式：直接用用户填的参数，不要求出现在预设白名单里
    if (useCustom) {
    const issues = validateCustomQuality(parseCustomDraft(customDraft), info?.qualityLimits);
    const rejecting = issues.filter((issue) => issue.severity === 'reject');
      if (rejecting.length > 0) {
        setShareError(rejecting.map((issue) => issue.message).join('；'));
        return;
      }
    } else if (!selectedPreset) {
      setShareError('该服务器暂未开放任何共享画质，请联系服务器管理员。');
      return;
    }

    const custom = useCustom ? parseCustomDraft(customDraft) : undefined;
    const encoderConfig = custom
      ? custom
      : selectedPreset
        ? {
            width: selectedPreset.width,
            height: selectedPreset.height,
            frameRate: selectedPreset.frameRate,
            bitrateMin: selectedPreset.bitrateMin,
            bitrateMax: selectedPreset.bitrateMax,
            optimizationMode: selectedPreset.optimizationMode,
            codec: selectedPreset.codec,
          }
        : null;
    if (!encoderConfig) {
      setShareError('该服务器暂未开放任何共享画质，请联系服务器管理员。');
      return;
    }

    const result = await screenShare.publish({ encoderConfig, lowLatency });
    if (!result.success) return;

    const resp = await socket.startSharing(
      useCustom ? undefined : selectedPreset?.id,
      clientId,
      lowLatency,
      custom,
    );
    if (resp.ok) {
      setActiveShare(token);
      // 服务端回传的风险提示：只展示，不修改用户输入
      setQualityWarnings(resp.warnings ?? []);
      if (resp.quality) setActiveSnapshot(resp.quality);
    } else {
      screenShare.stop();
      setShareError(resp.message || '无法开始共享，可能已有其他人正在共享或链接已失效。');
    }
  }, [
    screenShare, socket, useCustom, customDraft, selectedPreset, token, clientId, lowLatency, info,
  ]);

  const handleStop = useCallback(async () => {
    await screenShare.stop();
    socket.stopSharing();
    clearActiveShare();
  }, [screenShare, socket]);

  /**
   * 共享进行中动态切换编码参数。
   *
   * 先由服务端校验并切分账本区间，再调用 SDK 的 `setEncoderConfiguration` ——
   * 顺序不能反：服务端先落地档位，账目才不会把切换前的时间算到新档位上。
   */
  const handleLiveSwitch = useCallback(async () => {
    setLiveError('');
    setLiveSwitching(true);
    try {
      const payload = {
        width: Number(liveDraft.width),
        height: Number(liveDraft.height),
        frameRate: Number(liveDraft.frameRate),
        bitrateMin: liveDraft.bitrateMin.trim() === '' ? null : Number(liveDraft.bitrateMin),
        bitrateMax: liveDraft.bitrateMax.trim() === '' ? null : Number(liveDraft.bitrateMax),
      };
      const resp = await api.updateLiveQuality(token, payload);
      if (!resp.ok) {
        setLiveError(resp.message || '切换失败');
        return;
      }
      const result = await screenShare.setEncoderConfig({
        width: payload.width,
        height: payload.height,
        frameRate: payload.frameRate,
        ...(payload.bitrateMin != null ? { bitrateMin: payload.bitrateMin } : {}),
        ...(payload.bitrateMax != null ? { bitrateMax: payload.bitrateMax } : {}),
      });
      if (!result.success) {
        setLiveError(result.message || 'SDK 切换失败');
        return;
      }
      if (resp.quality) setActiveSnapshot(resp.quality);
    } catch (e: any) {
      setLiveError(e?.message || '切换失败');
    } finally {
      setLiveSwitching(false);
    }
  }, [token, liveDraft, screenShare]);

  useEffect(() => {
    const handler = () => { stopRef.current(); };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  useEffect(() => {
    if (socket.ended) {
      screenShare.stop();
      clearActiveShare();
    }
  }, [socket.ended, screenShare]);

  // 判断当前用户的共享权限（使用 socket 实时状态，而非初始 API 加载的静态数据）
  const isPublisher = !socket.publisherClientId || socket.publisherClientId === clientId;
  const lockedByOther = !!socket.publisherClientId && socket.publisherClientId !== clientId;
  const activeElsewhere = !!getActiveShare() && getActiveShare() !== token;

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-brand animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="glass rounded-xl px-6 py-5 max-w-sm text-center">
          <AlertTriangle className="w-10 h-10 text-yellow-400 mx-auto mb-3" />
          <h2 className="text-base font-semibold mb-1.5">无法进入共享</h2>
          <p className="text-muted text-xs">{loadError}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <header className="flex items-center justify-between mb-8 max-w-3xl mx-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-dark to-brand flex items-center justify-center text-xl">
            🖥
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">CLSNBcast</h1>
            <p className="text-xs text-muted">屏幕共享</p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('w-2.5 h-2.5 rounded-full', socket.connected ? 'bg-green-400' : 'bg-yellow-400', 'animate-pulse')} />
          <span className="text-muted">{socket.connected ? '已连接' : '连接中'}</span>
        </div>
      </header>

      <div className="max-w-3xl mx-auto">
        <NoticeBanners />
      </div>

      <main className="max-w-3xl mx-auto space-y-5">
        {/* 分享者信息 + 观看链接 */}
        {info && (
          <div className="glass rounded-2xl p-4 flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-sm text-muted">分享者</p>
              <p className="font-semibold">{info.sharerUsername}</p>
            </div>
            <div className="flex items-center gap-2">
              <code className="text-xs text-dim bg-white/5 px-3 py-1.5 rounded-lg max-w-[240px] truncate">
                {info.viewLink}
              </code>
              <button
                onClick={() => { copyToClipboard(info.viewLink); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                className="btn-brand px-3 py-1.5 rounded-lg text-white text-sm flex items-center gap-1.5"
              >
                {copied ? <CheckCircle2 className="w-4 h-4" /> : <Link2 className="w-4 h-4" />}
                复制观看链接
              </button>
            </div>
          </div>
        )}

        {/* 本地预览画面（不走声网，节省流量） */}
        {screenShare.isSharing && (
          <div className="relative w-full aspect-video rounded-2xl bg-black shadow-2xl overflow-hidden">
            <div ref={screenShare.setLocalPreviewContainer} className="absolute inset-0 w-full h-full" />
          </div>
        )}

        {/* 画质选择 + 大按钮 */}
        <div className="glass-strong rounded-2xl p-6">
          {screenShare.isSharing && (
            <div className="flex items-center justify-center gap-2 mb-4 text-brand-light text-sm">
              <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
              正在共享 · {socket.viewerCount} 人观看
              <span className={cn(
                'text-xs px-2 py-0.5 rounded-full',
                lowLatency ? 'bg-blue-500/20 text-blue-300' : 'bg-green-500/20 text-green-300',
              )}>
                {lowLatency ? '低延迟 400-800ms' : '极速直播 1500-2000ms'}
              </span>
            </div>
          )}

          {/* 画质选择：预设（服务端下发）或自定义 */}
          <div className="mb-4">
            <div className="flex items-center justify-center gap-2 mb-2">
              <span className="text-xs text-muted">选择画质</span>
              <button
                onClick={() => setUseCustom(false)}
                disabled={screenShare.isSharing || socket.ended || lockedByOther}
                className={cn(
                  'text-xs px-2 py-0.5 rounded-full transition-colors',
                  !useCustom ? 'bg-brand/20 text-white' : 'text-muted hover:text-white',
                )}
              >
                预设
              </button>
              <button
                onClick={() => setUseCustom(true)}
                disabled={screenShare.isSharing || socket.ended || lockedByOther}
                className={cn(
                  'text-xs px-2 py-0.5 rounded-full transition-colors',
                  useCustom ? 'bg-brand/20 text-white' : 'text-muted hover:text-white',
                )}
              >
                自定义
              </button>
            </div>

            {!useCustom ? (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {presets.map((preset) => (
                  <button
                    key={preset.id}
                    disabled={screenShare.isSharing || socket.ended || lockedByOther}
                    onClick={() => setSelectedPresetId(preset.id)}
                    className={cn(
                      'flex flex-col items-center gap-1 px-3 py-2 rounded-lg border cursor-pointer transition-all text-sm',
                      preset.id === selectedPresetId
                        ? 'border-brand bg-brand/20 text-white shadow-lg shadow-brand/30 ring-2 ring-brand/50'
                        : 'border-white/8 bg-white/[0.03] text-muted hover:border-white/15',
                      (screenShare.isSharing || socket.ended || lockedByOther) && 'opacity-40 cursor-not-allowed',
                    )}
                  >
                    <span className="font-medium">{preset.label}</span>
                    <span className="text-dim text-xs">{preset.width}×{preset.height}</span>
                  </button>
                ))}
                {presets.length === 0 && (
                  <p className="col-span-full text-xs text-dim text-center py-2">
                    该服务器暂未开放任何共享画质，请联系服务器管理员。
                  </p>
                )}
              </div>
            ) : (
              <CustomQualityForm
                draft={customDraft}
                onChange={setCustomDraft}
                disabled={screenShare.isSharing || socket.ended || lockedByOther}
                rejections={customRejections}
                warnings={customWarnings}
              />
            )}
          </div>

          {/* 运行中动态切换（仅共享中显示；分辨率 / 帧率 / 码率可切） */}
          {screenShare.isSharing && (
            <div className="mb-4 glass rounded-xl p-4">
              <p className="text-xs text-muted mb-3">
                运行中调整编码参数（无需重新发起共享）
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-3">
                {(['width', 'height', 'frameRate'] as const).map((key) => (
                  <label key={key} className="block">
                    <span className="text-xs text-muted mb-1 block">
                      {key === 'width' ? '宽度' : key === 'height' ? '高度' : '帧率'}
                    </span>
                    <input
                      type="number"
                      value={liveDraft[key]}
                      onChange={(e) => setLiveDraft({ ...liveDraft, [key]: e.target.value })}
                      className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                    />
                  </label>
                ))}
                <label className="block">
                  <span className="text-xs text-muted mb-1 block">最低码率 Kbps</span>
                  <input
                    type="number"
                    value={liveDraft.bitrateMin}
                    onChange={(e) => setLiveDraft({ ...liveDraft, bitrateMin: e.target.value })}
                    placeholder="留空=不传"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted mb-1 block">最高码率 Kbps</span>
                  <input
                    type="number"
                    value={liveDraft.bitrateMax}
                    onChange={(e) => setLiveDraft({ ...liveDraft, bitrateMax: e.target.value })}
                    placeholder="留空=不传"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleLiveSwitch}
                  disabled={liveSwitching}
                  className="px-4 py-2 rounded-lg text-sm btn-brand text-white disabled:opacity-40 flex items-center gap-1.5"
                >
                  {liveSwitching && <Loader2 className="w-4 h-4 animate-spin" />}
                  应用
                </button>
                <span className="text-xs text-dim">
                  优化模式与编码格式在运行中不可切换（需重新建立连接）
                </span>
              </div>
              {liveError && <p className="text-xs text-red-300 mt-2">{liveError}</p>}
            </div>
          )}

          {/* 生效参数 + 服务端风险提示 */}
          {activeSnapshot && (
            <div className="mb-4 glass rounded-xl p-3 text-xs">
              <p className="text-muted mb-1">当前生效参数</p>
              <p className="font-mono">
                {activeSnapshot.width}×{activeSnapshot.height}@{activeSnapshot.frameRate}fps
                {' · '}{activeSnapshot.optimizationMode}
                {' · '}{activeSnapshot.codec}
              </p>
              <p className="text-dim mt-0.5">计费档位：{activeSnapshot.tier}</p>
            </div>
          )}

          {qualityWarnings.length > 0 && (
            <div className="mb-4 glass rounded-xl p-3 border border-yellow-400/40">
              <p className="text-xs font-medium text-yellow-300 flex items-center gap-1.5 mb-1">
                <TriangleAlert className="w-3.5 h-3.5" />
                风险提示（已按您的设置开始）
              </p>
              <ul className="text-xs text-muted space-y-0.5">
                {qualityWarnings.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>· {issue.message}</li>
                ))}
              </ul>
            </div>
          )}

          {allowedQualities.length === 0 && !useCustom && (
            <p className="text-sm text-yellow-300 text-center mb-4">
              该服务器暂未开放任何共享画质，请联系服务器管理员。
            </p>
          )}

          {/* ===== 大按钮区域 ===== */}
          {screenShare.isSharing ? (
            /* 正在共享 - 红色停止按钮 */
            <button
              onClick={handleStop}
              className="w-full py-5 rounded-2xl bg-red-500/90 hover:bg-red-500 text-white font-semibold text-lg flex items-center justify-center transition-colors"
            >
              停止共享
            </button>
          ) : socket.ended ? (
            /* 链接已失效 - 灰色大按钮 */
            <button
              disabled
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <AlertTriangle className="w-6 h-6" />
              链接已失效
            </button>
          ) : lockedByOther ? (
            /* 已有其他人正在共享 - 灰色按钮 */
            <button
              disabled
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Monitor className="w-6 h-6" />
              已有其他人正在共享
            </button>
          ) : socket.status === 'grace' && !isPublisher ? (
            /* GRACE 状态 - 非共享者 - 等待恢复 */
            <button
              disabled
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Clock className="w-6 h-6" />
              等待共享者恢复…
            </button>
          ) : socket.status === 'grace' && isPublisher ? (
            /* GRACE 状态 - 共享者 - 可恢复，显示倒计时 */
            <button
              onClick={handleStart}
              disabled={!canStart}
              className={cn(
                'w-full py-5 rounded-2xl text-white font-semibold text-lg flex items-center justify-center gap-3 transition-all',
                'bg-gradient-to-r from-brand-dark to-brand hover:scale-[1.01] disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              <Monitor className="w-6 h-6" />
              恢复共享
              {idleCountdown != null && idleCountdown > 0 && (
                <span className="text-sm opacity-80">（剩余 {idleCountdown}s）</span>
              )}
            </button>
          ) : activeElsewhere ? (
            /* 正在其他 session 共享 */
            <button
              disabled
              className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-dim font-semibold text-lg flex items-center justify-center gap-3 cursor-not-allowed"
            >
              <Monitor className="w-6 h-6" />
              请先停止其他共享
            </button>
          ) : (
            /* 正常可用 - 选择共享窗口 */
            <button
              onClick={handleStart}
              className={cn(
                'btn-brand w-full py-5 rounded-2xl text-white font-semibold text-lg',
                'flex items-center justify-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed',
                'transition-all hover:scale-[1.01]',
              )}
            >
              <Monitor className="w-6 h-6" />
              选择共享窗口
              {socket.status === 'pending' && idleCountdown != null && idleCountdown > 0 && (
                <span className="text-sm opacity-80">（剩余 {idleCountdown}s）</span>
              )}
            </button>
          )}

          {/* 按钮下方提示 */}
          {!screenShare.isSharing && !socket.ended && !lockedByOther && !activeElsewhere && (
            <p className="text-xs text-dim text-center mt-3">
              {socket.status === 'grace' && isPublisher
                ? '点击按钮恢复共享，超时未共享屏幕链接将失效'
                : socket.status === 'pending'
                  ? '点击后浏览器会弹窗选择要共享的屏幕或窗口，超时未开始共享链接将失效'
                  : '点击后浏览器会弹窗选择要共享的屏幕或窗口'}
            </p>
          )}
        </div>

        {/* 低延迟模式开关（仅服务器允许时显示） */}
        {info?.allowLowLatency && (
          <div className="flex gap-3">
            <button
              onClick={() => setLowLatency((v) => !v)}
              disabled={screenShare.isSharing || socket.ended || lockedByOther || (socket.status === 'grace' && isPublisher)}
              className={cn(
                'flex-1 flex items-center justify-center gap-2 py-3 rounded-xl border transition-all',
                lowLatency
                  ? 'border-blue-400 bg-blue-500/20 text-white shadow-lg shadow-blue-500/30 ring-2 ring-blue-400/50'
                  : 'border-white/8 bg-white/[0.03] text-muted hover:border-white/15',
                (screenShare.isSharing || socket.ended || lockedByOther || (socket.status === 'grace' && isPublisher)) && 'opacity-40 cursor-not-allowed',
              )}
            >
              {lowLatency ? <Zap className="w-4 h-4" /> : <ZapOff className="w-4 h-4" />}
              <span className="text-sm font-medium">低延迟模式</span>
              <span className={cn(
                'text-xs px-1.5 py-0.5 rounded-full',
                lowLatency ? 'bg-blue-500/20 text-blue-300' : 'bg-white/5 text-dim',
              )}>
                {lowLatency ? '开' : '关'}
              </span>
            </button>
          </div>
        )}

        {/* 低延迟模式说明 */}
        {info?.allowLowLatency && !screenShare.isSharing && (
          <p className="text-xs text-dim text-center">
            {lowLatency
              ? '⚡ 低延迟模式：延迟降低约 60-70%（400-800ms），费用上涨约 100%'
              : '当前为极速直播（延迟 1500-2000ms），费用较低'}
          </p>
        )}

        {/* 无人观看自动结束提示 */}
        {screenShare.isSharing && noViewerCountdown != null && noViewerCountdown > 0 && (
          <div className="glass rounded-xl p-4 border border-yellow-400/40 flex items-center gap-3">
            <AlertTriangle className="w-5 h-5 text-yellow-400 shrink-0" />
            <div>
              <p className="text-sm text-yellow-300 font-medium">当前无人观看</p>
              <p className="text-xs text-muted mt-0.5">
                {noViewerCountdown} 秒后将自动结束直播以节省费用，有人观看即取消
              </p>
            </div>
          </div>
        )}

        {/* 错误提示 */}
        {(screenShare.error || shareError) && (
          <div className="glass rounded-xl p-4 border border-red-400/30 flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-red-300 text-sm">共享出错</p>
              <p className="text-xs text-muted mt-1">{shareError || screenShare.error}</p>
            </div>
          </div>
        )}

        {/* ===== 链接已失效 - 大号醒目提示 ===== */}
        {socket.ended && (
          <div className="glass rounded-2xl p-8 border border-red-400/40 text-center">
            <AlertTriangle className="w-16 h-16 text-red-400 mx-auto mb-4" />
            <h2 className="text-2xl font-bold text-red-300 mb-2">共享链接已失效</h2>
            <p className="text-muted text-sm">本次共享已结束，链接无法继续使用。如需再次共享请重新发起。</p>
          </div>
        )}
      </main>
    </div>
  );
}
