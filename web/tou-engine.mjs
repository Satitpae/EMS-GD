/** Original, dependency-free TOUReg reader and report-policy calculation engine. */
const QUARTER_MS = 15 * 60 * 1000;
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = value => String(value).padStart(2, '0');

// PEA's published 2569 Off-Peak calendar. Weekends also count as holidays.
export const CALENDAR_SOURCE = 'https://www.pea.co.th/sites/default/files/users/user36/Off-Peak_Calendar_2569_0.jpg';
const PEA_2026 = new Set([
  '01-01', '03-03', '04-06', '04-13', '04-14', '04-15', '05-01', '05-04',
  '05-31', '06-03', '07-28', '07-29', '07-30', '08-12', '10-13', '10-23',
  '12-05', '12-10', '12-31'
].map(day => `2026-${day}`));

/** Timestamps are nominal meter wall times; UTC is used only for stable labels. */
export function parseTou(arrayBuffer, filename) {
  const name = String(filename || '').split(/[\\/]/).at(-1);
  const match = /^(.+)(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(\d{2})\.tou$/i.exec(name);
  if (!match) throw new Error('TOU filename must end in a month and year, such as MeterSep26.tou.');
  const year = 2000 + Number(match[3]);
  const month = MONTH_NAMES.indexOf(match[2].toLowerCase()) + 1;
  const period = `${year}-${pad(month)}`;
  const meter = match[1].replace(/[\s_-]+$/, '') || match[1];
  const bytes = ArrayBuffer.isView(arrayBuffer)
    ? new Uint8Array(arrayBuffer.buffer, arrayBuffer.byteOffset, arrayBuffer.byteLength)
    : new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start, end) => new TextDecoder('ascii').decode(bytes.subarray(start, end));
  if (bytes.byteLength < 64 || text(0, 8) !== 'TOUReg\0\0') throw new Error('Unsupported TOUReg header.');
  if (view.getUint16(8, true) !== 64) throw new Error('Invalid TOU header size.');
  if ((bytes.byteLength - 64) % 16) throw new Error('Invalid TOU record length.');
  const stamp = /^(\d{2})\/(\d{2})\/(\d{4})(\d{2}):(\d{2}):(\d{2})$/.exec(text(10, 28));
  if (!stamp) throw new Error('Invalid TOU header date.');
  const [, dd, mm, yyyy, hh, min, sec] = stamp;
  const checked = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
  if (+mm < 1 || +mm > 12 || +dd < 1 || checked.getUTCDate() !== +dd || +hh > 23 || +min > 59 || +sec > 59) {
    throw new Error('Invalid TOU header date.');
  }
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 1);
  const allRows = [];
  const rows = [];
  for (let index = 0; index < (bytes.byteLength - 64) / 16; index++) {
    const demand = view.getFloat64(64 + index * 16, true);
    const energy = view.getFloat64(72 + index * 16, true);
    if (!Number.isFinite(demand) || !Number.isFinite(energy)) throw new Error(`Invalid numeric value in TOU row ${index + 1}.`);
    const ts = monthStart + index * QUARTER_MS;
    const iso = new Date(ts).toISOString();
    const row = {index, ts, date: iso.slice(0, 10), time: iso.slice(11, 16), demand, energy, missing: demand === 0 && energy === 0};
    allRows.push(row);
    if (ts < monthEnd) rows.push(row);
  }
  return {
    name, meter, period, year, month, rows, allRows,
    updated: `${yyyy}-${mm}-${dd} ${hh}:${min}:${sec}`,
    outside: allRows.length - rows.length
  };
}

const sumKnown = values => values.some(value => value !== null)
  ? values.reduce((sum, value) => sum + (value ?? 0), 0)
  : null;
const highestDemand = rows => {
  const valid = rows.filter(row => !row.missing);
  return valid.length ? valid.reduce((highest, row) => Math.max(highest, row.demand), -Infinity) : null;
};
const isHoliday = date => {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6 || PEA_2026.has(date);
};

function checkDateFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Date filters must use YYYY-MM-DD.');
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('Invalid date filter.');
  return value;
}

/**
 * Energy follows register endpoints, never demand integration. Null represents an
 * unknown segment. Aggregates sum known values independently, as in the report.
 */
