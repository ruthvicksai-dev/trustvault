import React, { Component, type ReactNode, type ErrorInfo } from "react";
import { Button } from "@/components/ui/button";
import { RiAlertLine, RiRefreshLine } from "@remixicon/react";

export interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode | ((props: { error: Error; resetErrorBoundary: () => void }) => ReactNode);
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = {
    hasError: false,
    error: null,
  };

  public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  public override componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Uncaught error in error boundary:", error, errorInfo);
  }

  public resetErrorBoundary = () => {
    this.props.onReset?.();
    this.setState({ hasError: false, error: null });
  };

  private handleReload = () => {
    window.location.reload();
  };

  public override render() {
    if (this.state.hasError) {
      if (typeof this.props.fallback === "function") {
        return this.props.fallback({
          error: this.state.error!,
          resetErrorBoundary: this.resetErrorBoundary,
        });
      }
      if (this.props.fallback) {
        return this.props.fallback;
      }
      return (
        <div
          role="alert"
          aria-live="assertive"
          className="flex min-h-[50vh] w-full flex-col items-center justify-center gap-4 p-8 text-center"
        >
          <div className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <RiAlertLine className="size-6" />
          </div>
          <div className="space-y-1.5 max-w-md">
            <h2 className="text-base font-semibold text-foreground">
              Unable to load application
            </h2>
            <p className="text-xs text-muted-foreground">
              {this.state.error?.message || "An unexpected error occurred while loading this view. Please try reloading."}
            </p>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <Button
              variant="default"
              size="sm"
              onClick={this.handleReload}
              className="gap-2"
            >
              <RiRefreshLine className="size-4" />
              <span>Reload Application</span>
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
