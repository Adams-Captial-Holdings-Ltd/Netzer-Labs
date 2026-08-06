import { render } from 'preact';
import { App } from './App';
import { bootTheme } from './lib/theme';
import './index.css';

// Apply the active named theme synchronously from the localStorage cache BEFORE
// the app mounts. This sets the brand palette (light/dark aware), the
// document.title, the favicon, and the live brand identity the Header reads, so
// the first paint already carries the active company's branding — no flash of
// the default. reconcileThemes() (called once a session exists) later refreshes
// these from the authoritative backend config.
bootTheme();

render(<App />, document.getElementById('app')!);
