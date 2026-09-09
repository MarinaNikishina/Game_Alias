import type { TurnSnapshot } from '../../shared/src/index.ts'

export function formatQueueState(turn: TurnSnapshot, viewerPlayerId: string | null) {
  if (turn.status === 'FINISHED') return String(turn.result ?? 0)
  if (turn.status === 'ACTIVE') return 'Играет сейчас'
  if (turn.status === 'ASSIGNED') {
    return viewerPlayerId === turn.playerId ? 'Ваш ход' : 'Ожидает старта'
  }
  return 'Ожидает'
}

export function remainingLabel(phaseEndsAt: string, serverNow: string) {
  const remaining = Math.max(0, new Date(phaseEndsAt).getTime() - new Date(serverNow).getTime())
  const totalSec = Math.ceil(remaining / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  return `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}
