export type ScheduleMode = "off" | "hourly" | "six_hours" | "daily" | "custom";

export const MIN_INTERVAL_MINUTES = 15;

export function intervalForMode(mode: ScheduleMode, custom: number | null | undefined): number | null {
  switch (mode) {
    case "hourly":
      return 60;
    case "six_hours":
      return 360;
    case "daily":
      return 1440;
    case "custom":
      return custom && custom >= MIN_INTERVAL_MINUTES ? custom : null;
    default:
      return null;
  }
}

export function nextRunFrom(now: Date, intervalMinutes: number): Date {
  return new Date(now.getTime() + intervalMinutes * 60_000);
}

export function dailyRunEstimate(intervalMinutes: number | null): number {
  return intervalMinutes ? Math.floor(1440 / intervalMinutes) : 0;
}
