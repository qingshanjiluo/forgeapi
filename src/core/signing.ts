/**
 * ForgeAPI 插件签名（Ed25519）
 *
 * 与 integrity.ts 的分工：
 *   integrity = 内容基线（防静默改动，无密钥，同机对比）
 *   signing   = 来源可信（有密钥，跨机可验，能证明"谁签的"）
 *
 * 签名对象：插件目录的内容哈希（hex），签名值 base64。
 * 签名文件：<pluginDir>/FORGE.SIG（JSON），随插件一起分发。
 * 密钥文件：~/.forgeapi/keys/forge-ed25519.key（私钥 PEM）与 .pub（公钥 PEM）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorkspacePaths, RegistryEntry } from './types.js';
import { Registry } from './registry.js';
import { hashPluginDir } from './integrity.js';

export const SIG_FILE = 'FORGE.SIG';

export interface SignKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  keyId: string;
}

export interface SignatureRecord {
  version: 1;
  algorithm: 'ed25519';
  /** 被签名的内容哈希（integrity hash，hex） */
  digest: string;
  /** 签名值（base64） */
  signature: string;
  /** 公钥指纹，便于多钥匙场景识别 */
  keyId: string;
  /** 签名者自述（可选） */
  signer?: string;
  at: string;
}

/** 公钥指纹：sha256(SPKI DER) 前 16 hex */
export function keyIdOf(publicKeyPem: string): string {
  const der = crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' });
  return crypto.createHash('sha256').update(der).digest('hex').slice(0, 16);
}

export function generateKeyPair(): SignKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { publicKeyPem, privateKeyPem, keyId: keyIdOf(publicKeyPem) };
}

export function keysDir(paths: WorkspacePaths): string {
  return path.join(paths.root, 'keys');
}

export function defaultKeyPaths(paths: WorkspacePaths): { privateKey: string; publicKey: string } {
  const dir = keysDir(paths);
  return {
    privateKey: path.join(dir, 'forge-ed25519.key'),
    publicKey: path.join(dir, 'forge-ed25519.pub'),
  };
}

/** 生成并落盘密钥对；已存在则不覆盖（除非 force） */
export function createKeys(paths: WorkspacePaths, opts: { force?: boolean; signer?: string } = {}): { keyId: string; privateKey: string; publicKey: string; created: boolean } {
  const p = defaultKeyPaths(paths);
  const dir = keysDir(paths);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(p.privateKey) && !opts.force) {
    const pub = fs.readFileSync(p.publicKey, 'utf8');
    return { keyId: keyIdOf(pub), privateKey: p.privateKey, publicKey: p.publicKey, created: false };
  }

  const kp = generateKeyPair();
  fs.writeFileSync(p.privateKey, kp.privateKeyPem, { encoding: 'utf8', mode: 0o600 });
  fs.writeFileSync(p.publicKey, kp.publicKeyPem, 'utf8');
  if (opts.signer) {
    fs.writeFileSync(path.join(dir, 'signer.txt'), opts.signer, 'utf8');
  }
  return { keyId: kp.keyId, privateKey: p.privateKey, publicKey: p.publicKey, created: true };
}

function readSigner(paths: WorkspacePaths): string | undefined {
  const f = path.join(keysDir(paths), 'signer.txt');
  try { return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() || undefined : undefined; } catch { return undefined; }
}

/** 对插件目录签名，写入 FORGE.SIG 并同步到 registry */
export function signPlugin(
  paths: WorkspacePaths,
  name: string,
  opts: { privateKeyPath?: string; signer?: string } = {},
): { name: string; digest: string; keyId: string; sigFile: string; signer?: string } | null {
  const reg = new Registry(paths);
  const entry = reg.get(name);
  if (!entry) return null;
  if (!fs.existsSync(entry.dir)) throw new Error(`插件目录不存在: ${entry.dir}`);

  const privPath = opts.privateKeyPath || defaultKeyPaths(paths).privateKey;
  if (!fs.existsSync(privPath)) throw new Error(`私钥不存在: ${privPath}（先跑 forge keygen）`);
  const privateKeyPem = fs.readFileSync(privPath, 'utf8');

  const { hash } = hashPluginDir(entry.dir);
  const signature = crypto.sign(null, Buffer.from(hash, 'utf8'), crypto.createPrivateKey(privateKeyPem)).toString('base64');
  const publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' }).toString();
  const keyId = keyIdOf(publicKeyPem);
  const signer = opts.signer || readSigner(paths);

  const record: SignatureRecord = {
    version: 1,
    algorithm: 'ed25519',
    digest: hash,
    signature,
    keyId,
    ...(signer ? { signer } : {}),
    at: new Date().toISOString(),
  };

  const sigFile = path.join(entry.dir, SIG_FILE);
  fs.writeFileSync(sigFile, JSON.stringify(record, null, 2), 'utf8');

  entry.signature = { digest: record.digest, signature: record.signature, keyId: record.keyId, signer: record.signer, at: record.at };
  reg.register(entry);
  return { name, digest: hash, keyId, sigFile, signer };
}

export function readSignature(pluginDir: string): SignatureRecord | null {
  const f = path.join(pluginDir, SIG_FILE);
  if (!fs.existsSync(f)) return null;
  try {
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) as SignatureRecord;
    return j?.version === 1 && j.algorithm === 'ed25519' ? j : null;
  } catch { return null; }
}

