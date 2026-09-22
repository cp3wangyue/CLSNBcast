import { useEffect, useState } from 'react';
import { Loader2, Pencil, Plus, Trash2, X, Check } from 'lucide-react';
import { api } from '../../lib/api';
import { cn } from '../../lib/utils';
import type { QualityPresetOption, QualityOptimizationMode, QualityCodec } from '../../types';

interface Draft {
  id: string;
  label: string;
  width: string;
  height: string;
  frameRate: string;
  bitrateMin: string;
  bitrateMax: string;
  optimizationMode: QualityOptimizationMode;
  codec: QualityCodec;
  enabled: boolean;
  sortOrder: string;
}

const EMPTY: Draft = {
  id: '', label: '', width: '1920', height: '1080', frameRate: '30',
  bitrateMin: '', bitrateMax: '', optimizationMode: 'motion', codec: 'h264',
  enabled: true, sortOrder: '999',
};

function toDraft(preset: QualityPresetOption): Draft {
  return {
    id: preset.id,
    label: preset.label,
    width: String(preset.width),
    height: String(preset.height),
    frameRate: String(preset.frameRate),
    bitrateMin: preset.bitrateMin == null ? '' : String(preset.bitrateMin),
    bitrateMax: preset.bitrateMax == null ? '' : String(preset.bitrateMax),
    optimizationMode: preset.optimizationMode,
    codec: preset.codec,
    enabled: preset.enabled,
    sortOrder: String(preset.sortOrder),
  };
}

/**
 * 超管画质预设管理。
 *
 * ⚠️ `id` 创建后不可改：它被 `servers.allowed_qualities` 与存量会话引用；编辑态会把输入框禁用。
 * 内置与被会话引用的预设不能删除，只能「停用」（服务端会拒绝并返回原因）。
 */
