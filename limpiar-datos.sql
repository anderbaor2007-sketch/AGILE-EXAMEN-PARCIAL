-- Vacía TODOS los pagos, préstamos y evidencias (deja usuarios y categorías). Ejecutar en Neon > SQL Editor.
TRUNCATE evidencias, pagos, prestamos RESTART IDENTITY CASCADE;
