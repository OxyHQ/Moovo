import { z } from 'zod';

export const Id = z
  .string()
  .min(1)
  .max(200)
  .refine((v) => v !== '.' && v !== '..');
export const OperationId = z
  .string()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
export const TRANSPORT_STATES = [
  'quoting',
  'quoted',
  'authorized',
  'booking',
  'booking_unknown',
  'booked',
  'cancelled',
] as const;
export const ERROR_STATUS = {
  bad_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  unknown_route: 404,
  gone: 410,
  conflict: 409,
  validation_failed: 422,
  rate_limited: 429,
  internal_error: 500,
  service_unavailable: 503,
} as const;
export const ErrorCode = z.enum(
  Object.keys(ERROR_STATUS) as [keyof typeof ERROR_STATUS, ...Array<keyof typeof ERROR_STATUS>],
);
export const ErrorBody = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .optional(),
  }),
});
export const Address = z.strictObject({
  line1: z.string().trim().min(1).max(250),
  line2: z.string().trim().max(250).optional(),
  city: z.string().trim().min(1).max(120),
  region: z.string().trim().max(120).optional(),
  postalCode: z.string().trim().min(1).max(30),
  country: z.string().regex(/^[A-Z]{2}$/),
});
export const Endpoint = z.strictObject({
  address: Address,
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  contactName: z.string().trim().min(1).max(160),
  contactPhone: z.string().trim().min(1).max(40),
  notes: z.string().max(2000).optional(),
});
export const Parcel = z.strictObject({
  weightKg: z.number().positive().max(10000),
  pieces: z.number().int().min(1).max(1000000),
  sizeClass: z.enum(['small', 'medium', 'large']),
  fragile: z.boolean().optional(),
});
export const CreateTransport = z.strictObject({
  reservationId: Id,
  actingAccountId: Id,
  payerAccountId: Id,
  operationId: OperationId,
  pickup: Endpoint,
  dropoff: Endpoint,
  parcel: Parcel,
  itemDescription: z.string().trim().min(1).max(2000),
});
export const Quote = z.object({
  id: Id,
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('FAIR'),
  expiresAt: z.iso.datetime(),
  fulfillment: z.literal('moovo_courier'),
});
export const Authorization = z.object({
  payerAccountId: Id,
  actorAccountId: Id,
  quoteId: Id,
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('FAIR'),
  expiresAt: z.iso.datetime(),
});
export const Transport = z.object({
  pickup: Endpoint,
  dropoff: Endpoint,
  parcel: Parcel,
  itemDescription: z.string(),
  id: Id,
  reservationId: Id,
  requestingAccountId: Id,
  payerAccountId: Id,
  status: z.enum(TRANSPORT_STATES),
  quotes: z.array(Quote),
  authorization: Authorization.nullable(),
  jobId: Id.nullable(),
  jobStatus: z.string().nullable(),
  paymentStatus: z.literal('pending'),
  paymentCollectionAvailable: z.literal(false),
  createdAt: z.iso.datetime(),
});
export const AuthorizeTransport = z.strictObject({
  actingAccountId: Id,
  quoteId: Id,
  amountMinor: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  currency: z.literal('FAIR'),
  confirmed: z.literal(true),
});
export const TransportAction = z.strictObject({ actingAccountId: Id });
export const TransportRead = z.strictObject({ accountId: Id });
export type TransportRequest = z.infer<typeof CreateTransport>;
export type TransportView = z.infer<typeof Transport>;
export type TransportAuthorizationInput = z.infer<typeof AuthorizeTransport>;
export type TransportActionInput = z.infer<typeof TransportAction>;
export type TransportEndpoint = z.infer<typeof Endpoint>;
export type TransportErrorCode = z.infer<typeof ErrorCode>;

export const schemas = {
  CreateTransport,
  Transport,
  AuthorizeTransport,
  TransportAction,
  TransportRead,
  ErrorBody,
};
export const routes = [
  {
    method: 'post',
    path: '/transports',
    body: 'CreateTransport',
    response: 'Transport',
    status: 201,
  },
  {
    method: 'get',
    path: '/transports/{id}',
    query: 'TransportRead',
    response: 'Transport',
    status: 200,
  },
  {
    method: 'get',
    path: '/reservations/{id}/transport',
    query: 'TransportRead',
    response: 'Transport',
    status: 200,
  },
  {
    method: 'post',
    path: '/transports/{id}/quotes',
    body: 'TransportAction',
    response: 'Transport',
    status: 200,
  },
  {
    method: 'post',
    path: '/transports/{id}/authorize',
    body: 'AuthorizeTransport',
    response: 'Transport',
    status: 200,
  },
  {
    method: 'post',
    path: '/transports/{id}/book',
    body: 'TransportAction',
    response: 'Transport',
    status: 200,
  },
  {
    method: 'post',
    path: '/transports/{id}/cancel',
    body: 'TransportAction',
    response: 'Transport',
    status: 200,
  },
] as const;
export function openapi() {
  const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routes) {
    const parameters: unknown[] = route.path.includes('{id}')
      ? [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }]
      : [];
    if ('query' in route)
      parameters.push({
        in: 'query',
        name: 'accountId',
        required: true,
        schema: { type: 'string' },
      });
    paths[route.path] ??= {};
    paths[route.path][route.method] = {
      parameters,
      security: [{ bearer: [] }],
      ...('body' in route
        ? {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: ref(route.body) } },
            },
          }
        : {}),
      responses: {
        [route.status]: {
          description: 'Success',
          content: { 'application/json': { schema: ref(route.response) } },
        },
        ...Object.fromEntries(
          [...new Set(Object.values(ERROR_STATUS))].map((status) => [
            status,
            { description: 'Error', content: { 'application/json': { schema: ref('ErrorBody') } } },
          ]),
        ),
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Moovo transport', version: '0.1.0' },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: Object.fromEntries(
        Object.entries(schemas).map(([key, schema]) => [
          key,
          z.toJSONSchema(schema, { unrepresentable: 'any' }),
        ]),
      ),
    },
  };
}

export function isContractError(error: unknown): error is z.ZodError {
  return error instanceof z.ZodError;
}
