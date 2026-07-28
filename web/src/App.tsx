import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { NoticeProvider } from './components/notices/NoticeCenter';

const SharePage = lazy(() => import('./pages/SharePage'));
const ViewPage = lazy(() => import('./pages/ViewPage'));
const HomePage = lazy(() => import('./pages/HomePage'));
const SuperAdminPage = lazy(() => import('./pages/SuperAdminPage'));
const ServerAdminPage = lazy(() => import('./pages/ServerAdminPage'));
const LegacyAdminMigrationPage = lazy(() => import('./pages/LegacyAdminMigrationPage'));

function Fallback() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <Loader2 className="w-8 h-8 text-brand animate-spin" />
    </div>
  );
}

export default function App() {
  return (
    <Suspense fallback={<Fallback />}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/share" element={<NoticeProvider page="share"><SharePage /></NoticeProvider>} />
        <Route path="/view" element={<NoticeProvider page="view"><ViewPage /></NoticeProvider>} />
        <Route path="/super" element={<SuperAdminPage />} />
        <Route path="/kook/:serverId" element={<ServerAdminPage />} />
        <Route path="/:serverId" element={<LegacyAdminMigrationPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}
