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
| HU-09 Avisos | diálogo al iniciar sesión (solo asistente), calculado desde `por-vencer` |

## Reglas de negocio (constantes en `src/handlers/pagos.js`)
- Límite de monto: Servicios S/ 20 000; Proveedores, Impuestos y Préstamos S/ 500 000 (`LIMITE_MONTO`).
- Fecha de pago: no posterior a ahora y no anterior a 7 días (`DIAS_MAX_ATRAS_PAGO`). Evidencia: JPG/PNG/PDF, máx. 5 MB, máx. 3 cambios.
- Mes actual: pagos que vencen en el mes **+** pendientes de meses anteriores (*Atrasado*). Otros meses: solo los que vencen en ese mes.
- Pago repetido: misma entidad + categoría + mismo mes de vencimiento → aviso, el asistente puede confirmar o cancelar.
- El vencimiento **no se puede modificar** una vez registrado el pago.
- El usuario distingue mayúsculas (`Gerente`, `Asistente`). Sin espacios; sin datos: "Ingrese usuario y contraseña".
- Sesión única: cada usuario (Gerente / Asistente) tiene una sola sesión activa; al iniciar sesión en otro dispositivo, la anterior se cierra. Gerente y Asistente pueden estar conectados a la vez.
- La base se crea sin pagos. Para vaciarla en cualquier momento: `limpiar-datos.sql` (SQL Editor de Neon).
