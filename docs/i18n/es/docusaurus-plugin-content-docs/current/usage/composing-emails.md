---
sidebar_position: 3
title: Redactar correos
---

# Redactar correos

## Nuevo mensaje

Haz clic en **Redactar** o pulsa **c**. Se abre en una ventana separada.

## Campos

- **De** -- si tienes varias cuentas, selecciona desde cual enviar usando el desplegable superior. Si la cuenta elegida tiene mas de una **identidad** (direccion «From» alternativa, por ejemplo un alias en la misma cuenta de Gmail u Outlook), aparece un selector de identidad justo debajo del desplegable de cuenta que te permite escoger desde que identidad enviar. Consulta [Identidades](../settings/identities) para entender como funcionan las identidades y las firmas por identidad.
- **Para** -- introduce la direccion. Varias con **Enter**, **Tab** o **coma**.
- **Cc / Cco** -- haz clic en **Cc/Cco**.
- **Asunto** y **Cuerpo del mensaje**.

## Autocompletado de contactos

Sugerencias basadas en correspondencia anterior.

## Adjuntos

Haz clic en **Adjuntar** o arrastra archivos. Maximo: 25 MB por archivo.

## Responder y reenviar

Responder (**r**), Responder a todos (**a**), Reenviar (**f**).

## Borradores

Guardado automatico local y en la carpeta de Borradores IMAP.

## Envío

Haga clic en el botón **Enviar** para enviar su mensaje. La ventana de redacción se cierra inmediatamente mientras el mensaje se envía en segundo plano. Si hay un error (por ejemplo, un problema de conexión), verá una notificación de escritorio.

Si el mensaje se entregó correctamente pero MailCopilot no pudo guardar una copia en la carpeta Enviados (por ejemplo, si el servidor IMAP no está disponible temporalmente), aparece una notificación emergente: **El mensaje se entregó, pero no se pudo guardar una copia en la carpeta Enviados**. Haga clic en **Cerrar** para cerrarla. El mensaje fue entregado al destinatario — solo no se guardó la copia en el servidor.

## Enviar y archivar {#send--archive}

Al responder a un correo, el menú desplegable del botón **Enviar** incluye la opción **Enviar y archivar**. Haga clic en la pequeña flecha **▾** junto al botón Enviar y luego elija **Enviar y archivar**. Esto envía su respuesta y archiva automáticamente el correo original en un solo paso.

Esto es especialmente útil para un flujo de trabajo Inbox Zero — responda y elimine el correo de su bandeja de entrada sin clics adicionales.

## Envío programado

Puede programar el envío de un mensaje para un momento posterior:

1. Haga clic en la pequeña flecha **▾** junto al botón Enviar para abrir el menú desplegable.
2. Elija un horario predefinido:
   - **Más tarde hoy** — la próxima marca de media hora.
   - **Mañana por la mañana (09:00)**.
   - **Lunes por la mañana (09:00)**.
   - **Elegir fecha y hora** — seleccione una fecha y hora personalizadas.
3. El mensaje se pondrá en cola y se enviará automáticamente a la hora programada.

Los mensajes programados aparecen en la carpeta **Bandeja de salida**, donde puede editarlos, reprogramarlos, enviarlos inmediatamente o cancelarlos.

## Retraso de envio

Activa un retraso (5, 10 o 30 segundos) en **Configuracion > Productividad**.

## Usar plantillas

Las plantillas te permiten insertar rapidamente mensajes predefinidos en la ventana de redaccion, ahorrando tiempo en correos que envias con frecuencia.

### Aplicar una plantilla

1. Abre la ventana de redaccion.
2. Haz clic en el boton **Plantillas** (icono de cuadricula) en la barra de herramientas.
3. Selecciona una plantilla del menu desplegable.
4. El asunto y el cuerpo de la plantilla se insertan en la ventana de redaccion.

### Variables de plantilla

