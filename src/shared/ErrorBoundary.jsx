import React from 'react';
import {reportError} from '../lib/clientErrorReporting.js';

const WRAP = {
  minHeight: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#f1f3f2',
  fontFamily: 'inherit',
  padding: 24,
};
const CARD = {
  background: 'white',
  borderRadius: 12,
  padding: '32px 28px',
  maxWidth: 420,
  width: '100%',
  textAlign: 'center',
  border: '1px solid #e5e7eb',
  boxShadow: '0 4px 12px rgba(0,0,0,.08)',
};
const BTN = {
  marginTop: 16,
  padding: '10px 24px',
  borderRadius: 6,
  border: 'none',
  background: '#085041',
  color: 'white',
  fontSize: 14,
  fontWeight: 600,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {hasError: false};
  }

  static getDerivedStateFromError() {
    return {hasError: true};
  }

  componentDidCatch(error, info) {
    reportError('ErrorBoundary', error, {
      componentStack: info && info.componentStack ? info.componentStack.split('\n').slice(0, 5).join('\n') : null,
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={WRAP}>
          <div style={CARD}>
            <div style={{fontSize: 26, marginBottom: 8}}>{'\u{1F404}'}</div>
            <h1 style={{fontSize: 18, fontWeight: 700, color: '#111827', margin: '0 0 8px'}}>Something went wrong</h1>
            <p style={{fontSize: 14, color: '#6b7280', margin: '0 0 4px', lineHeight: 1.5}}>
              The app ran into an unexpected problem. Your data is safe.
            </p>
            <p style={{fontSize: 13, color: '#9ca3af', margin: 0}}>If this keeps happening, let Ronnie know.</p>
            <button type="button" onClick={() => window.location.reload()} style={BTN}>
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
