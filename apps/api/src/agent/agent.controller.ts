import { Body, Controller, Get, Param, Post, Sse } from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { AgentService } from './agent.service';
import { RunEventHub } from './run-hub';

@Controller('api/runs')
export class AgentController {
  constructor(
    private readonly agent: AgentService,
    private readonly hub: RunEventHub,
  ) {}

  @Post()
  create(@Body() body: { input: string }) {
    return this.agent.createRun(body.input ?? '');
  }

  @Post('repeat-demo')
  repeatDemo(@Body() body: { input: string }) {
    return this.agent.repeatDemo(body.input ?? '团购接龙');
  }

  @Get()
  list() {
    return this.agent.listRuns();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.agent.getRun(id);
  }

  @Get(':id/replay')
  replay(@Param('id') id: string) {
    return this.agent.getReplay(id);
  }

  @Post(':id/approve-architecture')
  approveArchitecture(@Param('id') id: string, @Body() body: { approved: boolean }) {
    return this.agent.approveArchitecture(id, body.approved === true);
  }

  @Post(':id/approve-publish')
  approvePublish(@Param('id') id: string, @Body() body: { approved: boolean }) {
    return this.agent.approvePublish(id, body.approved === true);
  }

  /** SSE：先重放已有事件，再推送实时事件；run 到达终态后关闭。 */
  @Sse(':id/stream')
  stream(@Param('id') id: string): Observable<{ data: any }> {
    return new Observable((subscriber) => {
      for (const e of this.hub.getLog(id)) {
        subscriber.next({ data: e });
      }
      const off = this.hub.subscribe(id, (e) => {
        subscriber.next({ data: e });
        if (e.type === 'run_stopped' || e.type === 'eval_ready') {
          // eval_ready 是发布后复盘的最后一个事件，稍后关闭
          setTimeout(() => subscriber.complete(), 300);
        }
      });
      const heartbeat = setInterval(() => subscriber.next({ data: { type: 'ping', at: new Date().toISOString() } }), 15000);
      return () => {
        clearInterval(heartbeat);
        off();
      };
    });
  }
}
