---
sidebar_position: 1
title: Vista general de la interfaz
---

# Vista general de la interfaz

MailCopilot tiene un diseno limpio de tres columnas.

## Barra lateral

Izquierda: selector de cuenta, lista de carpetas con insignias de no leidos, botones de Redactar, Sincronizar y Configuracion, bandeja de entrada unificada.

- **Trabajar sin conexión** — activa y desactiva el modo sin conexión. Cuando está activado, MailCopilot detiene toda actividad de red y trabaja exclusivamente con datos en caché. Puede leer correos previamente sincronizados, marcarlos como leídos o destacados, y navegar por las carpetas. Los cambios realizados sin conexión se sincronizarán cuando vuelva a estar en línea. El icono del botón alterna entre Wi-Fi (en línea) y Wi-Fi tachado (sin conexión).

**Inbox Zero** -- cuando procesas correos (archivar, eliminar, posponer, marcar como spam o mover a una carpeta) y tu bandeja de entrada queda vacía, aparece un mensaje de felicitación «¡Inbox Zero!» en el área de la lista de mensajes junto con el número de correos procesados hoy. El contador se reinicia automáticamente a medianoche y al reiniciar la aplicación.

Se puede contraer a modo de solo iconos. Los iconos contraidos muestran informacion emergente.

## Lista de mensajes

Columna central: remitente, asunto, fecha, indicadores de no leido, estrella, adjuntos y numero de mensajes en el hilo.

En el modo **Bandeja de entrada unificada**, la direccion de correo de la cuenta aparece junto al nombre del remitente para identificar que cuenta recibio el mensaje.

Usa los botones de filtro para mostrar mensajes No leidos, Con adjuntos o Destacados. Haz clic en un boton para activar el filtro, haz clic de nuevo para desactivarlo. Seleccionar otro boton reemplaza el filtro activo.

Para cambiar el orden de clasificacion (fecha, remitente, asunto), ve a **Configuracion > Productividad > Sort emails by**.

### Menu contextual de mensajes

Haz clic derecho sobre cualquier mensaje de la lista para abrir el menu contextual. Desde aqui puedes realizar rapidamente:

- **Posponer** el mensaje
- **Archivar**
- **Eliminar**
- **Marcar como leido / no leido**
- Otras acciones: **Leer mas tarde**, **Fijar**, **Mover a carpeta**, **Marcar como spam**, **Responder**, **Responder a todos**, **Reenviar**

Al seleccionar varios mensajes, el menu contextual permite marcar como leido/no leido, mover, marcar como spam, archivar o eliminar todos a la vez. Leer mas tarde y Fijar siempre se aplican unicamente al mensaje sobre el que se abrio el menu. Posponer se aplica a todo el hilo cuando la agrupacion por conversacion esta activada; de lo contrario, solo al mensaje. Responder, Responder a todos y Reenviar estan ocultos en el modo de seleccion multiple.

### Seleccion de mensajes y barra de acciones

- Haz clic en un mensaje para seleccionarlo y leerlo.
- Manten **Shift** y haz clic para seleccionar un rango.
- Usa la tecla **x** para alternar la seleccion.
- Una barra de acciones esta siempre visible sobre la lista de mensajes. Al seleccionar uno o mas mensajes, los botones se activan: marcar leido/no leido, marcar como spam, archivar, eliminar y mover. Mover esta desactivado en la bandeja de entrada unificada. La barra funciona en todos los demas modos.

## Panel de lectura

