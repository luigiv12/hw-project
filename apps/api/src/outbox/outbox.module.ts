import { Module } from '@nestjs/common';
import { AlertingClient } from './alerting.client';
import { OutboxDispatcher } from './outbox.dispatcher';

@Module({
  providers: [AlertingClient, OutboxDispatcher],
  exports: [OutboxDispatcher],
})
export class OutboxModule {}
