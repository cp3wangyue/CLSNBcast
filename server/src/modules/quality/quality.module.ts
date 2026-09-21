import { Global, Module } from '@nestjs/common';
import { QualityConfigService } from './quality-config.service';
import { QualityPresetService } from './quality-preset.service';

/**
 * 全局模块：计费配置被会话展示（`toInfo()`）、账本（折算系数快照）
 * 与配额判断共用；画质预设被分享页与会话快照共用。
 * 注册为 Global 省去各处的 imports 样板。
 */
@Global()
@Module({
  providers: [QualityConfigService, QualityPresetService],
  exports: [QualityConfigService, QualityPresetService],
})
export class QualityModule {}
