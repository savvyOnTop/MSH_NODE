import {
  OpenApiGeneratorV31,
  OpenAPIRegistry,
  extendZodWithOpenApi,
} from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import { config } from '../infra/config/index.js';

extendZodWithOpenApi(z);

// Central OpenAPI registry — modules register their routes/schemas here;
// swagger-ui serves the generated document at /docs.
export const openApiRegistry = new OpenAPIRegistry();

openApiRegistry.registerPath({
  method: 'get',
  path: '/api/v1/health',
  summary: 'Liveness/readiness: DB SELECT 1 + Redis ping',
  responses: {
    200: {
      description: 'Service healthy',
      content: {
        'application/json': {
          schema: z.object({
            status: z.string(),
            db: z.string(),
            redis: z.string(),
          }),
        },
      },
    },
  },
});

export function generateOpenApiDocument() {
  const generator = new OpenApiGeneratorV31(openApiRegistry.definitions);
  return generator.generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'CathAID NextGen API',
      version: '0.1.0',
      description:
        'Multi-tenant emergency-care workflow coordination platform. Workflows are data; MSH STEMI is configuration, not code.',
    },
    servers: [{ url: config.PUBLIC_BASE_URL }],
  });
}
