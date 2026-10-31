export function zoneParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(date));
  return Object.fromEntries(
    parts
      .filter((x) => x.type !== "literal")
      .map((x) => [x.type, Number(x.value)]),
  );
}
export function localDate(date, timezone) {
  const p = zoneParts(date, timezone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}
export function zonedToUtc(day, minute, timezone) {
  const [y, m, d] = day.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d, 0, minute);
  let guess = target;
  for (let i = 0; i < 4; i++) {
    const p = zoneParts(guess, timezone);
    const represented = Date.UTC(
      p.year,
      p.month - 1,
      p.day,
      p.hour,
      p.minute,
      p.second,
    );
    const next = target - (represented - guess);
    if (next === guess) break;
    guess = next;
  }
  const check = zoneParts(guess, timezone);
  if (
    `${check.year}-${String(check.month).padStart(2, "0")}-${String(check.day).padStart(2, "0")}` !==
      day ||
    check.hour * 60 + check.minute !== minute
  )
    throw new Error("Horário local inexistente.");
  return new Date(guess);
}
export function validDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const date = new Date(s + "T12:00:00Z");
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === s;
}
export function addDays(day, n) {
  const d = new Date(day + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function minuteOf(date, timezone) {
  const p = zoneParts(date, timezone);
  return p.hour * 60 + p.minute;
}
export function weekdayOf(day) {
  return new Date(day + "T12:00:00Z").getUTCDay();
}
