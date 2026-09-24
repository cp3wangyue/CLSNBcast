import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../database/database.service';
import { SecretCryptoService } from '../crypto/secret-crypto.service';
import { AgoraProviderService } from '../agora/agora-provider.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { QualityPresetService } from '../quality/quality-preset.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import { SuperAdminController } from './super-admin.controller';

process.env.SUPER_ADMIN_PASSWORD = 'test-password';
process.env.SECRET_ENCRYPTION_KEY = process.env.SECRET_ENCRYPTION_KEY || 'c'.repeat(64);

let dir = '';

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'super-admin-discord-'));
  process.env.DATA_DIR = dir;
  const db = new DatabaseService();
  const crypto = new SecretCryptoService(db);
  const providers = new AgoraProviderService(db, crypto);
  const qualityConfig = new QualityConfigService(db);
  qualityConfig.onModuleInit();
  const presets = new QualityPresetService(db, qualityConfig);
  presets.onModuleInit();
  const usage = new UsageLedgerService(db, qualityConfig);
  // 构造签名：(db, providers, qualityConfig, usage, presets, crypto)
  const controller = new SuperAdminController(db, providers, qualityConfig, usage, presets, crypto);
  return { db, crypto, controller };
}

describe('超管配置中的 Discord 凭证', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    ctx = setup();
  });

  it('未配置时 Bot Token 显示为空串', () => {
    const cfg = ctx.controller.getConfig() as any;
    expect(cfg.discordBotToken).toBe('');
    expect(cfg.discordPublicKey).toBe('');
  });

  it('配置后 Bot Token 显示为掩码，不回显明文', () => {
    ctx.crypto.setGlobalSecret('discordBotToken', 'MTIz.real.token');
    const cfg = ctx.controller.getConfig() as any;
    expect(cfg.discordBotToken).toBe('******');
    expect(cfg.discordBotToken).not.toContain('real');
  });

  it('Public Key 不是秘密，原样返回便于核对', () => {
    ctx.controller.updateConfig({ discordPublicKey: 'aabbccdd' } as any);
    const cfg = ctx.controller.getConfig() as any;
    expect(cfg.discordPublicKey).toBe('aabbccdd');
  });

  it('写入的 Bot Token 在库中是密文', () => {
    ctx.controller.updateConfig({ discordBotToken: 'MTIz.real.token' } as any);
    const raw = new Database(join(dir, 'clsnbcast.db'), { readonly: true });
    const row = raw.prepare("SELECT value FROM global_config WHERE key='discordBotToken'").get() as any;
    raw.close();
    expect(row.value).toContain('v1:');
    expect(row.value).not.toContain('real');
  });

  it('掩码值表示「不修改」—— 不会被当成真值写回', () => {
    ctx.crypto.setGlobalSecret('discordBotToken', 'ORIGINAL');
    ctx.controller.updateConfig({ discordBotToken: '******' } as any);
    expect(ctx.crypto.getGlobalSecret('discordBotToken')).toBe('ORIGINAL');
  });

  it('显式传空串会清空配置（与掩码区分开）', () => {
    ctx.crypto.setGlobalSecret('discordBotToken', 'ORIGINAL');
    ctx.controller.updateConfig({ discordBotToken: '' } as any);
    expect(ctx.crypto.getGlobalSecret('discordBotToken')).toBe('');
  });

  it('Public Key 可被清空', () => {
    ctx.controller.updateConfig({ discordPublicKey: 'xx' } as any);
    ctx.controller.updateConfig({ discordPublicKey: '' } as any);
    expect((ctx.controller.getConfig() as any).discordPublicKey).toBe('');
  });

  it('getConfig 不泄露任何明文秘密', () => {
    ctx.crypto.setGlobalSecret('discordBotToken', 'SUPER_SECRET_VALUE');
    ctx.controller.updateConfig({ discordPublicKey: 'pk' } as any);
    const serialized = JSON.stringify(ctx.controller.getConfig());
    expect(serialized).not.toContain('SUPER_SECRET_VALUE');
  });
});
