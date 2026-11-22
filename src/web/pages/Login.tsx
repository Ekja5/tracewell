import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, post, ROLE_LABEL } from '../lib/api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [demo, setDemo] = useState<any[] | null>(null);
  useEffect(() => { api<any[]>('/api/auth/demo-accounts').then(setDemo).catch(() => setDemo(null)); }, []);
  const nav = useNavigate();
  const done = () => { sessionStorage.removeItem('tw-board'); nav('/', { replace: true }); onLogin(); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(null);
    try { await post('/api/auth/login', { email, password }); done(); } catch (x: any) { setErr(x.message); }
  };
  return (
    <div className="login">
      <h1>Tracewell Case Logistics</h1>
      <p className="muted">Orthopedic case readiness, inventory and case-to-cash pilot. All organizations, people, devices, prices and cases are synthetic.</p>
      <form className="card" onSubmit={submit} aria-label="Sign in">
        <div className="row">
          <label className="field">Email or username<input type="text" autoCapitalize="none" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
          <label className="field">Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
          <button type="submit" style={{ alignSelf: 'flex-end' }}>Sign in</button>
        </div>
        {err && <div className="alert" role="alert">{err}</div>}
      </form>
      {demo && (
        <section className="card">
          <h2>Development-only demo accounts</h2>
          <p className="small muted">Shown only when NODE_ENV is not production and DEMO_LOGIN_SHORTCUTS=true. Password for every synthetic account: <code>Pilot-Demo-2026!</code></p>
          <div className="demo-accts">
            {demo.map((d) => (
              <button key={d.email} onClick={async () => { await post('/api/auth/demo-login', { email: d.email }); done(); }} data-email={d.email}>
                <strong>{d.display_name}</strong><span className="small">{ROLE_LABEL[d.role]}{d.facility ? ` · ${d.facility}` : ''}</span><span className="small muted">{d.tenant}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
