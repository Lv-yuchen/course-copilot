/**
 * Scalar parsing helpers shared by every adapter.
 *
 * Selection-system pages are inconsistent about units, separators, and
 * placeholders. These helpers therefore return `undefined` for "not stated"
 * rather than `0`, which is what lets the availability model distinguish
 * "full" from "unknown".
 *
 * @module @course-copilot/core/parse
 */

/** Characters a page may use for "no value". */
const PLACEHOLDERS = new Set([
  '', '-', '--', '---', '—', '——', '/', 'n/a', 'na', 'null', 'nil',
  '无', '未知', '不详', '暂无', '空', 'none', '?', '？',
]);

/** Text a page uses to mean "the course is full". */
const FULL_MARKERS = ['已满', '满员', '已选满', '无余量', 'full', 'closed'];

/** Text a page uses to mean "a seat is free" without giving a number. */
const AVAILABLE_MARKERS = ['可选', '有余量', '充足', 'available', 'open'];

/**
 * Is this cell empty of information?
 *
 * @param value - raw cell text.
 * @returns true for blank text and known placeholders.
 */
export function isPlaceholder(value: string | undefined): boolean {
  if (value === undefined) return true;
  const normalized = value.replace(/[\s\u00A0\u3000]+/gu, '').toLowerCase();
  return PLACEHOLDERS.has(normalized);
}

/**
 * Parse an integer from free text.
 *
 * @param value - raw text, possibly with units or thousands separators.
 * @returns the integer, or `undefined` when the text states no number.
 */
export function parseIntOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize('NFKC').replace(/[\s\u00A0\u3000,，]/gu, '');
  const match = /-?\d+(?:\.\d+)?/u.exec(normalized);
  if (match === null) return undefined;
  const number = Number.parseFloat(match[0]);
  if (!Number.isFinite(number)) return undefined;
  return Math.trunc(number);
}

/**
 * Parse a decimal number from free text.
 *
 * @param value - raw text such as `2.5 学分`.
 * @returns the number, or `undefined` when none is stated.
 */
export function parseNumberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const normalized = value.normalize('NFKC').replace(/[\s\u00A0\u3000,，]/gu, '');
  const match = /-?\d+(?:\.\d+)?/u.exec(normalized);
  if (match === null) return undefined;
  const number = Number.parseFloat(match[0]);
  return Number.isFinite(number) ? number : undefined;
}

/** Result of reading a seat cell. */
export interface SeatReading {
  remainingSeats?: number;
  capacity?: number;
  /** True when the cell explicitly says the course is full. */
  explicitlyFull: boolean;
  /** True when the cell explicitly says seats are available but gives no count. */
  explicitlyAvailable: boolean;
}

/**
 * Read a capacity/remaining-seat cell.
 *
 * Handles the shapes real systems use:
 * - `30` — a bare remaining count.
 * - `12/50` or `12 / 50` — remaining/capacity.
 * - `已选 38 / 容量 50` — selected/capacity, so remaining is derived.
 * - `已满` / `0` — full.
 * - `--` / `未知` — unknown, NOT zero.
 *
 * @param value - raw cell text.
 * @param roleGuess - which number the column is expected to hold.
 * @returns the reading, with `explicitlyFull` set only on positive evidence.
 */
