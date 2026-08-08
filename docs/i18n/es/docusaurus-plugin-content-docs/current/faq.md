---
sidebar_position: 7
title: FAQ
---

# Preguntas frecuentes

## Que es MailCopilot?

Un cliente de correo de escritorio moderno con soporte IMAP/SMTP, disenado para la velocidad y la privacidad.

## Que plataformas se soportan?

**Linux** (AppImage). Windows y macOS estan planeados.

## Donde se almacenan las contrasenas?

En el llavero del sistema (keytar), nunca en texto plano.

## Que proveedores son compatibles?

Cualquier proveedor IMAP/SMTP: Gmail, Outlook, Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail (via Bridge), servidores propios.

## Puedo usar varias cuentas?

Si, con cambio en la barra lateral o la bandeja de entrada unificada.

## La prueba de conexion muestra un error de certificado TLS. Que debo hacer?

MailCopilot siempre verifica los certificados TLS, comparandolos tanto con el conjunto de certificados de Mozilla integrado como con el almacen de certificados de tu sistema operativo. Si tu servidor de correo usa un certificado autofirmado o personalizado, aparecera un dialogo de confianza. Revisa los detalles del certificado y aceptalo si confias en que el servidor es legitimo. Si la huella digital aun no se ha leido, el boton principal muestra primero **"Leer el certificado"** -- haz clic, revisa el resultado y luego haz clic en **"Confiar y continuar"** para confirmar.

## Mi antivirus o proxy corporativo inspecciona mi conexion de correo. Seguira funcionando MailCopilot?

Si. MailCopilot confia en el almacen de certificados de tu sistema operativo ademas de en su conjunto de certificados integrado, por lo que el software de seguridad que inspecciona el trafico TLS (por ejemplo, antivirus con escaneo HTTPS) y los proxies corporativos ya no interrumpen la sincronizacion del correo. Tras la primera sincronizacion exitosa de tu cuenta en una sesion, MailCopilot comprueba esto una vez y, si lo encuentra, muestra un aviso que identifica al software o proxy responsable; esta comprobacion se ejecuta como maximo una vez por servidor durante toda la vida de tu perfil, por lo que una inspeccion activada en un servidor despues de que esta comprobacion ya se ejecuto no sera detectada. Si el certificado cambia mas tarde a uno en el que ya no se puede confiar en absoluto (y no solo a traves del almacen del sistema), MailCopilot muestra un dialogo de recuperacion donde puedes revisar los detalles del nuevo certificado y decidir si confiar en el.

## Mi servidor de correo autofirmado dejo de conectarse tras actualizar MailCopilot. Por que?

La fijacion de certificados antes solo comparaba huellas digitales para certificados cuya cadena ya se verificaba con normalidad; los certificados autofirmados y con autoridad de certificacion privada -- el caso exacto para el que existe la fijacion -- se saltaban por completo esa comprobacion de huella digital. Ese vacio ya esta cerrado, lo cual es una mejora de seguridad -- pero si fijaste un servidor autofirmado o con autoridad de certificacion privada antes de este cambio, la fijacion guardada puede no incluir el certificado necesario para verificarlo, y ese servidor ahora dejara de conectarse. Abre el dialogo de recuperacion de certificado que aparece para el: si el boton muestra **"Leer el certificado"**, haz clic primero en el, luego en **"Confiar y continuar"**; si ya se muestra **"Confiar y continuar"**, haz clic solo en ese. Esto guarda la fijacion junto con el propio certificado, y la cuenta se resincroniza automaticamente. Solo necesitas hacer esto una vez por cada servidor afectado. Agregar o editar una fijacion manualmente en Configuracion no soluciona esto -- una fijacion manual solo puede restringir la confianza para un servidor que ya tiene un certificado normal y publicamente confiable; para un certificado que de otro modo no es de confianza (autofirmado, o de una autoridad de certificacion privada que aun no esta en el almacen de tu sistema operativo), solo el dialogo de recuperacion puede concederle confianza.

Si tu servidor usa STARTTLS (normalmente el puerto IMAP 143 o el puerto SMTP 587), MailCopilot no puede capturar su certificado de esta forma -- solo se guarda la huella digital, por lo que un servidor STARTTLS autofirmado seguira sin poder conectarse. Usa en su lugar TLS implicito (normalmente el puerto 993 para IMAP, 465 para SMTP) si tu servidor lo admite.

## Como buscar mensajes?

