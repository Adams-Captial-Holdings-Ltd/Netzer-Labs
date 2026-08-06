import { Component, type ComponentChildren } from 'preact';

interface ErrorBoundaryProps {
  children: ComponentChildren;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors in the routed page tree so one bad fetch or a
 * shape surprise can never blank the whole dashboard. Renders a small inline
 * fallback instead of a white screen. Reset clears the captured error so the
 * user can retry without a full reload.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error): void {
    // Surface in the console for debugging; never crash the shell.
    // eslint-disable-next-line no-console
    console.error('Dashboard page error:', error);
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <div class="bg-surface border border-border rounded-xl p-6 max-w-lg mx-auto mt-12 text-center">
          <div class="flex items-center justify-center gap-2 mb-2">
            <span class="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden="true" />
            <h2 class="text-heading-sm font-semibold text-primary">Something went wrong on this page</h2>
          </div>
          <p class="text-body-sm text-secondary mb-4">
            This page hit an unexpected error and could not render. The rest of the dashboard is still working.
          </p>
          <button
            type="button"
            onClick={this.reset}
            class="inline-flex items-center px-3 py-1.5 rounded-lg text-body-sm font-medium bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
          >
            Try again
          </button>
        </div>
      );
    }
    return <>{this.props.children}</>;
  }
}
