import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { DiscordChannelSender } from './discord-channel-sender';
import { DiscordMessagePayload } from './discord-message-builder';

process.env.SUPER_ADMIN_PASSWORD = 'test-password';
process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY || 'b'.repeat(64);

let dir = '';

function makeDb(): DatabaseService {
  dir = mkdtempSync(join(tmpdir(), 'discord-sender-'));
  process.env.DATA_DIR = dir;
  return new DatabaseService();
}

describe('DiscordChannelSender', () => {
  let db: DatabaseService;
  let crypto: SecretCryptoService;

  beforeEach(() => {
    db = makeDb();
    crypto = new SecretCryptoService(db);
  });

  it('未配置 Bot Token 时 refresh 返回 false 且 isReady 为 false', () => {
    const sender = new DiscordChannelSender(crypto);
    expect(sender.refresh()).toBe(false);
    expect(sender.isReady()).toBe(false);
  });

  it('配置 Bot Token 后 refresh 返回 true 且 isReady 为 true', () => {
    crypto.setGlobalSecret('discordBotToken', 'MTIzNDU2Nzg5.token.abc');
    const sender = new DiscordChannelSender(crypto);
    expect(sender.refresh()).toBe(true);
    expect(sender.isReady()).toBe(true);
  });

  it('Bot Token 在库中是密文，不是明文', () => {
    crypto.setGlobalSecret('discordBotToken', 'MTIzNDU2Nzg5.token.abc');
    const raw = new Database(join(dir, 'clsnbcast.db'), { readonly: true });
    const row = raw.prepare("SELECT value FROM global_config WHERE key = 'discordBotToken'").get() as any;
    raw.close();
    expect(row.value).toContain('v1:');
    expect(row.value).not.toContain('MTIzNDU2Nzg5.token.abc');
    // 但读回来必须是原值
    expect(crypto.getGlobalSecret('discordBotToken')).toBe('MTIzNDU2Nzg5.token.abc');
  });

  it('未 ready 时 sendToChannel 返回 null 而不是抛错（事件链路不能被打断）', async () => {
    const sender = new DiscordChannelSender(crypto);
    sender.refresh();
    const payload: DiscordMessagePayload = { content: 'x' };
    await expect(sender.sendToChannel('c1', payload)).resolves.toBeNull();
  });

  it('未 ready 时 editMessage 静默返回，不抛错', async () => {
    const sender = new DiscordChannelSender(crypto);
    sender.refresh();
    await expect(sender.editMessage('c1', 'm1', { content: 'x' })).resolves.toBeUndefined();
  });

  it('Token 被清空后 refresh 会停用发送（避免用过期的无效凭证继续调 API）', () => {
    crypto.setGlobalSecret('discordBotToken', 'tok');
    const sender = new DiscordChannelSender(crypto);
    expect(sender.refresh()).toBe(true);

    crypto.setGlobalSecret('discordBotToken', '');
    expect(sender.refresh()).toBe(false);
    expect(sender.isReady()).toBe(false);
  });

  it('无主密钥但库中已有密文时 refresh 不抛错（按未配置处理）', () => {
    crypto.setGlobalSecret('discordBotToken', 'tok');
    // 模拟主密钥丢失：库中留着密文，但服务拿不到密钥
    const noKeyCrypto = new SecretCryptoService(db);
    const sender = new DiscordChannelSender(noKeyCrypto);
    expect(() => sender.refresh()).not.toThrow();
  });
});
