import { Global, Module } from '@nestjs/common';
import { AgoraService } from './agora.service';
import { AgoraProviderService } from './agora-provider.service';

@Global()
@Module({
  providers: [AgoraService, AgoraProviderService],
  exports: [AgoraService, AgoraProviderService],
})
export class AgoraModule {}
