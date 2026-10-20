// Keeps one failing effect editor from taking down its window (or the gallery):
// shows the error in place of the editor and lets the user retry.

import { Component, type ReactNode } from 'react';

interface Props { name: string; width: number; height: number; children: ReactNode }
interface State { error: Error | null }

export class EditorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error): void {
    console.error(`${this.props.name} editor failed:`, error);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ width: this.props.width, height: this.props.height, background: '#3a3033', color: '#f2c9c9', font: '12px sans-serif', padding: 12, boxSizing: 'border-box', overflow: 'hidden' }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{this.props.name}: the editor failed to draw</div>
        <div style={{ opacity: 0.8, whiteSpace: 'pre-wrap', marginBottom: 10 }}>{String(this.state.error.message || this.state.error)}</div>
        <button onClick={() => this.setState({ error: null })} style={{ font: 'inherit' }}>Retry</button>
      </div>
    );
  }
}
