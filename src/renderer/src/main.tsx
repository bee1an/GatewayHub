import '@unocss/reset/tailwind.css'
import 'virtual:uno.css'
import './assets/main.css'
import './i18n'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import GatewayDetail from './pages/GatewayDetail'
import Logs from './pages/Logs'
import ModelMappings from './pages/ModelMappings'
import ApiKeys from './pages/ApiKeys'
import Settings from './pages/Settings'
import { ToastProvider } from './components/ui/Toast'
import { UpgradeProgress } from './components/UpgradeProgress'
import ErrorBoundary from './components/ErrorBoundary'

const root = createRoot(document.getElementById('root')!)
const view = new URLSearchParams(window.location.search).get('view')

// Safety net: the splash is normally removed by <Sidebar> once the first
// gateway status lands. If that never happens (e.g. the renderer crashes
// before mount), force-remove it so the window never stays stuck on the
// spinner. Skip removal when Sidebar has already started its cross-fade
// (marked via `data-splash-dismissing`) so the two paths never race around
// the 8s boundary and the fade always gets to finish.
setTimeout(() => {
  const el = document.getElementById('splash')
  if (!el || el.dataset.splashDismissing === '1') return
  el.remove()
}, 8000)

if (view === 'progress') {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <UpgradeProgress />
      </ErrorBoundary>
    </StrictMode>
  )
} else {
  root.render(
    <StrictMode>
      <ErrorBoundary>
        <ToastProvider>
          <HashRouter>
            <Routes>
              <Route element={<Layout />}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard" element={<Dashboard />} />
                <Route path="gateway/:name" element={<GatewayDetail />} />
                <Route path="logs" element={<Logs />} />
                <Route path="api-keys" element={<ApiKeys />} />
                <Route path="model-mappings" element={<ModelMappings />} />
                <Route path="settings" element={<Settings />} />
              </Route>
            </Routes>
          </HashRouter>
        </ToastProvider>
      </ErrorBoundary>
    </StrictMode>
  )
}
