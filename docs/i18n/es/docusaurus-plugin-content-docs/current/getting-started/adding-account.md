---
sidebar_position: 2
title: Anadir una cuenta
---

# Anadir una cuenta de correo

MailCopilot es compatible con cualquier proveedor que use IMAP y SMTP. Tambien puedes iniciar sesion con Google o con una cuenta de Microsoft 365 / Outlook.com via OAuth, sin escribir contrasena.

## Asistente de configuracion

Haz clic en **Conectar correo** (icono de sobre en la parte inferior de la barra lateral).

### Paso 1: Elige tu proveedor

El asistente arranca ahora con un selector de proveedor explicito: le indicas a MailCopilot que proveedor usas antes de introducir cualquier credencial. Cada proveedor se muestra como una tarjeta con su logotipo o icono:

- **Gmail** -- salta directamente al flujo OAuth de Google. Se abre el navegador donde autorizas a MailCopilot a acceder a tu cuenta de Gmail; no hace falta contrasena.
- **Outlook / Microsoft 365** -- inicia el flujo OAuth de Microsoft (Authorization Code con PKCE) y se conecta via Microsoft Graph. Funciona tanto para cuentas personales `@outlook.com` / `@hotmail.com` / `@live.com` como para cuentas profesionales y educativas de Microsoft 365.
- **Generic IMAP/SMTP** -- para cualquier otro proveedor (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, correo de empresa, servidores propios, etc.). Pasa primero a un paso de confirmacion con un unico boton **Cuenta IMAP/SMTP**, que abre despues el formulario de credenciales.

Puedes navegar entre tarjetas con las flechas del teclado y confirmar la seleccion con **Enter** o **Espacio**. Tras elegir un proveedor, el asistente continua con los pasos apropiados. En la ruta Generic IMAP/SMTP, el boton **Atras** del paso de confirmacion devuelve al selector de proveedor; el paso de introduccion de credenciales tambien tiene un boton **Atras**, y devuelve al paso de confirmacion (un paso por vez). Los pasos de deteccion de servidor y configuracion manual solo avanzan -- para empezar de nuevo con otro proveedor, cancela el asistente y vuelve a abrirlo.

Si quieres usar Outlook a traves de Generic IMAP/SMTP en vez de OAuth, elige la tarjeta Generic y conectate con una contrasena de aplicacion contra `outlook.office365.com` / `smtp.office365.com`.

### Paso 2: Introducir credenciales (Generic IMAP/SMTP)

1. Introduce tu **correo electronico** y **contrasena**.
2. Opcionalmente, un **nombre para mostrar**.
3. Opcionalmente, introduce una **dirección de email (De)** -- esta dirección se usa en el campo «De» de los mensajes salientes. Si se deja en blanco, se utiliza la dirección de inicio de sesión SMTP.
4. Si las credenciales SMTP son diferentes, marca la opcion correspondiente.
5. Haz clic en **Siguiente**.

### Paso 3: Deteccion del servidor

MailCopilot intentara detectar automaticamente la configuracion de tu servidor de correo utilizando protocolos estandar de descubrimiento automatico. Si tiene exito, los servidores IMAP y SMTP detectados se muestran en campos editables. Puedes revisar y ajustar el nombre para mostrar, la direccion de email, los hosts de servidor, los puertos y la configuracion SSL antes de conectar.

- Haz clic en **Conectar** para probar la conexion y guardar la cuenta.
- Si deseas control manual completo sobre todos los ajustes (incluidas credenciales IMAP/SMTP separadas), haz clic en **Configuracion manual**.

## Cuenta Google (OAuth)

Selecciona la tarjeta **Gmail** en el asistente. Se abrira una ventana de navegador para autorizar a MailCopilot. Una vez autorizada, la cuenta se anade automaticamente con la configuracion IMAP y SMTP correcta.

## Cuenta Microsoft 365 / Outlook (OAuth)

Selecciona la tarjeta **Outlook / Microsoft 365** en el asistente. Se abrira una ventana de navegador con la pagina de inicio de sesion de Microsoft; entra con tu cuenta `@outlook.com`, `@hotmail.com`, `@live.com` o profesional/educativa y aprueba los permisos solicitados. El cliente Microsoft incluido usa el flujo Authorization Code con PKCE sin client secret -- ningun client secret abandona tu dispositivo. Las builds personalizadas que sustituyen el cliente incluido fijando **ambas** variables de entorno `MAILCOPILOT_MS_CLIENT_ID` (tu propio registro de aplicacion en Azure) y `MAILCOPILOT_MS_CLIENT_SECRET` (pensada para tenants que han emitido un cliente confidencial) si envian ese secret al endpoint de tokens de Microsoft sobre TLS. `MAILCOPILOT_MS_CLIENT_SECRET` por si solo (sin un client ID propio) se ignora. Tras autorizarse, la cuenta se anade automaticamente.

