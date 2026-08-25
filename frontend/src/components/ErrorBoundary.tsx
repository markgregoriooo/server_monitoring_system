import { Component, type ErrorInfo, type ReactNode } from "react";
import { GF as gf, STATUS } from "../theme/gf";

/**
 * Catches a render-time exception and shows a recoverable panel instead of a white page.
 *
 * There was no error boundary anywhere in the app. React's default on an uncaught render
 * error is to **unmount the entire tree** — so a single null-dereference in one panel
 * blanked the whole dashboard to a white screen, with the cause visible only in the
 * console. On a monitoring system that is the worst possible failure mode: the operator
 * cannot tell "the app broke" from "everything is fine and quiet", and a room could be on
 * fire behind a blank page.
 *
 * A boundary only catches errors thrown while RENDERING, in lifecycle methods, and in
 * constructors below it. It does **not** catch errors inside event handlers, in `setTimeout`,
 * or in promise rejections — those never unmounted the tree in the first place. It also
 * cannot catch an error thrown by itself or by anything above it, which is why this is
 * mounted inside the providers rather than around them.
 *
 * See audits/error-handling-report-2026-08-25.md — E-05.
 */
interface Props {
  children: ReactNode;
  /** Shown in the panel so the operator can say WHERE it broke. */
  label?: string;
}
interface State {
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The component stack is the part that actually locates the fault; React logs its
    // own copy in dev but strips it in production builds.
    console.error(
      `[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ""}] render failed:`,
      error,
      info.componentStack,
    );
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        className="flex items-center justify-center p-6"
        style={{ minHeight: "60vh", background: gf.bg }}
      >
        <div
          className="max-w-lg w-full p-5"
          style={{ background: gf.panel, border: `1px solid ${gf.border}`, borderRadius: 2 }}
        >
          <div
            className="text-[11px] tracking-[0.18em] uppercase mb-2"
            style={{ color: STATUS.red }}
          >
            Something broke on this page
          </div>
          <p className="text-[14px] leading-relaxed mb-3" style={{ color: gf.textPrimary }}>
            This part of the dashboard failed to render.{" "}
            <strong>Live monitoring and alerting are unaffected</strong> — they run on the
            server, not in this page.
          </p>
          <p className="text-[12.5px] leading-relaxed mb-4" style={{ color: gf.textMuted }}>
            Try again, or reload. If it keeps happening, the console holds the details a
            developer needs.
          </p>

          {/* The message only — never the stack. It can carry API payload fragments, and
              this panel is on screen in a shared server room. */}
          <pre
            className="text-[12px] overflow-x-auto p-2.5 mb-4"
            style={{ background: gf.well, color: gf.textMuted, borderRadius: 2 }}
          >
            {error.message || String(error)}
          </pre>

          <div className="flex gap-2">
            <button
              onClick={this.reset}
              className="gf-btn text-[13px] font-medium px-3 py-1.5"
              style={{ color: gf.accentText }}
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="gf-btn text-[13px] font-medium px-3 py-1.5"
              style={{ color: gf.textMuted }}
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
