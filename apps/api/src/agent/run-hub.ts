import { Injectable } from '@nestjs/common';
import { EventEmitter } from 'events';

export interface RunEvent {
  seq: number;
  type: string;
  actor?: string;
  data?: any;
  at: string;
}

/** 每轮 run 的事件总线：SSE 订阅者先重放历史，再收实时事件。 */
@Injectable()
export class RunEventHub {
  private logs = new Map<string, RunEvent[]>();
  private emitters = new Map<string, EventEmitter>();

  emit(runId: string, type: string, actor?: string, data?: any): RunEvent {
    const log = this.logs.get(runId) ?? [];
    const event: RunEvent = {
      seq: log.length + 1,
      type,
      actor,
      data,
      at: new Date().toISOString(),
    };
    log.push(event);
    this.logs.set(runId, log);
    this.emitters.get(runId)?.emit('event', event);
    return event;
  }

  getLog(runId: string): RunEvent[] {
    return this.logs.get(runId) ?? [];
  }

  subscribe(runId: string, listener: (e: RunEvent) => void): () => void {
    let emitter = this.emitters.get(runId);
    if (!emitter) {
      emitter = new EventEmitter();
      this.emitters.set(runId, emitter);
    }
    emitter.on('event', listener);
    return () => emitter!.off('event', listener);
  }
}
