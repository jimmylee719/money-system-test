/**
 * 環境變數載入與驗證。
 *
 * ⚠️ 本模組**永遠不會把金鑰內容放進錯誤訊息、回傳值或任何 log**。
 * 需要診斷時只提供 `describeSupabaseConfig()`，它只回報長度與網域。
 */

/**
 * 載入 .env.local（若存在）。使用 Node 內建的 process.loadEnvFile，不引入 dotenv。
 * 已存在的環境變數不會被覆蓋。回傳是否成功載入。
 */
export function loadEnvFileIfPresent(path = '.env.local'): boolean {
  try {
    process.loadEnvFile(path);
    return true;
  } catch {
    return false;
  }
}

export interface SupabaseConfig {
  readonly url: string;
  readonly serviceRoleKey: string;
  /** 選配：僅驗證用（證明匿名身分寫不進去） */
  readonly anonKey: string | null;
}

export class MissingEnvError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `缺少必要環境變數：${missing.join(', ')}。` +
        '請在專案根目錄的 .env.local 填寫後重試（該檔已被 gitignore 排除）。',
    );
    this.name = 'MissingEnvError';
    this.missing = missing;
  }
}

function read(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 讀取 Supabase 設定；缺漏時拋錯，錯誤訊息只含變數名稱，不含值。 */
export function loadSupabaseConfig(env: NodeJS.ProcessEnv = process.env): SupabaseConfig {
  const url = read(env, 'NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = read(env, 'SUPABASE_SERVICE_ROLE_KEY');

  const missing: string[] = [];
  if (url === null) {
    missing.push('NEXT_PUBLIC_SUPABASE_URL');
  }
  if (serviceRoleKey === null) {
    missing.push('SUPABASE_SERVICE_ROLE_KEY');
  }
  if (url === null || serviceRoleKey === null) {
    throw new MissingEnvError(missing);
  }

  if (!url.startsWith('https://')) {
    throw new RangeError('NEXT_PUBLIC_SUPABASE_URL 必須是 https:// 開頭的網址');
  }

  return {
    url: url.replace(/\/+$/, ''),
    serviceRoleKey,
    anonKey: read(env, 'NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  };
}

export interface LineConfig {
  readonly channelAccessToken: string;
  readonly channelSecret: string;
  /** 推播對象。v1 只推給你自己一個人。 */
  readonly userId: string;
}

/**
 * 讀取 LINE 設定；缺漏時拋錯，錯誤訊息只含變數名稱，不含值。
 *
 * ⚠️ 這三個值都是憑證，永遠不會被印出來。
 *    外洩時請到 LINE Developers Console 立即重新產生。
 */
export function loadLineConfig(env: NodeJS.ProcessEnv = process.env): LineConfig {
  const channelAccessToken = read(env, 'LINE_CHANNEL_ACCESS_TOKEN');
  const channelSecret = read(env, 'LINE_CHANNEL_SECRET');
  const userId = read(env, 'LINE_USER_ID');

  const missing: string[] = [];
  if (channelAccessToken === null) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (channelSecret === null) missing.push('LINE_CHANNEL_SECRET');
  if (userId === null) missing.push('LINE_USER_ID');
  if (channelAccessToken === null || channelSecret === null || userId === null) {
    throw new MissingEnvError(missing);
  }

  // LINE 的 user ID 一律以 U 開頭 + 32 碼十六進位。
  // 事先檢查可以避免把日報推到不存在的對象而只看到一個 400。
  if (!/^U[0-9a-f]{32}$/.test(userId)) {
    throw new RangeError(
      'LINE_USER_ID 格式不正確：應為 U 開頭加 32 碼十六進位字元。' +
        '（那是「你的 User ID」，不是 channel ID，也不是 LINE ID）',
    );
  }

  return { channelAccessToken, channelSecret, userId };
}

/** LINE 是否已設定（未設定時日報推播會略過，不讓整條管線失敗） */
export function hasLineConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    read(env, 'LINE_CHANNEL_ACCESS_TOKEN') !== null &&
    read(env, 'LINE_CHANNEL_SECRET') !== null &&
    read(env, 'LINE_USER_ID') !== null
  );
}

/** 可安全印出的 LINE 設定摘要——只有長度，沒有內容。 */
export function describeLineConfig(config: LineConfig): string {
  return (
    `access_token=${config.channelAccessToken.length} 字元 | ` +
    `channel_secret=${config.channelSecret.length} 字元 | ` +
    `user_id=${config.userId.slice(0, 3)}…（${config.userId.length} 字元）`
  );
}

/** Supabase 是否已設定（用來決定要走本機檔案還是資料庫） */
export function hasSupabaseConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    read(env, 'NEXT_PUBLIC_SUPABASE_URL') !== null &&
    read(env, 'SUPABASE_SERVICE_ROLE_KEY') !== null
  );
}

/** 可安全印出的設定摘要——只有網址與金鑰長度，沒有金鑰內容。 */
export function describeSupabaseConfig(config: SupabaseConfig): string {
  const anon = config.anonKey === null ? '未提供' : `${config.anonKey.length} 字元`;
  return (
    `url=${config.url} | service_role_key=${config.serviceRoleKey.length} 字元 | anon_key=${anon}`
  );
}
