---
sidebar_position: 2
title: Productividad
---

# Configuracion de productividad

Notificaciones de escritorio, IMAP IDLE, intervalo de sincronizacion (1–30 min), sincronizacion de borradores, cargar siempre imagenes externas, fotos de remitentes (Gravatar), orden de clasificacion, agrupacion en conversaciones, preset de atajos (Gmail/Outlook), retraso de envio y modo sin conexion.

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
