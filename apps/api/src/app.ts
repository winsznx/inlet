import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import { env } from "@inlet/config";
import { redisConnection } from "@inlet/control";
import { AppError } from "@inlet/domain";
import type { ErrorBody } from "@inlet/domain";
import { randomUUID } from "node:crypto";
import { assertSameOrigin, resolveAuth } from "./plumbing/auth";
import { authRoutes } from "./routes/auth";
import { connectionRoutes } from "./routes/connections";
import { demoRoutes } from "./routes/demo";
import { healthRoutes } from "./routes/health";
import { incidentRoutes } from "./routes/incidents";
import { labRoutes } from "./routes/lab";
import { organizationRoutes } from "./routes/organizations";
import { runRoutes } from "./routes/runs";
import { siteRoutes } from "./routes/sites";
import { webhookRoutes } from "./routes/webhooks";

const CSRF_EXEMPT_PREFIXES = ["/api/v1/webhooks/"];
const INTERNAL_PREFIXES = ["/api/v1/internal", "/api/v1/webhooks"];

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: env().LOG_LEVEL,
      redact: { paths: ["req.headers.cookie", "req.headers.authorization", 'res.headers["set-cookie"]'], remove: true },
    },
    genReqId: () => `req_${randomUUID().replaceAll("-", "")}`,
    bodyLimit: 1_048_576,
    trustProxy: env().NODE_ENV === "production" ? "127.0.0.1,172.16.0.0/12" : false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    redis: redisConnection(),
    nameSpace: "inlet-rate:",
    keyGenerator: (request) => request.ip,
    errorResponseBuilder: () => new AppError("RATE_LIMITED", "Too many requests. Please slow down.", { nextAction: "Try again in a minute." }),
  });
  await app.register(swagger, {
    openapi: { info: { title: "Inlet API", version: "1.0.0" }, servers: [{ url: "/" }] },
    transform: jsonSchemaTransform,
    hideUntagged: false,
  });

  app.decorateRequest("auth", null);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("x-request-id", request.id);
    reply.header("x-content-type-options", "nosniff");
    reply.header("cache-control", "no-store");
    request.auth = await resolveAuth(request);
  });

  app.addHook("preHandler", async (request) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
    if (CSRF_EXEMPT_PREFIXES.some((prefix) => request.url.startsWith(prefix))) return;
    assertSameOrigin(request);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    let appError: AppError;
    if (error instanceof AppError) {
      appError = error;
    } else if (hasZodFastifySchemaValidationErrors(error)) {
      appError = new AppError("INVALID_INPUT", "Some fields need attention.", {
        details: { fields: error.validation.map((item) => ({ path: item.instancePath.replace(/^\//, ""), message: item.message })) },
      });
    } else if (typeof error === "object" && error !== null && (error as { statusCode?: number }).statusCode === 413) {
      appError = new AppError("INVALID_INPUT", "That upload is too large.");
    } else if (typeof error === "object" && error !== null && (error as { statusCode?: number }).statusCode === 415) {
      appError = new AppError("INVALID_INPUT", "That content type is not supported.");
    } else {
      request.log.error({ err: error }, "unhandled error");
      appError = new AppError("INTERNAL", "Something went wrong on our side.", { nextAction: "Try again. If it keeps happening, check the service logs." });
    }
    const body: ErrorBody = {
      error: {
        code: appError.code,
        message: appError.message,
        nextAction: appError.nextAction,
        requestId: request.id,
        retryable: appError.retryable,
        details: appError.details,
      },
    };
    void reply.status(appError.status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = { error: { code: "NOT_FOUND", message: "Not found.", requestId: request.id, retryable: false } };
    void reply.status(404).send(body);
  });

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(organizationRoutes);
      await api.register(siteRoutes);
      await api.register(runRoutes);
      await api.register(incidentRoutes);
      await api.register(connectionRoutes);
      await api.register(demoRoutes);
      await api.register(labRoutes);
      await api.register(webhookRoutes);
      await api.register(healthRoutes);
      api.get("/openapi.json", { schema: { hide: true } }, async (_request, reply) => {
        const document = app.swagger() as { paths?: Record<string, unknown> };
        const paths = Object.fromEntries(Object.entries(document.paths ?? {}).filter(([path]) => !INTERNAL_PREFIXES.some((prefix) => path.startsWith(prefix))));
        return reply.send({ ...document, paths });
      });
    },
    { prefix: "/api/v1" },
  );

  return app;
}
