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
