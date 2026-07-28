import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AlertTriangle, Loader2, X } from 'lucide-react';
import { api } from '../../lib/api';

export type NoticePage = 'server_admin' | 'share' | 'view';

export interface PublicNotice {
  id: string;
  kind: 'banner' | 'modal';
  modalPolicy: 'dismissible' | 'acknowledgement_required' | null;
  title: string;
  contentFormat: 'text' | 'html';
  content: string;
  imageUrl: string;
  enabled: number;
  sortOrder: number;
  repeatAfterSec: number | null;
  revision: number;
}

interface NoticeContextValue {
  banners: PublicNotice[];
  dismiss: (notice: PublicNotice) => void;
}

const NoticeContext = createContext<NoticeContextValue>({
  banners: [],
  dismiss: () => undefined,
});

function storageKey(notice: PublicNotice): string {
  return `xgoat_notice_${notice.id}`;
}

function wasDismissed(notice: PublicNotice): boolean {
  try {
    const raw = localStorage.getItem(storageKey(notice));
    if (!raw) return false;
    const record = JSON.parse(raw);
    if (record.revision !== notice.revision) return false;
    if (notice.repeatAfterSec === null) return true;
    return Date.now() - Number(record.dismissedAt || 0) < notice.repeatAfterSec * 1000;
  } catch {
    return false;
  }
}

function NoticeBody({ notice }: { notice: PublicNotice }) {
  return (
    <div className="space-y-3">
      {notice.imageUrl && (
        <img
          src={notice.imageUrl}
          alt={notice.title || '通知图片'}
          className="max-h-[45vh] w-full rounded-xl object-contain bg-black/20"
          referrerPolicy="no-referrer"
        />
      )}
      {notice.contentFormat === 'html' ? (
        <div
          className="notice-rich-text text-sm leading-relaxed text-muted"
          dangerouslySetInnerHTML={{ __html: notice.content }}
        />
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">
          {notice.content}
        </p>
      )}
    </div>
  );
}

export function NoticeProvider({
  page,
  children,
}: {
  page: NoticePage;
  children: ReactNode;
}) {
  const [notices, setNotices] = useState<PublicNotice[]>([]);
  const [hiddenThisVisit, setHiddenThisVisit] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setLoading(true);
    setError('');
    api.getNotices(page)
      .then((items) => setNotices(items as PublicNotice[]))
      .catch((e) => setError(e.message || '无法加载页面通知'))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const visibleNotices = useMemo(
    () => notices.filter(notice => (
      !hiddenThisVisit.has(notice.id) && !wasDismissed(notice)
    )),
    [notices, hiddenThisVisit],
  );

  const dismiss = useCallback((notice: PublicNotice) => {
    try {
      localStorage.setItem(storageKey(notice), JSON.stringify({
        revision: notice.revision,
        dismissedAt: Date.now(),
      }));
    } catch {
      // 浏览器禁用存储时仍允许关闭当前页面中的通知。
    }
    setHiddenThisVisit(current => new Set(current).add(notice.id));
  }, []);

  const banners = visibleNotices.filter(notice => notice.kind === 'banner');
  const activeModal = visibleNotices.find(notice => notice.kind === 'modal') || null;
  const blocksPage = activeModal?.modalPolicy === 'acknowledgement_required';

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-dark">
        <Loader2 className="w-8 h-8 text-brand animate-spin" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-dark p-6">
        <div className="glass rounded-2xl p-6 max-w-sm text-center">
          <AlertTriangle className="w-10 h-10 text-yellow-400 mx-auto mb-3" />
          <h1 className="font-semibold">页面通知加载失败</h1>
          <p className="text-sm text-muted mt-2">{error}</p>
          <button onClick={load} className="btn-brand rounded-xl px-5 py-2 mt-5 text-sm">
            重新加载
          </button>
        </div>
      </div>
    );
  }

  return (
    <NoticeContext.Provider value={{ banners, dismiss }}>
      {!blocksPage && children}
      {activeModal && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`notice-title-${activeModal.id}`}
        >
          <div className="glass-strong relative w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl border border-white/15 p-6 shadow-2xl">
            {activeModal.modalPolicy === 'dismissible' && (
              <button
                type="button"
                onClick={() => dismiss(activeModal)}
                className="absolute right-4 top-4 p-1.5 rounded-lg text-dim hover:text-white hover:bg-white/10"
                aria-label="关闭通知"
              >
                <X className="w-5 h-5" />
              </button>
            )}
            {activeModal.title && (
              <h2
                id={`notice-title-${activeModal.id}`}
                className="text-xl font-bold pr-10 mb-4"
              >
                {activeModal.title}
              </h2>
            )}
            <NoticeBody notice={activeModal} />
            {activeModal.modalPolicy === 'acknowledgement_required' && (
              <button
                type="button"
                onClick={() => dismiss(activeModal)}
                className="btn-brand w-full rounded-xl py-2.5 mt-6 text-sm font-medium"
              >
                我明白并同意
              </button>
            )}
          </div>
        </div>
      )}
    </NoticeContext.Provider>
  );
}

export function NoticeBanners() {
  const { banners, dismiss } = useContext(NoticeContext);
  if (banners.length === 0) return null;

  return (
    <div className="w-full space-y-2 mb-4">
      {banners.map(notice => (
        <div
          key={notice.id}
          className="glass rounded-xl border border-white/10 px-4 py-3 flex items-start gap-3"
        >
          <div className="flex-1 min-w-0">
            {notice.title && <h3 className="text-sm font-semibold mb-1">{notice.title}</h3>}
            <NoticeBody notice={notice} />
          </div>
          <button
            type="button"
            onClick={() => dismiss(notice)}
            className="p-1 rounded text-dim hover:text-white flex-shrink-0"
            aria-label="关闭通知"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
