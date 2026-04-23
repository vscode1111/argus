import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './global.css';
import { DevHarness } from './dev/DevHarness';

createRoot(document.getElementById('root')!).render(<App />);

const harnessEl = document.getElementById('dev-harness');
if (harnessEl) {
  const stored = localStorage.getItem('argus.showDevHarness');
  if (stored !== 'true') {
    harnessEl.style.display = 'none';
  } else {
    document.body.classList.add('dev-harness-visible');
  }
  createRoot(harnessEl).render(<DevHarness />);
}
