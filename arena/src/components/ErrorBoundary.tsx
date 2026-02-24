import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;
      return (
        <div className="glass-card rounded-xl text-center py-16 text-arena-elements-textSecondary">
          <div className="i-ph:warning-circle text-3xl mb-3 mx-auto text-amber-400" />
          <p className="mb-2">Something went wrong loading this component.</p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="text-sm text-violet-400 hover:text-violet-300 underline cursor-pointer"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
