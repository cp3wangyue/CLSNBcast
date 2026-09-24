/**
 * Discord 平台的入站交互校验。
 *
 * Discord 的 Interactions Endpoint 用 Ed25519 签名校验请求体，签名覆盖
 * `时间戳 + 原始请求体`。这与 KOOK 的「Encrypt Key + 结构体」不同，
 * 但**两者都是入站 HTTP + 签名校验**，所以能复用同一套收件箱 / 幂等设施。
 *
 * 签名规则（官方）：
 *   message  = timestamp + rawBody
 *   signature = Ed25519(privateKey, message)   # hex
 *  请求头：X-Signature-Ed25519 / X-Signature-Timestamp
 *
 * 参考：https://discord.com/developers/docs/interactions/receiving-and-responding
 */

import { createPublicKey, verify } from 'crypto';

export class DiscordSignatureError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
    this.name = 'DiscordSignatureError';
  }
}

/** Discord 的 PING 交互类型；校验端点连通性时由平台主动发起 */
export const DISCORD_INTERACTION_PING = 1;

/**
 * 校验 Discord 交互请求签名。
 *
 * @param publicKey Discord 应用面板给的 Public Key（hex，64 字符）
 * @param timestamp `X-Signature-Timestamp`
 * @param signature `X-Signature-Ed25519`（hex）
 * @param rawBody **未经解析**的原始请求体（Buffer）。
 *   必须是原始字节：任何 JSON 解析再序列化都会改变键序与空白，
 *   从而使签名校验必然失败。
 * @throws {DiscordSignatureError} 参数缺失或签名不匹配
 */
export function verifyDiscordSignature(
  publicKey: string,
  timestamp: string,
  signature: string,
  rawBody: Buffer,
): void {
  if (!publicKey) {
    throw new DiscordSignatureError('discord_public_key_missing', 500);
  }
  if (!timestamp || !signature) {
    throw new DiscordSignatureError('invalid_signature_headers', 401);
  }
  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    throw new DiscordSignatureError('empty_body', 400);
  }

  // hex 与长度的基本校验，避免把非法输入喂给 crypto 而抛未分类异常
  const hex = /^[0-9a-fA-F]+$/;
  if (signature.length !== 128 || !hex.test(signature)) {
    throw new DiscordSignatureError('invalid_signature_headers', 401);
  }
  if (!hex.test(publicKey) || publicKey.length !== 64) {
    throw new DiscordSignatureError('discord_public_key_missing', 500);
  }

  const message = Buffer.concat([Buffer.from(timestamp, 'utf-8'), rawBody]);

  let ok = false;
  try {
    // Discord 给的 public key 是裸的 Ed25519 公钥（32 字节），
    // 需要包装成 DER SubjectPublicKeyInfo 才能交给 Node 的 crypto。
    const key = createPublicKey({
      key: buildDerEd25519PublicKey(publicKey),
      format: 'der',
      type: 'spki',
    });
    // Ed25519 是纯签名算法（不做摘要），必须走 crypto.verify 且 algorithm 传 null；
    // `createVerify('ed25519')` 会抛 "Invalid digest"。
    ok = verify(null, message, key, Buffer.from(signature, 'hex'));
  } catch {
    // 公钥格式错误属于服务端配置问题，不当成客户端伪造请求
    throw new DiscordSignatureError('discord_public_key_missing', 500);
  }

  if (!ok) {
    throw new DiscordSignatureError('invalid_request_signature', 401);
  }
}

/**
 * Ed25519 裸公钥 -> DER SubjectPublicKeyInfo。
 *
 * Node 的 `createPublicKey` 不接受裸的 32 字节 Ed25519 公钥，
 * 必须加上固定的 ASN.1 前缀（OID 1.3.101.112 = Ed25519）。
 */
function buildDerEd25519PublicKey(hexKey: string): Buffer {
  // SPKI 前缀：30 2a 30 05 06 03 2b 65 70 03 21 00
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  const raw = Buffer.from(hexKey, 'hex');
  if (raw.length !== 32) {
    throw new DiscordSignatureError('discord_public_key_missing', 500);
  }
  return Buffer.concat([prefix, raw]);
}
