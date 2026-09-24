import { Module, OnModuleInit } from '@nestjs/common';
import { EventsModule } from './modules/events/events.module';
import { DatabaseModule } from './modules/database/database.module';
import { CryptoModule } from './modules/crypto/crypto.module';
import { AgoraModule } from './modules/agora/agora.module';
import { UsageModule } from './modules/usage/usage.module';
import { QualityModule } from './modules/quality/quality.module';
import { UsageRollupScheduler } from './modules/usage/usage-rollup.scheduler';
import { SessionModule } from './modules/session/session.module';
import { AuthModule } from './modules/auth/auth.module';
import { KookModule } from './modules/kook/kook.module';
import { DiscordModule } from './modules/discord/discord.module';
import { ShareModule } from './modules/share/share.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { ServerAdminModule } from './modules/server-admin/server-admin.module';
import { NoticesModule } from './modules/notices/notices.module';

@Module({
  imports: [
    EventsModule,
    DatabaseModule,
    CryptoModule,
    AgoraModule,
    UsageModule,
    QualityModule,
    SessionModule,
    AuthModule,
    KookModule,
    DiscordModule,
    ShareModule,
    SuperAdminModule,
    ServerAdminModule,
    NoticesModule,
  ],
})
export class AppModule implements OnModuleInit {
  constructor(private readonly usageRollup: UsageRollupScheduler) {}

  onModuleInit(): void {
    // 启动时先汇总一次：否则刚部署完配额判断会读到空缓存。
    this.usageRollup.runOnce();
  }
}
