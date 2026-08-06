import { Link } from 'wouter-preact';
import { Button } from '../components/Button';

export function NotFound() {
  return (
    <div class="flex flex-col items-center justify-center py-24 text-center">
      <div class="w-16 h-16 bg-gradient-to-br from-claw-500 to-purple-600 rounded-2xl flex items-center justify-center mb-4 mx-auto">
        <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>
      </div>
      <h1 class="text-display-lg text-primary font-bold mb-2">404</h1>
      <p class="text-body text-secondary mb-8">This page doesn't exist or has been moved.</p>
      <div class="flex gap-3">
        <Link href="/">
          <Button variant="primary">Go to Overview</Button>
        </Link>
        <Link href="/agents">
          <Button variant="secondary">View Agents</Button>
        </Link>
      </div>
    </div>
  );
}
