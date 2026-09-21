import { useEffect, useState } from 'react';
import { Activity, AlertTriangle, BarChart3, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { UsageDashboardRow } from '../../types';

const OWNER_LABEL: Record<string, string> = {
  platform: '平台池',
  space: '服务器自带',
  user: '用户自带',
};

const HEALTH_LABEL: Record<string, string> = {
  healthy: '正常',
  degraded: '降级',
  unhealthy: '不可用',
  unknown: '未检查',
};

function num(value: number): string {
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 1 });
}

function formatTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * 超管用量看板。
 *
 * 数据来自 `provider_usage_monthly`（由定时任务从账本重算），
 * 事实来源是 `usage_intervals`。这里只做展示与手动触发重算。
 *
 * ⚠️ 不展示任何凭证 —— Provider 相关的秘密字段后端根本没有返回。
 */
export function UsageDashboardPanel() {
  const [rows, setRows] = useState<UsageDashboardRow[]>([]);
  const [period, setPeriod] = useState('');
  const [timezone, setTimezone] = useState('');
  const [loading, setLoading] = useState(true);
  const [rebuilding, setRebuilding] = useState(false);
  const [error, setError] = useState('');

  const reload = async () => {
    try {
      const data = await api.getSuperUsage();
      setRows(data.rows);
      setPeriod(data.period);
      setTimezone(data.timezone);
      setError('');
    } catch (e: any) {
      setError(e?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    reload();
  }, []);

  const rebuild = async () => {
    setRebuilding(true);
    try {
      await api.rebuildSuperUsage();
      await reload();
    } catch (e: any) {
      setError(e?.message || '重算失败');
    } finally {
      setRebuilding(false);
    }
  };

  if (loading) return <div className="text-muted text-sm">加载中...</div>;

  return (
    <div className="space-y-4">
      {error && (
        <div className="glass rounded-xl px-4 py-3 border border-red-400/30 text-sm text-red-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-muted">
          计费周期 <span className="text-white font-mono">{period || '—'}</span>
          {timezone && <span className="text-dim ml-2">（{timezone}）</span>}
        </div>
        <button
          onClick={rebuild}
          disabled={rebuilding}
          className="px-3 py-1.5 rounded-lg text-sm text-muted hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40 flex items-center gap-1.5"
        >
          {rebuilding ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          立即重算
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center">
          <BarChart3 className="w-8 h-8 text-dim mx-auto mb-3" />
          <p className="text-sm text-muted">还没有配置任何 Agora Provider</p>
        </div>
      ) : (
        <div className="glass rounded-2xl overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-muted border-b border-white/5">
                <th className="text-left font-medium px-4 py-3">Provider</th>
                <th className="text-right font-medium px-4 py-3">标准分钟</th>
                <th className="text-right font-medium px-4 py-3">主播分钟</th>
                <th className="text-right font-medium px-4 py-3">观众分钟</th>
                <th className="text-right font-medium px-4 py-3">会话数</th>
                <th className="text-left font-medium px-4 py-3">配额</th>
                <th className="text-left font-medium px-4 py-3">状态</th>
                <th className="text-right font-medium px-4 py-3">最后使用</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const ratio = row.quotaUsageRatio;
                const nearLimit = ratio !== null && ratio >= 0.8 && !row.quotaExceeded;
                return (
                  <tr
                    key={row.providerId}
                    className={cn('border-b border-white/5 last:border-0', !row.enabled && 'opacity-60')}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium">{row.name}</span>
                        <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-muted">
                          {OWNER_LABEL[row.ownerType] ?? row.ownerType}
                          {row.ownerId ? ` · ${row.ownerId}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{num(row.standardMinutes)}</td>
                    <td className="px-4 py-3 text-right font-mono text-muted">{num(row.publisherMinutes)}</td>
                    <td className="px-4 py-3 text-right font-mono text-muted">{num(row.viewerMinutes)}</td>
                    <td className="px-4 py-3 text-right font-mono text-muted">{row.sessionCount}</td>
                    <td className="px-4 py-3">
                      {row.quotaMinutes === null ? (
                        <span className="text-dim text-xs">不限</span>
                      ) : (
                        <div className="min-w-[120px]">
                          <div className="flex items-center justify-between text-xs mb-1">
                            <span className="font-mono">
                              {num(row.standardMinutes)} / {num(row.quotaMinutes)}
                            </span>
                            {ratio !== null && (
                              <span
                                className={cn(
                                  'font-mono',
                                  row.quotaExceeded ? 'text-red-300' : nearLimit ? 'text-yellow-300' : 'text-muted',
                                )}
                              >
                                {Math.round(ratio * 100)}%
                              </span>
                            )}
                          </div>
                          {ratio !== null && (
                            <div className="h-1.5 rounded-full bg-white/10 overflow-hidden">
                              <div
                                className={cn(
                                  'h-full rounded-full',
                                  row.quotaExceeded
                                    ? 'bg-red-500'
                                    : nearLimit
                                      ? 'bg-yellow-500'
                                      : 'bg-brand',
                                )}
                                style={{ width: `${Math.min(100, ratio * 100)}%` }}
                              />
                            </div>
                          )}
                          {!row.quotaEnforced && (
                            <span className="text-xs text-dim mt-1 block">未启用拦截</span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-col gap-1">
                        <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-muted w-fit">
                          <Activity className="w-3 h-3 inline mr-1" />
                          {HEALTH_LABEL[row.healthStatus] ?? row.healthStatus}
                        </span>
                        {!row.enabled && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-dim w-fit">
                            已停用
                          </span>
                        )}
                        {row.quotaExceeded && (
                          <span className="text-xs px-2 py-0.5 rounded-full bg-red-500/15 text-red-300 w-fit">
                            <AlertTriangle className="w-3 h-3 inline mr-1" />
                            已达配额
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right text-xs text-dim">
                      {formatTime(row.lastUsedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-dim">
        用量由定时任务从账本（<code>usage_intervals</code>）重算得到；达到配额后不再向该
        Provider 分配新会话，进行中的会话不受影响。改完 Provider 配置可点「立即重算」刷新。
      </p>
    </div>
  );
}
