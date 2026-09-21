import { Global, Module } from '@nestjs/common';
import { UsageLedgerService } from './usage-ledger.service';
import { UsageRollupScheduler } from './usage-rollup.scheduler';

/**
 * 全局模块：账本被会话生命周期、计费展示、配额判断与看板共用，
 * 注册为 Global 省去各处的 imports 样板。
 */
@Global()
@Module({
  providers: [UsageLedgerService, UsageRollupScheduler],
  // 两个都导出：`UsageLedgerService` 供各处注入；
  // `UsageRollupScheduler` 供 AppModule 在启动时触发一次汇总。
  exports: [UsageLedgerService, UsageRollupScheduler],
})
export class UsageModule {}