export function QualityPresetPanel() {
  const [rows, setRows] = useState<QualityPresetOption[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reload = async () => {
    try {
      setRows(await api.getSuperQualities());
      setError('');
    } catch (e: any) {
      setError(e?.message || '加载失败');
    }
  };

  useEffect(() => { reload(); }, []);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => (current ? { ...current, [key]: value } : current));

  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const payload = {
        label: draft.label.trim(),
        width: Number(draft.width),
        height: Number(draft.height),
        frameRate: Number(draft.frameRate),
        bitrateMin: draft.bitrateMin.trim() === '' ? null : Number(draft.bitrateMin),
        bitrateMax: draft.bitrateMax.trim() === '' ? null : Number(draft.bitrateMax),
        optimizationMode: draft.optimizationMode,
        codec: draft.codec,
        enabled: draft.enabled,
        sortOrder: Number(draft.sortOrder),
      };
      const result = editingId
        ? await api.updateSuperQuality(editingId, payload)
        : await api.createSuperQuality({ id: draft.id.trim(), ...payload });
      if (!result.ok) { setError(result.message || '保存失败'); return; }
      await reload();
      setDraft(null);
      setEditingId(null);
    } catch (e: any) {
      setError(e?.message || '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (preset: QualityPresetOption) => {
    if (!confirm(`确定删除画质「${preset.label}」？`)) return;
    const result = await api.deleteSuperQuality(preset.id);
    if (!result.ok) setError(result.message || '删除失败');
    await reload();
  };

  const toggleEnabled = async (preset: QualityPresetOption) => {
    setBusy(true);
    const result = await api.updateSuperQuality(preset.id, { enabled: !preset.enabled });
    if (!result.ok) setError(result.message || '操作失败');
    await reload();
    setBusy(false);
  };

  if (!rows.length && !draft && !error) {
    return <div className="text-muted text-sm">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="glass rounded-xl px-4 py-3 border border-red-400/30 text-sm text-red-300">
          {error}
        </div>
      )}

      {!draft && (
        <button
          onClick={() => { setDraft({ ...EMPTY }); setEditingId(null); }}
          className="btn-brand px-4 py-2 rounded-xl text-white text-sm flex items-center gap-1.5"
        >
          <Plus className="w-4 h-4" />
          新建画质
        </button>
      )}

      {draft && (
        <div className="glass-strong rounded-2xl p-5 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-white text-sm">
              {editingId ? '编辑画质' : '新建画质'}
            </h3>
            <button onClick={() => { setDraft(null); setEditingId(null); }} className="text-dim hover:text-white">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs text-muted mb-1 block">ID（创建后不可改）</span>
              <input
                value={draft.id}
                onChange={(e) => set('id', e.target.value)}
                disabled={!!editingId}
                placeholder="如 1080p30_custom"
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm font-mono disabled:opacity-50"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted mb-1 block">名称</span>
              <input
                value={draft.label}
                onChange={(e) => set('label', e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              />
            </label>
            {(['width', 'height', 'frameRate'] as const).map((key) => (
              <label key={key} className="block">
                <span className="text-xs text-muted mb-1 block">
                  {key === 'width' ? '宽度' : key === 'height' ? '高度' : '帧率'}
                </span>
                <input
                  type="number"
                  value={draft[key]}
                  onChange={(e) => set(key, e.target.value)}
                  className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                />
              </label>
            ))}
            <label className="block">
              <span className="text-xs text-muted mb-1 block">最低码率 Kbps（留空=不传）</span>
              <input
                type="number"
                value={draft.bitrateMin}
                onChange={(e) => set('bitrateMin', e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted mb-1 block">最高码率 Kbps（留空=不传）</span>
              <input
                type="number"
                value={draft.bitrateMax}
                onChange={(e) => set('bitrateMax', e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              />
            </label>
            <label className="block">
              <span className="text-xs text-muted mb-1 block">优化模式</span>
              <select
                value={draft.optimizationMode}
                onChange={(e) => set('optimizationMode', e.target.value as QualityOptimizationMode)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              >
                <option value="motion">motion（流畅优先）</option>
                <option value="detail">detail（画质优先）</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted mb-1 block">编码格式</span>
              <select
                value={draft.codec}
                onChange={(e) => set('codec', e.target.value as QualityCodec)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              >
                <option value="h264">H.264</option>
                <option value="vp8">VP8</option>
                <option value="vp9">VP9（Beta）</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs text-muted mb-1 block">排序（越小越靠前）</span>
              <input
                type="number"
                value={draft.sortOrder}
                onChange={(e) => set('sortOrder', e.target.value)}
                className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
              />
            </label>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) => set('enabled', e.target.checked)}
            />
            启用
          </label>

          <div className="flex gap-2 pt-1">
            <button
              onClick={submit}
              disabled={busy || !draft.label.trim() || (!editingId && !draft.id.trim())}
              className="btn-brand px-4 py-2 rounded-lg text-white text-sm disabled:opacity-40 flex items-center gap-1.5"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              保存
            </button>
            <button
              onClick={() => { setDraft(null); setEditingId(null); }}
              className="px-4 py-2 rounded-lg text-sm text-muted hover:text-white hover:bg-white/5 transition-colors"
            >
              取消
            </button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {rows.map((preset) => (
          <div
            key={preset.id}
            className={cn('glass rounded-xl p-4 flex flex-wrap items-center gap-3', !preset.enabled && 'opacity-60')}
          >
            <div className="flex-1 min-w-[200px]">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium text-sm">{preset.label}</span>
                <code className="text-xs text-dim font-mono">{preset.id}</code>
                {preset.isBuiltin && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-muted">内置</span>
                )}
                {!preset.enabled && (
                  <span className="text-xs px-2 py-0.5 rounded-full bg-white/10 text-dim">已停用</span>
                )}
              </div>
              <p className="text-xs text-dim mt-1 font-mono">
                {preset.width}×{preset.height}@{preset.frameRate}fps
                {' · '}{preset.optimizationMode}
                {' · '}{preset.codec.toUpperCase()}
                {' · '}
                {preset.bitrateMin != null || preset.bitrateMax != null
                  ? `${preset.bitrateMin ?? '—'}~${preset.bitrateMax ?? '—'} Kbps` : '码率自动'}
                {preset.tier && ` · 档位 ${preset.tier}`}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={() => toggleEnabled(preset)}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg text-xs text-muted hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40"
              >
                {preset.enabled ? '停用' : '启用'}
              </button>
              <button
                onClick={() => { setDraft(toDraft(preset)); setEditingId(preset.id); }}
                title="编辑"
                className="p-2 rounded-lg text-muted hover:text-white hover:bg-white/5 transition-colors"
              >
                <Pencil className="w-4 h-4" />
              </button>
              <button
                onClick={() => remove(preset)}
                title="删除"
                className="p-2 rounded-lg text-muted hover:text-red-300 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <p className="text-xs text-dim">
        画质 ID 创建后不可修改 —— 它被服务器白名单与历史会话引用。内置、或已被会话引用的画质不能删除，
        需要停用请使用「停用」。
      </p>
    </div>
  );
}
