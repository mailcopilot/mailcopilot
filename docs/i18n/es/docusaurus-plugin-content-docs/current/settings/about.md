---
sidebar_position: 6
title: Acerca de
---

# Acerca de

La pestaña **Acerca de** en Configuración muestra información sobre su instalación de MailCopilot y proporciona controles de diagnóstico y actualizaciones.

## Versión

Muestra la versión actual de MailCopilot instalada en su computadora.

## Enlaces

- **Sitio web** — abre el sitio web de MailCopilot en su navegador.
- **Documentación** — abre este sitio de documentación.

## Información del sistema

El panel **Información del sistema** muestra detalles técnicos sobre su instalación:

- **Versión de la app** — la versión actual de MailCopilot y el canal de publicación (stable, nightly o dev).
- **Electron** — la versión del entorno de ejecución Electron utilizado por MailCopilot.
- **Chromium** — la versión del motor Chromium incluido en Electron.
- **Node.js** — la versión de Node.js que se ejecuta dentro de la aplicación.
- **Plataforma** — el sistema operativo y la arquitectura.
- **Ruta de instalación** — la ruta del ejecutable actualmente en ejecución (`process.execPath`). En Windows y macOS es el lugar real donde está instalado MailCopilot. En una AppImage, `execPath` apunta a una ubicación temporal `/tmp/.mount_*` creada mientras la aplicación está abierta, no a la ubicación del propio archivo `.AppImage` — la marca **solo lectura** refleja si se puede escribir en la carpeta real del archivo AppImage, no en la ruta mostrada aquí. Esta marca nunca aparece en las instalaciones `.deb`/`.rpm`/pacman, que escriben las actualizaciones con privilegios de administrador en lugar de depender de los permisos de la carpeta.

Esta información es útil al informar errores o verificar la compatibilidad.

## Actualizaciones

La sección **Actualizaciones** le permite controlar cómo MailCopilot se mantiene actualizado.

### Descargar automáticamente las actualizaciones en segundo plano

Cuando esta opción está habilitada, MailCopilot descarga silenciosamente las nuevas versiones a medida que están disponibles. Una vez completada la descarga, se le pide que reinicie la aplicación para aplicar la actualización. No se requiere ninguna acción hasta que esté listo para reiniciar.

Cuando esta opción está deshabilitada, MailCopilot le notifica que hay una actualización disponible y muestra un botón **Descargar**. Usted controla exactamente cuándo comienza la descarga.

Esta configuración está **deshabilitada de forma predeterminada** (requiere activación explícita). Actívela para que MailCopilot descargue las actualizaciones sin intervención manual.

### Buscar actualizaciones

Haga clic en el botón **Buscar actualizaciones** para activar manualmente una verificación en cualquier momento. El botón y el área de estado reflejan el estado actual del proceso de actualización:

- **inactivo** — el botón **Buscar actualizaciones** está visible y listo para usar.
- **Comprobando…** — se está realizando una verificación de actualizaciones; el botón está deshabilitado hasta que finalice la comprobación.
- **Tienes la última versión** — no hay actualizaciones disponibles.
- **disponible** — se detectó una nueva versión: junto al número de versión de arriba aparece un aviso **(última versión disponible X.Y.Z)**, y — si la instalación admite la autoactualización — aparece aquí un botón **Descargar X.Y.Z**.
- **Descargando… N %** — el archivo de actualización se está descargando; un indicador de progreso muestra el porcentaje.
- **Reiniciar para instalar** — la descarga está completa; haga clic para reiniciar MailCopilot y aplicar la actualización inmediatamente.
- **Error de red — inténtalo de nuevo cuando estés en línea** — la verificación o descarga falló debido a un problema de red.
- **Permiso denegado — se requiere administrador** — el mecanismo de actualización o el sistema operativo denegó el acceso. En instalaciones que usan privilegios de administrador (`.deb`/`.rpm`/pacman), esto suele significar que falló el paso de elevación de privilegios o el de instalación del paquete, no que una carpeta no admite escritura.
- **Error de actualización — consulta los registros para más detalles** — ocurrió un error inesperado; consulte el registro de depuración para más información.
- **Las actualizaciones están desactivadas en esta compilación** — MailCopilot se está ejecutando en modo de desarrollo o no está empaquetado; las actualizaciones automáticas no están disponibles.

### Cuando la autoactualización no está disponible

MailCopilot normalmente puede actualizarse a sí mismo en cualquier plataforma que admite: una instalación AppImage sustituye el propio archivo `.AppImage`, y una instalación `.deb`/`.rpm`/pacman deja que el mecanismo de actualización intente la escritura solicitando privilegios de administrador (`pkexec`/`sudo`), del mismo modo que lo harían `apt`/`dnf`/`pacman`. El resultado final en esas instalaciones de Linux empaquetadas lo deciden el aviso de elevación de privilegios y el gestor de paquetes, no MailCopilot — un fallo ahí muestra un diálogo **Update installation failed** («Error al instalar la actualización») con un enlace a la página de descargas, no en silencio.

MailCopilot solo decide de antemano que la autoactualización no está disponible en dos situaciones:

- **La compilación no está empaquetada** — una compilación de desarrollo o de CI. En ese caso no existe ningún mecanismo de actualización: el botón **Buscar actualizaciones** y el área de estado no aparecen, y en su lugar se muestra el aviso **«Las actualizaciones están desactivadas en esta compilación»**.
- **La compilación está empaquetada, pero MailCopilot tiene un motivo concreto para esperar que la escritura falle**, lo cual ocurre cuando:
  - la compilación de Linux no es ni un AppImage ni un paquete de sistema compatible — por ejemplo, un AppImage extraído o una carpeta `linux-unpacked` sin empaquetar, o
  - la carpeta en la que MailCopilot necesitaría escribir no admite escritura para su cuenta de usuario. En un AppImage, esa es la carpeta que contiene el archivo `.AppImage`; en Windows y macOS es la carpeta que contiene el ejecutable instalado. Esta comprobación no se aplica a las instalaciones `.deb`/`.rpm`/pacman, porque el mecanismo de actualización eleva privilegios en su lugar.

En el segundo caso, comprobar actualizaciones sigue funcionando con normalidad — solo se ve afectada la posibilidad de escribir la actualización en su sitio:

- El botón **Buscar actualizaciones** sigue disponible y funciona — siempre puede comprobar si existe una nueva versión.
- La casilla **Descargar automáticamente las actualizaciones en segundo plano** sigue disponible y continúa guardando su preferencia, pero nada se descarga automáticamente hasta que la autoactualización sea posible.
- Aparece una advertencia junto a la casilla explicando el motivo — por ejemplo: «Esta compilación no puede reemplazarse a sí misma (no se está ejecutando como AppImage ni como paquete del sistema). Descarga la nueva versión manualmente desde el sitio web.» o «La carpeta que contiene la aplicación no admite escritura, así que la actualización no puede instalarse en el sitio. Descarga la nueva versión manualmente o mueve la aplicación a una carpeta propia.» Si MailCopilot no puede determinar el motivo concreto, aparece en su lugar una advertencia neutra: «Esta instalación no puede actualizarse automáticamente. Descarga la nueva versión manualmente desde el sitio web.»
- Los controles **Descargar** y **Reiniciar para instalar** no aparecen, porque MailCopilot no tiene forma de escribir la actualización por sí mismo.

Esta comprobación se ejecuta una sola vez, al iniciar MailCopilot. Si mueve el archivo AppImage a una ubicación con permisos de escritura o cambia los permisos de la carpeta de instalación, cierre y vuelva a abrir MailCopilot para que el cambio surta efecto — una instancia ya en ejecución conserva su veredicto original.

Actualice la aplicación a través de su gestor de paquetes, con privilegios de administrador, o descargando la nueva versión manualmente desde el sitio web.

## Diagnósticos y datos de uso

Cuando está habilitado, MailCopilot envía informes de fallos, mediciones de rendimiento, eventos de uso (qué funciones se utilizan, qué proveedor y modelo de IA, el coste estimado de una petición) y un identificador aleatorio de la instalación que vincula sus sesiones. El contenido de los mensajes y el texto de sus búsquedas nunca se incluyen; las direcciones, asuntos y nombres de carpetas quedan totalmente excluidos allí donde el diagnóstico usa una lista cerrada de campos (como en el diagnóstico de la copia enviada), y en el resto de los casos los atrapa una limpieza de mejor esfuerzo de formas reconocibles de direcciones y rutas -- una red de seguridad, no una garantía. El formulario de comentarios de abajo es el único lugar donde se envía una dirección a propósito, para que puedan responderle; en cualquier otro sitio, una dirección solo se elimina si se detecta, no se garantiza su ausencia -- y, como sí incluye ese identificador de instalación, estos datos no son totalmente anónimos. Consulte [Telemetría](../privacy/telemetry) para ver la lista completa de qué se envía y qué nunca se envía.

Esta configuración refleja la respuesta que dio en la pantalla de consentimiento mostrada la primera vez que inició MailCopilot, y está **deshabilitada de forma predeterminada** — no se envía nada a menos que haya dado su consentimiento activamente. Puede cambiar su decisión en cualquier momento marcando o desmarcando la casilla.

Si MailCopilot no tiene registro de una respuesta a la pregunta de consentimiento inicial — por ejemplo, justo después de que la lista de datos recopilados cambie y sea necesario volver a preguntar — la casilla aquí se muestra desmarcada y deshabilitada, con una nota indicando que el diagnóstico permanece desactivado hasta que responda en la pantalla de consentimiento en el próximo inicio.

## Registro de depuración

Cuando está habilitado, MailCopilot escribe registros detallados en un archivo para la resolución de problemas. Estos registros se almacenan localmente en su computadora y nunca se envían automáticamente.

El registro de depuración está deshabilitado por defecto. Actívelo solo cuando investigue un problema — puede afectar ligeramente el rendimiento.

## Reportar un error

Haga clic en el botón **Reportar un error** para enviar comentarios directamente a los desarrolladores de MailCopilot. Describa el problema encontrado — esto nos ayuda a identificar y corregir problemas más rápidamente.

Sus comentarios se envían de forma segura a través del mismo sistema de diagnósticos descrito arriba. Si los informes de errores están desactivados, verá un enlace al sitio web de MailCopilot donde puede contactar con el soporte.

Cuando la aplicación encuentra un error inesperado, también aparecerá un formulario de comentarios en la pantalla de error, permitiéndole describir lo que estaba haciendo antes del error.
