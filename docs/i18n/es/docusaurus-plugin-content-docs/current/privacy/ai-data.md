---
sidebar_position: 1
title: AI Data & Audit Log
---

# Datos de IA y registro de auditoría

Esta página explica qué datos procesa el asistente de IA, cómo MailCopilot registra ese procesamiento en un registro de auditoría local y qué controles tiene usted sobre esos datos.

## Qué envía el asistente de IA a los proveedores

Cuando utiliza el asistente de IA, MailCopilot transmite lo siguiente a su proveedor de IA elegido:

- El contenido del correo o hilo de conversación que está viendo en ese momento (asunto, cuerpo, remitente, destinatarios).
- Los archivos adjuntos que le pide explícitamente al asistente que lea.
- Sus notas de memoria de IA (si la función de Memoria está configurada).
- El texto de su mensaje al asistente en el chat.

**Lo que nunca se envía:**

- Correos o carpetas que no haya abierto ni mencionado en la sesión actual.
- Sus credenciales IMAP/SMTP o la configuración del servidor.
- Las contraseñas de sus cuentas de correo.
- Datos de cuentas que no haya utilizado explícitamente en la solicitud de IA actual.

El asistente de IA es completamente opcional. Si no configura un proveedor, ningún dato de correo se transmite a ningún servicio externo.

## Resumen IA del hilo

El [Resumen IA del hilo](../ai-assistant#resumen-ia-del-hilo) es una función independiente y opcional que genera un breve resumen de un hilo abierto. Sigue las mismas protecciones que el resto del asistente de IA:

- **Deshabilitado de forma predeterminada, por cuenta.** No se envía nada para resumir a menos que habilite **Configuración > IA > Resumen IA del hilo** para esa cuenta específica.
- **Contenido envuelto.** Cada mensaje incluido en la solicitud de resumen se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita más abajo en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts).
- **Generaciones auditadas.** Cada vez que se genera realmente un resumen (y no se sirve desde la caché), se escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría) con el objetivo de la acción de resumen. Volver a abrir un hilo que ya fue resumido lee el resultado en caché y no crea una nueva entrada de auditoría ni vuelve a contactar al proveedor de IA.
- **Caché limitada a la cuenta.** Un resumen generado se almacena en caché y se busca por cuenta: la clave de caché combina su cuenta con la identidad del hilo, de modo que un resumen en caché de una cuenta nunca se reutiliza ni se expone para otra cuenta.
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, el resumen se rechaza de forma controlada en lugar de generarse — consulte [Resumen IA del hilo](../ai-assistant#resumen-ia-del-hilo) para ver qué se muestra en ese caso.
- **Selección de proveedor.** El Resumen IA del hilo utiliza su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini). Está diseñado para preferir un modelo local, en el dispositivo, en cuanto esa opción esté disponible, de modo que el contenido del hilo no necesitaría salir de su equipo — ese soporte aún no está disponible, por lo que hoy siempre usa su proveedor remoto configurado por clave de API.
- **La telemetría no contiene contenido de mensajes.** El evento de uso seudónimo registrado en cada generación solo incluye el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens de entrada/salida, la latencia y una clase de error agregada — nunca el asunto, el cuerpo o las direcciones de los participantes del hilo.

## Acciones rápidas al redactar

