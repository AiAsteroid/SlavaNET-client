import { Navigate } from 'react-router-dom'
import Proxies from '@renderer/pages/proxies'
import Rules from '@renderer/pages/rules'
import Settings from '@renderer/pages/settings'
import SettingsAppearance from '@renderer/pages/settings-appearance'
import SettingsAdvanced from '@renderer/pages/settings-advanced'
import SettingsShortcuts from '@renderer/pages/settings-shortcuts'
import Profiles from '@renderer/pages/profiles'
import Logs from '@renderer/pages/logs'
import Connections from '@renderer/pages/connections'
import Mihomo from '@renderer/pages/mihomo'
import Sysproxy from '@renderer/pages/syspeoxy'
import Tun from '@renderer/pages/tun'
import Resources from '@renderer/pages/resources'
import DNS from '@renderer/pages/dns'
import Sniffer from '@renderer/pages/sniffer'
import Home from '@renderer/pages/home'
import More from '@renderer/pages/more'
import Subscription from '@renderer/pages/subscription'
const routes = [
  // Разделы настроек — отдельные маршруты, а не состояние внутри экрана.
  // Иначе возврат «назад» выбрасывал бы из раздела в корень приложения.
  // Второй уровень «Ещё». Маршрутом, а не состоянием: иначе возврат с
  // диагностического экрана выбрасывает мимо списка, из которого в него вошли.
  {
    path: '/more/diagnostics',
    element: <More />
  },
  {
    path: '/settings/appearance',
    element: <SettingsAppearance />
  },
  {
    path: '/settings/advanced',
    element: <SettingsAdvanced />
  },
  {
    path: '/settings/shortcuts',
    element: <SettingsShortcuts />
  },
  {
    path: '/mihomo',
    element: <Mihomo />
  },
  {
    path: '/sysproxy',
    element: <Sysproxy />
  },
  {
    path: '/tun',
    element: <Tun />
  },
  {
    path: '/proxies',
    element: <Proxies />
  },
  {
    path: '/rules',
    element: <Rules />
  },
  {
    path: '/resources',
    element: <Resources />
  },
  {
    path: '/dns',
    element: <DNS />
  },
  {
    path: '/sniffer',
    element: <Sniffer />
  },
  {
    path: '/logs',
    element: <Logs />
  },
  {
    path: '/connections',
    element: <Connections />
  },
  {
    path: '/profiles',
    element: <Profiles />
  },
  {
    path: '/settings',
    element: <Settings />
  },
  {
    path: '/',
    element: <Navigate to="/home" />
  },
  {
    path: '/home',
    element: <Home />
  },
  {
    path: '/more',
    element: <More />
  },
  {
    path: '/subscription',
    element: <Subscription />
  }
]

export default routes
