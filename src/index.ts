import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { verify } from 'hono/jwt';

type Bindings = {
  BUCKET: R2Bucket;
  JWT_SECRET: string;
};

type Variables = {
  storeId: string;
};

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// ─── CORS ────────────────────────────────────────────────────────────────────
// El navegador sube archivos a este Worker desde el frontend (otro origen).
// Se debe permitir explícitamente el dominio de producción y los de desarrollo.

const ALLOWED_ORIGINS = [
  'http://localhost:4321',          // astro dev
  'http://localhost:8788',          // wrangler dev / preview
  'https://marke1cloud.online',     // producción
  'https://www.marke1cloud.online', // producción con www
];

app.use('*', logger());
app.use(
  '*',
  cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    maxAge: 86400,
  })
);

// ─── Health Check ────────────────────────────────────────────────────────────

app.get('/', (c) => {
  return c.json({
    service: 'livemarket-ms-media',
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

// ─── Middleware de Autenticación (Stateless) ─────────────────────────────────

app.use('/upload/*', async (c, next) => {
  const auth = c.req.header('Authorization');
  if (!auth) {
    return c.json({ success: false, error: 'Token requerido.' }, 401);
  }

  const token = auth.replace('Bearer ', '').trim();

  try {
    const decoded = await verify(token, c.env.JWT_SECRET, 'HS256');

    if (typeof decoded.store_id !== 'string' || decoded.store_id.length === 0) {
      return c.json({ success: false, error: 'Token sin store_id válido.' }, 403);
    }

    c.set('storeId', decoded.store_id);
    await next();
  } catch (err: any) {
    return c.json(
      { success: false, error: 'Token inválido o expirado.', detalle: err?.message },
      401
    );
  }
});

// ─── POST /upload/product-media ──────────────────────────────────────────────

app.post('/upload/product-media', async (c) => {
  const storeId = c.get('storeId');

  // 1. Parsear form-data
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!(file instanceof File)) {
    return c.json(
      { success: false, error: 'Archivo no encontrado en el form-data.' },
      400
    );
  }

  // 2. Validación estricta de formato (solo webp y webm)
  const validTypes = ['image/webp', 'video/webm'];
  if (!validTypes.includes(file.type)) {
    return c.json(
      {
        success: false,
        error: 'Formato inválido. Solo se permite .webp y .webm.',
        detalle: `Recibido: ${file.type || 'desconocido'}`,
      },
      415
    );
  }

  // 3. Límite de tamaño
  const MAX_IMAGE = 10 * 1024 * 1024; // 10 MB
  const MAX_VIDEO = 50 * 1024 * 1024; // 50 MB
  const maxSize = file.type.startsWith('image/') ? MAX_IMAGE : MAX_VIDEO;

  if (file.size > maxSize) {
    return c.json(
      {
        success: false,
        error: `Archivo demasiado grande. Máximo ${maxSize / (1024 * 1024)} MB.`,
      },
      413
    );
  }

  // 4. Ruta relativa única bajo el storeId (aislamiento multi-tenant)
  const fileExtension = file.type === 'image/webp' ? 'webp' : 'webm';
  const fileName = crypto.randomUUID();
  const relativePath = `${storeId}/products/${fileName}.${fileExtension}`;

  // 5. Subir a R2 con cache inmutable (UUID = contenido único, no cambia nunca)
  const arrayBuffer = await file.arrayBuffer();
  await c.env.BUCKET.put(relativePath, arrayBuffer, {
    httpMetadata: {
      contentType: file.type,
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

  // 6. Responder con la ruta relativa
  return c.json(
    {
      success: true,
      data: {
        relative_url: relativePath,
        media_type: file.type.split('/')[0],
      },
    },
    201
  );
});

// ─── GET /media/* — Servir archivos de R2 públicamente ───────────────────────
// Sin esto, las imágenes subidas a R2 no se pueden servir al navegador.
// Se evita el custom domain y el subdominio r2.dev.

app.get('/media/*', async (c) => {
  const fullPath = c.req.path; // ej: /media/5a2daafd.../products/abc.webp
  const relativePath = fullPath.replace(/^\/media\//, '');

  if (!relativePath) {
    return c.json({ success: false, error: 'Ruta de archivo no especificada.' }, 400);
  }

  const object = await c.env.BUCKET.get(relativePath);

  if (!object) {
    return c.json({ success: false, error: 'Archivo no encontrado.' }, 404);
  }

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType || 'application/octet-stream',
      'Cache-Control': object.httpMetadata?.cacheControl || 'public, max-age=31536000, immutable',
      'ETag': object.httpEtag,
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// ─── 404 Catch-all ───────────────────────────────────────────────────────────

app.notFound((c) => {
  return c.json({ success: false, error: 'Recurso no encontrado.' }, 404);
});

// ─── Error Handler Global ────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error(`[MS3 Error] ${err.message}`, err.stack);
  return c.json({ success: false, error: 'Error interno del servidor.' }, 500);
});

// 1. Endpoint público para logos (SIN middleware de autenticación)
app.post('/upload/store-logo', async (c) => {
  const body = await c.req.parseBody();
  const file = body['file'];

  if (!file || !(file instanceof File)) {
    return c.json({ success: false, error: 'Se requiere un archivo de imagen válido.' }, 400);
  }

  const allowedTypes = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ success: false, error: 'Formato no soportado. Usa PNG, JPG o WebP.' }, 400);
  }

  if (file.size > 5 * 1024 * 1024) {
    return c.json({ success: false, error: 'La imagen excede el límite de 5MB.' }, 400);
  }

  const fileKey = `stores/logos/${crypto.randomUUID()}.webp`;
  const arrayBuffer = await file.arrayBuffer();

  await c.env.MEDIA_BUCKET.put(fileKey, arrayBuffer, {
    httpMetadata: { contentType: 'image/webp' },
  });

  return c.json({
    success: true,
    data: { url: fileKey },
  }, 201);
});

// 2. Middleware JWT aplicado únicamente a las rutas privadas (product-media)
app.use('/upload/product-media/*', authMiddleware);
// o si usas rutas con prefijo privado:
// app.route('/upload/product-media', privateMediaRoutes);

export default app;