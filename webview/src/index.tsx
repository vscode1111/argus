import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './global.css';
import { DevHarness } from './dev/DevHarness';

const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App />);
}

const harnessEl = document.getElementById('dev-harness');
if (harnessEl) {
  createRoot(harnessEl).render(<DevHarness />);
}
