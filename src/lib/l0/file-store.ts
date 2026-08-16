/**
 * append-only 本機檔案儲存。
 *
 * 佈局：
 *   <root>/manifest.jsonl                                  每次抓取一行，含失敗，永不覆寫
 *   <root>/<sourceId>/<dataAsOf|unknown-date>/<hash>.json  原始 bytes，內容定址
 *
 * append-only 如何保證：
 * 1. 檔名就是內容的 SHA-256 → 內容改變必然是不同檔案，不可能覆蓋舊資料。
 * 2. 寫入用 flag 'wx'（存在即失敗），不用 'w'。EEXIST 代表同內容已存過，回傳 written:false。
 * 3. 本模組不提供任何刪除或更新方法。
 *
 * P3 會換成 Supabase + RLS 封鎖 UPDATE/DELETE；屆時只換這個實作，抓取層不動。
 */

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ManifestEntry, PutResult, RawSnapshot, SnapshotStore } from './types';

export const MANIFEST_FILENAME = 'manifest.jsonl';
export const UNKNOWN_DATE_DIR = 'unknown-date';

function isEexist(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'EEXIST'
  );
}

export class FileSnapshotStore implements SnapshotStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  get root(): string {
    return this.#root;
  }

  bodyPathFor(snapshot: RawSnapshot): string {
    return path.join(
      this.#root,
      snapshot.sourceId,
      snapshot.dataAsOf ?? UNKNOWN_DATE_DIR,
      `${snapshot.contentHash}.json`,
    );
  }

  get manifestPath(): string {
    return path.join(this.#root, MANIFEST_FILENAME);
  }

  async put(snapshot: RawSnapshot, body: Uint8Array): Promise<PutResult> {
    const bodyPath = this.bodyPathFor(snapshot);
    await mkdir(path.dirname(bodyPath), { recursive: true });
    try {
      // 'wx'：檔案已存在即拋 EEXIST。絕不覆寫既有原始資料。
      await writeFile(bodyPath, body, { flag: 'wx' });
      return { bodyPath, written: true };
    } catch (error) {
      if (isEexist(error)) {
        return { bodyPath, written: false };
      }
      throw error;
    }
  }

  async appendManifest(entry: ManifestEntry): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await appendFile(this.manifestPath, `${JSON.stringify(entry)}\n`, 'utf8');
  }

  async readManifest(): Promise<readonly ManifestEntry[]> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath, 'utf8');
    } catch {
      return [];
    }
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as ManifestEntry);
  }
}
