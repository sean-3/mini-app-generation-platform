import { Controller, Get } from '@nestjs/common';
import { TemplatesService } from '../templates/templates.service';

@Controller('api/templates')
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  list() {
    return this.templates.list();
  }
}