Para enviar correo, MailCopilot usa Microsoft Graph (`POST /me/sendMail`) en cuentas de Outlook, porque Microsoft ha desactivado SMTP AUTH en la mayoria de cuentas personales de Outlook.com creadas desde 2024. La via de envio por Graph no se ve afectada por esa politica. Microsoft guarda automaticamente los mensajes enviados en tu carpeta de Enviados.

Si tu cuenta de Outlook deja de funcionar tras un periodo largo sin conexion, es posible que el refresh token de OAuth haya caducado. Abre **Configuracion > Cuentas**, edita la cuenta y usa el boton de re-autenticacion de Microsoft para volver a iniciar sesion.


## Verificacion de certificado TLS

MailCopilot siempre verifica los certificados TLS, comparándolos tanto con el conjunto de certificados de Mozilla integrado como con el almacén de certificados de tu sistema operativo (recurriendo solo al conjunto integrado si el almacén del sistema no se puede leer). Si tu servidor usa un certificado autofirmado, aparecera un dialogo de confianza: si la huella digital aun no se ha leido, el boton muestra primero **"Leer el certificado"** -- haz clic, revisa los detalles y confirma con **"Confiar y continuar"**; si ya se muestra **"Confiar y continuar"**, haz clic solo en ese. Los servidores a los que se accede mediante STARTTLS (normalmente el puerto IMAP 143 o el puerto SMTP 587) no pueden entregar su certificado en este paso, por lo que solo se guarda la huella digital -- un servidor STARTTLS autofirmado no puede hacerse confiable de esta forma; usa en su lugar TLS implicito (normalmente el puerto 993 o 465) si tu servidor lo admite.

Al iniciar sesión con Google, si tu red utiliza un proxy o antivirus que reemplaza los certificados TLS por uno que tu sistema operativo aún no conoce, MailCopilot lo detectará y ofrecerá automáticamente aceptar el certificado. Verás los detalles del certificado (host, emisor, huella digital) y podrás aceptarlo o rechazarlo. La cuenta se guarda en cualquier caso, y puedes gestionar los certificados más tarde en la configuración de la cuenta. Si en cambio el certificado raíz del proxy o antivirus ya está instalado en el almacén de tu sistema operativo, la conexión se establece sin ningún diálogo de confianza -- MailCopilot marca este caso por separado con un aviso informativo (ver abajo) en lugar de pedirte que aceptes algo.

Confiar en el almacén de certificados del sistema significa que la mayoría de los proxies corporativos y antivirus que inspeccionan el tráfico TLS funcionan sin más, sin un diálogo de confianza durante la configuración. Tras la primera sincronización exitosa de tu cuenta en una sesión, MailCopilot comprueba una vez si una conexión se inspecciona de esta forma y, si es así, muestra un aviso que nombra al software o proxy responsable; esta comprobación se ejecuta como máximo una vez por servidor durante toda la vida de tu perfil, por lo que una inspección activada en un servidor después de esta comprobación no será detectada. Si el certificado de un servidor cambia más tarde a uno en el que no se puede confiar en absoluto, MailCopilot mostrará entonces un diálogo de recuperación en la ventana principal -- consulta [Confianza de certificados TLS](../settings/general#confianza-de-certificados-tls) para más detalles.

## Gestionar varias cuentas

Puedes anadir tantas cuentas como necesites. Para cambiar entre cuentas, usa la barra lateral o ve a **Ajustes > Cuentas**. La cuenta activa aparece resaltada y puedes establecer cualquier cuenta como la actual.

## Personalizar el avatar de la cuenta

Cada cuenta se muestra en la barra lateral con un avatar -- un círculo de color con iniciales. Puedes personalizar el avatar en **Configuración > Cuentas** haciendo clic en el icono de paleta junto a la cuenta.

### Modos de visualización

- **Letras** -- un círculo de color con 1--2 caracteres (iniciales). Puedes introducir iniciales personalizadas si las automáticas no son adecuadas.
- **Icono** -- un círculo de color con un icono de la colección (correo, maletín, estrella, cohete, etc.).
- **Gravatar** -- carga tu foto de perfil desde [Gravatar](https://gravatar.com) según tu dirección de email. Si no se encuentra un Gravatar, se muestran las letras.

### Cambiar el color

Haz clic en cualquier color de la paleta para cambiar el fondo del avatar. El color se guarda y permanece igual tras reiniciar.

### Tooltip

Al pasar el ratón sobre un avatar en la barra lateral, se muestra el nombre de la cuenta y la dirección de email.

## Proveedores compatibles

Gmail, Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (via Bridge), servidores propios.