Las plantillas pueden incluir variables que se reemplazan automaticamente al aplicarlas:

- `{name}` -- el nombre del destinatario (si esta disponible).
- `{email}` -- la direccion de correo del destinatario.
- `{date}` -- la fecha de hoy.

Por ejemplo, un cuerpo de plantilla como "Estimado/a `{name}`, ..." reemplazara `{name}` con el nombre real del destinatario.

Para crear y gestionar plantillas, ve a **Configuracion > Plantillas**. Consulta la pagina de [Configuracion de plantillas](../settings/templates) para mas detalles.

## Acciones rapidas al redactar

Sobre el cuerpo del mensaje aparece una pequena barra de herramientas de IA con cuatro botones: **Mejorar**, **Acortar**, **Formal** y **Corregir gramatica**. Haga clic en uno para que la IA reescriba el texto actual de su borrador.

MailCopilot muestra un panel "Revisar la reescritura de IA" comparando su texto original (**Antes**) con la reescritura de la IA (**Despues**). Elija **Reemplazar** para sustituir todo el borrador por la reescritura, **Insertar en el cursor** para insertarla en la posicion actual del cursor, o **Cancelar** para descartar la reescritura y dejar su borrador sin cambios. El cuerpo del mensaje solo se modifica si elige **Reemplazar** o **Insertar en el cursor** -- **Cancelar** deja el borrador sin cambios.

Las Acciones rapidas requieren un proveedor de IA configurado (consulte [Asistente IA](../ai-assistant)) y texto en el cuerpo del mensaje para reescribir. Consulte [Acciones rapidas al redactar](../ai-assistant#acciones-rapidas-al-redactar) para el comportamiento completo y los detalles de privacidad.

## Advertencia de destinatarios erróneos

MailCopilot ayuda a evitar el envío accidental de correos a las personas equivocadas. Antes de enviar, verifica la lista de destinatarios y le advierte en dos situaciones:

- **Dominio externo** -- si la mayoría de los destinatarios comparten un mismo dominio (por ejemplo, @empresa.com) y usted añadió a alguien de un dominio diferente y no confiable, aparece un diálogo de confirmación.
- **Nuevos destinatarios en una respuesta** -- al responder, si añadió destinatarios que no formaban parte de la conversación original, se muestra una advertencia.

Puede añadir dominios de confianza (que no deben activar advertencias) en **Configuración > Productividad > Dominios de confianza**.

## Firma

Si la identidad activa (la identidad por defecto, salvo que hayas escogido otra) tiene una firma configurada en **Ajustes > Firmas** o **Ajustes > Identities**, se anade automaticamente a los nuevos mensajes. La firma no se anade a las respuestas ni a los reenvios.

## Recordatorios de seguimiento

Los recordatorios de seguimiento te ayudan a rastrear los correos que necesitan respuesta. Si envías un mensaje importante y no recibes respuesta, MailCopilot te lo recordará.

### Configurar un recordatorio

1. En la ventana de redacción, marca la casilla **"Recordar si no hay respuesta"** en la parte inferior.
2. Elige un período de recordatorio: **2 días**, **3 días** o **7 días**.
3. Envía el mensaje como de costumbre.

Si no se recibe respuesta dentro del período elegido, recibirás una notificación de escritorio recordándote hacer seguimiento.

### La carpeta de Seguimientos

Los seguimientos pendientes aparecen en la carpeta **Seguimientos** en la barra lateral (icono de reloj con marca de verificación). La insignia de la carpeta muestra el número de recordatorios activos.

Cada seguimiento muestra:
- La dirección del destinatario.
- El asunto del mensaje original.
- Cuánto tiempo ha pasado desde que venció el recordatorio.

### Descartar un recordatorio

Cuando ya no necesites un recordatorio (por ejemplo, la persona respondió fuera del correo electrónico), haz clic en el botón **Descartar** junto al seguimiento para eliminarlo.