export function readSeatCell(
  value: string | undefined,
  roleGuess: 'remaining' | 'capacity' | 'ratio' = 'ratio',
): SeatReading {
  if (value === undefined) return { explicitlyFull: false, explicitlyAvailable: false };
  const text = value.normalize('NFKC');
  const lowered = text.toLowerCase();

  if (isPlaceholder(text)) return { explicitlyFull: false, explicitlyAvailable: false };

  if (FULL_MARKERS.some((marker) => lowered.includes(marker))) {
    return { remainingSeats: 0, explicitlyFull: true, explicitlyAvailable: false };
  }
  if (AVAILABLE_MARKERS.some((marker) => lowered.includes(marker))) {
    const number = parseIntOrUndefined(text);
    if (number === undefined) return { explicitlyFull: false, explicitlyAvailable: true };
  }

  const numbers = [...text.matchAll(/\d+/gu)].map((match) => Number.parseInt(match[0], 10));
  const mentionsSelected = /已选|已报名|选课人数|申请人数|enrolled|selected/u.test(text);
  const mentionsCapacity = /容量|上限|限额|课容量|capacity|limit|quota/u.test(text);
  const mentionsRemaining = /余量|剩余|余额|余|remaining|left|available/u.test(text);

  if (numbers.length === 0) return { explicitlyFull: false, explicitlyAvailable: false };
  if (numbers.length === 1) {
    const only = numbers[0] as number;
    if (roleGuess === 'capacity' || mentionsCapacity) {
      return { capacity: only, remainingSeats: undefined, explicitlyFull: false, explicitlyAvailable: false };
    }
    if (mentionsSelected) {
      return { remainingSeats: undefined, capacity: undefined, explicitlyFull: false, explicitlyAvailable: false };
    }
    if (only === 0 && mentionsRemaining) {
      return { remainingSeats: 0, explicitlyFull: true, explicitlyAvailable: false };
    }
    return { remainingSeats: only, explicitlyFull: only === 0, explicitlyAvailable: false };
  }

  // Two or more numbers: the first pair is what matters.
  const [first, second] = numbers as [number, number, ...number[]];
  if (mentionsCapacity && !mentionsRemaining && mentionsSelected) {
    // `已选 38 / 容量 50`
    return {
      capacity: second,
      remainingSeats: Math.max(0, second - first),
      explicitlyFull: second - first <= 0,
      explicitlyAvailable: second - first > 0,
    };
  }
  if (mentionsCapacity && !mentionsRemaining && !mentionsSelected) {
    return { capacity: second, remainingSeats: first, explicitlyFull: first <= 0, explicitlyAvailable: first > 0 };
  }
  if (mentionsRemaining) {
    return { remainingSeats: first, capacity: second, explicitlyFull: first <= 0, explicitlyAvailable: first > 0 };
  }
  // `remaining/capacity` is the most common unlabelled layout.
  if (first <= second) {
    return { remainingSeats: first, capacity: second, explicitlyFull: first <= 0, explicitlyAvailable: first > 0 };
  }
  // `capacity/remaining` also exists; avoid inventing a negative remainder.
  return { remainingSeats: second, capacity: first, explicitlyFull: second <= 0, explicitlyAvailable: second > 0 };
}

/**
 * Split a schedule cell into separate entries.
 *
 * @param value - raw cell text, possibly multi-line.
 * @param lines - pre-split lines when the caller already has them.
 * @returns non-empty trimmed entries, in page order.
 */
export function readSchedule(value: string | undefined, lines: readonly string[] = []): string[] {
  if (lines.length > 0) {
    return lines.map((line) => line.replace(/[\s\u00A0]+/gu, ' ').trim()).filter((line) => line.length > 0);
  }
  if (value === undefined) return [];
  return value
    .split(/[\r\n;；]+|\s{2,}/u)
    .map((part) => part.replace(/[\s\u00A0]+/gu, ' ').trim())
    .filter((part) => part.length > 0);
}

/**
 * Read a credits cell.
 *
 * @param value - raw cell text such as `2`, `2.0`, `2学分`.
 * @returns the credit value, or `undefined` when not stated or implausible.
 */
export function readCredits(value: string | undefined): number | undefined {
  const number = parseNumberOrUndefined(value);
  if (number === undefined) return undefined;
  if (number < 0 || number > 30) return undefined;
  return number;
}

/**
 * Normalize a cell's text for storage.
 *
 * @param value - raw text.
 * @returns collapsed text, or `undefined` for placeholders.
 */
export function cleanCell(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/[\s\u00A0\u3000]+/gu, ' ').trim();
  if (isPlaceholder(cleaned)) return undefined;
  return cleaned;
}

/**
 * Convert a Chinese numeral to an integer, for cells written as `十八`.
 *
 * @param value - text possibly containing Chinese numerals.
 * @returns the integer, or `undefined` when the text is not a simple numeral.
 */
export function chineseNumeralToNumber(value: string): number | undefined {
  const digits: Record<string, number> = {
    零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  const text = value.trim();
  if (text.length === 0) return undefined;
  const tenMatch = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u.exec(text);
  if (tenMatch !== null) {
    const tens = tenMatch[1] === undefined ? 1 : (digits[tenMatch[1]] ?? 0);
    const ones = tenMatch[2] === undefined ? 0 : (digits[tenMatch[2]] ?? 0);
    return tens * 10 + ones;
  }
  if (text.length === 1 && digits[text] !== undefined) return digits[text];
  return undefined;
}
