---
sidebar_position: 4
title: Identities
---

# Identidades

Una sola cuenta de correo puede tener varias **identidades**, es decir, direcciones «From» alternativas desde las que envía mensajes. Esto resulta útil en cuentas de Gmail o Microsoft 365 donde, además de la dirección principal, hay alias (un alias personal, uno de equipo o una dirección antigua), y desea que cada uno tenga su propio nombre para mostrar, firma y reglas de Bcc, sin necesidad de registrarlos como cuentas IMAP independientes.

## Qué contiene una identidad

Cada identidad incluye:

- Un **nombre para mostrar**: lo que ve el destinatario en el encabezado «From».
- Una **dirección de correo**: la dirección real utilizada en el campo «From». Debe ser una dirección desde la que la cuenta subyacente esté autorizada a enviar.
- Una **firma** opcional: sustituye a la firma de la cuenta cuando esta identidad está seleccionada. Consulte [Firmas](./signatures) para entender cómo interactúan las firmas con respuestas y reenvíos.
- Un **Bcc por defecto** opcional: se añade automáticamente al campo Bcc cada vez que se elige esta identidad en la ventana de redacción.
- Una **marca de identidad por defecto**: exactamente una identidad por cuenta es la principal. La identidad por defecto se utiliza cuando no aplica ninguna regla más específica.

Cada cuenta tiene siempre al menos una identidad. La primera vez que inicia sesión, MailCopilot crea una única identidad por defecto a partir del nombre de la cuenta, su email y la firma existente.

## Gestionar identidades

Abra **Ajustes > Identities** y elija la cuenta en el desplegable superior. La pestaña muestra la lista de identidades de esa cuenta con controles para:

- **Añadir** una nueva identidad. Rellene nombre para mostrar, email, firma y Bcc por defecto; márquela como predeterminada si lo desea.
- **Editar** una identidad existente para cambiar cualquier campo.
- **Establecer como predeterminada**: promueva cualquier identidad al rol de predeterminada. Solo puede haber una identidad predeterminada a la vez.
- **Eliminar** una identidad. La identidad predeterminada no puede eliminarse; promueva primero otra identidad a predeterminada.

## Elegir una identidad al redactar

La ventana de redacción tiene un selector de identidad justo debajo del desplegable de cuenta «From». Por defecto, MailCopilot escoge una identidad por usted con este orden:

1. **Respuestas y reenvíos**: comparación con las direcciones From, To y Cc del mensaje original. Gana la primera identidad cuyo email aparezca en cualquier lugar de esa lista, de modo que la respuesta salga desde la misma dirección a la que recibió originalmente el mensaje. La comparación no distingue mayúsculas y minúsculas sobre el email completo; las cadenas de alias y las variantes con direcciones plus no se reconocen y caen en la identidad por defecto.
2. **Mensajes nuevos**: se selecciona la identidad por defecto de la cuenta.

Puede anular esta elección en cualquier momento abriendo el desplegable y eligiendo otra identidad. Cambiar de identidad actualiza el encabezado «From». La firma se reemplaza solo cuando el cuerpo está vacío o contiene únicamente un bloque de firma después del separador estándar `\n\n--\n` -- el texto que usted haya escrito por encima del separador nunca se sobrescribe. El campo Bcc se reemplaza solo cuando está vacío o sigue siendo igual al Bcc por defecto de la identidad seleccionada anteriormente, de modo que un Bcc escrito a mano sobrevive al cambio de identidad.

## Relación con las firmas

Las firmas viven ahora **por identidad**, no por cuenta. La pestaña **Ajustes > Firmas** edita la firma de la identidad por defecto de la cuenta seleccionada; las identidades no predeterminadas se editan en **Ajustes > Identities**. Las cuentas creadas antes del despliegue multi-identidad conservan su firma por cuenta antigua: MailCopilot la lee a través de una identidad por defecto sintetizada, así que nada se rompe. La nueva lista de identidades se escribe en disco la próxima vez que se guarde la cuenta (por ejemplo, al editar cualquier campo de la cuenta).

## Envío y auditoría

La identidad activa en la ventana de redacción en el momento del envío es la que aparece en el mensaje saliente real:

- El encabezado «From» de SMTP o Microsoft Graph lleva el email y el nombre para mostrar de la identidad.
- Los envíos programados recuerdan la identidad seleccionada en el momento de programar: un mensaje programado desde su alias seguirá saliendo desde ese alias cuando se dispare el temporizador.
