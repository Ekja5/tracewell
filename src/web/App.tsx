import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { setDefaultTz, api, ApiError, post, ROLE_LABEL, fmtTime } from './lib/api';
import { clearForUser, isForcedOffline, isOnline, listQueue, setForcedOffline, syncQueue, requestPersistence, listNotes as listLocalNotes, syncNotes } from './lib/offline';
import { Login } from './pages/Login';
import { Board } from './pages/Board';
import { CaseDetail } from './pages/CaseDetail';
import { QuickNote } from './pages/QuickNote';
import { UploadsPage, UploadRun } from './pages/Uploads';
import { Tomorrow, Reconcile, PilotReview, PilotReport } from './pages/Pilot';
import { Attention, Transfers, TransferDetail, Loaners, LoanerDetail, ParLevels, Expiring, Allocation, OpsSettings } from './pages/Command';
import { MoveIn } from './pages/MoveIn';
import { WhereIsEverything, CaseTracker, RunSheet } from './pages/Visibility';
import { UsageReport } from './pages/Usage';
import { ReviewGuide, FeedbackList, FeedbackButton } from './pages/Review';
import { Rescue } from './pages/Rescue';
import { Shipments, ShipmentDetail, PickQueue } from './pages/Shipments';
import { TrayVerify } from './pages/TrayVerify';
import { MobileHome, Closeout } from './pages/Closeout';
import { Finance, CaseFinance } from './pages/Finance';
import { Quality, RecallDetail } from './pages/Quality';
import { ImportPage } from './pages/Import';
import { Counts, CountDetail } from './pages/Counts';
import { Inventory, Exceptions, Integrations, Metrics, SearchPage, Cases, UsageReview } from './pages/Misc';
import { Handoff, Alerts } from './pages/Ops';
import { FindItem } from './pages/FindItem';
import { FinanceQueue } from './pages/Finance';

export interface Me { user: any; perms: string[]; now: string; demoClock: boolean; demoShortcuts: boolean }
const MeCtx = createContext<{ me: Me; can: (p: string) => boolean; refresh: () => void } | null>(null);
export const useMe = () => useContext(MeCtx)!;

export function useData<T = any>(path: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try { setData(await api<T>(path)); setError(null); } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export function Status({ s }: { s: string }) {
  const label: Record<string, string> = { ready: 'Ready', at_risk: 'At risk', blocked: 'Blocked', cancelled: 'Cancelled', completed: 'Completed', closed: 'Closed', scheduled: 'Scheduled' };
  return <span className={`badge st-${s}`} role="status">{label[s] ?? s.replace(/_/g, ' ')}</span>;
}
export function Err({ e }: { e: string | null }) { return e ? <div className="alert" role="alert">{e}</div> : null; }
export function Simulated() { return <span className="badge sim" title="Simulated integration: no live customer system is connected">SIMULATED</span>; }

function useConnectivity() {
  const [online, setOnline] = useState(isOnline());
  useEffect(() => {
    const f = () => setOnline(isOnline());
    window.addEventListener('online', f); window.addEventListener('offline', f); window.addEventListener('tw-connectivity', f);
    return () => { window.removeEventListener('online', f); window.removeEventListener('offline', f); window.removeEventListener('tw-connectivity', f); };
  }, []);
  return online;
}

function SyncBar({ me }: { me: Me }) {
  const online = useConnectivity();
  const [pending, setPending] = useState(0);
  const [review, setReview] = useState(0);
  const [last, setLast] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const q = await listQueue(me.user.id); const n = await listLocalNotes(me.user.id);
      setPending(q.filter((e) => e.state === 'pending').length + n.filter((x) => x.state === 'pending').length); setReview(q.filter((e) => e.state === 'needs_review').length);
    } catch { /* idb unavailable */ }
  }, [me.user.id]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    window.addEventListener('tw-queue', refresh);
    return () => { clearInterval(t); window.removeEventListener('tw-queue', refresh); };
  }, [refresh]);
  useEffect(() => {
    if (!online) return;
    syncQueue(me.user.id).then((r) => { if (r.sent) { setLast(new Date().toISOString()); window.dispatchEvent(new Event('tw-synced')); } refresh(); }).catch(() => {});
    syncNotes(me.user.id).then((n) => { if (n) { setLast(new Date().toISOString()); refresh(); } }).catch(() => {});
  }, [online, pending]);
  if (me.user.role !== 'rep' && pending === 0 && online) return null;
  return (
    <div className={`syncbar ${online ? 'on' : 'off'}`} role="status" aria-live="polite">
      <strong>{online ? 'Online' : 'Offline'}</strong>
      <span>{pending} pending</span>{review > 0 && <span>{review} need review</span>}
      {last && <span>last sync {fmtTime(last)}</span>}
      {me.user.role === 'rep' && (
        <label className="toggle"><input type="checkbox" checked={isForcedOffline()} onChange={(e) => setForcedOffline(e.target.checked)} /> Work offline</label>
      )}
    </div>
  );
}

