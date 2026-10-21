// Capa de datos: PostgreSQL (Neon en producción). Un solo Pool compartido + creación del esquema al arrancar.
try { process.loadEnvFile(); } catch { /* sin archivo .env: se usan las variables del entorno (Render) */ }
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL (cadena de conexión de Postgres/Neon). Ver README.');
  process.exit(1);
}
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === 'false' ? false : undefined, // Neon exige SSL (ya viene en la URL: sslmode=require)
  max: 5,
});

// Atajo: devuelve las filas de una consulta parametrizada ($1, $2, ...)
const query = async (sql, params = []) => (await pool.query(sql, params)).rows;

// Esquema. Las fechas se guardan como TEXT 'AAAA-MM-DD' (mismo valor que ve el usuario, sin problemas de zona horaria).
async function iniciarEsquema() {
  await pool.query(`
CREATE TABLE IF NOT EXISTS usuarios (
  id         SERIAL PRIMARY KEY,
  nombre     TEXT NOT NULL,
  correo     TEXT NOT NULL UNIQUE,
  clave_hash TEXT NOT NULL,
  rol        TEXT NOT NULL CHECK (rol IN ('GERENTE','ASISTENTE'))
);

CREATE TABLE IF NOT EXISTS categorias (
  id     SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL UNIQUE            -- Servicios, Proveedores, Impuestos, Préstamos
);

CREATE TABLE IF NOT EXISTS pagos (
  id                SERIAL PRIMARY KEY,
  concepto          TEXT NOT NULL,                                   -- QUÉ se paga
  entidad           TEXT NOT NULL,                                   -- A QUIÉN se paga (empresa o persona)
  categoria_id      INT  NOT NULL REFERENCES categorias(id),
  monto             NUMERIC(12,2) NOT NULL CHECK (monto > 0),        -- CUÁNTO, siempre en soles (S/)
  fecha_vencimiento TEXT NOT NULL CHECK (fecha_vencimiento ~ '^\\d{4}-\\d{2}-\\d{2}$'),  -- CUÁNDO
  estado            TEXT NOT NULL DEFAULT 'PENDIENTE' CHECK (estado IN ('PENDIENTE','PAGADO')),
  fecha_pago        TEXT,                                            -- AAAA-MM-DD, obligatoria si PAGADO
  hora_pago         TEXT,                                            -- HH:MM (hora de Lima)
  comentario        TEXT,                                            -- opcional, lo escribe el asistente al pagar
  pagado_por        INT REFERENCES usuarios(id),
  creado_en         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((estado = 'PAGADO' AND fecha_pago IS NOT NULL) OR (estado = 'PENDIENTE' AND fecha_pago IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_pagos_venc ON pagos(fecha_vencimiento);

-- Evidencia = recibo/boleta (JPG, PNG o PDF), guardada DENTRO de la base.
-- Cada pago tiene UNA evidencia vigente y hasta 3 intentos previos (archivos reemplazados), que no se eliminan.
CREATE TABLE IF NOT EXISTS evidencias (
  id              SERIAL PRIMARY KEY,
  pago_id         INT NOT NULL REFERENCES pagos(id) ON DELETE CASCADE,
  datos           BYTEA NOT NULL,
  nombre_original TEXT NOT NULL,
  tipo_mime       TEXT NOT NULL,
  subido_por      INT NOT NULL REFERENCES usuarios(id),
  subido_en       TIMESTAMPTZ NOT NULL DEFAULT now(),
  vigente         BOOLEAN NOT NULL DEFAULT true,
  numero_intento  INT,                 -- 1..3, solo en los intentos previos
  reemplazada_en  TIMESTAMPTZ          -- cuándo dejó de ser la vigente
);

-- Compatibilidad con bases creadas con versiones anteriores
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS entidad TEXT NOT NULL DEFAULT 'Sin entidad';
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS hora_pago TEXT;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS comentario TEXT;
ALTER TABLE evidencias DROP CONSTRAINT IF EXISTS evidencias_pago_id_key;
ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS vigente BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS numero_intento INT;
ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS reemplazada_en TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS ux_evidencia_vigente ON evidencias(pago_id) WHERE vigente;

ALTER TABLE evidencias ADD COLUMN IF NOT EXISTS comentario TEXT;   -- comentario del asistente al subir/cambiar la evidencia
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS sesion_id TEXT;   -- sesión vigente: un solo inicio de sesión activo por usuario

-- Los usuarios son «Gerente» y «Asistente» (con mayúscula inicial)
UPDATE usuarios SET correo = 'Gerente@castillo.pe' WHERE correo = 'gerente@castillo.pe';
UPDATE usuarios SET correo = 'Asistente@castillo.pe' WHERE correo = 'asistente@castillo.pe';

-- Préstamos: un préstamo genera una cuota (pago) por mes. La mora es una tasa nominal anual (base 360 días).
CREATE TABLE IF NOT EXISTS prestamos (
  id                      SERIAL PRIMARY KEY,
  entidad                 TEXT NOT NULL,                  -- entidad bancaria
  monto_total             NUMERIC(12,2) NOT NULL CHECK (monto_total > 0),
  num_cuotas              INT NOT NULL CHECK (num_cuotas > 0),
  mora_tna                NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (mora_tna >= 0),
  fecha_vencimiento_total TEXT NOT NULL,                  -- fecha en que vence el préstamo completo
  fecha_primera_cuota     TEXT NOT NULL,                  -- el día de esta fecha se repite cada mes
  creado_en               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Datos propios de cada categoría y método de pago (todos opcionales: los pagos antiguos siguen funcionando)
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS tipo_servicio     TEXT;     -- Servicios: Agua / Luz / Internet
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS numero_recibo     TEXT;     -- Servicios
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS codigo_suministro TEXT;     -- Servicios: Agua / Luz
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS ruc               TEXT;     -- Proveedores
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS razon_social      TEXT;     -- Proveedores
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS prestamo_id       INT REFERENCES prestamos(id) ON DELETE CASCADE;   -- Préstamos
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS numero_cuota      INT;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS total_cuotas      INT;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS metodo_pago       TEXT;     -- TRANSFERENCIA / EFECTIVO / BILLETERA / TARJETA (se elige al pagar)
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS metodo_detalle    TEXT;     -- PLIN / YAPE / AGORA / CREDITO / DEBITO
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS mora_pagada       NUMERIC(12,2) NOT NULL DEFAULT 0;   -- mora cobrada al pagar una cuota atrasada
CREATE INDEX IF NOT EXISTS ix_pagos_prestamo ON pagos(prestamo_id);

-- Avisos para el gerente (cambio de evidencia)
CREATE TABLE IF NOT EXISTS notificaciones (
  id        SERIAL PRIMARY KEY,
  mensaje   TEXT NOT NULL,
  leida     BOOLEAN NOT NULL DEFAULT false,
  creada_en TIMESTAMPTZ NOT NULL DEFAULT now()
);`);
}

module.exports = { pool, query, iniciarEsquema };