Columna derecha: encabezados, cuerpo del mensaje, adjuntos y botones de accion (responder, reenviar, eliminar, archivar, posponer, etc.). En modo de hilo, la barra de herramientas pasa al modo de hilo: Responder/Reenviar se dirigen al mensaje mas reciente, Archivar y Eliminar actuan sobre todo el hilo. Vea [Leer correos](./reading-emails#acciones-del-hilo) para mas detalles.

## Columnas redimensionables

Arrastra el borde entre columnas. Tu preferencia se guarda entre sesiones.

## Seleccion y edicion de texto

Haz clic derecho en cualquier campo de texto -- la barra de busqueda, un mensaje que estas redactando, el campo de la petición del asistente IA, o cualquier otro cuadro editable -- para abrir un pequeno menu contextual con **Cortar**, **Copiar**, **Pegar** y **Seleccionar todo**. Un clic derecho sobre texto seleccionado y no editable (por ejemplo un pasaje resaltado en el cuerpo de un mensaje) ofrece solo **Copiar**.

Un clic derecho en un enlace dentro del cuerpo de un mensaje abre un menu distinto con opciones para abrir o copiar el enlace; consulta [Clic derecho en un enlace](./reading-emails#clic-derecho-en-un-enlace).

## Barra de estado

Una barra de estado persistente recorre la parte inferior de la ventana, similar a la de VS Code. Muestra la actividad en segundo plano que antes solo se veia dentro del panel de busqueda:

- **Indicador de sincronizacion**: aparece cuando una carpeta se esta sincronizando con el servidor IMAP, e incluye la cuenta, el nombre de la carpeta, el numero actual de mensajes y un porcentaje cuando aplica.
- **Cobertura de cabeceras**: cuantas carpetas han completado su sincronizacion inicial de cabeceras (por ejemplo, «Cabeceras: 5/8 carpetas»).
- **Progreso de la indexacion de cuerpos**: el porcentaje de mensajes en cache cuyo cuerpo se ha indexado para busqueda de texto completo.
- **Distintivo de resultados remotos**: cuando una busqueda devuelve coincidencias adicionales del servidor mas alla del cache local, aparece aqui un distintivo «+N del servidor».

La barra de estado permanece visible siempre que haya trabajo de sincronizacion o indexacion en curso, no solo durante una busqueda. Cuando no hay nada que reportar, se contrae automaticamente. El contenido se refresca en segundo plano aproximadamente cada 30 segundos. La barra se oculta al imprimir.

## Centro de notificaciones

Un icono de campana en el encabezado de la lista de mensajes abre el centro de notificaciones. Agrupa dos tipos de notificaciones:

- **Recordatorios de seguimiento**: cuando un seguimiento que estableciste sobre un mensaje enviado vence (consulta [Redactar correos](./composing-emails) para mas detalles).
- **Fallos de envio**: cuando un mensaje en la cola de envio se rinde tras errores de entrega permanentes (SMTP o, en cuentas Outlook, Microsoft Graph).

La campana muestra un pequeno distintivo con el numero de notificaciones nuevas. Pulsa la campana para abrir el panel desplegable: alli puedes leer cada notificacion, marcarla como leida, marcarlas todas como leidas a la vez, o eliminar entradas individuales. Las notificaciones se almacenan localmente en el cache SQLite, por lo que sobreviven al reinicio de la aplicacion; las entradas de mas de 30 dias se purgan automaticamente.

Cuando estan permitidas las notificaciones del sistema operativo, los mismos eventos disparan ademas una notificacion nativa del escritorio.

## Ventana unica

MailCopilot impone una unica instancia en ejecucion por usuario. Si lanzas la aplicacion una segunda vez --por ejemplo al pulsar un enlace `mailto:` o cualquier otro acceso directo del escritorio-- la ventana existente pasa al frente y recibe el foco en lugar de abrir una ventana duplicada. Asi se evita que dos copias paralelas compitan por las mismas conexiones IMAP y por el cache local.

## Enlaces `mailto:` y cliente de correo predeterminado

Puedes registrar MailCopilot como manejador del sistema para enlaces `mailto:`, de modo que pulsar un enlace «enviar correo» en tu navegador, terminal u otra aplicacion abra la ventana de redaccion de MailCopilot con el destinatario y los demas parametros pre-rellenados.

El interruptor para registrar MailCopilot como aplicacion de correo predeterminada esta en **Ajustes > General**. Los parametros `mailto:` admitidos incluyen `to`, `cc`, `bcc`, `subject` y `body`.

## Trabajar sin conexion

El boton «Trabajar sin conexion» en la barra lateral (icono Wi-Fi, tachado cuando se esta sin conexion) alterna el modo sin conexion. Sin conexion:

- Toda la actividad de red se detiene: no se abren conexiones IMAP ni SMTP.
- Aun puedes leer los mensajes ya sincronizados, navegar por las carpetas, marcar mensajes como leidos o destacados, etc.
- Los mensajes salientes se encolan en la bandeja de salida y se envian automaticamente al volver a estar en linea.
- Las operaciones de mover y eliminar crean marcadores locales para que el mensaje desaparezca inmediatamente de la carpeta de origen, en lugar de seguir visible hasta la reconexion. El movimiento real en el servidor se reproduce al restablecer la conexion, y el marcador local se reconcilia con el resultado del servidor.
- El comportamiento sin conexion por carpeta (si se descargan los cuerpos para lectura sin conexion y para que ventana de tiempo) se configura en **Ajustes > Carpetas**; consulta [Ajustes de carpetas](../settings/folders-settings).

## Temas claro y oscuro

Cambia en **Configuracion > General > Tema**.