Las [Acciones rápidas al redactar](../ai-assistant#acciones-rapidas-al-redactar) reescriben el texto que usted mismo ha escrito (Mejorar / Acortar / Formal) en la ventana de redacción. Siguen las mismas protecciones que el resto del asistente de IA:

- **Solo su propio texto sale del dispositivo, en borradores redactados por MailCopilot.** MailCopilot separa su propio texto del mensaje citado, el encabezado de reenvío y la firma antes de enviar nada, de modo que solo su propio texto llega al proveedor de IA y solo su propio texto se reemplaza jamás. Esta separación es fiable para respuestas, reenvíos y firmas que ha producido el propio MailCopilot, así como para las convenciones extendidas de otros clientes: citas con prefijo `>` (incluida una cita anidada `>>` o con sangría de espacios), un banner de reenvío hecho de guiones, un separador de firma `--` o `-- `. **Un borrador redactado en otro programa de correo puede citar con un estilo que MailCopilot no reconoce**: un prefijo `|`, solo sangría sin `>`, un bloque de encabezados `From:` / `Sent:` / `To:` / `Subject:` sin marco, texto plano convertido desde una cita HTML, un separador de guiones bajos al estilo Outlook, o "Begin forwarded message:" sin banner de guiones. En un borrador así no se encuentra ninguna frontera, todo el cuerpo cuenta como su propio texto y la cita se envía junto con él. Su revisión sigue interponiéndose ante cualquier cambio: la reescritura siempre se muestra primero como una comparación antes/después. Consulte [Acciones rápidas al redactar](../ai-assistant#acciones-rapidas-al-redactar) para saber cómo se detecta esa separación.
- **Sin sustitución silenciosa.** Una reescritura solo se muestra como una comparación antes/después. El cuerpo de su borrador solo cambia después de que haga clic explícitamente en **Reemplazar** o **Añadir debajo de mi texto** — hacer clic en **Cancelar**, o descartar la comparación, deja su borrador sin cambios y no se envía nada más.
- **Sin truncado silencioso.** Si su propio texto supera los 8000 caracteres, MailCopilot rechaza la reescritura en lugar de enviar y reemplazar solo una parte.
- **Protección contra ediciones simultáneas.** Si sigue escribiendo mientras una reescritura está en curso, **Reemplazar** se deshabilita en cuanto llega la reescritura, para que no pueda sobrescribir el texto que haya escrito mientras tanto; **Añadir debajo de mi texto** sigue disponible.
- **Contenido envuelto.** Su propio texto se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts) más abajo — esto también protege contra texto que haya pegado desde una fuente no confiable.
- **Generaciones auditadas.** Cada reescritura escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría) con `goal` establecido en `quick_action`; el preset concreto usado se registra en el span de telemetría, no en la entrada de auditoría.
- **Selección de proveedor.** Las Acciones rápidas utilizan su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini). No hay un ajuste de activación/desactivación independiente: las Acciones rápidas están disponibles siempre que haya un proveedor adecuado configurado y el borrador tenga texto para reescribir.
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, la reescritura se rechaza de forma controlada — consulte [Acciones rápidas al redactar](../ai-assistant#acciones-rapidas-al-redactar) para ver qué se muestra en ese caso.
- **La telemetría no contiene contenido de mensajes.** El evento de uso seudónimo registrado en cada reescritura solo incluye el preset usado, el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens, la latencia y una clase de error agregada — nunca el texto del borrador en sí.

## AI Proofread

[AI Proofread](../ai-assistant#ai-proofread) revisa el texto que usted mismo ha escrito y enumera correcciones sugeridas una a una, en lugar de reescribir todo el texto como los presets de arriba. Sigue las mismas protecciones que el resto del asistente de IA:

- **Deshabilitada de forma predeterminada, por cuenta.** No se envía nada para revisar a menos que habilite **AI Proofread** para ese buzón específico en la tabla [Funciones de IA por buzón](../ai-assistant#funciones-de-ia-por-buzón). **A diferencia de la mayoría de las demás autorizaciones de IA, el botón no se oculta por ello** -- permanece visible, en un estado visiblemente bloqueado, con una pista al pasar el cursor por encima que indica dónde activarlo. Hacer clic mientras está bloqueado no envía nada; MailCopilot también rechaza de forma independiente en la conexión con el proveedor de IA si el ajuste está desactivado, de modo que la autorización se comprueba dos veces, no solo mediante el color gris del botón.
- **Solo su propio texto sale del dispositivo, en borradores redactados por MailCopilot.** Aquí se aplica la misma frontera de texto propio que en las acciones rápidas al redactar: el mensaje citado, el encabezado de reenvío y la firma quedan excluidos de lo que se revisa. Consulte [Acciones rápidas al redactar](#acciones-rápidas-al-redactar) más arriba para saber cómo se detecta esa frontera y dónde puede fallar.
- **Sin sustitución silenciosa.** Las sugerencias solo se muestran como una lista que usted acepta individualmente; el borrador solo cambia después de que haga clic explícitamente en **Accept** (o **Accept all**) y luego en **Apply selected**.
- **Contenido envuelto.** Su propio texto se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts) más abajo.
- **Generaciones auditadas.** Cada revisión escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría).
- **Selección de proveedor.** AI Proofread utiliza su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini).
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, la revisión se rechaza de forma controlada — consulte [AI Proofread](../ai-assistant#ai-proofread) para ver qué se muestra en ese caso.
- **La telemetría no contiene contenido de mensajes.** El evento de uso seudónimo registrado en cada revisión solo incluye el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens, la latencia y una clase de error agregada — nunca el texto del borrador ni las sugerencias en sí.

## Respuesta instantánea

La [Respuesta instantánea](../ai-assistant#respuesta-instantanea) es una función independiente y opcional que redacta dos o tres opciones de respuesta breves para el mensaje que tiene abierto. Sigue las mismas protecciones que el resto del asistente de IA, más una salvaguarda adicional específica de cómo obtiene el cuerpo del correo:

- **Deshabilitada de forma predeterminada, por cuenta.** No se envía nada para redactar a menos que habilite **Configuración > IA > Respuesta instantánea** para esa cuenta específica. Cuando está deshabilitada, el botón de Respuesta instantánea no se muestra y no se realiza ninguna solicitud.
- **Solo cuerpo desde la caché.** La Respuesta instantánea resuelve el cuerpo del correo original desde la caché local de MailCopilot por cuenta, carpeta y UID del mensaje — nunca confía en el texto del cuerpo que pudiera venir de lo que se esté mostrando en la ventana, lo que descarta una clase de ataques de envenenamiento de caché en los que una vista manipulada podría influir en lo que se envía al proveedor de IA.
- **Contenido envuelto.** El cuerpo del correo original se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts) más abajo.
- **Nunca se envía automáticamente.** Elegir una opción redactada solo prellena una **nueva** ventana de redacción. No se envía nada hasta que usted revise explícitamente el borrador y pulse Enviar usted mismo.
- **Generaciones auditadas.** Cada vez que se generan realmente borradores, se escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría) con el objetivo de la acción de respuesta instantánea.
- **Selección de proveedor.** La Respuesta instantánea utiliza su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini).
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, la redacción se rechaza de forma controlada — consulte [Respuesta instantánea](../ai-assistant#respuesta-instantanea) para ver qué se muestra en ese caso.
- **La telemetría no contiene contenido de mensajes.** El evento de uso seudónimo registrado en cada generación solo incluye el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens, la latencia y una clase de error agregada — nunca el asunto, el cuerpo del correo, las direcciones del remitente o del destinatario, o el texto de la respuesta redactada.

## Traducción del mensaje

La [Traducción del mensaje](../ai-assistant#traducción-del-mensaje) es una función independiente y opcional que traduce el mensaje que tiene abierto a un idioma de su elección. Sigue las mismas protecciones que el resto del asistente de IA:

- **Deshabilitada de forma predeterminada, por cuenta.** No se envía nada para traducir a menos que habilite **Configuración > IA > Traducción con IA** para esa cuenta específica. Cuando está deshabilitada, el control Traducir no se muestra y no se realiza ninguna solicitud.
- **Solo bajo demanda.** Solo se llama a un proveedor cuando hace clic en **Traducir** -- no hay traducción automática al abrir un mensaje.
- **Proyección a texto plano.** El proveedor solo ve, y solo devuelve, texto plano: la traducción se genera a partir de la versión de texto del mensaje, nunca del marcado HTML, incluso para un mensaje HTML.
- **Solo texto desde la caché.** El texto del mensaje procede de la caché local de MailCopilot por cuenta, carpeta y UID del mensaje — nunca de lo que se esté mostrando en ese momento en la ventana.
- **Contenido envuelto.** El texto del mensaje se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts) más abajo.
- **En caché, no se reenvía.** Una traducción ya generada para un mensaje, un idioma de destino y una versión del contrato de traducción (proveedor, modelo y forma del prompt) se sirve desde una caché local en aperturas posteriores — no llega ninguna solicitud al proveedor una segunda vez para el mismo mensaje, idioma y contrato. Las entradas de la caché no tienen caducidad propia: un cambio posterior en cómo MailCopilot genera las traducciones queda registrado bajo una clave nueva en lugar de servir el resultado de un contrato antiguo como si fuera el actual. Están limitadas a 500 por cuenta y se eliminan junto con la cuenta.
- **Generaciones auditadas.** Cada vez que se genera realmente una traducción (y no se sirve desde la caché), se escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría). Un acierto de caché no escribe ninguna entrada.
- **Selección de proveedor.** La Traducción del mensaje utiliza su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini).
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, la traducción se rechaza de forma controlada — consulte [Traducción del mensaje](../ai-assistant#traducción-del-mensaje) para ver qué se muestra en ese caso.
- **La telemetría no contiene contenido de mensajes.** El evento de uso seudónimo registrado en cada llamada al proveedor solo incluye el identificador del proveedor, si el modelo se ejecutó localmente, los recuentos de tokens, la latencia, una clase de error agregada, los códigos del idioma de origen detectado y del idioma de destino elegido, y si el resultado provino de la caché — nunca el texto del mensaje, la traducción, el asunto, las direcciones o el nombre de la carpeta.

## Traducción del borrador

[La traducción del borrador](../ai-assistant#traducción-del-borrador) es el equivalente, en el lado de la redacción, de la traducción del mensaje: traduce el texto que usted mismo escribió a un idioma de su elección, desde la ventana de redacción. Comparte el mismo ajuste de activación que la traducción del mensaje y sigue las mismas protecciones, más las específicas de la redacción que ya usan las acciones rápidas al redactar:

- **Deshabilitada de forma predeterminada, por cuenta -- sin ajuste independiente.** La traducción del borrador se controla con la misma autorización **AI Translate** que la traducción del mensaje, activada por buzón en la tabla [Funciones de IA por buzón](../ai-assistant#funciones-de-ia-por-buzón); no hay nada adicional que activar. **A diferencia de la mayoría de las demás autorizaciones de IA, la lista y el botón no se ocultan por ello** -- permanecen visibles, el botón en un estado visiblemente bloqueado, con una pista al pasar el cursor por encima que indica dónde activarlo. Hacer clic en el botón mientras está bloqueado no envía nada; MailCopilot también rechaza de forma independiente en la conexión con el proveedor de IA si el ajuste está desactivado.
- **Solo a petición.** Un proveedor solo se llama cuando hace clic en **Traducir**. Abrir la ventana de redacción, que aparezca un idioma de destino sugerido en la lista, o cambiar el valor de la lista nunca llama a un proveedor por sí solo.
- **Solo su propio texto sale del dispositivo, cuando se encuentra una frontera.** La traducción del borrador reutiliza la misma frontera de texto propio que las acciones rápidas al redactar: el mensaje citado, el encabezado de reenvío y la firma quedan excluidos tanto de lo que se envía como de lo que se llega a reemplazar, para respuestas, reenvíos y firmas que ha producido el propio MailCopilot, así como para las convenciones extendidas de otros clientes. En un borrador que cita con un estilo que MailCopilot no reconoce, no se encuentra ninguna frontera y todo el cuerpo -- cita incluida -- se envía al proveedor de IA y puede reemplazarse. Consulte [Acciones rápidas al redactar](#acciones-rápidas-al-redactar) más arriba para saber cómo se detecta esa frontera y la lista completa de estilos de cita que no reconoce.
- **Sin sustitución silenciosa.** La traducción solo se muestra como una comparación antes/después, en el mismo panel de revisión que usan las acciones rápidas al redactar. El cuerpo de su borrador solo cambia después de que haga clic explícitamente en **Reemplazar** o **Añadir debajo de mi texto**.
- **Sin caché.** A diferencia de la traducción del mensaje, un borrador traducido no se almacena: se espera que un borrador siga cambiando entre solicitudes, por lo que una caché duradera guardaría en su mayoría escritura no enviada que nunca llegaría a reutilizarse.
- **Contenido envuelto.** Su propio texto se envuelve con marcadores de límite `wrapUntrusted()` antes de llegar al proveedor de IA, la misma protección descrita en [Protección contra inyección de prompts](#protección-contra-inyección-de-prompts) más abajo.
- **Generaciones auditadas.** Cada traducción escribe una entrada en el [registro de auditoría de IA](#el-registro-de-auditoría).
- **Selección de proveedor.** La traducción del borrador utiliza su **proveedor configurado por clave de API** (Anthropic, compatible con OpenAI o Google Gemini).
- **Consciente del presupuesto.** Si se ha alcanzado el presupuesto diario de IA, la traducción se rechaza de forma controlada — consulte [Traducción del borrador](../ai-assistant#traducción-del-borrador) para ver qué se muestra en ese caso.
- **El idioma sugerido es solo una sugerencia.** Cuando está respondiendo, MailCopilot puede rellenar de antemano el selector de idioma de destino con el idioma del mensaje al que está respondiendo, detectado localmente en su dispositivo. Nunca inicia una traducción por sí solo, y nunca se informa de él: ningún campo de telemetría registra qué idioma se sugirió, ni si el idioma que eligió provino de esa sugerencia.
- **La telemetría no contiene contenido de mensajes.** El evento de uso pseudónimo registrado para cada traducción lleva solo el identificador del proveedor, si el modelo se ejecutó localmente, el recuento de tokens, la latencia, una clase de error agrupada y el código del idioma de destino que eligió — nunca el texto del borrador, la traducción, los destinatarios, el asunto o el idioma sugerido.

## Política de egress de IA

MailCopilot intercepta cada llamada a herramientas de internet que la IA desea realizar — búsqueda web, obtención de páginas web y llamadas a herramientas MCP externas — y detiene la IA para solicitar su aprobación antes de ejecutar la llamada. Esto evita que un correo malicioso filtre silenciosamente sus datos mediante un ataque de inyección de prompt.

### Funcionamiento

Cuando la IA quiere usar una herramienta de internet (por ejemplo, realizar una búsqueda web), MailCopilot detiene la respuesta y muestra un modal de confirmación integrado en el panel de IA con el mensaje **«La IA quiere acceder a Internet»**. El modal muestra:

- El tipo de acción — «Búsqueda web:», «Obtener URL:» o «Llamada a herramienta externa»
- La consulta, URL o nombre de herramienta externa solicitado por la IA (cuando esté disponible)
- Los botones **Permitir** y **Denegar**

Haga clic en **Permitir** para permitir que la IA continúe, o en **Denegar** para rechazar. Su decisión se aplica a todo el turno de respuesta actual — si la IA realiza varias llamadas a herramientas de internet en una misma respuesta, solo se le preguntará una vez. Al hacer clic en **Permitir** se concede acceso para todas las llamadas restantes de ese turno.

Si no responde en 30 segundos, MailCopilot deniega la llamada a la herramienta automáticamente.

### Icono de escudo

Se muestra un icono de escudo en el encabezado del panel de IA cuando la interception de egress está activa. Al pasar el cursor sobre él, aparece: «El acceso web de la IA está interceptado: cada llamada saliente requiere su aprobación». Este icono confirma que el interceptor está en funcionamiento y que ninguna llamada a internet puede omitir su aprobación.

### Configuración de política

Puede ajustar la política de egress en **Configuración → AI** (bajo el control **Acceso web de la IA**). Controla cuándo la IA puede usar herramientas de internet. Con **Denegar por defecto** o **Preguntar en cada turno**, MailCopilot solicita confirmación en la primera llamada a herramienta de internet de cada turno de respuesta. Con **Permitir siempre**, la solicitud se omite — las herramientas de internet se ejecutan sin confirmación:

- **Denegar por defecto (recomendado)** — interceptar todas las llamadas a herramientas de internet; usted aprueba o deniega cada turno mediante el modal de confirmación.
- **Preguntar en cada turno** — mismo comportamiento que la denegación predeterminada: consentimiento explícito por turno a través del modal de confirmación.
- **Permitir siempre** — la IA puede llamar libremente a herramientas web. Advertencia: la IA puede enviar contenido de correo a servicios externos.

### Registro de auditoría

Cada llamada a herramientas de internet interceptada crea una fila en el registro de auditoría; las llamadas denegadas incrementan la columna **Bloqueado**, mientras que las llamadas aprobadas se registran con **Bloqueado** = 0. Cada entrada también se contabiliza en el evento de telemetría `ai.egress.intercepted` con etiquetas que indican el nombre de la herramienta, el resultado (aprobado o denegado) y si el consentimiento para ese turno ya estaba registrado. Para los detalles de consulta o URL, el registro almacena únicamente un hash SHA-256 truncado a los primeros 16 caracteres hexadecimales; las consultas y URL sin procesar nunca se escriben en el disco.

## El registro de auditoría

MailCopilot mantiene un registro de auditoría local de cada acción de IA. El registro se almacena en su base de datos local en su dispositivo y nunca se transmite a MailCopilot ni a terceros.

### Qué registra cada entrada

| Campo | Descripción |
|-------|-------------|
| **Marca de tiempo** | Fecha y hora exactas en que ocurrió la acción. |
| **Proveedor** | Una etiqueta de atribución para la entrada, normalmente su proveedor de IA configurado (p. ej., Anthropic, OpenAI, Google). También puede nombrar a un cliente externo conectado a través del [Servidor MCP](../ai-assistant#servidor-mcp) (`mcp-export`), y las entradas más antiguas pueden conservar un identificador de proveedor que esta versión de MailCopilot ya no ofrece como método de conexión. |
| **Modelo** | La versión específica del modelo que procesó la solicitud. |
| **Objetivo** | Una breve descripción de lo que se pidió al asistente. |
| **Herramienta** | La herramienta MCP llamada, si corresponde (p. ej., `send_email`, `mail_action`, `move_email`). |
| **Tokens entrada / salida** | Recuento de tokens de entrada y salida para esta acción. Los valores se registran si el proveedor los expone a través del SDK; de lo contrario, las columnas muestran **n/d**. |
| **Costo (USD)** | Costo estimado según los precios publicados del proveedor, o **n/d** cuando esta entrada no tiene un costo por solicitud identificado -- ya sea porque el proveedor no informó uno, o porque la entrada en sí nunca lleva un costo por llamada (por ejemplo, una llamada a una herramienta de internet interceptada, o una acción realizada a través de una sesión MCP exportada). **n/d** aquí no significa que la solicitud haya eludido los límites de gasto: el Resumen IA del hilo, las Acciones rápidas al redactar y la Respuesta instantánea cuentan siempre contra el Presupuesto diario / mensual, sin importar lo que muestre esta columna. El costo es la señal principal para el seguimiento del gasto. |
| **Envuelto** | Número de invocaciones del marcador `wrapUntrusted()`. Cada invocación significa que un bloque de contenido de correo fue aislado antes de pasarse a la IA para prevenir la inyección de prompts. |
| **Bloqueado** | Número de intentos de egress saliente bloqueados por la política de seguridad durante esta acción. |
| **Resultado** | Resultado de la acción: **OK** (completado con éxito), **Error** (fallido) o **Cancelado** (interrumpido por usted o el sistema). |

### Inmutabilidad y retención

Las nuevas entradas siempre se añaden al final. Todas las columnas excepto `deleted_at` son inmutables después de la inserción — los registros existentes no se modifican una vez escritos. Esto significa que la aplicación no puede alterar entradas pasadas (solo puede eliminarlas de forma suave o dejar que el límite de rotación elimine las más antiguas). La eliminación suave de una entrada (ver más abajo) establece la marca de tiempo `deleted_at` y oculta la entrada de la vista, pero todas las demás columnas permanecen sin cambios.

El registro está limitado a **10.000 entradas**. Cuando se añade una nueva entrada y el total supera este límite, las filas más antiguas se eliminan automáticamente para mantener el registro dentro del límite. Las entradas anteriores a las 10.000 más recientes se eliminan permanentemente de la base de datos local. Si necesita un registro permanente, exporte el registro regularmente mediante los botones **Exportar JSON** o **Exportar CSV** antes de que las entradas queden fuera de la ventana de retención.

### Acceder al registro de auditoría

Abra **Configuración → IA** y expanda la sección **Privacidad y auditoría**. El registro está paginado y ordenado del más reciente al más antiguo.

### Exportar

Haga clic en **Exportar JSON** o **Exportar CSV** para descargar el registro de auditoría actualmente visible (filas activas dentro del límite de rotación de 10.000 entradas; las entradas eliminadas de forma suave y las eliminadas por rotación quedan excluidas). La exportación incluye todos los campos listados arriba para cada entrada incluida. El archivo CSV utiliza el formato RFC 4180 con separadores de línea CRLF y escape correcto (los campos que contienen comas, comillas o saltos de línea están correctamente escapados). El archivo CSV es compatible con Excel, Numbers y LibreOffice. Puede usarla para:

- Revisar la actividad de IA en cualquier momento.
- Responder a solicitudes de acceso a datos personales bajo el RGPD u otras normativas similares.
- Conservar una copia sin conexión para sus propios registros.

### Eliminar entradas

**Eliminación suave por fila** — haga clic en el icono de eliminación de una entrada del registro para ocultarla de la vista. La marca de tiempo `deleted_at` de la entrada se establece y desaparece de la lista y los agregados, pero los datos subyacentes se conservan para preservar la integridad del audit.

**Borrar todo** — marca todas las entradas de auditoría como eliminadas de forma suave (establece `deleted_at` en cada registro). Antes de ejecutar esta acción, MailCopilot muestra un diálogo de confirmación nativo del sistema operativo con el título "Clear AI audit log" y los botones **Cancel** y **Delete All**. Las entradas quedan ocultas de la lista, los agregados y las exportaciones. Tenga en cuenta que el límite automático de 10.000 filas (ver más arriba) elimina físicamente las filas más antiguas con el tiempo; las entradas eliminadas de forma suave cuentan para el límite y eventualmente serán purgadas definitivamente por la rotación.

## Agregados de tokens y costos

La parte superior del panel de Privacidad y auditoría muestra los totales de tokens y costos por proveedor. Seleccione un período — **Hoy**, **Últimos 7 días** o **Últimos 30 días** — para filtrar los agregados. Estas son ventanas móviles, no semana o mes calendario. Estos totales se calculan a partir del registro de auditoría local y nunca se envían a ningún servidor.

## Protección contra inyección de prompts

Cada bloque de contenido de correo que se pasa a la IA se envuelve con marcadores de límite `wrapUntrusted()`. Estos marcadores instruyen a la IA a tratar el contenido incluido como datos de usuario no confiables — no como instrucciones — para que un correo malicioso no pueda secuestrar el comportamiento del asistente. La columna **Envuelto** en el registro de auditoría le permite ver exactamente cuántas veces se aplicó esta protección en cada solicitud. El contador es preciso: si el mismo correo se recupera más de una vez dentro de una misma solicitud (por ejemplo, cuando la IA vuelve a consultarlo durante una tarea de varios pasos), cada recuperación se contabiliza por separado, de modo que el total refleja con exactitud el número real de lecturas de correos.

## Véase también

- [Asistente de IA](../ai-assistant) — guía completa para usar el asistente de IA.
- [Telemetría](./telemetry) — datos de diagnóstico seudónimos recopilados por MailCopilot (independientes del registro de auditoría de IA).
