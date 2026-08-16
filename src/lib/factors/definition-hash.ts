/**
 * 因子定義的正規化雜湊。純函式。
 *
 * 為什麼要正規化：`{a:1,b:2}` 與 `{b:2,a:1}` 是同一個定義，
 * 若直接 JSON.stringify 會得到不同雜湊，等於同一個因子可以重複登記兩次而不被發現。
 * 遞迴排序鍵值後再序列化，確保「同定義必同雜湊、異定義必異雜湊」。
 */

import { createHash } from 'node:crypto';
import type { FactorDefinition } from './types';

/** 遞迴排序物件鍵值，產生穩定的 JSON 字串 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    // 陣列順序有意義，不排序
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** SHA-256(canonicalJson(definition))，hex */
export function hashDefinition(definition: FactorDefinition): string {
  return createHash('sha256').update(canonicalJson(definition), 'utf8').digest('hex');
}
