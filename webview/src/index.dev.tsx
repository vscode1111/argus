import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './index.css';
import { DevHarness } from './dev/DevHarness';

createRoot(document.getElementById('root')!).render(<App />);

const harnessEl = document.getElementById('dev-harness');
if (harnessEl) {
  createRoot(harnessEl).render(<DevHarness />);
}
