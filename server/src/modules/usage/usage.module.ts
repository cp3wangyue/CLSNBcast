import { Global, Module } from '@nestjs/common';
import { UsageLedgerService } from './usage-ledger.service';

/**
 * 全局模块：账本被会话生命周期（Phase 2-2）、计费展示（Phase 2-3）
 * 与配额看板（Phase 2-4）共用，注册为 Global 省去各处的 imports 样板。
 */
@Global()
@Module({
  providers: [UsageLedgerService],
  exports: [UsageLedgerService],
})
export class UsageModule {}