const NAV: { to: string; label: string; perm?: string; roles?: string[]; review?: boolean }[] = [
  { to: '/attention', label: 'Needs attention', perm: 'attention.view' },
  { to: '/board', label: 'Readiness', perm: 'board.view' },
  { to: '/tracker', label: 'Case tracker', perm: 'attention.view' },
  { to: '/run-sheet', label: 'Run sheet', perm: 'shipment.pick' },
  { to: '/stock/where', label: 'Where everything is', perm: 'inventory.view' },
  { to: '/tomorrow', label: "Tomorrow's cases", perm: 'board.view' },
  { to: '/feedback', label: 'Feedback received', review: true },
  { to: '/uploads', label: 'Load files', perm: 'upload.view' },
  { to: '/reconcile', label: 'Reconcile', perm: 'upload.view' },
  { to: '/pilot', label: 'Pilot review', perm: 'pilot.record' },
  { to: '/today', label: 'My cases', roles: ['rep'] },
  { to: '/find', label: 'Item finder', perm: 'rescue.search' },
  { to: '/handoff', label: 'Shift handoff', perm: 'board.view' },
  { to: '/cases', label: 'Cases', perm: 'case.manage' },
  { to: '/pick', label: 'Pick queue', perm: 'shipment.pick' },
  { to: '/shipments', label: 'Shipments' },
  { to: '/transfers', label: 'Transfers', perm: 'attention.view' },
  { to: '/loaners', label: 'Loaners', perm: 'loaner.view' },
  { to: '/allocation', label: 'Allocation', perm: 'allocation.run' },
  { to: '/inventory', label: 'Inventory', perm: 'inventory.view' },
  { to: '/stock/par', label: 'Par levels', perm: 'inventory.view' },
  { to: '/stock/expiring', label: 'Expiring stock', perm: 'inventory.view' },
  { to: '/usage', label: 'Usage and consumption', perm: 'inventory.view' },
  { to: '/import', label: 'Import', perm: 'import.run' },
  { to: '/counts', label: 'Counts', perm: 'count.perform' },
  { to: '/finance', label: 'Finance', perm: 'finance.manage' },
  { to: '/finance/queue', label: 'Billing line queue', perm: 'finance.manage' },
  { to: '/quality', label: 'Quality', perm: 'recall.task' },
  { to: '/exceptions', label: 'Exceptions' },
  { to: '/integrations', label: 'Integrations', perm: 'integration.view' },
  { to: '/metrics', label: 'Scorecard', perm: 'metrics.view' },
  { to: '/move-in', label: 'Move from another system', perm: 'upload.run' },
  { to: '/settings/ops', label: 'Settings', perm: 'settings.manage' },
];

