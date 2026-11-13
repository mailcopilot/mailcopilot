---
sidebar_position: 2
title: Anadir una cuenta
---

# Anadir una cuenta de correo

MailCopilot es compatible con cualquier proveedor que use IMAP y SMTP. Gmail se conecta con una contraseña de aplicación (consulta [Cuenta de Gmail](#gmail-account)), y una cuenta de Microsoft 365 / Outlook.com puede iniciar sesión mediante OAuth, sin escribir contraseña.

## Asistente de configuracion

Haz clic en **Conectar correo** (icono de sobre en la parte inferior de la barra lateral).

### Paso 1: Elige tu proveedor

El asistente arranca ahora con un selector de proveedor explicito: le indicas a MailCopilot que proveedor usas antes de introducir cualquier credencial. Cada proveedor se muestra como una tarjeta con su logotipo o icono:

- **Gmail** -- lleva a los pasos de la contraseña de aplicación (la tarjeta indica «Conectar con una contraseña de aplicación»): activas la verificación en dos pasos, creas una contraseña de aplicación en tu cuenta de Google y la introduces junto con tu dirección de Gmail. Consulta [Cuenta de Gmail](#gmail-account) más abajo. En una versión compilada desde el código fuente con su propio cliente de Google OAuth, la tarjeta indica en cambio «Iniciar sesión con Google OAuth» y pasa directamente al inicio de sesión de Google.
- **Outlook / Microsoft 365** -- inicia el flujo OAuth de Microsoft (Authorization Code con PKCE) y se conecta via Microsoft Graph. Funciona tanto para cuentas personales `@outlook.com` / `@hotmail.com` / `@live.com` como para cuentas profesionales y educativas de Microsoft 365.
- **Generic IMAP/SMTP** -- para cualquier otro proveedor (Yahoo, Fastmail, Yandex, Mail.ru, ProtonMail Bridge, correo de empresa, servidores propios, etc.). Pasa primero a un paso de confirmacion con un unico boton **Cuenta IMAP/SMTP**, que abre despues el formulario de credenciales.

Puedes navegar entre tarjetas con las flechas del teclado y confirmar la seleccion con **Enter** o **Espacio**. Tras elegir un proveedor, el asistente continua con los pasos apropiados. En la ruta Generic IMAP/SMTP, el boton **Atras** del paso de confirmacion devuelve al selector de proveedor; el paso de introduccion de credenciales tambien tiene un boton **Atras**, y devuelve al paso de confirmacion (un paso por vez). Los pasos de deteccion de servidor y configuracion manual solo avanzan -- para empezar de nuevo con otro proveedor, cancela el asistente y vuelve a abrirlo.

Si quieres usar Outlook a traves de Generic IMAP/SMTP en vez de OAuth, elige la tarjeta Generic y conectate con una contrasena de aplicacion contra `outlook.office365.com` / `smtp.office365.com`.

### Paso 2: Introducir credenciales (Generic IMAP/SMTP)

Un buzón nuevo de Gmail llega a este mismo formulario después del paso de la contraseña de aplicación (consulta [Cuenta de Gmail](#gmail-account)).

1. Introduce tu **correo electronico** y **contrasena**.
2. Opcionalmente, un **nombre para mostrar**.
3. Opcionalmente, introduce una **dirección de email (De)** -- esta dirección se usa en el campo «De» de los mensajes salientes. Si se deja en blanco, se utiliza la dirección de inicio de sesión SMTP.
4. Si las credenciales SMTP son diferentes, marca la opcion correspondiente.
5. Haz clic en **Siguiente**.

### Paso 3: Deteccion del servidor

MailCopilot intentara detectar automaticamente la configuracion de tu servidor de correo utilizando protocolos estandar de descubrimiento automatico. Si tiene exito, los servidores IMAP y SMTP detectados se muestran en campos editables. Puedes revisar y ajustar el nombre para mostrar, la direccion de email, los hosts de servidor, los puertos y la configuracion SSL antes de conectar.

- Haz clic en **Conectar** para probar la conexion y guardar la cuenta.
- Si un servidor acepta la conexión pero nunca responde (normalmente una red o una VPN que bloquea los puertos de correo), la prueba falla con el mensaje «No se pudo contactar con el servidor de correo antes de que respondiera. A menudo significa que la red o una VPN bloquea los puertos de correo saliente. Revisa tu conexión o los ajustes de la VPN e inténtalo de nuevo.» La misma frase se muestra para el servidor de entrada (IMAP) y para el de salida (SMTP).
- Cuando la cuenta se guarda, aparece de inmediato en la ventana principal. Si es tu primera cuenta, la ventana principal la abre por sí sola -- no hace falta reiniciar ni recargar.
- Si deseas control manual completo sobre todos los ajustes (incluidas credenciales IMAP/SMTP separadas), haz clic en **Configuración manual**.

## Cuenta de Gmail {#gmail-account}

Gmail se conecta mediante los protocolos estándar IMAP y SMTP. Google solo permite que una aplicación que no ha verificado inicie sesión con 100 usuarios nuevos en total, y ese límite no se puede restablecer, por lo que la versión oficial de MailCopilot no conecta buzones **nuevos** de Gmail con **Iniciar sesión con Google**. Un buzón nuevo se conecta con una contraseña de aplicación. Esto incluye un segundo buzón de Gmail de alguien que ya usa MailCopilot con el inicio de sesión de Google: también es un buzón nuevo.

### Conectar un buzón nuevo de Gmail con una contraseña de aplicación

Elige la tarjeta **Gmail** en el asistente. El asistente abre **Conectar Gmail con una contraseña de aplicación** con los pasos siguientes y tres botones: **Atrás** (vuelve al selector de proveedor), **Abrir las instrucciones de Google** y **Siguiente**.

1. Activa la verificación en dos pasos en tu cuenta de Google: las contraseñas de aplicación la requieren.
2. Crea una contraseña de aplicación para MailCopilot en tu cuenta de Google. Las instrucciones oficiales de Google están en [support.google.com/accounts/answer/185833](https://support.google.com/accounts/answer/185833); el botón **Abrir las instrucciones de Google** abre esa página en tu navegador.
3. Haz clic en **Siguiente** e introduce tu dirección de Gmail y la contraseña de aplicación de 16 caracteres (no tu contraseña habitual de Google).

La configuración del servidor se rellena automáticamente: IMAP `imap.gmail.com` en el puerto 993 y SMTP `smtp.gmail.com` en el puerto 465. Revísala en el paso de detección y haz clic en **Conectar**.

### Buzones que ya inician sesión con Google

Los buzones de Gmail conectados con el inicio de sesión de Google siguen funcionando, y puedes reconectarlos (por ejemplo, tras revocar el acceso o cambiar tu contraseña de Google) en **Configuración > Cuentas** con el botón **Reconectar Google**. La reconexión solo funciona con la misma dirección de Google que la del buzón. Si inicias sesión con otra cuenta de Google, MailCopilot lo rechaza: «Esa cuenta de Google no es (la dirección del buzón), así que el buzón no se ha modificado. Inicia sesión con la misma dirección que estás reconectando.», y no se cambia nada. La otra cuenta conserva el acceso que acaba de conceder a MailCopilot; quítalo en esa cuenta de Google, en el acceso de terceros.

La dirección de un buzón que inicia sesión con Google (o con cualquier inicio de sesión OAuth) ya no se puede editar en la configuración de la cuenta: los campos de usuario IMAP y SMTP son de solo lectura para ese buzón. Para cambiar la dirección, reconecta con la misma cuenta de Google. Si la propia dirección de Google del buzón ha cambiado (por ejemplo, la cuenta se renombró o se trasladó a otro dominio), la reconexión se rechaza y no se cambia nada; la salida es eliminar el buzón y volver a añadirlo con una contraseña de aplicación (el correo almacenado en caché local se vuelve a descargar).

### Si falta la opción de contraseñas de aplicación

Google no ofrece contraseñas de aplicación para todas las cuentas. La opción puede faltar si la cuenta la gestiona una organización (consulta a su administrador), usa la Protección avanzada o solo usa llaves de seguridad en la verificación en dos pasos. Entonces la única opción que queda es una versión compilada desde el código fuente con tu propio cliente de Google OAuth; una aplicación interna de una organización está exenta de la verificación de Google (consulta [la explicación de Google](https://support.google.com/cloud/answer/7454865)). Consulta también las [preguntas frecuentes](../faq#app-passwords-missing).

### Versiones con su propio cliente de Google

Una versión compilada desde el código fuente con su propio cliente de Google OAuth conserva el inicio de sesión de Google para buzones nuevos: las versiones compiladas por uno mismo lo tienen por defecto, la tarjeta de Gmail indica «Iniciar sesión con Google OAuth» y al elegirla se abre el flujo en el navegador descrito más abajo. Una versión sin ningún cliente de Google OAuth no muestra ningún botón de Google; para un buzón que inicia sesión con Google, **Configuración > Cuentas** indica entonces que el buzón inicia sesión con Google pero esta versión no incluye un cliente de Google OAuth, por lo que no se puede reconectar allí. Outlook / Microsoft 365 no se ve afectado.

### Progreso del inicio de sesión de Google

El paso de progreso descrito a continuación aparece en las versiones que ofrecen el inicio de sesión de Google para buzones nuevos.


Mientras se realiza la conexion, el asistente sustituye la lista de proveedores por un paso de progreso que indica que esta esperando: tu autorizacion en el navegador, despues la obtencion del acceso, la comprobacion del servidor de correo y del servidor de envio, y el guardado de la cuenta. Dos partes tienen limite de tiempo: la espera de tu autorizacion en el navegador (tres minutos) y las comprobaciones de servidor (30 segundos para la recepcion y 15 para el envio, con un reintento). El resto no lo tiene; lo demas depende del proveedor y de tu red, asi que el paso indica que esta ocurriendo, no cuanto falta. Si la cuenta aun no tiene nombre y el proveedor facilita uno utilizable, se toma del perfil; un nombre que hayas editado nunca se sobrescribe en una reautorizacion posterior. Si la conexion falla antes de guardar la cuenta, el asistente vuelve a la lista de proveedores para que puedas intentarlo de nuevo. Cerrar la ventana no cancela una conexion ya iniciada: continua en segundo plano y aun puede crear la cuenta, de modo que volver a empezar en ese momento puede dejarte un duplicado. Este paso corresponde a anadir una cuenta: al reautorizar una existente desde sus ajustes solo se muestra un indicador en el boton.

## Cuenta Microsoft 365 / Outlook (OAuth)

Selecciona la tarjeta **Outlook / Microsoft 365** en el asistente. Se abrira una ventana de navegador con la pagina de inicio de sesion de Microsoft; entra con tu cuenta `@outlook.com`, `@hotmail.com`, `@live.com` o profesional/educativa y aprueba los permisos solicitados. El cliente Microsoft incluido usa el flujo Authorization Code con PKCE sin client secret -- ningun client secret abandona tu dispositivo. Las builds personalizadas que sustituyen el cliente incluido fijando **ambas** variables de entorno `MAILCOPILOT_MS_CLIENT_ID` (tu propio registro de aplicacion en Azure) y `MAILCOPILOT_MS_CLIENT_SECRET` (pensada para tenants que han emitido un cliente confidencial) si envian ese secret al endpoint de tokens de Microsoft sobre TLS. `MAILCOPILOT_MS_CLIENT_SECRET` por si solo (sin un client ID propio) se ignora. Tras autorizarse, la cuenta se anade automaticamente.

Aqui aparece la misma pantalla de espera que en Gmail, con las mismas etapas y las mismas salvedades: la espera en el navegador y las comprobaciones de servidor tienen limite de tiempo, el resto no y cerrar la ventana no cancela una conexion en curso. A diferencia de Gmail, aqui no hay reintento para el servidor de envio. Tu nombre se toma del perfil de Microsoft si la cuenta no tiene ninguno y el perfil facilita uno utilizable; un nombre que hayas editado nunca se sobrescribe en una reautorizacion posterior. La solicitud de confianza en el certificado descrita mas abajo para Google tambien aparece en esta ruta, despues de guardar la cuenta.

Para enviar correo, MailCopilot usa Microsoft Graph (`POST /me/sendMail`) en cuentas de Outlook, porque Microsoft ha desactivado SMTP AUTH en la mayoria de cuentas personales de Outlook.com creadas desde 2024. La via de envio por Graph no se ve afectada por esa politica. Microsoft guarda automaticamente los mensajes enviados en tu carpeta de Enviados.

Si tu cuenta de Outlook deja de funcionar tras un periodo largo sin conexion, es posible que el refresh token de OAuth haya caducado. Un refresh token de OAuth ausente del almacenamiento seguro activa el [aviso de inicio de sesión caducado](#aviso-de-inicio-de-sesión-caducado) de inmediato, tanto para cuentas de Google como de Outlook. Si un token guardado es rechazado, el rechazo de autenticación IMAP resultante sigue el flujo habitual de fallo de inicio de sesión; reautoriza la cuenta desde **Configuración > Cuentas** con el boton de re-autenticacion de Microsoft.


## Verificacion de certificado TLS

MailCopilot siempre verifica los certificados TLS, comparándolos tanto con el conjunto de certificados de Mozilla integrado como con el almacén de certificados de tu sistema operativo (recurriendo solo al conjunto integrado si el almacén del sistema no se puede leer). El diálogo de confianza dentro de la aplicación descrito en esta sección solo existe para tu **servidor de recepción (IMAP)**. Si ese servidor usa un certificado autofirmado, o uno emitido por una autoridad de certificación privada que aún no está en el almacén de confianza de tu sistema operativo -- por ejemplo, una autoridad de certificación interna gestionada por una universidad o una empresa --, aparecerá un diálogo de confianza: si la huella digital aún no se ha leído, el botón muestra primero **"Leer el certificado"** -- haz clic, revisa los detalles y confirma con **"Confiar y continuar"**; si ya se muestra **"Confiar y continuar"**, haz clic solo en ese. La confianza otorgada de esta forma queda vinculada a ese certificado exacto y a la dirección y puerto específicos de ese servidor -- otro servidor emitido por la misma autoridad de certificación no se vuelve confiable automáticamente, y si el certificado de este servidor cambia de nuevo más adelante, tendrás que confirmar el nuevo de la misma manera. Como alternativa, puedes instalar el certificado raíz de la autoridad de certificación en el almacén de confianza de tu sistema operativo; MailCopilot solo lee ese almacén una vez -- la primera vez que lo necesita -- y conserva esa instantánea hasta que la aplicación se reinicie, por lo que esta alternativa requiere reiniciar MailCopilot para surtir efecto, mientras que confirmar el diálogo de confianza descrito aquí no lo requiere. Los servidores a los que se accede mediante STARTTLS (normalmente el puerto IMAP 143 o el puerto SMTP 587) no pueden entregar su certificado en este paso, por lo que solo se guarda la huella digital -- un servidor STARTTLS autofirmado no puede hacerse confiable de esta forma; usa en su lugar TLS implicito (normalmente el puerto 993 o 465) si tu servidor lo admite.

La línea **«Detalles»** de la solicitud de confianza indica, en el idioma de la aplicación, por qué se rechazó el certificado -- por ejemplo, porque es autofirmado o ha caducado; la lista completa de motivos está en [Confianza de certificados TLS](../settings/general#confianza-de-certificados-tls).

Tu **servidor de envío (SMTP)** no tiene hoy ningún diálogo de confianza equivalente. Si presenta un certificado autofirmado o de una autoridad de certificación privada que aún no está en el almacén de confianza de tu sistema operativo, la prueba de conexión para ese servidor simplemente fallará -- no hay ninguna solución desde dentro de la aplicación. El certificado debe confiarse fuera de MailCopilot, ya sea instalando el certificado raíz de esa autoridad de certificación en el almacén de confianza de tu sistema operativo (reinicia MailCopilot después para que surta efecto), o mediante la variable de entorno `NODE_EXTRA_CA_CERTS` para configuraciones avanzadas.

Al iniciar sesión con Google, si tu red utiliza un proxy o antivirus que reemplaza los certificados TLS por uno que tu sistema operativo aún no conoce, MailCopilot lo detectará y ofrecerá automáticamente aceptar el certificado. Verás los detalles del certificado (host, emisor, huella digital) y podrás aceptarlo o rechazarlo. La cuenta se guarda en cualquier caso, y puedes gestionar los certificados más tarde en la configuración de la cuenta. Si en cambio el certificado raíz del proxy o antivirus ya está instalado en el almacén de tu sistema operativo, la conexión se establece sin ningún diálogo de confianza -- MailCopilot marca este caso por separado con un aviso informativo (ver abajo) en lugar de pedirte que aceptes algo.

Confiar en el almacén de certificados del sistema significa que la mayoría de los proxies corporativos y antivirus que inspeccionan el tráfico TLS funcionan sin más, sin un diálogo de confianza durante la configuración. Tras la primera sincronización exitosa de tu cuenta en una sesión, MailCopilot comprueba una vez si una conexión se inspecciona de esta forma y, si es así, muestra un aviso que nombra al software o proxy responsable; esta comprobación se ejecuta como máximo una vez por servidor durante toda la vida de tu perfil, por lo que una inspección activada en un servidor después de esta comprobación no será detectada. Si el certificado de un servidor cambia más tarde a uno en el que no se puede confiar en absoluto, MailCopilot mostrará entonces un diálogo de recuperación en la ventana principal -- consulta [Confianza de certificados TLS](../settings/general#confianza-de-certificados-tls) para más detalles.

En las conexiones con sus servidores de entrada (IMAP) y de salida (SMTP) y con el proveedor de IA, MailCopilot tampoco confía ya en los certificados cuya cadena lleva a tres raíces de autoridades de certificación vinculadas a un incidente de certificados intermedios comprometidos -- `emSign ECC Root CA - G3`, `emSign Root TLS CA - G3` y `AAA Certificate Services` --, aunque su sistema operativo siga confiando en ellas. Un servidor cuyo certificado lleva a una de ellas se trata como cualquier otro certificado no confiable: para su servidor de entrada (IMAP) aparece el aviso de confianza descrito arriba (para su servidor de salida no hay aviso, como se explicó antes). Un certificado que ya haya confirmado en ese aviso sigue funcionando.

## Conexión cifrada obligatoria (STARTTLS)

Cuando la casilla **SSL/TLS** del servidor de entrada o de salida está desmarcada -- normalmente el puerto IMAP 143 o el puerto SMTP 587, donde la conexión comienza sin cifrar y luego se pasa a cifrada con STARTTLS --, MailCopilot exige que el servidor complete ese cambio antes de enviar su contraseña o cualquier mensaje. Si el servidor no ofrece STARTTLS o no lo acepta, la conexión se rechaza y la prueba de conexión (o la sincronización o el envío fallidos) muestra: «El servidor no ofrece una conexión cifrada (STARTTLS), por lo que MailCopilot no envió ninguna contraseña ni mensaje. Revise el puerto y la configuración de seguridad, o contacte con su proveedor de correo.» Deliberadamente no existe ninguna opción para continuar sin cifrado. Para solucionarlo, compruebe el puerto y la casilla **SSL/TLS** (normalmente el puerto IMAP 993 y el puerto SMTP 465 con **SSL/TLS** marcada) o pregunte a su proveedor de correo qué ajustes espera su servidor. Las conexiones con **SSL/TLS** no se ven afectadas.

## Gestionar varias cuentas

Puedes anadir tantas cuentas como necesites. Para cambiar entre cuentas, usa la barra lateral o ve a **Configuración > Cuentas**. La cuenta activa aparece resaltada y puedes establecer cualquier cuenta como la actual.

## Aviso de inicio de sesión caducado

Si las credenciales de una cuenta dejan de funcionar -- por ejemplo, una contraseña IMAP cambiada en otro lugar, o una cuenta sin ninguna contraseña ni autorización OAuth guardada -- MailCopilot ya no falla en silencio en segundo plano. Aparece un aviso discreto encima de la lista de mensajes: por ejemplo, «Cuenta de correo» no está recibiendo correo: la sesión ha caducado. Vuelve a iniciar sesión para reanudar la sincronización. En un fallo de inicio de sesión normal durante las operaciones habituales de correo, el aviso aparece solo tras dos fallos consecutivos para la misma cuenta. Dos situaciones se saltan ese umbral y muestran el aviso de inmediato. La primera es una cuenta sin ninguna credencial configurada, ya que no hay nada que reintentar. La segunda es un inicio de sesión que el servidor de correo rechaza cuando MailCopilot inicia la vigilancia de correo en segundo plano (IMAP IDLE) para esa cuenta: un intento de inicio de sesión completo rechazado por el servidor es un veredicto definitivo sobre tus credenciales guardadas, no solo una operación que no funcionó, así que no tiene sentido esperar a un segundo fallo -- y una cuenta cuyas carpetas están todas en actualización manual puede no tener una segunda sincronización en segundo plano en la que volver a fallar. Haz clic en **Iniciar sesión de nuevo** para ir directamente a la configuración de esa cuenta, donde puedes volver a introducir tu contraseña o reautorizar la conexión OAuth.

El aviso solo aparece por fallos de inicio de sesión (autenticación) informados por el propio servidor de correo -- una caída temporal de red o un problema de certificado no lo activan, ya que cada uno de esos casos ya tiene su propio indicador independiente (consulta [Verificación de certificado TLS](#verificacion-de-certificado-tls) más arriba). Un refresh token de OAuth ausente del almacenamiento seguro activa el aviso de inmediato, tanto para cuentas de Google como de Outlook. Si un token guardado es rechazado, el rechazo de autenticación IMAP resultante sigue el flujo habitual de fallo de inicio de sesión; si ocurre esto, reautoriza la cuenta manualmente desde **Configuración > Cuentas**. Desaparece automáticamente en cuanto cualquier operación de esa cuenta se completa con éxito -- no solo una sincronización en segundo plano, sino también abrir un mensaje, mover correo o buscar -- de modo que una cuenta con todas las carpetas en actualización manual también retira el aviso en cuanto la usas. No hay nada que cerrar manualmente. Este estado no se guarda entre reinicios -- si MailCopilot se cierra mientras una cuenta está marcada, el aviso solo reaparece si el mismo patrón de fallos vuelve a producirse tras el siguiente inicio.

## Personalizar el avatar de la cuenta

Cada cuenta se muestra en la barra lateral con un avatar -- un círculo de color con iniciales. Puedes personalizar el avatar en **Configuración > Cuentas** haciendo clic en el icono de paleta junto a la cuenta.

### Modos de visualización

- **Letras**: un círculo de color con 1 o 2 caracteres (iniciales). Puedes introducir iniciales personalizadas si las automáticas no son adecuadas.
- **Icono**: un círculo de color con un icono de la colección (correo, maletín, estrella, cohete, etc.).
- **Gravatar**: carga tu foto de perfil desde [Gravatar](https://gravatar.com) según tu dirección de email. Si no se encuentra un Gravatar, se muestran las letras. Así Gravatar recibe el hash SHA-256 de tu dirección y ve tu dirección IP; consulta [Fotos de remitentes (Gravatar)](../privacy/sender-photos.md).

### Cambiar el color

Haz clic en cualquier color de la paleta para cambiar el fondo del avatar. El color se guarda y permanece igual tras reiniciar.

### Tooltip

Al pasar el ratón sobre un avatar en la barra lateral, se muestra el nombre de la cuenta y la dirección de email.

## Proveedores compatibles

Gmail (con contraseña de aplicación; los buzones que ya inician sesión con Google siguen funcionando), Outlook, Yahoo, Fastmail, Yandex Mail, Mail.ru, ProtonMail (vía Bridge), servidores propios.
