import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';
import { UsageLedgerService } from '../usage/usage-ledger.service';
import { QualityConfigService } from '../quality/quality-config.service';
import { currentPeriodKey } from '../usage/usage-period';

/**
 * 用量汇总定时任务。
 *
 * `provider_usage_monthly` 是账本的**派生缓存**，目的是让配额判断能 O(1) 查询，
 * 不必每次去扫 `usage_intervals`。因此它必须定期重算；`usage_intervals` 始终是
 * 唯一的事实来源。
 *
 * 为什么还要重算**上一个**周期：会话结束或崩溃恢复可能刚补进上月的区间
 * （例如月末跨月的会话在下个月初才结算完）。只重算当前周期会漏掉这部分，
 * 让上月的账单与配额缓存停在旧值。
 */
@Injectable()
export class UsageRollupScheduler {
  private readonly logger = new Logger(UsageRollupScheduler.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly ledger: UsageLedgerService,
    private readonly qualityConfig: QualityConfigService,
  ) {}

  /** 每 10 分钟重算一次当前周期与上一周期的 Provider 用量汇总。 */
  @Interval(10 * 60 * 1000)
  rebuildRollups(): void {
    try {
      const timeZone = this.qualityConfig.getUsageTimezone();
      const now = new Date();
      for (const periodKey of [currentPeriodKey(timeZone, now), previousPeriodKey(timeZone, now)]) {
        this.ledger.rebuildMonthlyRollup(periodKey);
      }
    } catch (error) {
      // 汇总失败不影响正在进行的共享，但必须可见 ——
      // 静默失败会让配额判断一直读到过期缓存。
      this.logger.error(`usage rollup failed: ${(error as Error).message}`);
    }
  }

  /** 启动时先跑一次，避免刚部署完配额判断读到空缓存。 */
  runOnce(): void {
    this.rebuildRollups();
  }
}

/**
 * 上一个计费周期的键。
 *
 * 按月退一格并做年份借位，不引入日期库。
 */
export function previousPeriodKey(timeZone: string, now: Date = new Date()): string {
  const key = currentPeriodKey(timeZone, now);
  const [yearText, monthText] = key.split('-');
  let year = Number(yearText);
  let month = Number(monthText);
  if (month === 1) {
    month = 12;
    year -= 1;
  } else {
    month -= 1;
  }
  return `${year}-${String(month).padStart(2, '0')}`;
}