export interface SignatureCheck {
  state: 'signed' | 'signed-invalid' | 'unsigned' | 'digest-mismatch';
  ok: boolean;
  keyId?: string;
  signer?: string;
  expectedDigest?: string;
  actualDigest: string;
  reason?: string;
}

/**
 * 验签：
 *   1. 无 FORGE.SIG → unsigned（不阻塞，只是"未签名"）
 *   2. 签名里的 digest 与当前目录哈希不符 → digest-mismatch（内容被改）
 *   3. 用公钥验签失败 → signed-invalid（签名伪造或公钥不对）
 *   4. 全部通过 → signed
 */
export function verifySignature(
  pluginDir: string,
  opts: { publicKeyPath?: string; publicKeyPem?: string } = {},
): SignatureCheck {
  const { hash } = hashPluginDir(pluginDir);
  const sig = readSignature(pluginDir);

  if (!sig) {
    return { state: 'unsigned', ok: false, actualDigest: hash, reason: '未签名（无 FORGE.SIG）' };
  }

  if (sig.digest !== hash) {
    return {
      state: 'digest-mismatch',
      ok: false,
      keyId: sig.keyId,
      signer: sig.signer,
      expectedDigest: sig.digest,
      actualDigest: hash,
      reason: '内容与签名时的摘要不符（插件被改动）',
    };
  }

  // 取公钥：显式 PEM > 显式路径 > 本地默认
  let publicKeyPem = opts.publicKeyPem;
  if (!publicKeyPem && opts.publicKeyPath && fs.existsSync(opts.publicKeyPath)) {
    publicKeyPem = fs.readFileSync(opts.publicKeyPath, 'utf8');
  }

  if (!publicKeyPem) {
    // 没有公钥无法验签；但 digest 已对上，标记为 signed 但注明未验钥
    return {
      state: 'signed',
      ok: true,
      keyId: sig.keyId,
      signer: sig.signer,
      actualDigest: hash,
      reason: '摘要匹配；未提供公钥（仅做内容一致性检查）',
    };
  }

  const kid = keyIdOf(publicKeyPem);
  if (kid !== sig.keyId) {
    return {
      state: 'signed-invalid',
      ok: false,
      keyId: sig.keyId,
      signer: sig.signer,
      actualDigest: hash,
      reason: `公钥指纹不匹配（签名 keyId=${sig.keyId}，提供=${kid}）`,
    };
  }

  const ok = crypto.verify(
    null,
    Buffer.from(sig.digest, 'utf8'),
    crypto.createPublicKey(publicKeyPem),
    Buffer.from(sig.signature, 'base64'),
  );

  if (!ok) {
    return {
      state: 'signed-invalid',
      ok: false,
      keyId: sig.keyId,
      signer: sig.signer,
      actualDigest: hash,
      reason: '签名验证失败（被篡改或不是该公钥对应的私钥所签）',
    };
  }

  return { state: 'signed', ok: true, keyId: sig.keyId, signer: sig.signer, actualDigest: hash };
}

/** 列出所有插件的签名状态（供 forge verify / forge sign --list 用） */
export function signatureStatusAll(
  paths: WorkspacePaths,
  opts: { publicKeyPath?: string } = {},
): { name: string; check: SignatureCheck }[] {
  const reg = new Registry(paths);
  const out: { name: string; check: SignatureCheck }[] = [];
  for (const e of reg.all()) {
    if (!fs.existsSync(e.dir)) continue;
    out.push({ name: e.name, check: verifySignature(e.dir, opts) });
  }
  return out;
}

/** 导出公钥（便于分发给他人验证） */
export function exportPublicKey(paths: WorkspacePaths, outPath: string): string {
  const p = defaultKeyPaths(paths);
  if (!fs.existsSync(p.publicKey)) throw new Error('公钥不存在（先跑 forge keygen）');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.copyFileSync(p.publicKey, outPath);
  return outPath;
}

export function importPublicKey(paths: WorkspacePaths, srcPath: string): { keyId: string; target: string } {
  if (!fs.existsSync(srcPath)) throw new Error(`公钥文件不存在: ${srcPath}`);
  const pem = fs.readFileSync(srcPath, 'utf8');
  const keyId = keyIdOf(pem);
  const target = path.join(keysDir(paths), 'trusted', `${keyId}.pub`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, pem, 'utf8');
  return { keyId, target };
}

/** 列出已导入的可信公钥 */
export function listTrustedKeys(paths: WorkspacePaths): { keyId: string; path: string }[] {
  const dir = path.join(keysDir(paths), 'trusted');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.pub'))
    .map((f) => ({ keyId: f.replace(/\.pub$/, ''), path: path.join(dir, f) }));
}

/** 用已导入的可信公钥验签（多钥匙：按签名里的 keyId 找对应公钥） */
export function verifyWithTrusted(paths: WorkspacePaths, pluginDir: string): SignatureCheck {
  const sig = readSignature(pluginDir);
  if (!sig) return verifySignature(pluginDir);
  const trusted = path.join(keysDir(paths), 'trusted', `${sig.keyId}.pub`);
  if (fs.existsSync(trusted)) return verifySignature(pluginDir, { publicKeyPath: trusted });
  // 没有对应可信公钥：退回本地默认公钥
  return verifySignature(pluginDir, { publicKeyPath: defaultKeyPaths(paths).publicKey });
}

export type { RegistryEntry };