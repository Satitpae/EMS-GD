/**
 * MEA is grid import; solar is production consumed on site. Site energy and
 * coincident power are their sum. This model has no export or battery term.
 *
 * Energy comes only from matching consecutive cumulative-register endpoints.
 * Missing readings never become zero and intervals never bridge a gap.
 */
const QUARTER_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function dateFilter(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error('Date filters must use YYYY-MM-DD.');
  }
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid date filter.');
  }
  return value;
}

const hasRegister = row => Number.isFinite(row?.energy) && row.energy > 0;
const powerAt = row => hasRegister(row) && Number.isFinite(row.demand) && row.demand >= 0
  ? row.demand : null;
const share = (solar, load) => load !== null && load > 0 ? solar / load * 100 : null;
const maximum = (previous, current) => current === null ? previous
  : previous === null ? current : Math.max(previous, current);

function registerDelta(first, last) {
  if (!hasRegister(first) || !hasRegister(last) || last.energy < first.energy) return null;
  return last.energy - first.energy;
}

function readingsByTime(dataset) {
  const readings = dataset.allRows ?? dataset.rows;
  if (!Array.isArray(readings)) throw new Error('A parsed TOU dataset is required for each meter.');
  return new Map(readings.map(row => [row.ts, row]));
}

/**
 * Compare parsed TOU datasets from the same calendar month. Date filters select
 * interval START dates, including each day's closing next-midnight register.
 * The report's calendar-first-day baseline omits 00:00–00:15 only on day one.
 * Null energy means no valid paired interval, rather than measured zero use.
 */
export function analyzeBalance(grid, solar, {from, to} = {}) {
  if (!grid || !solar || grid.period !== solar.period) {
    throw new Error('Grid and solar meter periods must match.');
  }
  const period = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(grid.period);
  if (!period) throw new Error('A valid meter calendar period is required.');
  if (grid.meter && solar.meter && grid.meter === solar.meter) {
    throw new Error('Grid and solar must be different meters.');
  }
  const lower = dateFilter(from);
  const upper = dateFilter(to);
  if (lower && upper && lower > upper) throw new Error('Date range start must precede its end.');

  const gridReadings = readingsByTime(grid);
  const solarReadings = readingsByTime(solar);
  const year = Number(period[1]);
  const month = Number(period[2]);
  const monthStart = Date.UTC(year, month - 1, 1);
  const monthEnd = Date.UTC(year, month, 1);
  const rows = [];
  const days = [];
  const totals = {
    gridKwh: null, solarKwh: null, loadKwh: null, solarSharePct: null,
    gridPeakKw: null, solarPeakKw: null, loadPeakKw: null, peakAt: null,
    validIntervals: 0, expectedIntervals: 0, incompleteDays: 0, completeDays: 0
  };

  for (let dayStart = monthStart; dayStart < monthEnd; dayStart += DAY_MS) {
    const date = new Date(dayStart).toISOString().slice(0, 10);
    if ((lower && date < lower) || (upper && date > upper)) continue;
    const firstQuarter = dayStart === monthStart ? 1 : 0;
    const day = {
      date, gridKwh: null, solarKwh: null, loadKwh: null, solarSharePct: null,
      gridPeakKw: null, solarPeakKw: null, loadPeakKw: null,
      validIntervals: 0, expectedIntervals: 96 - firstQuarter, status: 'no-data'
    };

    // Demand remains instantaneous. Include the shared closing boundary for
    // peak reporting, but keep chart rows within the selected calendar dates.
    for (let quarter = 0; quarter <= 96; quarter++) {
      const ts = dayStart + quarter * QUARTER_MS;
      const gridKw = powerAt(gridReadings.get(ts));
      const solarKw = powerAt(solarReadings.get(ts));
      const valid = gridKw !== null && solarKw !== null;
      const loadKw = valid ? gridKw + solarKw : null;
      const iso = new Date(ts).toISOString();
      if (quarter < 96) {
        rows.push({date, time: iso.slice(11, 16), ts, gridKw, solarKw, loadKw, valid});
      }
      day.gridPeakKw = maximum(day.gridPeakKw, gridKw);
      day.solarPeakKw = maximum(day.solarPeakKw, solarKw);
      day.loadPeakKw = maximum(day.loadPeakKw, loadKw);
      totals.gridPeakKw = maximum(totals.gridPeakKw, gridKw);
      totals.solarPeakKw = maximum(totals.solarPeakKw, solarKw);
      if (loadKw !== null && (totals.loadPeakKw === null || loadKw > totals.loadPeakKw)) {
        totals.loadPeakKw = loadKw;
        totals.peakAt = `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
      }
    }

    for (let quarter = firstQuarter; quarter < 96; quarter++) {
      const start = dayStart + quarter * QUARTER_MS;
      const end = start + QUARTER_MS;
      const gridDelta = registerDelta(gridReadings.get(start), gridReadings.get(end));
      const solarDelta = registerDelta(solarReadings.get(start), solarReadings.get(end));
      if (gridDelta === null || solarDelta === null) continue;
      day.gridKwh = (day.gridKwh ?? 0) + gridDelta;
      day.solarKwh = (day.solarKwh ?? 0) + solarDelta;
      day.validIntervals++;
    }

    if (day.validIntervals) {
      day.loadKwh = day.gridKwh + day.solarKwh;
      day.solarSharePct = share(day.solarKwh, day.loadKwh);
      day.status = day.validIntervals === day.expectedIntervals ? 'complete' : 'incomplete';
      totals.gridKwh = (totals.gridKwh ?? 0) + day.gridKwh;
      totals.solarKwh = (totals.solarKwh ?? 0) + day.solarKwh;
    }
    totals.validIntervals += day.validIntervals;
    totals.expectedIntervals += day.expectedIntervals;
    if (day.status === 'complete') totals.completeDays++;
    else totals.incompleteDays++;
    days.push(day);
  }

  if (totals.validIntervals) {
    totals.loadKwh = totals.gridKwh + totals.solarKwh;
    totals.solarSharePct = share(totals.solarKwh, totals.loadKwh);
  }
  return {
    period: grid.period, days, totals, rows,
    coveragePct: totals.expectedIntervals ? totals.validIntervals / totals.expectedIntervals * 100 : null,
    gridMeter: grid.meter, solarMeter: solar.meter
  };
}