Haz clic en la barra de busqueda (o pulsa **/***) y escribe tu consulta.

Operadores de busqueda avanzada:

- `from:user@example.com` -- mensajes de un remitente especifico.
- `to:user@example.com` -- mensajes enviados a un destinatario especifico.
- `subject:reunion` -- mensajes con una palabra en el asunto.
- `has:attachment` -- mensajes con archivos adjuntos.
- `is:unread` / `is:read` -- filtrar por estado de lectura.
- `is:starred` -- mensajes destacados.
- `before:2026-01-01` / `after:2025-12-01` -- filtrar por fecha.
- `in:Sent` -- mensajes en una carpeta especifica.
- Negar con `-`: `-from:spam@example.com`.
- Combinar con `OR` o `AND` (sin distincion de mayusculas): `from:alice OR from:bob`.

## Es obligatorio el asistente IA?

No, es completamente opcional.

## Donde puedo ver lo que la IA hace con mis datos?

Abra **Configuracion → IA** y expanda la seccion **Privacidad y auditoria**. Alli encontrara un registro de auditoria completo de cada accion de IA: marca de tiempo, proveedor, modelo, objetivo, herramienta utilizada, costo estimado y resultado. El recuento de tokens se registra si el proveedor lo expone a traves del SDK; de lo contrario, las columnas muestran **n/d**. Tambien puede exportar el registro en formato JSON o CSV.

Para mas detalles, consulte [Datos de IA y registro de auditoria](./privacy/ai-data).

## Como actualizar MailCopilot?

De forma predeterminada, MailCopilot **no** descarga las actualizaciones automaticamente. Cuando se detecta una nueva version, aparece un boton **Descargar X.Y.Z** en **Configuración > Acerca de**. Hagale clic para iniciar la descarga y, cuando finalice, haga clic en **Reiniciar para instalar**.

Para comprobar manualmente en cualquier momento, abra **Configuración > Acerca de** y haga clic en **Buscar actualizaciones**.

Para activar la descarga automatica en segundo plano, abra **Configuración > Acerca de** y marque **Descargar automáticamente las actualizaciones en segundo plano**. Cuando esta opcion esta activada, las nuevas versiones se descargan silenciosamente y se le pide que reinicie cuando la actualizacion este lista.

MailCopilot normalmente puede actualizarse a si mismo en cualquier plataforma que admite: una instalacion AppImage sustituye el propio archivo `.AppImage`, y una instalacion `.deb`/`.rpm`/pacman deja que el mecanismo de actualizacion intente la escritura solicitando privilegios de administrador (`pkexec`/`sudo`), del mismo modo que lo harian `apt`/`dnf`/`pacman` -- el resultado final lo deciden ese aviso de elevacion de privilegios y el gestor de paquetes, no MailCopilot.

La autoactualizacion puede no estar disponible por dos motivos distintos, y MailCopilot muestra controles diferentes para cada uno:

- **La compilacion no esta empaquetada** -- una compilacion de desarrollo o de CI. En ese caso no existe ningun mecanismo de actualizacion: el boton **Buscar actualizaciones** y el area de estado no aparecen, y en su lugar se muestra el aviso **"Las actualizaciones están desactivadas en esta compilación"**.
- **La compilacion esta empaquetada, pero la autoactualizacion esta bloqueada** -- ya sea porque MailCopilot no pudo determinar la carpeta en la que deberia escribir la actualizacion in situ, o porque esa carpeta no admite escritura para su cuenta. El primer caso ocurre en Linux cuando la aplicacion no se ejecuta como un AppImage montado (por ejemplo, un AppImage extraido o una compilacion `linux-unpacked` sin empaquetar) -- en ese caso no hay ninguna carpeta en la que escribir. El segundo caso significa que la carpeta de un AppImage en ejecucion no admite escritura (una instalacion `.deb`/`.rpm`/pacman no se ve afectada, ya que estas elevan privilegios en su lugar); en Windows y macOS significa que la carpeta que contiene el ejecutable instalado no admite escritura. En ambos casos aparece una advertencia explicando el motivo, el boton **Buscar actualizaciones** sigue funcionando, y la casilla de descarga automatica sigue disponible -- pero los controles de descarga y reinicio se ocultan.

## Puedo desactivar las actualizaciones automaticas?

La descarga automatica en segundo plano esta desactivada de forma predeterminada. Si ha activado la opcion **Descargar automáticamente las actualizaciones en segundo plano** y desea desactivarla, abra **Configuración > Acerca de** y desmarchela. MailCopilot le seguira notificando cuando haya una actualizacion disponible, pero la descarga no comenzara hasta que haga clic en **Descargar**.

## MailCopilot no sincroniza.

Verifica IMAP IDLE en la configuracion, haz clic en Sincronizar y verifica tu conexion a internet.
