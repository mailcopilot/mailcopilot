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

## Cómo conecto una cuenta de Gmail?

Elige la tarjeta **Gmail** en el asistente de configuración y sigue los pasos: activa la verificación en dos pasos en tu cuenta de Google, crea una contraseña de aplicación para MailCopilot (instrucciones de Google: [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833)) e introduce tu dirección de Gmail y la contraseña de aplicación de 16 caracteres, no tu contraseña habitual de Google. La configuración del servidor (`imap.gmail.com` puerto 993, `smtp.gmail.com` puerto 465) se rellena automáticamente. Consulta [Cuenta de Gmail](./getting-started/adding-account#gmail-account) para ver los pasos completos.

## Por qué no puedo añadir un buzón nuevo de Gmail con el inicio de sesión de Google?

Google solo permite que una aplicación que no ha verificado inicie sesión con 100 usuarios nuevos en total, y ese límite no se puede restablecer. Por eso la versión oficial de MailCopilot no conecta buzones nuevos de Gmail con **Iniciar sesión con Google**: cualquier buzón nuevo de Gmail, incluido un segundo buzón de alguien que ya usa MailCopilot, se conecta con una contraseña de aplicación (consulta la pregunta anterior). Los buzones de Gmail que ya inician sesión con Google siguen funcionando y puedes reconectarlos (por ejemplo, tras revocar el token o cambiar la contraseña), pero solo con la misma dirección de Google. Si inicias sesión con otra cuenta de Google, MailCopilot lo rechaza, no cambia nada. La otra cuenta conserva el acceso que acaba de conceder; quítalo en esa cuenta de Google, en el acceso de terceros. La dirección de un buzón así no se puede editar en la configuración de la cuenta (los campos de usuario IMAP y SMTP son de solo lectura); para cambiarla, reconecta con la misma cuenta de Google. Si la propia dirección de Google del buzón ha cambiado (por ejemplo, la cuenta se renombró o se trasladó a otro dominio), la reconexión se rechaza y no se cambia nada: elimina el buzón y vuelve a añadirlo con una contraseña de aplicación (el correo almacenado en caché local se vuelve a descargar). Una versión compilada desde el código fuente con su propio cliente de Google OAuth conserva el inicio de sesión de Google para buzones nuevos; una versión sin ningún cliente de Google OAuth no muestra ningún botón de Google, y un buzón que inicia sesión con Google no se puede reconectar allí. Outlook / Microsoft 365 no se ve afectado.

## Falta la opción de contraseñas de aplicación. Qué debo hacer? {#app-passwords-missing}

Google no ofrece contraseñas de aplicación para todas las cuentas. La opción puede faltar si la cuenta la gestiona una organización (consulta a su administrador), usa la Protección avanzada o solo usa llaves de seguridad en la verificación en dos pasos. Entonces la única opción que queda es una versión compilada desde el código fuente con tu propio cliente de Google OAuth. Una aplicación interna de una organización está exenta de la verificación de Google, consulta [la explicación de Google](https://support.google.com/cloud/answer/7454865).

## Puedo usar varias cuentas?

Si, con cambio en la barra lateral o la bandeja de entrada unificada.

## La prueba de conexion muestra un error de certificado TLS. Que debo hacer?

MailCopilot siempre verifica los certificados TLS, comparandolos tanto con el conjunto de certificados de Mozilla integrado como con el almacen de certificados de tu sistema operativo. Este diálogo de confianza dentro de la aplicación solo existe para tu **servidor de recepción (IMAP)**. Si ese servidor usa un certificado autofirmado, o uno emitido por una autoridad de certificación privada que aún no está en el almacén de confianza de tu sistema operativo (por ejemplo, una autoridad de certificación interna gestionada por una universidad o una empresa), aparecerá un diálogo de confianza. Revisa los detalles del certificado y acéptalo si confías en que el servidor es legítimo. Si la huella digital aún no se ha leído, el botón principal muestra primero **"Leer el certificado"** -- haz clic, revisa el resultado y luego haz clic en **"Confiar y continuar"** para confirmar. La confianza otorgada de esta forma queda vinculada a ese certificado exacto y a la dirección y puerto específicos de ese servidor; otro servidor, incluso emitido por la misma autoridad de certificación, no se vuelve confiable automáticamente, y un cambio posterior del certificado de este servidor exigirá confirmar el nuevo de la misma manera. La línea **«Detalles»** del diálogo indica, en el idioma de la aplicación, por qué no se aceptó el certificado (por ejemplo, porque ha caducado, es autofirmado o se emitió para otro nombre de servidor).

Si en cambio el error ocurre en tu **servidor de envío (SMTP)**, MailCopilot no ofrece en absoluto este diálogo de confianza -- un certificado autofirmado o de una autoridad de certificación privada en el lado SMTP no tiene ninguna solución dentro de la aplicación. El certificado debe confiarse fuera de MailCopilot: ya sea haciendo que el certificado raíz de la autoridad de certificación sea de confianza en el propio sistema operativo (MailCopilot necesita reiniciarse para tenerlo en cuenta), o mediante la variable de entorno `NODE_EXTRA_CA_CERTS` para configuraciones avanzadas.

## Mi antivirus o proxy corporativo inspecciona mi conexion de correo. Seguira funcionando MailCopilot?

Si. MailCopilot confia en el almacen de certificados de tu sistema operativo ademas de en su conjunto de certificados integrado, por lo que el software de seguridad que inspecciona el trafico TLS (por ejemplo, antivirus con escaneo HTTPS) y los proxies corporativos ya no interrumpen la sincronizacion del correo. Tras la primera sincronizacion exitosa de tu cuenta en una sesion, MailCopilot comprueba esto una vez y, si lo encuentra, muestra un aviso que identifica al software o proxy responsable; esta comprobacion se ejecuta como maximo una vez por servidor durante toda la vida de tu perfil, por lo que una inspeccion activada en un servidor despues de que esta comprobacion ya se ejecuto no sera detectada. Si el certificado cambia mas tarde a uno en el que ya no se puede confiar en absoluto (y no solo a traves del almacen del sistema), MailCopilot muestra un dialogo de recuperacion donde puedes revisar los detalles del nuevo certificado y decidir si confiar en el.

## Mi servidor de correo autofirmado dejo de conectarse tras actualizar MailCopilot. Por que?

La fijacion de certificados antes solo comparaba huellas digitales para certificados cuya cadena ya se verificaba con normalidad; los certificados autofirmados y con autoridad de certificacion privada -- el caso exacto para el que existe la fijacion -- se saltaban por completo esa comprobacion de huella digital. Ese vacio ya esta cerrado, lo cual es una mejora de seguridad -- pero si fijaste un servidor autofirmado o con autoridad de certificacion privada antes de este cambio, la fijacion guardada puede no incluir el certificado necesario para verificarlo, y ese servidor ahora dejara de conectarse. Para tu **servidor de recepción (IMAP)**, abre el dialogo de recuperacion de certificado que aparece para el: si el boton muestra **"Leer el certificado"**, haz clic primero en el, luego en **"Confiar y continuar"**; si ya se muestra **"Confiar y continuar"**, haz clic solo en ese. Esto guarda la fijacion junto con el propio certificado, y la cuenta se resincroniza automaticamente. Solo necesitas hacer esto una vez por cada servidor afectado. Agregar o editar una fijacion manualmente en Configuracion no soluciona esto -- una fijacion manual solo puede restringir la confianza para un servidor que ya tiene un certificado normal y publicamente confiable; para un certificado que de otro modo no es de confianza (autofirmado, o de una autoridad de certificacion privada que aun no esta en el almacen de tu sistema operativo), solo el dialogo de recuperacion puede concederle confianza. Si mas tarde agregas una fijacion por huella digital para ese mismo servidor y no coincide con el certificado ya confirmado alli, se rechaza de la misma forma -- MailCopilot vuelve a abrir el dialogo de recuperacion en lugar de usarla. Para tu **servidor de envío (SMTP)**, no existe ningún diálogo de recuperación -- un servidor SMTP autofirmado o con autoridad de certificación privada que se rompa de esta forma seguirá roto hasta que el certificado se confíe fuera de MailCopilot: ya sea que el certificado raíz de su autoridad de certificación sea de confianza directamente en el sistema operativo, o mediante la variable de entorno `NODE_EXTRA_CA_CERTS` para configuraciones avanzadas.

Si tu servidor usa STARTTLS (normalmente el puerto IMAP 143 o el puerto SMTP 587), MailCopilot no puede capturar su certificado de esta forma -- solo se guarda la huella digital, por lo que un servidor STARTTLS autofirmado seguira sin poder conectarse. Usa en su lugar TLS implicito (normalmente el puerto 993 para IMAP, 465 para SMTP) si tu servidor lo admite.

## La conexión indica que el servidor no ofrece una conexión cifrada (STARTTLS). Qué significa?

Su cuenta está configurada sin **SSL/TLS** inmediato (normalmente el puerto IMAP 143 o el puerto SMTP 587), por lo que MailCopilot espera que el servidor pase la conexión a cifrada con STARTTLS antes de enviar cualquier contraseña o mensaje. Este servidor no ofreció ni aceptó el cambio, así que MailCopilot se negó a continuar y no envió ninguna contraseña ni mensaje. Deliberadamente no existe una opción «permitir sin cifrar». Compruebe el puerto y la casilla **SSL/TLS** en **Settings > Accounts** (normalmente el puerto IMAP 993 y el puerto SMTP 465 con **SSL/TLS** marcada) o contacte con su proveedor de correo. Consulte [Conexión cifrada obligatoria (STARTTLS)](./getting-started/adding-account#conexión-cifrada-obligatoria-starttls).

## El envío falla y el mensaje dice que la red o una VPN pueden estar bloqueando los puertos de correo saliente. Qué debo hacer?

Este mensaje aparece cuando MailCopilot no pudo contactar en absoluto con su servidor de salida: la conexión falló antes de que el servidor respondiera, lo que normalmente indica un puerto bloqueado, una VPN o una red inaccesible. Esos envíos se reintentan automáticamente con esperas crecientes; si finalmente fallan, verá esta indicación en lugar de un error técnico en bruto. Compruebe su conexión a Internet, desactive o reconfigure la VPN, asegúrese de que su red o cortafuegos permite conexiones salientes al puerto de su servidor de correo (normalmente 465 o 587) y vuelva a intentar el envío.

El mismo mensaje aparece cuando añades una cuenta o pruebas su conexión y un servidor acepta la conexión pero nunca responde: la prueba de conexión del servidor de entrada (IMAP) y la del servidor de salida (SMTP) terminan con él, en lugar de con un error técnico sin procesar. El consejo es el mismo: revisa tu conexión a Internet, desactiva o reconfigura la VPN y asegúrate de que tu red permite conexiones salientes a los puertos de tu servidor de correo.

## El envío falla y el mensaje dice que no se sabe si se envió. Qué debo hacer?

Este mensaje aparece cuando la conexión con su servidor de salida se interrumpió después de contactar con el servidor pero antes de que confirmara el envío, por ejemplo por un tiempo de espera agotado, un restablecimiento de la conexión o porque el servidor cerró la conexión sin responder. MailCopilot no puede saber entonces si el servidor aceptó el mensaje, así que **no** reintenta el envío automáticamente, porque un reintento podría entregar el mensaje dos veces. En su lugar, el mensaje pasa a estado de fallo. No se fíe de la carpeta Enviados: MailCopilot guarda su copia en Enviados solo después de un envío confirmado, por lo que la copia suele faltar aunque el mensaje sí haya salido. Pregunte al destinatario o consulte los enviados del propio proveedor de correo para saber si llegó; si no llegó, abra la **Outbox** y use **Send now** (o edite antes el mensaje) para volver a enviarlo manualmente. Los fallos antes de que el servidor responda (puerto bloqueado, VPN, red inaccesible) se siguen reintentando automáticamente con esperas crecientes, las denegaciones con código de respuesta 4xx también se reintentan, y las denegaciones 5xx no se reintentan y muestran el motivo del propio servidor.

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

Aparte de las descargas, MailCopilot busca nuevas versiones en segundo plano al iniciarse y aproximadamente una vez por hora. Para que no inicie nuevas búsquedas por sí mismo, abra **Configuración > Acerca de** y desmarque **Buscar actualizaciones en segundo plano**. El cambio surte efecto de inmediato, sin reiniciar. El botón **Buscar actualizaciones** sigue funcionando. Con la búsqueda en segundo plano desactivada, MailCopilot no inicia ninguna búsqueda automática nueva ni ninguna descarga automática nueva, aunque esté marcada la opción **Descargar automáticamente las actualizaciones en segundo plano**; una búsqueda o descarga que ya estuviera en curso al desactivar la opción aún puede completarse.

## MailCopilot no sincroniza.

Verifica IMAP IDLE en la configuracion, haz clic en Sincronizar y verifica tu conexion a internet.

## Cerré la ventana y ahora no encuentro MailCopilot.

Con **«Cerrar la ventana a la bandeja»** activado, cerrar la ventana la oculta detrás del icono de la bandeja (siempre que MailCopilot haya podido crear el icono) -- haz clic en el icono para recuperarla. En algunos escritorios de Linux el icono puede no dibujarse en absoluto, y entonces no hay nada en lo que hacer clic.

En cualquier caso, simplemente vuelve a iniciar MailCopilot. Si todavía se está ejecutando con una ventana oculta, la trae de vuelta al primer plano en lugar de abrir una segunda copia; si ya se había cerrado, se abre una ventana nueva.
