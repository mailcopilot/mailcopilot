---
sidebar_position: 2
title: Productividad
---

# Configuracion de productividad

Notificaciones de escritorio, IMAP IDLE, intervalo de sincronizacion (1–30 min), sincronizacion de borradores, cargar siempre imagenes externas, fotos de remitentes (Gravatar), orden de clasificacion, agrupacion en conversaciones, preset de atajos (Gmail/Outlook), retraso de envio y modo sin conexion.

## Notificaciones de escritorio

Activa o desactiva las notificaciones de escritorio para el correo entrante nuevo. Cuando está activado, MailCopilot te notifica sobre correo nuevo que llega a una carpeta contabilizada en la [insignia de no leídos](general#insignia-de-no-leídos) -- de forma predeterminada tu Bandeja de entrada, más cualquier carpeta que hayas incluido explícitamente en la insignia -- y solo si esa carpeta está configurada con sincronización completa o periódica de encabezados. Además, MailCopilot omite de forma predeterminada un conjunto fijo de carpetas -- Papelera, Spam, Archivo y Borradores -- incluso si has incluido explícitamente alguna de ellas en la insignia; esto restringe aún más las notificaciones y nunca las amplía más allá de la política de la insignia. Las carpetas excluidas de la insignia, o sincronizadas solo bajo demanda, nunca generan una notificación aunque llegue correo nuevo a ellas.

Mientras la ventana de MailCopilot está en primer plano, no se muestra ninguna notificación para el correo nuevo: la insignia y la lista de mensajes se actualizan con normalidad, pero la llegada no se interrumpe con una notificación, ya que ya estás mirando la aplicación. Si llegan varios mensajes en un intervalo corto mientras la aplicación está en segundo plano, MailCopilot muestra una sola notificación por cuenta (por ejemplo, **«5 mensajes nuevos»**) en lugar de una por mensaje -- si dos cuentas reciben correo al mismo tiempo, igualmente recibirás dos notificaciones distintas; al hacer clic en una notificación se abre ese mensaje. En compilaciones de macOS sin firmar, es posible que el sistema operativo no permita mostrar notificaciones en absoluto.

## Modo sin conexion

Descarga mensajes para leerlos sin conexion a Internet. El modo sin conexion se configura **por carpeta** en la pestana [Carpetas](folders-settings#offline-mode) — puedes habilitarlo para Bandeja de entrada, Enviados o cualquier otra carpeta individualmente.

La pestana Productividad contiene solo el limite de tamano global:

- **Tamano maximo de mensaje** — omitir mensajes mas grandes que este tamano (0 = sin limite, en KB).
- **Sincronizar ahora** — iniciar manualmente una sincronizacion sin conexion en todas las carpetas habilitadas.

Cuando abres un mensaje sin conexion, MailCopilot muestra los encabezados almacenados en cache (asunto, remitente, fecha) y un indicador de que el cuerpo del mensaje no esta disponible. Una vez que te reconectes, el mensaje completo se carga normalmente.

## Orden de clasificacion

Elige el orden de clasificacion de la lista de mensajes:

- **Por fecha** (predeterminado) -- los mensajes mas recientes primero.
- **Por remitente** -- alfabeticamente por nombre del remitente.
- **Por asunto** -- alfabeticamente por linea de asunto.

## Avance automatico

Elija que sucede despues de archivar, eliminar o posponer un mensaje:

- **Abrir correo mas antiguo** (predeterminado) -- abre automaticamente el siguiente mensaje mas antiguo.
- **Abrir correo mas reciente** -- abre el siguiente mensaje mas reciente.
- **Volver a la lista** -- cierra los detalles y vuelve a la lista de mensajes.
- **Quedarse (no hacer nada)** -- mantiene la vista actual sin mensaje activo.

Funciona especialmente bien con [Enviar y archivar](../usage/composing-emails#send--archive) para un flujo de trabajo inbox-zero.

## Fotos de remitentes (Gravatar)

Cuando esta habilitado (por defecto), MailCopilot muestra fotos de perfil junto a los nombres de los remitentes en la lista de mensajes. Las fotos se cargan desde [Gravatar](https://gravatar.com). Si un remitente no tiene perfil de Gravatar, se muestra un circulo de color con sus iniciales.

Desactive esta opcion si prefiere avatares solo con iniciales o si desea evitar solicitudes de red al navegar por su bandeja de entrada.

## Modo oscuro para el contenido de correos

Con el tema oscuro, el contenido HTML de los correos puede ser difícil de leer ya que muchos correos están diseñados para un fondo blanco. Active esta opción (activada por defecto) para invertir automáticamente los colores del contenido de los correos en modo oscuro y permitir una lectura cómoda.

Las imágenes, videos y otros medios mantienen sus colores originales — solo se invierten el texto y el fondo.