function Shell({ me, refresh }: { me: Me; refresh: () => void }) {
  const can = (p: string) => me.perms.includes(p);
  const nav = useNavigate();
  const loc = useLocation();
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState(false);
  const notes = useData<any[]>('/api/notifications', [loc.pathname]);
  const unread = (notes.data ?? []).filter((n) => !n.read_at && n.status !== 'closed').length;
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  useEffect(() => { if (me.user.role === 'rep') requestPersistence(); }, []);
  const logout = async () => { await clearForUser(me.user.id).catch(() => {}); localStorage.removeItem('tw-me'); await post('/api/auth/logout').catch(() => {}); location.href = '/login'; };
  const role = me.user.role;
  const narrow = typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches;
  const home = (me as any).reviewMode && role === 'admin' ? '/review' : ['ops_manager', 'admin', 'inventory_coordinator'].includes(role) ? '/attention' : role === 'warehouse' ? '/pick' : role === 'finance' ? '/finance' : role === 'quality_manager' ? '/quality' : role === 'rep' && narrow ? '/today' : null;
  return (
    <MeCtx.Provider value={{ me, can, refresh }}>
      <header className="top">
        <button className="menu-btn" aria-expanded={menu} aria-controls="nav" onClick={() => setMenu(!menu)}>Menu</button>
        <Link to="/" className="brand">Tracewell</Link>
        <form className="search" role="search" onSubmit={(e) => { e.preventDefault(); nav(`/search?q=${encodeURIComponent(q)}`); }}>
          <label className="sr" htmlFor="gsearch">Exact catalog, lot, serial, GTIN or case search</label>
          <input id="gsearch" placeholder="Search ref / lot / serial / GTIN / case" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        {(me as any).reviewMode && <><Link to="/review" className="notes">Reviewer guide</Link><FeedbackButton /></>}
        <Link to="/notifications" className="notes" aria-label={`${unread} unread notifications`}>Alerts{unread ? <span className="count">{unread}</span> : null}</Link>
        <div className="who"><span>{me.user.displayName}</span><small>{ROLE_LABEL[role]}{me.user.facilityName ? ` · ${me.user.facilityName}` : ''} · {me.user.tenantName}</small></div>
        <button className="link" onClick={logout}>Sign out</button>
      </header>
      {me.demoClock && <div className="democlock">Demo clock: {fmtTime(me.now, 'America/Chicago')}. All data is synthetic.</div>}
      <SyncBar me={me} />
      <div className="layout">
        <nav id="nav" className={menu ? 'open' : ''} aria-label="Main">
          {NAV.filter((n) => (!n.perm || can(n.perm)) && (!n.roles || n.roles.includes(role)) && (!n.review || (me as any).canReadFeedback)).map((n) => <NavLink key={n.to} to={n.to} end={n.to === '/'}>{n.label}</NavLink>)}
        </nav>
        <main id="main">
          <Routes>
            <Route path="/" element={home && loc.pathname === '/' && !sessionStorage.getItem('tw-board') ? <Navigate to={home} replace /> : <Board />} />
            <Route path="/board" element={<Board />} />
            <Route path="/attention" element={<Attention />} />
            <Route path="/transfers" element={<Transfers />} />
            <Route path="/transfers/:id" element={<TransferDetail />} />
            <Route path="/loaners" element={<Loaners />} />
            <Route path="/loaners/:id" element={<LoanerDetail />} />
            <Route path="/stock/par" element={<ParLevels />} />
            <Route path="/stock/expiring" element={<Expiring />} />
            <Route path="/allocation" element={<Allocation />} />
            <Route path="/settings/ops" element={<OpsSettings />} />
            <Route path="/move-in" element={<MoveIn />} />
            <Route path="/tracker" element={<CaseTracker />} />
            <Route path="/usage" element={<UsageReport />} />
            <Route path="/run-sheet" element={<RunSheet />} />
            <Route path="/stock/where" element={<WhereIsEverything />} />
            <Route path="/today" element={<MobileHome />} />
            <Route path="/cases" element={<Cases />} />
            <Route path="/cases/:id" element={<CaseDetail />} />
            <Route path="/cases/:id/rescue/:reqId" element={<Rescue />} />
            <Route path="/cases/:id/closeout" element={<Closeout />} />
            <Route path="/cases/:id/handoff" element={<QuickNote />} />
            <Route path="/cases/:id/finance" element={<CaseFinance />} />
            <Route path="/pick" element={<PickQueue />} />
            <Route path="/shipments" element={<Shipments />} />
            <Route path="/shipments/:id" element={<ShipmentDetail />} />
            <Route path="/trays/:id/verify" element={<TrayVerify />} />
            <Route path="/finance" element={<Finance />} />
            <Route path="/quality" element={<Quality />} />
            <Route path="/recalls/:id" element={<RecallDetail />} />
            <Route path="/import" element={<ImportPage />} />
            <Route path="/counts" element={<Counts />} />
            <Route path="/counts/:id" element={<CountDetail />} />
            <Route path="/inventory" element={<Inventory />} />
            <Route path="/exceptions" element={<Exceptions />} />
            <Route path="/usage-review" element={<UsageReview />} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/metrics" element={<Metrics />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/notifications" element={<Alerts reload={notes.reload} />} />
            <Route path="/handoff" element={<Handoff />} />
            <Route path="/find" element={<FindItem />} />
            <Route path="/tomorrow" element={<Tomorrow />} />
            <Route path="/review" element={<ReviewGuide />} />
            <Route path="/feedback" element={<FeedbackList />} />
            <Route path="/uploads" element={<UploadsPage />} />
            <Route path="/uploads/runs/:id" element={<UploadRun />} />
            <Route path="/reconcile" element={<Reconcile />} />
            <Route path="/pilot" element={<PilotReview />} />
            <Route path="/pilot/report" element={<PilotReport />} />
            <Route path="/finance/queue" element={<FinanceQueue />} />
            <Route path="*" element={<p>Page not found. <Link to="/board">Go to readiness board</Link></p>} />
          </Routes>
        </main>
      </div>
    </MeCtx.Provider>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [checked, setChecked] = useState(false);
  const loc = useLocation();
  const load = useCallback(async () => {
    try {
      const m = await api<Me>('/api/auth/me');
      setDefaultTz((m as any).user?.facilityTimezone ?? (m as any).user?.tenantTimezone);
      setMe(m);
      // Non-secret profile cached so an assigned rep can reopen the app offline. The session cookie stays HttpOnly.
      if (m.user.role === 'rep') localStorage.setItem('tw-me', JSON.stringify(m)); else localStorage.removeItem('tw-me');
    } catch (e: any) {
      const cached = localStorage.getItem('tw-me');
      if (!(e instanceof ApiError) && cached) setMe({ ...JSON.parse(cached), offlineProfile: true });
      else { setMe(null); localStorage.removeItem('tw-me'); }
    } finally { setChecked(true); }
  }, []);
  useEffect(() => { load(); }, [load]);
  if (!checked) return <p className="pad">Loading…</p>;
  if (loc.pathname === '/login' || !me) return <Login onLogin={load} />;
  return <Shell me={me} refresh={load} />;
}
