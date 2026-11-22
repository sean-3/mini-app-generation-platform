import { Module } from '@nestjs/common';
import { DatabaseService } from './persistence/database.service';
import { TemplatesService } from './templates/templates.service';
import { ToolGatewayService } from './tool-gateway/tool-gateway.service';
import { ModelGatewayService } from './model-gateway/model-gateway.service';
import { EvalService } from './eval/eval.service';
import { AgentService } from './agent/agent.service';
import { AgentController } from './agent/agent.controller';
import { RunEventHub } from './agent/run-hub';
import { AppsService } from './apps/apps.service';
import { AppsController } from './apps/apps.controller';
import { TemplatesController } from './apps/templates.controller';
import { HealthController } from './health/health.controller';

@Module({
  controllers: [HealthController, AgentController, AppsController, TemplatesController],
  providers: [
    DatabaseService,
    TemplatesService,
    ToolGatewayService,
    ModelGatewayService,
    EvalService,
    RunEventHub,
    AgentService,
    AppsService,
  ],
})
export class AppModule {}
