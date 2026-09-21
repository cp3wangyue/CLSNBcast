import { Global, Module } from '@nestjs/common';
import { QualityConfigService } from './quality-config.service';

/**
 * 全局模块：计费配置被会话展示（`toInfo()`）、账本（折算系数快照）
 * 与配额判断共用，注册为 Global 省去各处的 imports 样板。
 *
 * Phase 3 会把 `quality_presets`（预设档位）也放进这个模块。
 */
@Global()
@Module({
  providers: [QualityConfigService],
  exports: [QualityConfigService],
})
export class QualityModule {}
