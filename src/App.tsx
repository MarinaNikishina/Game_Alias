import { Navigate, Route, Routes } from 'react-router-dom'
import AdminHomePage from './pages/AdminHomePage'
import AdminGamePage from './pages/AdminGamePage'
import JoinPage from './pages/JoinPage'
import PlayerGamePage from './pages/PlayerGamePage'
import RulesPage from './pages/RulesPage'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/admin" replace />} />
      <Route path="/admin" element={<AdminHomePage />} />
      <Route path="/admin/game/:gameId" element={<AdminGamePage />} />
      <Route path="/join/:publicCode" element={<JoinPage />} />
      <Route path="/game/:gameId/rules" element={<RulesPage />} />
      <Route path="/game/:gameId" element={<PlayerGamePage />} />
    </Routes>
  )
}
