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

  /** 对话改数据：POST /api/apps/:id/edit {input}，只改工作区数据，不发布。 */
  @Post(':id/edit')
  editData(@Param('id') id: string, @Body() body: { input: string }) {
    return this.apps.editData(id, body.input ?? '');
  }

  /** Update：把当前工作区数据推成新的线上版（版本号 +1）。 */
  @Post(':id/update')
  publishUpdate(@Param('id') id: string) {
    return this.apps.publishUpdate(id);
  }

  /** Remix / 克隆：复制成独立新项目。 */
  @Post(':id/clone')
  clone(@Param('id') id: string) {
    return this.apps.clone(id);
  }

  /** 版本列表：该应用每次 Publish/Update 的快照。 */
  @Get(':id/versions')
  listVersions(@Param('id') id: string) {
    return this.apps.listVersions(id);
  }

  /** Restore：把某版本快照拷回工作区（未发布改动，不直接改线上快照）。 */
  @Post(':id/restore')
  restore(@Param('id') id: string, @Body() body: { version: number }) {
    return this.apps.restore(id, body.version);
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
