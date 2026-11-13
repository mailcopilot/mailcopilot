---
sidebar_position: 3
title: Fotos de remitentes (Gravatar)
---

# Fotos de remitentes (Gravatar)

La opción **Mostrar fotos de remitentes (Gravatar)** está desactivada en las instalaciones nuevas. Mientras lo esté, MailCopilot no hace ninguna solicitud a gravatar.com.

Una instalación actualizada desde una versión anterior a 1.27.2 conserva el ajuste que tenía guardado. Las versiones antiguas activaban la opción por defecto y escribían ese valor en los ajustes, así que en la mayoría de las instalaciones existentes está activada. Si no la quieres, desactívala como se indica más abajo.

## Qué se envía cuando la opción está activada

Para cada dirección de remitente que aparece en la lista de mensajes, la aplicación pide una foto a `www.gravatar.com`. La solicitud va directamente desde tu ordenador a Gravatar. Ningún servidor de MailCopilot participa y no pasa por el proxy que se usa para las imágenes remotas de los mensajes.

Gravatar recibe:

- el hash SHA-256 de la dirección del remitente (sin espacios, en minúsculas). Quien conozca una dirección puede calcular su hash y relacionarlo con la solicitud;
- tu dirección IP y la hora de la solicitud;
- las cabeceras habituales de una solicitud de navegador, incluido un User-Agent con el nombre y la versión de la aplicación.

La solicitud no lleva cabecera Referer. Gravatar no recibe el texto de los mensajes ni los asuntos. Las direcciones de tus propias cuentas e identidades se omiten en la lista de mensajes, así que sus hashes no se envían desde ahí.

La aplicación recuerda en memoria qué remitentes no tienen foto. Las fotos que devuelve Gravatar también se guardan en la caché HTTP de Chromium, en la carpeta de datos de la aplicación en tu disco, como cualquier imagen que carga la aplicación. Desactivar la opción no vacía esa caché.

## Dónde cambiarlo

Ajustes > Productividad > **Mostrar fotos de remitentes (Gravatar)**.

## El avatar de tu propia cuenta

El modo de avatar **Gravatar** de una cuenta (Ajustes > Cuentas) es una elección aparte. Al seleccionarlo se hace el mismo tipo de solicitud para la dirección de esa cuenta. Los demás modos no hacen ninguna.
