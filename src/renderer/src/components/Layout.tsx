import { Outlet, useLocation } from 'react-router-dom'
import Sidebar from './Sidebar'

export default function Layout(): React.JSX.Element {
  const location = useLocation()
  const isGatewayRoute = location.pathname.startsWith('/gateway/')

  return (
    <div className="h-full flex bg-pitch">
      <Sidebar />
      <div className="flex-1 flex flex-col overflow-hidden">
        <div className="h-10 shrink-0 [-webkit-app-region:drag]" />
        <main className="flex-1 overflow-y-auto bg-pitch">
          <div className={`mx-auto px-6 pb-5 ${isGatewayRoute ? 'max-w-5xl' : 'max-w-4xl'}`}>
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}