export function analyzeTou(dataset, {from, to} = {}) {
  const lower = checkDateFilter(from);
  const upper = checkDateFilter(to);
  if (lower && upper && lower > upper) throw new Error('Date range start must precede its end.');
  const selected = date => (!lower || date >= lower) && (!upper || date <= upper);
  const source = dataset.allRows || dataset.rows;
  const rows = dataset.rows.filter(row => selected(row.date));
  const dates = [...new Set(rows.map(row => row.date))];
  const monthStart = Date.UTC(dataset.year, dataset.month - 1, 1);
  let lastRegister = -1;
  for (let i = source.length - 1; i >= 0; i--) {
    if (source[i].energy !== 0) { lastRegister = i; break; }
  }
  const peakCandidates = [];
  const days = dates.map(date => {
    const offset = Math.round((new Date(`${date}T00:00:00Z`).getTime() - monthStart) / QUARTER_MS);
    const end = Math.min(96, lastRegister - offset);
    const start = offset === 0 ? 1 : 0;
    const observed = source.slice(offset, offset + Math.max(0, end + 1));
    const holidayDay = isHoliday(date);
    const issues = new Set();
    const fallbacks = new Map();
    const at = quarter => source[offset + quarter];
    const boundary = quarter => {
      if (holidayDay || (quarter !== 36 && quarter !== 88) || at(quarter)?.energy !== 0) return quarter;
      let previous = quarter - 1;
      while (previous >= 0 && at(previous)?.energy === 0) previous--;
      if (previous >= 0 && at(previous)) {
        fallbacks.set(quarter, previous);
        issues.add(`${at(quarter).time} register missing; used ${at(previous).time}.`);
        return previous;
      }
      return quarter;
    };
    const difference = (first, last) => {
      const a = boundary(first);
      const b = boundary(last);
      const left = at(a);
      const right = at(b);
      if (!left || !right || left.energy === 0 || right.energy === 0) {
        const label = quarter => quarter === 96 ? 'next midnight' : at(quarter)?.time || 'endpoint';
        if (!left || left.energy === 0) issues.add(`Missing energy register at ${label(a)}.`);
        if (!right || right.energy === 0) issues.add(`Missing energy register at ${label(b)}.`);
        return null;
      }
      let previous = null;
      for (let quarter = a; quarter <= b; quarter++) {
        const row = at(quarter);
        if (row.energy === 0) continue;
        if (previous !== null && row.energy < previous) {
          issues.add(`Energy register decreased at ${row.time}.`);
          return null;
        }
        previous = row.energy;
      }
      return right.energy - left.energy;
    };
    const total = end >= start ? difference(start, end) : null;
    let offpeak, onpeak, holiday;
    if (holidayDay) {
      offpeak = 0;
      onpeak = 0;
      holiday = total;
    } else {
      const morning = end >= start ? difference(start, Math.min(36, end)) : null;
      const night = end < 0 ? null : end <= 88 ? 0 : difference(88, end);
      offpeak = morning === null || night === null ? null : morning + night;
      onpeak = end < 0 ? null : end <= 36 ? 0 : difference(36, Math.min(88, end));
      holiday = 0;
    }
    const peakOff = holidayDay ? 0 : highestDemand([...observed.slice(0, 37), ...observed.slice(88)]);
    const peakOn = holidayDay ? 0 : highestDemand(observed.slice(36, 89));
    const peakHoliday = holidayDay ? highestDemand(observed) : 0;
    const gaps = observed.filter(row => row.energy === 0).length;
    const hasData = observed.slice(0, 96).some(row => !row.missing);
    const partial = end >= 0 && end < 96;
    if (gaps) issues.add(`${gaps} missing energy register${gaps === 1 ? '' : 's'}; demand may be incomplete.`);
    if (partial) issues.add(`Readings end at ${at(end).time}.`);
    if (!hasData) issues.add('No valid readings for this day.');
    const status = !hasData ? 'no-data'
      : total === null || offpeak === null || onpeak === null ? 'incomplete'
      : fallbacks.size ? 'boundary-fallback'
      : partial ? 'partial'
      : gaps ? 'gaps' : 'complete';
    peakCandidates.push(...observed.filter(row => !row.missing));
    return {
      date, offpeak, onpeak, holiday, total, peakOff, peakOn, peakHoliday,
      status, issues: [...issues], isHoliday: holidayDay, calendarKnown: date.startsWith('2026-'),
      startAt: start === 1 ? '00:15' : '00:00', endAt: end >= 0 ? at(end)?.time ?? null : null,
      partial, missingReadings: gaps
    };
  });
  let peak = null;
  for (const row of peakCandidates) if (!peak || row.demand > peak.demand) peak = row;
  const energy = Object.fromEntries(['offpeak', 'onpeak', 'holiday', 'total'].map(key => [key, sumKnown(days.map(day => day[key]))]));
  return {
    days, energy, peakDemand: peak?.demand ?? null,
    peakAt: peak ? `${peak.date} ${peak.time}` : null,
    validDays: days.filter(day => day.status === 'complete').length,
    incompleteDays: days.filter(day => day.status !== 'complete').length,
    missingReadings: rows.filter(row => row.missing).length,
    rows, period: dataset.period, meter: dataset.meter, calendarKnown: dataset.year === 2026
  };
}
