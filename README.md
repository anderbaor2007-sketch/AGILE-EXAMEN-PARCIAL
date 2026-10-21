# Sistema de Egresos – Empresa Castillo (MVP)

Node.js 22 · PostgreSQL (Neon) · HTML/JS simple. Despliegue: GitHub → Render (gratis) + Neon (gratis).

## Correr en local
```bash
copy .env.example .env     # y pega tu DATABASE_URL de Neon (sin -pooler, ?sslmode=require)
npm install
npm start                  # http://localhost:3000
```
Pruebas (una por historia de usuario; usar una base **de prueba vacía**, se borran sus datos):
`DATABASE_URL=<url-de-prueba> npm test`

| Rol | Usuario | Contraseña inicial |
|---|---|---|
| Gerente | `Gerente` | `GERENTE_CLAVE` (por defecto gerente123) |
| Asistente | `Asistente` | `ASISTENTE_CLAVE` (por defecto asistente123) |

## Trazabilidad con las historias de usuario
| HU | Dónde se cumple |
|---|---|
| HU-01 Iniciar sesión | `public/app.js` (campos obligatorios, sin espacios) · `src/auth.js` (contraseña sensible a mayúsculas/minúsculas) |
| HU-02 Panel de monitoreo (gerente) | `GET /api/panel` (`panel`) · pantalla principal del gerente (dashboard) |
| HU-03 Evidencia e intentos (gerente) | `GET /api/pagos/:id/evidencias`, `GET /api/evidencias/:id[?descargar=1]` |
| HU-04 Pagos del mes (asistente) | `GET /api/pagos` (`listar`) · vista Lista y Calendario |
| HU-05 Registrar pago por realizar | `POST /api/pagos/verificar` (aviso de repetido) y `POST /api/pagos` (`crear`) |
| HU-06 Registrar pago realizado + evidencia | `PUT /api/pagos/:id/pagar` (una sola sentencia SQL atómica) |
| HU-07 Cambiar evidencia | `PUT /api/pagos/:id/evidencia` (máx. 3 intentos; el archivo reemplazado queda como intento previo) |
| HU-08 Pagos por vencer | `GET /api/pagos/por-vencer` (hoy + 3 días y atrasados) |
| Congelar pagos (gerente) | `POST /api/pagos/:id/congelar` y `/descongelar` (solo GERENTE; columnas `congelado`, `motivo_congelado`) |
| Pago atrasado (asistente) | `POST /api/pagos` con `atrasado:true` (`validarVencimiento`) |
| Evidencias (hasta 3 archivos; repetidos con justificación) | hash SHA-256 en `evidencias.hash`, `validarArchivos` y `revisarRepetidos` |
| HU-09 Avisos | diálogo al iniciar sesión (solo asistente), calculado desde `por-vencer` |

## Reglas de negocio (constantes en `src/handlers/pagos.js`)
- Límite de monto: Servicios S/ 20 000; Proveedores e Impuestos S/ 500 000; Préstamos S/ 2 000 000 (`LIMITE_MONTO`). Al excederlo: «El monto no puede exceder los … soles».
- Fecha de pago: no posterior a ahora y no anterior a 7 días (`DIAS_MAX_ATRAS_PAGO`). Evidencia: de 1 a 3 archivos JPG/PNG/PDF por pago (máx. 5 MB cada uno y 15 MB en total); máx. 3 cambios (cada cambio reemplaza el conjunto completo).
- Mes actual: pagos que vencen en el mes **+** pendientes de meses anteriores (*Atrasado*). Otros meses: solo los que vencen en ese mes.
- Pago repetido: misma entidad + categoría + concepto + mismo mes de vencimiento → aviso, el asistente puede confirmar o cancelar.
- Formulario por categoría (se elige primero): **Servicios** (Agua/Luz/Internet; Luz y Agua piden código de suministro; N.º de recibo), **Proveedores** (RUC de 11 dígitos + razón social), **Impuestos** (SUNAT: IGV o Impuesto a la renta; SAT: predial o vehicular) y **Préstamos**.
- Préstamos: monto total (máx. S/ 2 000 000), N.º de cuotas (1–120; 1 cuota = 1 mes, debe coincidir con los meses entre la primera cuota y el vencimiento; cuota mínima S/ 50), mora (TNA %, base 360 días), vencimiento total (máx. 10 años) y fecha de la primera cuota. Se generan las cuotas mensuales (mismo día cada mes; el monto se reparte en partes iguales y la última absorbe los céntimos). La mora de una cuota atrasada = cuota × TNA ÷ 360 × días de atraso y se suma al monto; al pagar queda fija.
- Método de pago (se elige al registrar el pago como realizado; sin descuentos): Transferencia (cuenta de la empresa), Efectivo, Billetera digital (Plin, Yape o Agora) o Tarjeta (crédito o débito). En Préstamos solo Transferencia o Tarjeta de crédito.
- El vencimiento **no se puede modificar** una vez registrado el pago.
- El usuario distingue mayúsculas (`Gerente`, `Asistente`). Sin espacios; sin datos: "Ingrese usuario y contraseña".
- Sesión única: cada usuario (Gerente / Asistente) tiene una sola sesión activa; al iniciar sesión en otro dispositivo, la anterior se cierra. Gerente y Asistente pueden estar conectados a la vez.
- La base se crea sin pagos. Para vaciarla en cualquier momento: `limpiar-datos.sql` (SQL Editor de Neon).
- Estado visible de cada pago: Pendiente, Pagado, Atrasado o Congelado. El gerente puede congelar/descongelar cualquier pago pendiente (motivo opcional, máx. 200 caracteres); un pago congelado no se puede pagar, no genera mora ni aparece en «por vencer».
- Pago atrasado: el asistente marca «Es un pago atrasado»; el vencimiento debe ser anterior a hoy (hasta 12 meses atrás). Solo Servicios, Proveedores e Impuestos (no Préstamos).
- Evidencias: hasta 3 archivos por envío (5 MB c/u, 15 MB en total). Un archivo idéntico (mismo contenido) a uno ya subido —en otro pago, la evidencia vigente o un intento anterior— solo se acepta con una justificación escrita (10–300 caracteres), que queda guardada y visible para el gerente. El mismo archivo dos veces en un mismo envío se rechaza siempre. Solo detecta archivos idénticos byte a byte.
- Tema visual verde oscuro y blanco, con animaciones (contadores que suben desde 0, entradas suaves); respeta «reducir movimiento» del sistema.
