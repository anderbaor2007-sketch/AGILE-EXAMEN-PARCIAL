-- Vacía TODOS los pagos y evidencias (deja usuarios y categorías). Ejecutar en Neon > SQL Editor.
TRUNCATE evidencias, pagos RESTART IDENTITY CASCADE;
