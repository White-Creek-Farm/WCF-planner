// ============================================================================
// LoginScreen — Phase 2.1.5
// ============================================================================
// Verbatim byte-for-byte extraction from main.jsx. Email/password sign-in +
// forgot-password flow. Uses the same supabase client as everything else.
// ============================================================================
import React, {useState} from 'react';
import {sb} from '../lib/supabase.js';
function LoginScreen({onLogin}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState('login'); // 'login' | 'reset'
  const [resetSent, setResetSent] = useState(false);

  async function handleLogin(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    const {error} = await sb.auth.signInWithPassword({email, password});
    if (error) {
      setError(error.message);
      setLoading(false);
    }
  }

  async function handleReset(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      // Use our branded email via edge function instead of Supabase's default
      const {error: fnError} = await sb.functions.invoke('rapid-processor', {
        body: {type: 'password_reset', data: {email: email}},
      });
      if (fnError) throw fnError;
      setResetSent(true);
    } catch (err) {
      setError(err.message || 'Could not send reset email. Please try again.');
    }
    setLoading(false);
  }

  return (
    <div
      data-login-screen
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
        </div>
        {mode === 'login' ? (
          <form onSubmit={handleLogin} style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            <div>
              <label style={{fontSize: 12, color: '#4b5563', display: 'block', marginBottom: 3}}>Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="your@email.com"
                required
                style={{marginBottom: 0}}
              />
            </div>
            <div>
              <label style={{fontSize: 12, color: '#4b5563', display: 'block', marginBottom: 3}}>Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            {error && (
              <div
                style={{color: '#b91c1c', fontSize: 12, background: '#fef2f2', padding: '8px 12px', borderRadius: 6}}
              >
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '10px',
                borderRadius: 10,
                border: 'none',
                background: '#085041',
                color: 'white',
                fontWeight: 600,
                fontSize: 14,
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.7 : 1,
                marginTop: 4,
              }}
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
            <button
              type="button"
              onClick={() => setMode('reset')}
              style={{
                background: 'none',
                border: 'none',
                color: '#085041',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              Forgot password?
            </button>
          </form>
        ) : (
          <form onSubmit={handleReset} style={{display: 'flex', flexDirection: 'column', gap: 12}}>
            {resetSent ? (
              <div style={{textAlign: 'center', color: '#085041', fontSize: 13}}>
                <div style={{fontSize: 32, marginBottom: 8}}>✓</div>
                Check your email for a password reset link.
              </div>
            ) : (
              <>
                <div style={{fontSize: 13, color: '#4b5563'}}>Enter your email and we'll send a reset link.</div>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                  style={{marginBottom: 0}}
                />
                {error && (
                  <div
                    style={{
                      color: '#b91c1c',
                      fontSize: 12,
                      background: '#fef2f2',
                      padding: '8px 12px',
                      borderRadius: 6,
                    }}
                  >
                    {error}
                  </div>
                )}
                <button
                  type="submit"
                  disabled={loading}
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
                  {loading ? 'Sending...' : 'Send Reset Link'}
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setResetSent(false);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: '#085041',
                fontSize: 12,
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              ← Back to sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
export default LoginScreen;
