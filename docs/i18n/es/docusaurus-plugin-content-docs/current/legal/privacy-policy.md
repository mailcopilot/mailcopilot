---
sidebar_position: 1
title: Politica de Privacidad
---

# Politica de Privacidad

**Fecha de entrada en vigor:** 13 de febrero de 2026
**Ultima actualizacion:** 4 de noviembre de 2026

## 1. Introduccion

MailCopilot ("la Aplicacion", "nosotros", "nuestro") es un cliente de correo electronico de escritorio para Windows, macOS y Linux. Esta Politica de Privacidad describe como recopilamos, utilizamos, almacenamos y protegemos sus datos personales cuando utiliza la Aplicacion.

Al utilizar MailCopilot, usted acepta las practicas descritas en esta Politica de Privacidad. Si no esta de acuerdo, por favor no utilice la Aplicacion.

## 2. Datos que recopilamos

### 2.1 Credenciales de cuenta de correo

- **Direccion de correo electronico** — necesaria para conectarse a su servidor de correo.
- **Contrasena** (IMAP/SMTP) — si utiliza autenticacion basada en contrasena.
- **Tokens OAuth** (token de acceso, token de actualizacion) — si utiliza Google OAuth 2.0 u otro proveedor OAuth.

### 2.2 Datos de correo electronico

Cuando conecta su cuenta, la Aplicacion descarga y almacena en cache:

- Encabezados de correo (asunto, remitente, destinatarios, fecha).
- Cuerpo del correo (texto y HTML).
- Metadatos de archivos adjuntos (nombres de archivo y tipos; los archivos adjuntos en si no se almacenan en cache de forma predeterminada).
- Indicadores de correo (leido/no leido, marcado).
- Identificadores de mensaje (Message-ID, In-Reply-To, References) para el agrupamiento en conversaciones.

### 2.3 Informacion de contactos

- Direcciones de correo electronico y nombres de las personas con las que se comunica.
- Frecuencia de uso y fecha de ultima interaccion para sugerencias de autocompletado.

### 2.4 Estructura de carpetas

- Lista de carpetas del buzon, sus nombres y atributos de uso especial (Bandeja de entrada, Enviados, Borradores, Papelera, Spam, Archivo).
- Preferencias por carpeta (visibilidad, configuracion de insignias, modo de sincronizacion).

### 2.5 Configuracion de la aplicacion

- Idioma, tema, preferencias de IA y otras opciones de configuracion.
- Direccion de correo personalizada para el encabezado "From" (si esta configurada).
- Firmas de correo electronico.

### 2.6 Informes de errores

- Si el reporte de errores de Sentry esta activo, recopilamos **informes anonimos de fallos** (trazas de pila, version de la aplicacion, entorno operativo). **No se incluyen datos personales** (contenido de correos, direcciones, contrasenas ni tokens) en los informes de errores (`sendDefaultPii: false`).

## 3. Como almacenamos sus datos

**Todos los datos del usuario se almacenan localmente en su computadora.** MailCopilot no opera ningun servidor en la nube para almacenar sus correos, contactos o configuracion.

| Datos | Metodo de almacenamiento |
|---|---|
| Contrasenas y claves API | Almacenamiento seguro a nivel del sistema operativo (keytar): Windows DPAPI, macOS Keychain, Linux Secret Service |
| Cache de correo y contactos | Base de datos SQLite local (`~/.mailcopilot/cache.db`) |
| Configuracion y cuentas | Archivo JSON local (electron-store) |
| Tokens OAuth | Almacenamiento local cifrado via electron-store |

Puede eliminar todos los datos locales en cualquier momento eliminando el directorio `~/.mailcopilot/` (o el directorio de datos configurado mediante `MAILCOPILOT_DATA_DIR`).

## 4. Como utilizamos sus datos

Utilizamos sus datos **unicamente** para proporcionar la funcionalidad principal de la Aplicacion:

- **Conectarse a su servidor de correo** mediante IMAP/SMTP para enviar, recibir y gestionar correo electronico.
- **Almacenar correos en cache localmente** para un acceso mas rapido y lectura sin conexion.
- **Proporcionar autocompletado** de direcciones de destinatarios basado en su historial de contactos.
- **Mostrar la estructura de carpetas** y los contadores de correos no leidos.
- **Funciones del Asistente de IA** (opcional) — consulte la Seccion 5.

