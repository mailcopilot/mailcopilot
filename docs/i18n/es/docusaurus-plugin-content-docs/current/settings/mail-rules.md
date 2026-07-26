---
sidebar_position: 5
title: Reglas de correo
---

# Reglas de correo

Las reglas de correo te permiten ordenar y organizar automáticamente los correos entrantes según condiciones que tú defines. Las reglas se evalúan cada vez que llegan mensajes nuevos.

## Crear una regla

1. Abre **Configuración > Reglas**.
2. Haz clic en **Agregar regla**.
3. Dale un nombre a tu regla.
4. Elige a qué cuenta se aplica la regla (o selecciona «Todas las cuentas»).

### Condiciones

Cada regla tiene una o más condiciones. Todas las condiciones deben coincidir para que la regla se active (lógica Y). Si necesitas lógica O, crea reglas separadas.

Campos de condición disponibles:
- **De** — nombre o dirección del remitente.
- **Para** — dirección del destinatario.
- **CC** — dirección en copia.
- **Asunto** — la línea de asunto del correo.
- **Tiene adjunto** — si el correo tiene archivos adjuntos.

Operadores disponibles:
- **contiene** / **no contiene** — coincidencia parcial.
- **es igual a** — coincidencia exacta.
- **empieza con** / **termina con** — coincidencia por prefijo o sufijo.
- **coincide con expresión regular** — búsqueda avanzada de patrones mediante expresiones regulares.

### Acciones

Cuando una regla coincide, se realizan una o más acciones:

- **Archivar** — mover a la carpeta Archivo.
- **Mover a la papelera** — mover a la carpeta Papelera.
- **Mover a carpeta** — mover a una carpeta específica de tu elección.
- **Marcar como leído** — marcar automáticamente el correo como leído.
- **Destacar** — marcar el correo con una estrella.
- **Marcar como spam** — mover a la carpeta Spam.

### Detener el procesamiento

Si activas **«Detener el procesamiento de reglas posteriores»**, no se evaluarán más reglas después de que esta se active. Esto es útil cuando tienes una regla general y quieres evitar que anule reglas más específicas.

## Probar reglas

Antes de guardar una regla, haz clic en **«Probar con correos existentes»** para ver cuáles de tus correos existentes coinciden con las condiciones. Esto te ayuda a verificar que la regla funciona como esperas antes de aplicarla a correos nuevos.

## Aplicar a correos existentes

Marca **«Aplicar a correos existentes en la bandeja de entrada»** al guardar una regla para aplicarla de inmediato a los correos que ya están en tu bandeja de entrada.

## Prioridad de las reglas

Las reglas se evalúan en orden de prioridad (número menor = mayor prioridad). Puedes ajustar la prioridad al editar una regla. Si dos reglas tienen la misma prioridad, se evalúan en orden de creación.

## Reglas de IA

Si tienes un proveedor de IA configurado (consulta [Asistente de IA](../ai-assistant)), también puedes crear reglas basadas en IA. Las reglas de IA procesan los correos que no coinciden con ninguna regla estática.

### Cómo funcionan las reglas de IA

1. Escribes un prompt que describe cómo ordenar los correos (por ejemplo, «Archivar boletines, mover correos de reclutadores a la carpeta Empleo»).
2. Eliges qué acciones puede realizar la IA.
3. Estableces un límite de presupuesto diario para controlar los costos.
4. La IA evalúa los correos no procesados en lotes. Aplica automáticamente solo las acciones reversibles (archivar, mover, marcar como leído, destacar); las acciones de papelera y spam se registran como vistas previas pendientes que debes aplicar tú mismo.

Las acciones de las reglas de IA se registran para que puedas revisar qué acción se aplicó o propuso para cada correo.

### Las nuevas reglas de IA empiezan desactivadas

Una regla de IA recién creada está **desactivada de forma predeterminada**. Active **«Activado»** en la regla una vez que haya revisado su prompt y las acciones permitidas, para empezar a aplicarla al correo entrante. Esto evita que una regla actúe sobre su bandeja de entrada antes de que usted confirme que se comporta como espera.

### Límite de reglas activadas por cuenta

Puede activar como máximo **20 reglas de IA por cuenta** (las reglas globales, que se aplican a todas las cuentas, cuentan para el límite de cada cuenta). Si intenta activar una regla por encima de este límite, la aplicación muestra un mensaje y la regla permanece desactivada — desactive primero otra regla. Este límite mantiene el procesamiento en segundo plano rápido y predecible: todas las reglas activadas de una cuenta se evalúan juntas en una sola pasada.

### Las acciones destructivas requieren revisión

Las acciones reversibles -- archivar, mover a carpeta, marcar como leído, destacar -- se aplican automáticamente cuando coincide una regla de IA. **Mover a la papelera** y **Marcar como spam** nunca se aplican automáticamente: en su lugar, la IA registra la acción propuesta como una entrada pendiente en el registro de acciones de la regla. Para llevar a cabo una acción propuesta de papelera o spam, debe abrir la entrada y aplicarla explícitamente -- no se elimina ni se marca como spam nada hasta que lo haga. Esto evita que la IA elimine correos de forma permanente de su bandeja de entrada sin su confirmación.

### Las reglas solo ven su propia cuenta

Una regla de IA asociada a una cuenta específica solo evalúa y actúa sobre el correo de esa cuenta. Nunca ve ni afecta a los mensajes de sus otras cuentas.
