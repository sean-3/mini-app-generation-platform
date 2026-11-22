import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { AppsService } from './apps.service';

@Controller('api/apps')
export class AppsController {
  constructor(private readonly apps: AppsService) {}

  @Get()
  list() {
    return this.apps.list();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.apps.get(id);
  }

  @Post()
  create(@Body() body: { templateId: string; name?: string }) {
    return this.apps.create(body.templateId, body.name ?? '');
  }

  @Patch(':id/data')
  updateData(@Param('id') id: string, @Body() body: { data: unknown }) {
    return this.apps.updateData(id, body.data);
  }

  @Patch(':id')
  rename(@Param('id') id: string, @Body() body: { name: string }) {
    return this.apps.rename(id, body.name);
  }

  @Delete(':id')
  delete(@Param('id') id: string) {
    return this.apps.delete(id);
  }

  @Post(':id/export')
  exportJson(@Param('id') id: string) {
    return this.apps.exportJson(id);
  }

  @Post(':id/export-file')
  exportFile(@Param('id') id: string, @Body() body: { format?: string }) {
    return this.apps.exportFile(id, body.format ?? 'csv');
  }
}
