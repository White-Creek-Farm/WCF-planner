// ============================================================================
// SetPasswordScreen — Phase 2.1.5
// ============================================================================
// Verbatim byte-for-byte extraction from main.jsx. Invite / password-recovery
// landing screen. Manually exchanges URL-hash access_token/refresh_token for a
// session because the supabase client is initialized with
// detectSessionInUrl:false. CRITICAL path — forgot-password flow gate.
// Don't modify the URL-token logic; see DECISIONS / PROJECT.md §16.
// ============================================================================
import React, {useState} from 'react';
import {sb} from '../lib/supabase.js';
function SetPasswordScreen({onDone, prefilledEmail}) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  // Supabase JS exchanges the recovery token for a session asynchronously.
  // The screen can render before that finishes (we trigger it from the URL
  // hash on mount), so we have to wait for a real session before allowing
  // updateUser — otherwise it fails with "Auth session missing".
  const [sessionReady, setSessionReady] = useState(false);
  const [linkInvalid, setLinkInvalid] = useState(false);

  React.useEffect(() => {
    let mounted = true;
    let timeoutId;

    // The supabase client is initialized with detectSessionInUrl:false (see
    // top of file) so the auto-exchange that would normally run on init is
    // disabled. We have to manually pick up the recovery tokens from the
    // URL and call setSession ourselves, otherwise updateUser fails with
    // "Auth session missing".
    async function tryEstablishSession() {
      try {
        const {
          data: {session: existing},
        } = await sb.auth.getSession();
        if (mounted && existing) {
          setSessionReady(true);
          clearTimeout(timeoutId);
          return;
        }
        // Implicit-flow tokens land in the URL hash
        const hash = (window.location.hash || '').replace(/^#/, '');
        if (hash) {
          const params = new URLSearchParams(hash);
          const at = params.get('access_token');
          const rt = params.get('refresh_token');
          if (at && rt) {
            const {error: sErr} = await sb.auth.setSession({access_token: at, refresh_token: rt});
            if (!sErr && mounted) {
              setSessionReady(true);
              clearTimeout(timeoutId);
              return;
            }
          }
        }
        // PKCE-flow code lands in the query string
        const code = new URLSearchParams(window.location.search).get('code');
        if (code) {
          const {error: cErr} = await sb.auth.exchangeCodeForSession(code);
          if (!cErr && mounted) {
            setSessionReady(true);
            clearTimeout(timeoutId);
            return;
          }
        }
      } catch (e) {
        /* fall through to timeout */
      }
    }
    tryEstablishSession();

    const {
      data: {subscription},
    } = sb.auth.onAuthStateChange((event, session) => {
      if (mounted && session) {
        setSessionReady(true);
        clearTimeout(timeoutId);
      }
    });
    // If we still haven't established a session after 8s, the recovery
    // link is expired or already used. Surface a clear error rather than
    // letting the user submit into the void.
    timeoutId = setTimeout(() => {
      if (mounted && !sessionReady) setLinkInvalid(true);
    }, 8000);
    return () => {
      mounted = false;
      subscription.unsubscribe();
      clearTimeout(timeoutId);
    };
  }, []);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    if (!sessionReady) {
      setError('Still validating your reset link \u2014 give it a moment and try again.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    const {error: upErr} = await sb.auth.updateUser({password});
    setLoading(false);
    if (upErr) {
      setError(upErr.message || 'Could not set password. The recovery link may have expired.');
      return;
    }
    // Clear any auth tokens left in the URL so a refresh doesn't re-trigger recovery.
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (_e) {
      /* cosmetic URL cleanup; auth state already set above */
    }
    setDone(true);
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        background: '#085041',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '1rem',
      }}
    >
      <div
        style={{
          background: 'white',
          borderRadius: 14,
          padding: '2.5rem',
          width: '100%',
          maxWidth: 400,
          boxShadow: '0 8px 32px rgba(0,0,0,.2)',
        }}
      >
        <div style={{textAlign: 'center', marginBottom: '2rem'}}>
          <div style={{fontSize: 22, fontWeight: 700, color: '#085041'}}>WCF Planner</div>
          {prefilledEmail && <div style={{fontSize: 12, color: '#6b7280', marginTop: 8}}>{prefilledEmail}</div>}
        </div>
        {done ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center'}}>
            <div style={{fontSize: 32, color: '#085041'}}>{'\u2713'}</div>
            <div style={{fontSize: 13, color: '#085041'}}>Password set. You're signed in.</div>
            <button
              type="button"
              onClick={onDone}
              style={{
                padding: '10px',
                borderRadius: 10,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontWeight: 600,
                fontSize: 14,
                cursor: 'pointer',
              }}
            >
              Continue to Planner
            </button>
          </div>
        ) : linkInvalid && !sessionReady ? (
          <div style={{display: 'flex', flexDirection: 'column', gap: 14, textAlign: 'center'}}>
            <div style={{fontSize: 32, color: '#b91c1c'}}>{'\u26a0'}</div>
            <div style={{fontSize: 13, color: '#b91c1c', lineHeight: 1.5}}>
              This reset link is expired or has already been used. Open{' '}
              <a href="https://wcfplanner.com" style={{color: '#085041'}}>
                wcfplanner.com
              </a>{' '}
              and click <strong>Forgot password?</strong> to get a fresh one.
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <div style={{fontSize: 12, color: '#4b5563', lineHeight: 1.5, marginBottom: 4}}>
              Pick a password (at least 6 characters). You'll use this and your email to sign in next time.
            </div>
            <div>
              <label style={{fontSize: 12, color: '#4b5563', display: 'block', marginBottom: 3}}>New password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                required
                autoFocus
              />
            </div>
            <div>
              <label style={{fontSize: 12, color: '#4b5563', display: 'block', marginBottom: 3}}>
                Confirm password
              </label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                required
              />
            </div>
            {!sessionReady && !error && (
              <div
                style={{color: '#92400e', fontSize: 12, background: '#fffbeb', padding: '8px 12px', borderRadius: 6}}
              >
                Validating reset link{'\u2026'}
              </div>
            )}
            {error && (
              <div
                style={{color: '#b91c1c', fontSize: 12, background: '#fef2f2', padding: '8px 12px', borderRadius: 6}}
              >
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading || !sessionReady}
              style={{
                padding: '10px',
                borderRadius: 10,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontWeight: 600,
                fontSize: 14,
                cursor: loading || !sessionReady ? 'not-allowed' : 'pointer',
                opacity: loading || !sessionReady ? 0.6 : 1,
                marginTop: 4,
              }}
            >
              {loading ? 'Saving...' : !sessionReady ? 'Verifying\u2026' : 'Set Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

export default SetPasswordScreen;
