import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors();

  // 单体部署：NestJS 直接 serve 前端静态产物（apps/web/dist），一个链接打开。
  const webDist = path.join(__dirname, '..', '..', 'web', 'dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    app.use(express.static(webDist));
    // SPA fallback：非 /api、非 /health 的 GET 请求回 index.html
    const server = app.getHttpAdapter().getInstance();
    server.get(/^(?!\/api\/|\/health).*/, (_req: any, res: any) => {
      res.sendFile(path.join(webDist, 'index.html'));
    });
  }

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`mini-app-generation-platform-v2 listening on ${port}`);
}

void bootstrap();