**No** utilizamos sus datos para:

- Publicidad, marketing ni segmentacion publicitaria.
- Venta ni intercambio con intermediarios de datos.
- Creacion de perfiles de usuario para terceros.
- Calificacion crediticia ni evaluaciones financieras.
- Vigilancia ni seguimiento.
- Entrenamiento de modelos de IA/ML de proposito general.

## 5. Asistente de IA y proveedores de IA de terceros

MailCopilot ofrece un asistente de IA opcional que puede ayudarle a redactar respuestas, resumir correos y realizar acciones de correo.

### 5.1 Se requiere consentimiento explicito

El asistente de IA esta **desactivado de forma predeterminada**. Antes de que se envie cualquier dato de correo a un proveedor de IA, usted debe:

1. Activar el asistente de IA en Configuracion.
2. Dar su consentimiento explicito para compartir datos de correo con el proveedor de IA seleccionado (configuracion `aiPrivacyConsent`).

### 5.2 Que datos se envian a los proveedores de IA

Cuando utiliza el asistente de IA, los siguientes datos pueden enviarse al proveedor seleccionado:

- Contenido del correo o correos con los que esta trabajando (asunto, cuerpo, remitente, destinatarios).
- Sus instrucciones o preguntas para la IA.

Los datos se envian **unicamente a peticion explicita suya** — nunca de forma automatica ni en segundo plano.

### 5.3 Proveedores de IA compatibles

| Proveedor | Servicio |
|---|---|
| Anthropic | Claude API (api.anthropic.com) |
| Compatible con OpenAI | La API estandar de OpenAI (api.openai.com) por defecto, o un endpoint compatible configurado por usted (por ejemplo OpenRouter, LiteLLM, Azure OpenAI o un servidor autoalojado) si establece una URL base personalizada |
| Google | Gemini API |

Cada proveedor tiene su propia politica de privacidad. Le recomendamos revisar la politica de privacidad del proveedor que elija:

