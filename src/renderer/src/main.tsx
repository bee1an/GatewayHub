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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
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
  </StrictMode>
)
