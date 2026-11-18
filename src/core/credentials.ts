import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorkspacePaths } from './types.js';
import { readJson, writeJson } from './workspace.js';

/**
 * 凭据存储：AES-256-GCM 加密，主密码派生密钥（scrypt）。
 * 结构：{ version, salt, verifier, entries: { "<plugin>:<key>": { iv, tag, ct } } }
 */
interface Store {
  version: 1;
  salt: string;
  verifier: string;
  entries: Record<string, { iv: string; tag: string; ct: string }>;
}

const KEY_LEN = 32;

function derive(password: string, salt: Buffer): Buffer {
  return crypto.scryptSync(password, salt, KEY_LEN, { N: 16384, r: 8, p: 1 });
}

export class Vault {
  private store: Store;
  private key: Buffer | null = null;

  constructor(private file: string) {
    this.store = readJson<Store>(file, { version: 1, salt: '', verifier: '', entries: {} });
    if (!this.store.salt) {
      this.store.salt = crypto.randomBytes(16).toString('hex');
      writeJson(file, this.store);
    }
  }

  get initialized(): boolean {
    return Boolean(this.store.verifier);
  }

  get unlocked(): boolean {
    return this.key !== null;
  }

  /** 首次设定主密码 */
  init(password: string): void {
    if (this.initialized) throw new Error('主密码已设置，请用 unlock');
    const salt = Buffer.from(this.store.salt, 'hex');
    this.key = derive(password, salt);
    this.store.verifier = this.pack(this.encryptRaw('forgeapi-verifier', this.key));
    writeJson(this.file, this.store);
  }

  unlock(password: string): boolean {
    if (!this.initialized) throw new Error('尚未设置主密码，先执行 forge config vault init');
    const salt = Buffer.from(this.store.salt, 'hex');
    const k = derive(password, salt);
    try {
      const probe = this.decryptRaw(this.store.verifier, k);
      if (probe !== 'forgeapi-verifier') return false;
      this.key = k;
      return true;
    } catch {
      return false;
    }
  }

  lock(): void {
    this.key = null;
  }

  private encryptRaw(plain: string, key: Buffer) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return { ct: ct.toString('base64'), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64') };
  }

  private decryptRaw(b64: string, key: Buffer): string {
    // verifier 是纯密文；entries 走 decryptEntry
    const [ivS, tagS, ctS] = b64.split('.');
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivS, 'base64'));
    d.setAuthTag(Buffer.from(tagS, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ctS, 'base64')), d.final()]).toString('utf8');
  }

  private decryptEntry(e: { iv: string; tag: string; ct: string }, key: Buffer): string {
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(e.iv, 'base64'));
    d.setAuthTag(Buffer.from(e.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(e.ct, 'base64')), d.final()]).toString('utf8');
  }

  private pack(e: { iv: string; tag: string; ct: string }): string {
    return `${e.iv}.${e.tag}.${e.ct}`;
  }

  set(plugin: string, key: string, value: string): void {
    if (!this.key) throw new Error('凭据库已锁定，先 forge config vault unlock');
    this.store.entries[`${plugin}:${key}`] = this.encryptRaw(value, this.key);
    writeJson(this.file, this.store);
  }

  get(plugin: string, key: string): string | undefined {
    if (!this.key) throw new Error('凭据库已锁定，先 forge config vault unlock');
    const e = this.store.entries[`${plugin}:${key}`];
    if (!e) return undefined;
    return this.decryptEntry(e, this.key);
  }

  delete(plugin: string, key: string): boolean {
    const k = `${plugin}:${key}`;
    if (!this.store.entries[k]) return false;
    delete this.store.entries[k];
    writeJson(this.file, this.store);
    return true;
  }

  /** 列出某插件的凭据键名（不返回值） */
  listKeys(plugin?: string): string[] {
    return Object.keys(this.store.entries)
      .filter((k) => (plugin ? k.startsWith(`${plugin}:`) : true))
      .map((k) => k.split(':').slice(1).join(':'));
  }

  /** 本机明文模式：无主密码时用固定派生（仅供本地开发，等同明文） */
  setInsecure(plugin: string, key: string, value: string): void {
    if (!this.key) {
      // 用 salt 本身派生，等同无密码
      this.key = derive(`${this.store.salt}:insecure`, Buffer.from(this.store.salt, 'hex'));
      if (!this.store.verifier) {
        this.store.verifier = this.pack(this.encryptRaw('forgeapi-verifier', this.key));
        writeJson(this.file, this.store);
      }
    }
    this.set(plugin, key, value);
  }
}

export function vaultFor(paths: WorkspacePaths): Vault {
  return new Vault(paths.credentials);
}

export function ensureDataDir(paths: WorkspacePaths, plugin: string): string {
  const d = path.join(paths.data, plugin);
  fs.mkdirSync(d, { recursive: true });
  return d;
}
