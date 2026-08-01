---
sidebar_position: 5
title: Reglas de correo
---

# Reglas de correo

Las reglas de correo te permiten ordenar y organizar automáticamente los correos entrantes según condiciones que tú defines. Las reglas se ejecutan cada vez que MailCopilot descarga correo del servidor, no necesariamente en el instante en que un mensaje llega allí.

## Crear una regla

1. Abre **Configuración > Reglas**.
2. Haz clic en **Añadir regla**.
3. Dale un nombre a tu regla.
4. Elige a qué cuenta se aplica la regla (o selecciona «Todas las cuentas»).

### Condiciones

Cada regla tiene una o más condiciones. Todas las condiciones deben coincidir para que la regla se active (lógica Y). Si necesitas lógica O, crea reglas separadas.

Campos de condición disponibles:
- **Remitente** — se compara con el nombre visible del remitente cuando el mensaje tiene uno, y solo recurre a la dirección si no lo tiene. Una regla dirigida a una dirección puede dejar de coincidir en cuanto ese remitente empiece a usar un nombre visible: prueba la regla después de configurarla y vigila si deja de activarse.
- **Destinatario** — dirección del destinatario.
- **Cc** — está presente en el editor de reglas, pero MailCopilot no guarda el campo Cc de los correos en caché, así que para una regla todos los correos parecen tener el Cc vacío. Eso hace que la condición se comporte de forma imprevisible en lugar de simplemente «no funcionar»: coincidir con una dirección concreta en Cc nunca funciona, pero un operador de exclusión como **no contiene**, o una expresión regular que coincide con una cadena vacía, coincide en cambio con **todos** los correos. No uses una condición de Cc en una regla que mueva correo a la papelera, lo marque como spam o lo mueva a otra carpeta -- con el operador equivocado puede afectar a toda tu bandeja de entrada.
- **Asunto** — la línea de asunto del correo.
- **Tiene adjunto** — si el correo tiene archivos adjuntos.

Operadores disponibles:
- **contiene** / **no contiene** — coincidencia parcial.
- **es igual a** — coincidencia exacta.
- **comienza con** / **termina en** — coincidencia por prefijo o sufijo.
- **coincide con regex** — búsqueda avanzada de patrones mediante expresiones regulares.

### Acciones

Cuando una regla coincide, se realizan una o más acciones:

- **Archivar** — mover a la carpeta Archivo.
- **Mover a papelera** — mover a la carpeta Papelera.
- **Mover a carpeta** — mover a una carpeta específica de tu elección.
- **Marcar como leído** — marcar automáticamente el correo como leído.
- **Destacar** — marcar el correo con una estrella.
- **Marcar como spam** — mover a la carpeta Spam.

### Dejar de procesar las reglas

Si activas **«Dejar de procesar las reglas siguientes»**, no se evaluarán más reglas después de que esta se active. Esto es útil cuando tienes una regla general y quieres evitar que anule reglas más específicas.

## Probar reglas

Antes de guardar una regla, haz clic en **«Probar en correos existentes»** para previsualizar cuáles de tus correos recientes de la bandeja de entrada coincidirían con las condiciones. La vista previa revisa hasta 500 correos de la bandeja de entrada ya descargados a este dispositivo y muestra hasta 20 coincidencias -- es una comprobación rápida, no una búsqueda exhaustiva en todo tu buzón. En una regla limitada a una sola cuenta, esos son tus correos más recientes; en una regla para todas las cuentas, los 500 revisados proceden del conjunto de tus cuentas, pero no son necesariamente los más recientes en general. El correo más antiguo y el que aún no se ha descargado a este dispositivo no se incluyen.

## Aplicar a correos existentes

Marca **«Aplicar a correos existentes en la bandeja de entrada»** al guardar una regla para ejecutarla de inmediato sobre el correo que ya tienes. Esto alcanza hasta 1000 correos de la bandeja de entrada ya descargados a este dispositivo -- en una regla limitada a una sola cuenta, tus correos más recientes de ese tipo; en una regla para todas las cuentas, hasta 1000 correos procedentes del conjunto de tus cuentas, no necesariamente los más recientes en general. No llega más atrás en tu historial de correo en el servidor, y solo cubre la bandeja de entrada, no otras carpetas. Si una acción falla, solo se omite esa acción -- las demás acciones de la misma regla se siguen ejecutando sobre ese correo, y el resto del proceso se completa igualmente.

## Solo correo nuevo

Las reglas actúan sobre un correo nuevo en cuanto llega a tu dispositivo, sin importar por qué vía llegó -- una notificación push, una sincronización periódica o una página con correos más recientes que los que ya habías visto. Antes, la vía por la que llegaba un mensaje podía influir en si una regla lo detectaba o no, y algunos correos se perdían por eso; ese hueco ya no existe. Sin embargo, desplazarte hacia atrás para cargar páginas más antiguas no hace que esos correos antiguos pasen por las reglas -- eso es intencional, el mismo comportamiento de «no explorar el historial» descrito más abajo, no un hueco que haya quedado sin cerrar.