- [Politica de Privacidad de Anthropic](https://www.anthropic.com/privacy)
- [Politica de Privacidad de OpenAI](https://openai.com/privacy) — se aplica cuando usa la API estandar de OpenAI; si ha establecido una URL base personalizada, consulte en su lugar la politica de privacidad del operador de ese endpoint.
- [Politica de Privacidad de Google](https://policies.google.com/privacy)

### 5.4 Controles de presupuesto de IA

Puede establecer limites de gasto diarios y mensuales para el uso de IA en Configuracion.

## 6. Servicios de la API de Google — Divulgacion de uso limitado {#google-limited-use}

El uso y la transferencia por parte de MailCopilot a cualquier otra aplicacion de la informacion recibida de las APIs de Google se ajustara a la [Politica de Datos de Usuario de los Servicios de la API de Google](https://developers.google.com/terms/api-services-user-data-policy), incluidos los requisitos de Uso Limitado.

Especificamente:

1. **Solo utilizamos los datos de usuario de Google para proporcionar y mejorar funciones orientadas al usuario** que son visibles y evidentes en la interfaz de la Aplicacion (leer, enviar y organizar correo electronico).
2. **No transferimos datos de usuario de Google a terceros** excepto:
   - Cuando sea necesario para proporcionar o mejorar funciones orientadas al usuario (por ejemplo, enviar contenido de correo a un proveedor de IA **solo con su consentimiento explicito**).
   - Cuando sea necesario para cumplir con la legislacion aplicable.
   - Como parte de una fusion, adquisicion o venta de activos, con notificacion al usuario.
3. **No utilizamos datos de usuario de Google para publicidad**, incluyendo retargeting, publicidad personalizada ni publicidad basada en intereses.
4. **No permitimos que personas lean datos de usuario de Google** a menos que:
   - Tengamos su consentimiento explicito (por ejemplo, soporte tecnico a su solicitud).
   - Sea necesario por motivos de seguridad (por ejemplo, investigacion de abusos).
   - Sea necesario para cumplir con la legislacion aplicable.
   - Los datos esten agregados y anonimizados para operaciones internas.
5. **No utilizamos datos de usuario de Google para entrenar modelos de IA/ML de proposito general.** Cuando usted elige usar el asistente de IA, el contenido de su correo se envia al proveedor de IA seleccionado unicamente para generar una respuesta para usted, no para el entrenamiento de modelos.

## 7. Google OAuth 2.0

Cuando conecta una cuenta de Gmail mediante el inicio de sesión de Google, MailCopilot utiliza Google OAuth 2.0 con PKCE (RFC 7636) para obtener acceso. En la compilación oficial de MailCopilot, el inicio de sesión de Google ya no se ofrece para los buzones nuevos de Gmail (estos se conectan con una contraseña de aplicación mediante IMAP/SMTP); sigue disponible para los buzones que ya lo utilizan y para las compilaciones hechas a partir del código fuente con su propio cliente de Google. Cuando se utiliza el inicio de sesión de Google, solicitamos los siguientes permisos:

| Permiso | Proposito |
|---|---|
| `https://mail.google.com/` | Acceso IMAP/SMTP para leer, enviar y gestionar su correo electronico |
| `openid` | Verificar su identidad |
| `email` | Obtener su direccion de correo electronico |
| `profile` | Obtener su nombre para mostrar |

Los tokens OAuth se almacenan localmente en su dispositivo (consulte la Seccion 3). Nunca transmitimos sus tokens a ningun servidor operado por nosotros.

## 8. Comparticion de datos

**No** compartimos sus datos personales con ningun tercero, excepto en las siguientes circunstancias limitadas:

- **Proveedores de IA** — solo con su consentimiento explicito, como se describe en la Seccion 5.
- **Sentry** — unicamente informes anonimos de fallos, sin datos personales (consulte la Seccion 2.6).
- **Su proveedor de correo electronico** — a traves de los protocolos estandar IMAP/SMTP para ofrecer la funcionalidad de correo.

No vendemos, alquilamos ni comerciamos con sus datos personales.

## 9. Retencion y eliminacion de datos

- **Cache de correo**: Se almacena localmente mientras utilice la Aplicacion. Puede borrar la cache en cualquier momento desde Configuracion o eliminando el directorio de datos.
- **Credenciales**: Se almacenan en el almacenamiento seguro del sistema operativo hasta que elimine la cuenta de MailCopilot.
- **Configuracion**: Se almacena localmente hasta que desinstale la Aplicacion o elimine los archivos de configuracion.

Dado que todos los datos se almacenan localmente, desinstalar la Aplicacion y eliminar el directorio `~/.mailcopilot/` elimina permanentemente todos los datos.

## 10. Sus derechos

Usted tiene control total sobre sus datos:

- **Acceso**: Todos sus datos se almacenan localmente en su dispositivo — puede acceder a ellos en cualquier momento.
- **Eliminacion**: Elimine cualquier cuenta de MailCopilot para borrar sus datos en cache, o elimine todo el directorio de datos.
- **Revocar acceso OAuth**: Puede revocar el acceso de MailCopilot a su cuenta de Google en cualquier momento a traves de [Permisos de la cuenta de Google](https://myaccount.google.com/permissions).
- **Desactivar la IA**: Puede desactivar el asistente de IA en cualquier momento en Configuracion.
- **Exportacion**: Sus correos permanecen en su servidor de correo y son accesibles a traves de cualquier cliente de correo electronico.

## 11. Seguridad

Implementamos las siguientes medidas de seguridad:

- **Almacenamiento cifrado**: Las contrasenas y claves API se almacenan en el almacenamiento seguro del sistema operativo (keytar).
- **TLS 1.2+**: Todas las conexiones a servidores de correo estan cifradas.
- **Verificacion de certificados TLS**: Los certificados se verifican frente al conjunto de certificados de Mozilla integrado y al almacen de certificados de su sistema operativo (recurriendo solo al conjunto integrado si el almacen del sistema no esta disponible); las conexiones a servidores que presenten certificados no confiables se bloquean hasta que usted decida explicitamente confiar en ellos.
- **Fijacion de certificados TLS**: Verificacion opcional de pin de certificado SHA-256 para prevenir ataques MITM; aplicada de forma estricta en cada conexion a un servidor fijado.
- **Aislamiento sandbox**: El proceso de renderizado se ejecuta en un entorno aislado sin acceso directo al sistema operativo.
- **Validacion IPC**: Toda la comunicacion entre procesos se valida mediante esquemas Zod.
- **PKCE**: El flujo OAuth 2.0 utiliza Proof Key for Code Exchange (RFC 7636).

## 12. Actualizaciones automaticas

MailCopilot busca actualizaciones en segundo plano: al iniciarse y después aproximadamente una vez por hora. Una búsqueda de actualizaciones es una solicitud HTTPS normal a nuestro servidor de actualizaciones para obtener un pequeño archivo de metadatos (número de versión y hash del archivo). Como en cualquier solicitud web, el servidor ve su dirección IP y, por el nombre del archivo solicitado, el tipo de su sistema operativo y la arquitectura de su procesador. La propia búsqueda no envía la versión de MailCopilot que usa (la aplicación compara las versiones localmente), y no se incluye correo, datos de cuentas ni datos de uso. La solicitud lleva únicamente cabeceras HTTP normales, como un agente de usuario genérico. Una cabecera de compatibilidad que la biblioteca de actualización usa para los despliegues escalonados se envía con un valor fijo de ceros, idéntico para todas las instalaciones, por lo que no identifica nada. La descarga de una actualización es distinta: sí revela versiones, porque los nombres de los archivos solicitados contienen números de versión y, cuando se usa una descarga diferencial, la solicitud del archivo block map de la versión instalada actualmente (con un nombre como `mailcopilot-<current-version>-setup.exe.blockmap` en Windows) indica al servidor qué versión se está ejecutando.

Usted decide si esto ocurre. **Buscar actualizaciones en segundo plano** está activada de forma predeterminada y se puede desactivar en Configuración → Acerca de → Actualizaciones, o en la pantalla del primer inicio. No hace falta reiniciar: al desactivarla, las nuevas búsquedas automáticas se detienen en cuanto guarda. Una búsqueda o una descarga automática que la biblioteca de actualización ya haya iniciado aún puede completarse (una descarga ya comenzada no se cancela; una búsqueda puede estar a mitad de la lectura de su configuración y reintenta varias veces una conexión rechazada). Aparte de eso, cuando está desactivada, MailCopilot nunca contacta por sí mismo con el servidor de actualizaciones: ni búsqueda al iniciar ni búsqueda cada hora. El botón **Buscar actualizaciones** sigue funcionando, porque al pulsarlo usted hace una solicitud explícita. Una nueva descarga automática no puede iniciarse sin una búsqueda, de modo que la opción «Descargar automáticamente las actualizaciones en segundo plano» no tiene efecto mientras la búsqueda en segundo plano esté desactivada. En una instalación completamente nueva (un perfil sin respuesta anterior a la pantalla del primer inicio y sin cuenta de correo), MailCopilot no envía ninguna solicitud automática de actualización hasta que usted haya respondido a esa pantalla; cerrarla sin responder no registra nada, así que la espera continúa. Todos los perfiles existentes siguen buscando, incluido uno al que se le vuelve a mostrar la pantalla del primer inicio tras un cambio en la información proporcionada.

En Windows, el instalador muestra, antes de los pasos de instalación, una página con un aviso de privacidad (un breve resumen con un enlace a esta política) en el idioma del instalador (inglés, ruso, francés, alemán, español o italiano; con otros idiomas del instalador se muestra en inglés). Debe aceptarlo para continuar. Esta página no se muestra en las instalaciones silenciosas ni en las actualizaciones automáticas. Los paquetes de Linux y macOS no tienen página de instalador; para ellos, la pantalla del primer inicio y Configuración son los lugares donde se presentan esta información y la opción.

## 13. Privacidad de los menores

MailCopilot no esta dirigido a menores de 16 anos. No recopilamos conscientemente datos personales de menores.

## 14. Cambios en esta politica

Podemos actualizar esta Politica de Privacidad de vez en cuando. Los cambios se publicaran en esta pagina con una fecha de "Ultima actualizacion" actualizada. Le recomendamos revisar esta politica periodicamente.

## 15. Contactenos

Si tiene preguntas sobre esta Politica de Privacidad, por favor contactenos:

- **Correo electronico**: privacy@mailcopilot.io
- **Sitio web**: [mailcopilot.io](https://mailcopilot.io)
