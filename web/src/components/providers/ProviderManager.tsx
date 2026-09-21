import { useState } from 'react';
import { Activity, Check, KeyRound, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import { cn } from '../../lib/utils';
import type { AgoraProvider, AgoraProviderFormInput, AgoraProviderOwnerType } from '../../types';

/**
 * Agora Provider 管理面板。超管与频道主共用。
 *
 * 差异由 props 控制：
 * - `showOwner`：是否展示归属（超管需要，频道主只有自己服务器）
 * - `allowOwnerSelection`：是否允许选择归属（超管可以建平台池 / 指定服务器 / BYOK）
 * - `advanced`：是否展示优先级、Token 有效期、配额等高级项
 *
 * ⚠️ 证书与 Customer Secret **没有任何读回接口**。编辑时这两项永远显示为空，
 * 留空即表示「保持不变」，填了才轮换。因此不存在「把掩码写回去覆盖真值」的风险。
 */
interface Props {
  providers: AgoraProvider[];
  showOwner?: boolean;
  allowOwnerSelection?: boolean;
  advanced?: boolean;
  onCreate: (input: AgoraProviderFormInput) => Promise<{ ok: boolean; message?: string }>;
  onUpdate: (
    id: string,
    input: Partial<AgoraProviderFormInput>,
  ) => Promise<{ ok: boolean; message?: string }>;
  onDelete: (id: string) => Promise<{ ok: boolean; message?: string }>;
  onReload: () => Promise<void> | void;
}

interface FormState {
  ownerType: AgoraProviderOwnerType;
  ownerId: string;
  name: string;
  appId: string;
  appCertificate: string;
  customerId: string;
  customerSecret: string;
  enabled: boolean;
  priority: string;
  tokenExpireSec: string;
  quota: string;
  quotaEnforced: boolean;
  note: string;
}

const EMPTY_FORM: FormState = {
  ownerType: 'platform',
  ownerId: '',
  name: '',
  appId: '',
  appCertificate: '',
  customerId: '',
  customerSecret: '',
  enabled: true,
  priority: '100',
  tokenExpireSec: '3600',
  quota: '',
  quotaEnforced: false,
  note: '',
};

const OWNER_LABEL: Record<AgoraProviderOwnerType, string> = {
  platform: '平台池',
  space: '服务器自带',
  user: '用户自带',
};

const HEALTH_STYLE: Record<string, string> = {
  healthy: 'bg-green-500/15 text-green-300',
  degraded: 'bg-yellow-500/15 text-yellow-300',
  unhealthy: 'bg-red-500/15 text-red-300',
  unknown: 'bg-white/10 text-dim',
};

const HEALTH_LABEL: Record<string, string> = {
  healthy: '正常',
  degraded: '降级',
  unhealthy: '不可用',
  unknown: '未检查',
};

function formatTime(ts: number | null): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ProviderManager({
  providers,
  showOwner = false,
  allowOwnerSelection = false,
  advanced = false,
  onCreate,
  onUpdate,
  onDelete,
  onReload,
}: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => (current ? { ...current, [key]: value } : current));

  const startCreate = () => {
    setEditingId(null);
    setError('');
    setForm({ ...EMPTY_FORM });
  };

  const startEdit = (provider: AgoraProvider) => {
    setEditingId(provider.id);
    setError('');
    setForm({
      ownerType: provider.ownerType,
      ownerId: provider.ownerId,
      name: provider.name,
      appId: provider.appId,
      // 秘密永远留空：留空 = 保持不变
      appCertificate: '',
      customerId: provider.customerId ?? '',
      customerSecret: '',
      enabled: provider.enabled,
      priority: String(provider.priority),
      tokenExpireSec: String(provider.tokenExpireSec),
      quota:
        provider.monthlyQuotaStandardMinutes === null
          ? ''
          : String(provider.monthlyQuotaStandardMinutes),
      quotaEnforced: provider.quotaEnforced,
      note: provider.note,
    });
  };

  const cancel = () => {
    setForm(null);
    setEditingId(null);
    setError('');
  };

  const submit = async () => {
    if (!form) return;
    setError('');
    setBusy(true);
    try {
      const payload: AgoraProviderFormInput = {
        name: form.name.trim(),
        appId: form.appId.trim(),
      };
      if (allowOwnerSelection) {
        payload.ownerType = form.ownerType;
        payload.ownerId = form.ownerId.trim();
      }
      // 秘密只在填了内容时才提交，否则保持原值
      if (form.appCertificate.trim()) payload.appCertificate = form.appCertificate.trim();
      if (form.customerSecret.trim()) payload.customerSecret = form.customerSecret.trim();
      if (form.customerId.trim()) payload.customerId = form.customerId.trim();
      if (advanced) {
        payload.priority = Number(form.priority);
        payload.tokenExpireSec = Number(form.tokenExpireSec);
        payload.quotaEnforced = form.quotaEnforced;
        payload.monthlyQuotaStandardMinutes =
          form.quota.trim() === '' ? null : Number(form.quota);
        payload.note = form.note;
      }
      payload.enabled = form.enabled;

      const result = editingId ? await onUpdate(editingId, payload) : await onCreate(payload);
      if (!result.ok) {
        setError(result.message || '保存失败');
        return;
      }
      await onReload();
      cancel();
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (provider: AgoraProvider) => {
    if (!confirm(`确定删除 Provider「${provider.name}」？\n\n已被会话引用的 Provider 无法删除，此时请改为「停用」。`)) {
      return;
    }
    setError('');
    const result = await onDelete(provider.id);
    if (!result.ok) {
      setError(result.message || '删除失败');
      return;
    }
    await onReload();
  };

  const toggleEnabled = async (provider: AgoraProvider) => {
    await onUpdate(provider.id, { enabled: !provider.enabled });
    await onReload();
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="glass rounded-xl px-4 py-3 border border-red-400/30 text-sm text-red-300">
          {error}
        </div>
      )}

      {!form && (
        <button
          onClick={startCreate}
          className="btn-brand px-4 py-2 rounded-xl text-white text-sm flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          新建 Provider
        </button>
      )}

      {form && (
        <div className="glass-strong rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-white text-sm">
              {editingId ? '编辑 Provider' : '新建 Provider'}
            </h3>
            <button onClick={cancel} className="text-dim hover:text-white transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>

          {allowOwnerSelection && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="block">
                <span className="text-xs text-muted mb-1 block">归属类型</span>
                <select
                  value={form.ownerType}
                  onChange={(e) => set('ownerType', e.target.value as AgoraProviderOwnerType)}
                  disabled={!!editingId}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
                >
                  <option value="platform">平台池（全体共享）</option>
                  <option value="space">服务器自带（指定 serverId）</option>
                  <option value="user">用户自带（指定 KOOK userId）</option>
                </select>
              </label>
              {form.ownerType !== 'platform' && (
                <label className="block">
                  <span className="text-xs text-muted mb-1 block">
                    {form.ownerType === 'space' ? '服务器 ID' : 'KOOK 用户 ID'}
                  </span>
                  <input
                    value={form.ownerId}
                    onChange={(e) => set('ownerId', e.target.value)}
                    disabled={!!editingId}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm disabled:opacity-50"
                  />
                </label>
              )}
            </div>
          )}

          {editingId && (
            <p className="text-xs text-dim">
              归属不可修改。如需更换归属，请新建一个 Provider 并停用旧的。
            </p>
          )}

          <label className="block">
            <span className="text-xs text-muted mb-1 block">名称</span>
            <input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="便于识别的名字，例如「主账号」"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
            />
          </label>

          <label className="block">
            <span className="text-xs text-muted mb-1 block">App ID</span>
            <input
              value={form.appId}
              onChange={(e) => set('appId', e.target.value)}
              placeholder="声网控制台的项目 App ID"
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </label>

          <div className="block">
            <label className="block">
              <span className="text-xs text-muted mb-1 block">
                App Certificate
                {editingId && <span className="text-dim ml-2">留空表示不修改</span>}
              </span>
              <input
                type="password"
                value={form.appCertificate}
                onChange={(e) => set('appCertificate', e.target.value)}
                placeholder={editingId ? '留空保持不变' : '32 字符，加密后存储'}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono"
              />
            </label>
            {/* 提示放在 label 之外：否则它会被并入输入框的无障碍名称 */}
            <span className="text-xs text-dim mt-1 block">
              加密存储，保存后无法查看。声网要求 32 字符，长度不对会导致无法签发 Token。
            </span>
          </div>

          {advanced && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-xs text-muted mb-1 block">优先级（越小越先选）</span>
                  <input
                    type="number"
                    value={form.priority}
                    onChange={(e) => set('priority', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-muted mb-1 block">Token 有效期（秒）</span>
                  <input
                    type="number"
                    value={form.tokenExpireSec}
                    onChange={(e) => set('tokenExpireSec', e.target.value)}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
              </div>

              <div className="block">
                <label className="block">
                  <span className="text-xs text-muted mb-1 block">月度配额（标准分钟，留空=不限）</span>
                  <input
                    type="number"
                    value={form.quota}
                    onChange={(e) => set('quota', e.target.value)}
                    placeholder="不限"
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                  />
                </label>
                <span className="text-xs text-dim mt-1 block">
                  不同声网账户配额差别很大，因此没有默认值。达到配额后不再向该 Provider 分配新会话，
                  进行中的会话不受影响。
                </span>
              </div>

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.quotaEnforced}
                  onChange={(e) => set('quotaEnforced', e.target.checked)}
                />
                启用配额拦截
              </label>

              <label className="block">
                <span className="text-xs text-muted mb-1 block">Customer ID（可选）</span>
                <input
                  value={form.customerId}
                  onChange={(e) => set('customerId', e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono"
                />
              </label>

              <div className="block">
                <label className="block">
                  <span className="text-xs text-muted mb-1 block">
                    Customer Secret（可选）
                    {editingId && <span className="text-dim ml-2">留空表示不修改</span>}
                  </span>
                  <input
                    type="password"
                    value={form.customerSecret}
                    onChange={(e) => set('customerSecret', e.target.value)}
                    placeholder={editingId ? '留空保持不变' : ''}
                    className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono"
                  />
                </label>
                <span className="text-xs text-dim mt-1 block">
                  用于调用声网官方用量 API 做对账。加密存储，无法查看。
                </span>
              </div>

              <label className="block">
                <span className="text-xs text-muted mb-1 block">备注</span>
                <input
                  value={form.note}
                  onChange={(e) => set('note', e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            </>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            启用
          </label>

          <div className="flex gap-2 pt-1">
            <button
              onClick={submit}
              disabled={busy || !form.name.trim() || !form.appId.trim()}
              className="btn-brand px-4 py-2 rounded-lg text-white text-sm disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              保存
            </button>
            <button
              onClick={cancel}
              className="px-4 py-2 rounded-lg text-sm text-muted hover:text-white hover:bg-white/5 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {providers.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center">
          <KeyRound className="w-8 h-8 text-dim mx-auto mb-3" />
          <p className="text-sm text-muted">还没有配置任何 Agora Provider</p>
          <p className="text-xs text-dim mt-1.5">
            没有可用的 Provider 时，新的共享会话会被拒绝 —— 不会创建注定无法使用的会话。
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {providers.map((provider) => (
            <div
              key={provider.id}
              className={cn(
                'glass rounded-xl p-4 flex flex-wrap items-center gap-3',
                !provider.enabled && 'opacity-60',
              )}
            >
              <div className="flex-1 min-w-[200px]">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{provider.name}</span>
                  {showOwner && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-muted">
                      {OWNER_LABEL[provider.ownerType]}
                      {provider.ownerId ? ` · ${provider.ownerId}` : ''}
                    </span>
                  )}
                  <span
                    className={cn(
                      'text-xs px-2 py-0.5 rounded-full',
                      HEALTH_STYLE[provider.healthStatus],
                    )}
                  >
                    <Activity className="w-3 h-3 inline mr-1" />
                    {HEALTH_LABEL[provider.healthStatus]}
                  </span>
                  {!provider.enabled && (
                    <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-dim">
                      已停用
                    </span>
                  )}
                </div>
                <p className="text-xs text-dim mt-1 font-mono truncate max-w-[320px]">
                  {provider.appId}
                </p>
                <p className="text-xs text-dim mt-0.5">
                  证书 {provider.hasAppCertificate ? '已配置' : '未配置'}
                  {advanced && ` · 优先级 ${provider.priority}`}
                  {advanced && ` · 配额 ${provider.monthlyQuotaStandardMinutes ?? '不限'}`}
                  {advanced && provider.quotaEnforced && '（已启用拦截）'}
                  {advanced && ` · 最后使用 ${formatTime(provider.lastUsedAt)}`}
                </p>
                {provider.healthMessage && (
                  <p className="text-xs text-red-300 mt-1">{provider.healthMessage}</p>
                )}
              </div>

              <div className="flex items-center gap-1">
                <button
                  onClick={() => toggleEnabled(provider)}
                  className="px-3 py-1.5 rounded-lg text-xs text-muted hover:text-white hover:bg-white/5 transition-colors"
                >
                  {provider.enabled ? '停用' : '启用'}
                </button>
                <button
                  onClick={() => startEdit(provider)}
                  title="编辑"
                  className="p-2 rounded-lg text-muted hover:text-white hover:bg-white/5 transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => remove(provider)}
                  title="删除"
                  className="p-2 rounded-lg text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="text-xs text-dim">
        会话创建时会固定绑定一个 Provider 并记录 App ID 快照，发布端与所有观众端始终使用同一个
        Provider / App ID / Channel。修改 App ID 只影响新会话；进行中的会话会明确报错要求重新发起，
        而不是把观众发到另一个声网项目。
      </p>
    </div>
  );
}