Aun así, esta garantía para el correo nuevo no es absoluta en todos los casos: un correo cuya acción falla tres intentos seguidos (por ejemplo, por una conexión interrumpida) se descarta definitivamente -- MailCopilot lo omite y sigue adelante en esa carpeta, así que un reinicio posterior no lo hará volver. Lo que un reinicio sí reinicia es un contador que aún no ha llegado a tres: si la aplicación se reinicia antes de que un correo haya fallado tres veces seguidas, el conteo vuelve a empezar desde cero, de modo que una acción que sigue fallando por un motivo que no desaparece puede bloquear indefinidamente el procesamiento de una carpeta, sin llegar nunca a alcanzar de verdad ese límite de tres intentos.

Además, las reglas nunca exploran por sí solas el historial completo de una carpeta. Cada carpeta que MailCopilot ya conoce al iniciarse recibe un punto de partida de inmediato, antes de que ocurra ninguna sincronización -- una carpeta vacía recibe un punto de partida en cero, así que su primer correo se evalúa con normalidad; una carpeta que ya tiene correo en caché recibe un punto de partida posterior a ese correo, de modo que el correo existente no se incorpora, pero todo lo que llegue después sí. Una carpeta que solo aparece después de ese momento de inicio -- recién creada o a la que te acabas de suscribir -- se trata de otra manera: no se evalúa nada en ella hasta que MailCopilot la haya sincronizado una vez, y solo cuenta el correo que llega después de esa primera sincronización. Ocurre el mismo reinicio si el servidor llega a reiniciar la numeración de los mensajes de una carpeta (algo poco frecuente, pero que puede ocurrir tras ciertas migraciones del lado del servidor). Usa **«Aplicar a correos existentes en la bandeja de entrada»** (véase más arriba) si quieres que una regla también evalúe el correo que ya tienes.

## Prioridad de las reglas

Las reglas se evalúan en orden de prioridad (número menor = mayor prioridad). La prioridad se asigna automáticamente al crear la regla -- por ahora no hay forma de ajustarla desde el editor de reglas. Si dos reglas tienen la misma prioridad, no está definido cuál de ellas se evalúa primero.

## Reglas de IA

Si tienes un proveedor de IA configurado (consulta [Asistente de IA](../ai-assistant)), también puedes crear reglas basadas en IA. Las reglas de IA procesan los correos que no coinciden con ninguna regla estática.

### Cómo funcionan las reglas de IA

1. Escribes un prompt que describe cómo ordenar los correos (por ejemplo, «Archivar boletines, mover correos de reclutadores a la carpeta Empleo»).
2. Eliges qué acciones puede realizar la IA.
3. Estableces un límite de presupuesto diario para controlar los costos.
4. La IA evalúa los correos no procesados en lotes. Aplica automáticamente solo las acciones reversibles (archivar, mover, marcar como leído, destacar); las acciones de papelera y spam se registran como vistas previas pendientes que debes aplicar tú mismo.

Las acciones de las reglas de IA se registran para que puedas revisar qué acción se aplicó o propuso para cada correo.

### Las nuevas reglas de IA empiezan desactivadas

Una regla de IA recién creada está **desactivada de forma predeterminada**. Active **«Activada»** en la regla una vez que haya revisado su prompt y las acciones permitidas, para empezar a aplicarla al correo entrante. Esto evita que una regla actúe sobre su bandeja de entrada antes de que usted confirme que se comporta como espera.

### Límite de reglas activadas por cuenta

Puede activar como máximo **20 reglas de IA por cuenta** (las reglas globales, que se aplican a todas las cuentas, cuentan para el límite de cada cuenta). Si intenta activar una regla por encima de este límite, la aplicación muestra un mensaje y la regla permanece desactivada — desactive primero otra regla. Este límite mantiene el procesamiento en segundo plano rápido y predecible: todas las reglas activadas de una cuenta se evalúan juntas en una sola pasada.

### Las acciones destructivas requieren revisión

Las acciones reversibles -- archivar, mover a carpeta, marcar como leído, destacar -- se aplican automáticamente cuando coincide una regla de IA. **Mover a papelera** y **Marcar como spam** nunca se aplican automáticamente: en su lugar, la IA registra la acción propuesta como una entrada pendiente en el registro de acciones de la regla. Para llevar a cabo una acción propuesta de papelera o spam, debe abrir la entrada y aplicarla explícitamente -- no se elimina ni se marca como spam nada hasta que lo haga. Esto evita que la IA elimine correos de forma permanente de su bandeja de entrada sin su confirmación.

### Las reglas solo ven su propia cuenta

Una regla de IA asociada a una cuenta específica solo evalúa y actúa sobre el correo de esa cuenta. Nunca ve ni afecta a los mensajes de sus otras cuentas.
