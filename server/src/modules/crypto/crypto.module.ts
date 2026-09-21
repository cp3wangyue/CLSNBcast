import { Global, Module } from '@nestjs/common';
import { SecretCryptoService } from './secret-crypto.service';

/**
 * 全局模块：秘密加解密是横切能力，Phase 1 起由 Provider 仓储、Phase 5 起由
 * KOOK 密钥相关代码注入使用。
 */
@Global()
@Module({
  providers: [SecretCryptoService],
  exports: [SecretCryptoService],
})
export class CryptoModule {}
