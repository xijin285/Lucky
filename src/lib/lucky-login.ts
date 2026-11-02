import { JSEncrypt } from 'jsencrypt';

import { toLuckyProxyUrl } from '@/src/lib/web-proxy';
import type { LuckyRecord } from '@/src/types/lucky';

// 新版 Lucky 登录改为「挑战-加密」机制：先 GET /api/login/challenge 拿到
// challengeId/nonce/RSA 公钥，把 {account,password,twoFA,challengeId,nonce} 加密后
// 以 {challengeId, cipherText} 提交。与官方网页端实现保持一致（jsencrypt，PKCS#1 v1.5，
// 超过 120 字节的载荷按字符边界分块加密后用 "." 拼接）。旧版 Lucky 无挑战接口，自动回退明文登录。

export type LuckyLoginCredentials = {
  baseUrl: string;
  account: string;
  password: string;
  twoFACode?: string;
};

const REQUEST_TIMEOUT_MS = 12000;
const RSA_CHUNK_BYTES = 120;

// 与 src/lib/lucky-fetch.ts 的 createLuckyRequestNonce 一致（独立实现避免循环依赖）
function legacyRequestNonce(now = Date.now()): string {
  const timestamp = String(now).slice(0, -1);
  const checksum = [...timestamp].reduce((sum, digit) => sum + Number(digit), 0) % 8;
  return `${timestamp}${checksum}`;
}

function randomSessionId(): string {
  const bytes = new Uint8Array(32);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index++) bytes[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; index++; }
    else bytes += 3;
  }
  return bytes;
}

function splitUtf8ByByteLimit(value: string, limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const char of value) {
    const size = utf8ByteLength(char);
    if (current && currentBytes + size > limit) {
      chunks.push(current);
      current = '';
      currentBytes = 0;
    }
    current += char;
    currentBytes += size;
  }
  if (current) chunks.push(current);
  return chunks;
}

// 与官方网页端一致：JSON 序列化后转义孤立代理对，避免 encodeURIComponent 差异
function encodeLoginPayload(value: LuckyRecord): string {
  return JSON.stringify(value).replace(/[\uD800-\uDFFF]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

function encryptLoginPayload(publicKey: string, text: string): string | false {
  const encryptor = new JSEncrypt();
  encryptor.setPublicKey(publicKey);
  if (utf8ByteLength(text) <= RSA_CHUNK_BYTES) return encryptor.encrypt(text);
  const parts = splitUtf8ByByteLimit(text, RSA_CHUNK_BYTES)
    .map((chunk) => encryptor.encrypt(chunk));
  if (parts.some((part) => !part)) return false;
  return parts.join('.');
}

async function fetchJsonWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLoginChallenge(baseUrl: string, sessionHeader: string): Promise<LuckyRecord | undefined> {
  try {
    const response = await fetchJsonWithTimeout(toLuckyProxyUrl(`${baseUrl.trim().replace(/\/+$/, '')}/api/login/challenge`), {
      headers: { Accept: 'application/json', 'Lucky-Login-Session': sessionHeader },
    });
    if (!response.ok) return undefined;
    const payload = await response.json() as LuckyRecord;
    if (Number(payload.ret) !== 0 || !payload.challengeId || !payload.nonce || !payload.publicKey) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}

export async function postLuckyLogin(credentials: LuckyLoginCredentials): Promise<{ response: Response; payload: LuckyRecord }> {
  const base = credentials.baseUrl.trim().replace(/\/+$/, '');
  const account = credentials.account.trim();
  const twoFACode = credentials.twoFACode?.trim() ?? '';
  const sessionHeader = randomSessionId();

  const challenge = await fetchLoginChallenge(base, sessionHeader);
  if (challenge) {
    const payloadText = encodeLoginPayload({
      account,
      password: credentials.password,
      twoFA: twoFACode,
      challengeId: challenge.challengeId,
      nonce: challenge.nonce,
    });
    const cipherText = encryptLoginPayload(String(challenge.publicKey), payloadText);
    if (cipherText) {
      const response = await fetchJsonWithTimeout(toLuckyProxyUrl(`${base}/api/login`), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'Lucky-Login-Session': sessionHeader,
        },
        body: JSON.stringify({ challengeId: challenge.challengeId, cipherText }),
      });
      let payload: LuckyRecord;
      try {
        payload = await response.json() as LuckyRecord;
      } catch {
        throw new Error(response.ok ? '登录失败：服务器返回了无法识别的数据' : `登录失败（HTTP ${response.status}）`);
      }
      return { response, payload };
    }
  }

  // 旧版 Lucky：无挑战机制，直接明文提交
  const response = await fetchJsonWithTimeout(toLuckyProxyUrl(`${base}/api/login?_=${legacyRequestNonce()}`), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ Account: account, Password: credentials.password, TwoFA: '', TwoFACode: twoFACode }),
  });
  let payload: LuckyRecord;
  try {
    payload = await response.json() as LuckyRecord;
  } catch {
    throw new Error(response.ok ? '登录失败：服务器返回了无法识别的数据' : `登录失败（HTTP ${response.status}）`);
  }
  return { response, payload };
}
