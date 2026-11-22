import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get()
  check() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      time: new Date().toISOString(),
      model: {
        provider: 'moonshot',
        model: process.env.MOONSHOT_MODEL ?? 'kimi-k3',
        // 未配 key 时生成不可用，创建 run 会直接报明确错误。
        configured: Boolean(process.env.MOONSHOT_API_KEY),
      },
    };
  }
}
