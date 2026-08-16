/**
 * LINE 指令解析。純函式。
 *
 * 【v1 的鐵則：指令只寫紀錄，不會下單】
 * `/rec 買 2330 100 580` 的意思是「我剛剛在券商 App 買了」，
 * 不是「系統幫我買」。v1 不下單，這一層連下單的程式都不存在。
 * 自動下單要過 G1–G5 五道閘門才解鎖。
 *
 * 【解析失敗一律回覆用法，不猜】
 * 猜錯會把錯的數字寫進 append-only 的表，拔不掉。
 * 寧可要求重打一次。
 */

export type RecordAction = 'buy' | 'sell' | 'watch' | 'skip' | 'note';

export interface RecCommand {
  readonly kind: 'rec';
  readonly action: RecordAction;
  readonly code: string | null;
  readonly shares: number | null;
  readonly price: number | null;
  readonly note: string | null;
}

export interface SimpleCommand {
  readonly kind: 'help' | 'today' | 'status';
}

export interface ParseError {
  readonly kind: 'error';
  /** 給使用者看的說明，會原樣回覆到 LINE */
  readonly message: string;
}

export interface Ignored {
  readonly kind: 'ignored';
}

export type ParsedCommand = RecCommand | SimpleCommand | ParseError | Ignored;

/** 中文動作詞 → 內部代號。逐字比對，不做模糊猜測。 */
const ACTION_WORDS: ReadonlyMap<string, RecordAction> = new Map([
  ['買', 'buy'],
  ['買進', 'buy'],
  ['賣', 'sell'],
  ['賣出', 'sell'],
  ['觀望', 'watch'],
  ['略過', 'skip'],
  ['跳過', 'skip'],
  ['備註', 'note'],
]);

export const HELP_TEXT = [
  '📖 指令說明',
  '',
  '【紀錄你自己做了什麼】',
  '/rec 買 2330 100 580.5',
  '/rec 賣 2330 100 610',
  '/rec 觀望 6121 想再等等',
  '/rec 略過 1560 沒錢了',
  '/rec 備註 今天大盤怪怪的',
  '',
  '格式：/rec 動作 代號 股數 價格',
  '　　　觀望／略過：/rec 動作 代號 [原因]',
  '　　　備註：/rec 備註 內容',
  '',
  '【其他】',
  '/today　重看今天的清單',
  '/status　系統狀態',
  '/help　這則說明',
  '',
  '⚠️ 這些指令只做紀錄，不會下單。',
  'v1 不具備任何下單功能。',
].join('\n');

const USAGE_HINT = '格式：/rec 買 2330 100 580.5\n輸入 /help 看完整說明';

/** 台股代號：4～6 碼英數（第一上市外國公司為 6 碼，如 910322） */
const CODE_RE = /^[0-9A-Z]{4,6}$/;

function parseNumber(token: string | undefined): number | null {
  if (token === undefined) {
    return null;
  }
  const value = Number(token.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/**
 * 解析一則使用者訊息。
 *
 * 不是指令（不以 / 開頭）就回 `ignored`——
 * 使用者可能只是在頻道裡打字，不該每句話都回覆。
 */
export function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) {
    return { kind: 'ignored' };
  }

  const [rawCommand, ...rest] = trimmed.split(/\s+/);
  const command = (rawCommand ?? '').toLowerCase();

  if (command === '/help') return { kind: 'help' };
  if (command === '/today') return { kind: 'today' };
  if (command === '/status') return { kind: 'status' };
  if (command !== '/rec') {
    return { kind: 'error', message: `不認得指令 ${rawCommand}。\n輸入 /help 看可用指令。` };
  }

  const actionWord = rest[0];
  if (actionWord === undefined) {
    return { kind: 'error', message: `/rec 後面要接動作。\n${USAGE_HINT}` };
  }
  const action = ACTION_WORDS.get(actionWord);
  if (action === undefined) {
    return {
      kind: 'error',
      message: `不認得動作「${actionWord}」。\n可用：買、賣、觀望、略過、備註\n${USAGE_HINT}`,
    };
  }

  // 備註：後面全部都是內容，沒有代號
  if (action === 'note') {
    const note = rest.slice(1).join(' ').trim();
    if (note === '') {
      return { kind: 'error', message: '備註內容不可空白。\n例：/rec 備註 今天大盤怪怪的' };
    }
    return { kind: 'rec', action, code: null, shares: null, price: null, note };
  }

  const code = rest[1]?.toUpperCase();
  if (code === undefined) {
    return { kind: 'error', message: `「${actionWord}」後面要接股票代號。\n${USAGE_HINT}` };
  }
  if (!CODE_RE.test(code)) {
    return {
      kind: 'error',
      message: `「${code}」看起來不像股票代號（應為 4～6 碼英數）。\n${USAGE_HINT}`,
    };
  }

  // 觀望／略過：代號之後全部視為原因
  if (action === 'watch' || action === 'skip') {
    const note = rest.slice(2).join(' ').trim();
    return { kind: 'rec', action, code, shares: null, price: null, note: note === '' ? null : note };
  }

  // 買／賣：必須有股數與價格，缺一不猜
  const shares = parseNumber(rest[2]);
  const price = parseNumber(rest[3]);
  if (shares === null || price === null) {
    return {
      kind: 'error',
      message: `「${actionWord}」需要股數與價格。\n${USAGE_HINT}`,
    };
  }
  if (!Number.isInteger(shares) || shares <= 0) {
    return { kind: 'error', message: `股數要是正整數，收到「${rest[2]}」。` };
  }
  if (price <= 0) {
    return { kind: 'error', message: `價格要大於 0，收到「${rest[3]}」。` };
  }

  const note = rest.slice(4).join(' ').trim();
  return { kind: 'rec', action, code, shares, price, note: note === '' ? null : note };
}

const ACTION_LABEL: Readonly<Record<RecordAction, string>> = {
  buy: '買進',
  sell: '賣出',
  watch: '觀望',
  skip: '略過',
  note: '備註',
};

/** 寫入成功後回覆使用者的確認訊息 */
export function confirmationText(cmd: RecCommand, dataAsOf: string | null): string {
  const lines = [`✅ 已記錄：${ACTION_LABEL[cmd.action]}`];
  if (cmd.code !== null) {
    lines.push(`代號　${cmd.code}`);
  }
  if (cmd.shares !== null && cmd.price !== null) {
    lines.push(`數量　${cmd.shares.toLocaleString()} 股 @ ${cmd.price}`);
    lines.push(`金額　約 ${Math.round(cmd.shares * cmd.price).toLocaleString()} 元（未計手續費）`);
  }
  if (cmd.note !== null) {
    lines.push(`備註　${cmd.note}`);
  }
  if (dataAsOf !== null) {
    lines.push(`對應清單　${dataAsOf}`);
  }
  lines.push('');
  lines.push('紀錄不可修改。打錯的話再送一次，');
  lines.push('同一天同一檔以最後一筆為準。');
  return lines.join('\n');
}
