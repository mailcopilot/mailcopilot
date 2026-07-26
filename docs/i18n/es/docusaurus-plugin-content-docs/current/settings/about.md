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

- **Versión de la aplicación** — la versión actual de MailCopilot y el canal de publicación (stable, nightly o dev).
- **Electron** — la versión del entorno de ejecución Electron utilizado por MailCopilot.
- **Chromium** — la versión del motor Chromium incluido en Electron.
- **Node.js** — la versión de Node.js que se ejecuta dentro de la aplicación.
- **Plataforma** — el sistema operativo y la arquitectura.
- **Ruta de instalación** — el directorio donde está instalado MailCopilot. Si la ruta está marcada como **solo lectura**, la instalación es para todo el sistema y las actualizaciones automáticas requieren privilegios de administrador.

Esta información es útil al informar errores o verificar la compatibilidad.

## Actualizaciones

La sección **Actualizaciones** le permite controlar cómo MailCopilot se mantiene actualizado.

### Descargar actualizaciones automáticamente en segundo plano

Cuando esta opción está habilitada, MailCopilot descarga silenciosamente las nuevas versiones a medida que están disponibles. Una vez completada la descarga, se le pide que reinicie la aplicación para aplicar la actualización. No se requiere ninguna acción hasta que esté listo para reiniciar.

Cuando esta opción está deshabilitada, MailCopilot le notifica que hay una actualización disponible y muestra un botón **Descargar**. Usted controla exactamente cuándo comienza la descarga.

Esta configuración está **deshabilitada de forma predeterminada** (requiere activación explícita). Actívela para que MailCopilot descargue las actualizaciones sin intervención manual.

### Buscar actualizaciones

Haga clic en el botón **Buscar actualizaciones** para activar manualmente una verificación en cualquier momento. El botón y el área de estado reflejan el estado actual del proceso de actualización:

- **inactivo** — el botón **Buscar actualizaciones** está visible y listo para usar.
- **Comprobando…** — se está realizando una verificación de actualizaciones; el botón está deshabilitado hasta que finalice la comprobación.
- **Tienes la última versión** — no hay actualizaciones disponibles.
- **Actualización disponible: vX.Y.Z** — se detectó una nueva versión; aparece un botón **Descargar X.Y.Z** si la instalación admite la autoactualización.
- **Descargando… N %** — el archivo de actualización se está descargando; un indicador de progreso muestra el porcentaje.
- **Reiniciar para instalar** — la descarga está completa; haga clic para reiniciar MailCopilot y aplicar la actualización inmediatamente.
- **Error de red — inténtelo de nuevo cuando esté en línea** — la verificación o descarga falló debido a un problema de red.
- **Permiso denegado — se requiere administrador** — el directorio de instalación no es escribible por el usuario actual.
- **Error de actualización — consulte los registros para más detalles** — ocurrió un error inesperado; consulte el registro de depuración para más información.
- **Las actualizaciones están desactivadas en esta compilación** — MailCopilot se está ejecutando en modo de desarrollo o no está empaquetado; las actualizaciones automáticas no están disponibles.

### Instalaciones de solo lectura

Si MailCopilot fue instalado para todo el sistema (por ejemplo, mediante un gestor de paquetes que coloca la aplicación en un directorio protegido), la **Ruta de instalación** en Información del sistema se marca como **solo lectura**. En este caso:

- La casilla **Descargar actualizaciones automáticamente en segundo plano** se muestra pero está **deshabilitada** (atenuada), con un tooltip explicando que la instalación es de solo lectura.
- El botón **Buscar actualizaciones** **sigue funcionando** — aún puede comprobar si hay una nueva versión disponible.
- Los controles **Descargar** y **Reiniciar para instalar** están bloqueados: no aparecen o no funcionan en instalaciones de solo lectura, ya que MailCopilot no puede escribir la actualización en un directorio protegido.

Actualice la aplicación a través de su gestor de paquetes o con privilegios de administrador.

## Informes de errores anónimos

Cuando está habilitado, MailCopilot envía informes de fallos anónimos para ayudar a los desarrolladores a encontrar y corregir errores. No se recopilan datos personales, contenido de correos electrónicos ni información de cuentas — solo se transmiten detalles técnicos de los errores.

Esta configuración está habilitada por defecto. Puede desactivarla en cualquier momento desmarcando la casilla.

## Registro de depuración

Cuando está habilitado, MailCopilot escribe registros detallados en un archivo para la resolución de problemas. Estos registros se almacenan localmente en su computadora y nunca se envían automáticamente.

El registro de depuración está deshabilitado por defecto. Actívelo solo cuando investigue un problema — puede afectar ligeramente el rendimiento.

## Reportar un error

Haga clic en el botón **Reportar un error** para enviar comentarios directamente a los desarrolladores de MailCopilot. Describa el problema encontrado — esto nos ayuda a identificar y corregir problemas más rápidamente.

Sus comentarios se envían de forma segura a través del mismo sistema anónimo de informes de errores. Si los informes de errores están desactivados, verá un enlace al sitio web de MailCopilot donde puede contactar con el soporte.

Cuando la aplicación encuentra un error inesperado, también aparecerá un formulario de comentarios en la pantalla de error, permitiéndole describir lo que estaba haciendo antes del error.
