 
export function nowMsServerLike(clientTimeResult: unknown): number {
  if (Array.isArray(clientTimeResult)) {
    const sec = Number(clientTimeResult[0]);
    const usec = Number(clientTimeResult[1]);
    return Math.floor(sec * 1000 + usec / 1000);
  }
  return Date.now();
}

export function nextDailyBoundaryUtcMs(nowMs: number): number {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const nextDay = Date.UTC(y, m, day + 1, 0, 0, 0, 0);
  return nextDay;
}

export function nextMonthlyBoundaryUtcMs(nowMs: number): number {
  const d = new Date(nowMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const next = Date.UTC(y, m + 1, 1, 0, 0, 0, 0);
  return next;
}
