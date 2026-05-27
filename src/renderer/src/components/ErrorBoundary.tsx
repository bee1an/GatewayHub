import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info)
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            padding: '2rem',
            textAlign: 'center'
          }}
        >
          <h1 style={{ fontSize: '1.25rem', fontWeight: 600, marginBottom: '1rem' }}>
            Something went wrong
          </h1>
          <pre
            style={{
              fontSize: '0.75rem',
              color: '#94a3b8',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              maxWidth: '100%',
              marginBottom: '1.5rem'
            }}
          >
            {this.state.error?.message}
          </pre>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '6px',
              border: '1px solid #334155',
              background: '#1e293b',
              color: '#e2e8f0',
              cursor: 'pointer',
              fontSize: '0.875rem'
            }}
          >
            Reload
          </button>
        </div>
      )
    }

    return this.props.children
  }
}
