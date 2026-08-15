/**
 * bigint 金額基礎運算。
 *
 * 為何不用浮點數：
 * 1. 中間值會溢位。成交額 1,000 萬元 = 1e9 分，× 1425 (ppm) × 10000 (bps)
 *    ≈ 1.4e16 > Number.MAX_SAFE_INTEGER (9.007e15)，會靜默失真。
 * 2. 手續費有最低額與「元以下」捨入，本質是整數運算；bigint 強迫捨入顯式化。
 * 3. 零依賴（不引入 decimal.js / big.js），符合「純函式、不依賴外部服務」。
 */

import type { Money, PriceInput, RoundingMode } from './types';

export const CENTS_PER_TWD = 100n;

/** 最多 2 位小數、可帶負號的十進位字串 */
const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

function numberToDecimalString(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`price must be a finite number, got ${String(value)}`);
  }
  const s = String(value);
  if (s.includes('e') || s.includes('E')) {
    throw new RangeError(`price out of supported range (exponential notation): ${s}`);
  }
  return s;
}

/**
 * 元 → 分。輸入超過 2 位小數即拋錯（錯誤擋在邊界，不讓誤差傳進計算）。
 * 刻意不使用 Math.round(x * 100)：避免浮點乘法引入誤差。
 */
export function parsePriceToCents(input: PriceInput): bigint {
  const raw = typeof input === 'string' ? input.trim() : numberToDecimalString(input);
  const m = DECIMAL_RE.exec(raw);
  if (m === null) {
    throw new RangeError(
      `price must be a decimal with at most 2 fraction digits, got "${raw}"`,
    );
  }
  const sign = m[1] ?? '';
  const whole = m[2] ?? '0';
  const frac = (m[3] ?? '').padEnd(2, '0');
  const cents = BigInt(whole) * CENTS_PER_TWD + BigInt(frac);
  return sign === '-' ? -cents : cents;
}

/** 分 → Money（附顯示字串） */
export function toMoney(cents: bigint): Money {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / CENTS_PER_TWD;
  const frac = abs % CENTS_PER_TWD;
  return {
    cents,
    twd: `${negative ? '-' : ''}${whole.toString()}.${frac.toString().padStart(2, '0')}`,
  };
}

/**
 * 整數除法 + 顯式捨入。模組內**唯一**的除法出口。
 * - floor：向下取整（負數更負）
 * - ceil：向上取整
 * - half_up：四捨五入，.5 遠離零
 */
export function divRound(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) {
    throw new RangeError('division by zero');
  }
  let n = numerator;
  let d = denominator;
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const q = n / d; // bigint 除法向零截斷
  const r = n % d;
  if (r === 0n) {
    return q;
  }
  switch (mode) {
    case 'floor':
      return n < 0n ? q - 1n : q;
    case 'ceil':
      return n < 0n ? q : q + 1n;
    case 'half_up': {
      const doubled = (r < 0n ? -r : r) * 2n;
      if (doubled < d) {
        return q;
      }
      return n < 0n ? q - 1n : q + 1n;
    }
  }
}

/** value × mul ÷ div，全程 bigint，最後一次捨入 */
export function mulDiv(value: bigint, mul: bigint, div: bigint, mode: RoundingMode): bigint {
  return divRound(value * mul, div, mode);
}

/** 將分捨入到整數元（回傳仍為分，個位固定為 00） */
export function roundToWholeTwd(cents: bigint, mode: RoundingMode): bigint {
  return divRound(cents, CENTS_PER_TWD, mode) * CENTS_PER_TWD;
}

/** a ÷ b 轉 number，保留 6 位小數（避免 bigint → number 直接轉換的精度風險） */
export function ratio(a: bigint, b: bigint): number {
  if (b === 0n) {
    throw new RangeError('ratio denominator is zero');
  }
  return Number(mulDiv(a, 1_000_000n, b, 'half_up')) / 1_000_000;
}
