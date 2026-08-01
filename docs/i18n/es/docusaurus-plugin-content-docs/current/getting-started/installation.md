---
sidebar_position: 1
title: Instalación
---

# Instalación

## Descargar MailCopilot

Visita [mailcopilot.io](https://mailcopilot.io) para descargar la última versión.

## Instalación en Linux

:::warning Ubuntu 23.10+ / 24.04 y otras distribuciones recientes
En Ubuntu 23.10 y versiones posteriores (incluyendo 24.04 LTS), y en otras distribuciones que incluyen el mismo endurecimiento del kernel, **instale el paquete `.deb`** (o el `.rpm` en Fedora/openSUSE) en lugar del AppImage.

Estos kernels restringen por defecto los espacios de nombres de usuario sin privilegios (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot está basado en Electron, cuyo componente auxiliar `chrome-sandbox` necesita esa capacidad cuando se lanza desde un AppImage — por lo que el AppImage falla al iniciar con una señal `SIGTRAP`. Los paquetes `.deb` y `.rpm` no tienen este problema: sus scripts de instalación configuran el componente auxiliar `chrome-sandbox` de forma adecuada — aplicando SUID-root (`chmod 4755`) donde los espacios de nombres de usuario sin privilegios están restringidos, o instalando un perfil de AppArmor en sistemas Ubuntu más recientes (24.04+).

**No** evite esto lanzando la aplicación con `--no-sandbox` o deshabilitando globalmente `apparmor_restrict_unprivileged_userns` — ambas opciones debilitan el límite de seguridad que le protege del contenido de correo electrónico no fiable. En su lugar, utilice el `.deb` o el `.rpm`.
:::

### Deb (Debian, Ubuntu, Mint) — recomendado

1. Descarga el archivo `.deb` desde el sitio web.
2. Instálalo haciendo doble clic o en un terminal:
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Inicia MailCopilot desde el menú de aplicaciones.

### RPM (Fedora, openSUSE)

1. Descarga el archivo `.rpm` desde el sitio web.
2. Instálalo haciendo doble clic o en un terminal:
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Inicia MailCopilot desde el menú de aplicaciones.

### AppImage

El AppImage es un único archivo autocontenido que no requiere instalación. Funciona bien en distribuciones más antiguas, pero consulte la advertencia anterior antes de usarlo en Ubuntu 23.10+ / 24.04.

1. Descarga el archivo `.AppImage` desde el sitio web.
2. Hazlo ejecutable:
   - Clic derecho > **Propiedades** > **Permisos** > **Permitir ejecutar como programa**.
   - O en un terminal: `chmod +x mailcopilot-*.AppImage`
3. Haz doble clic en el AppImage para iniciar MailCopilot.

El runtime de AppImage requiere FUSE. En versiones recientes de Debian/Ubuntu, instala el paquete `libfuse2t64` (en versiones más antiguas se llama `libfuse2`):

```bash
sudo apt install libfuse2t64
```

:::tip
Puedes mover el AppImage a cualquier ubicación, como `~/Applications/`. La aplicación es completamente autónoma.
:::

## Instalación en Windows

1. Descarga el instalador `.exe` desde el sitio web.
2. Ejecuta el instalador y sigue las instrucciones. Puedes elegir el directorio de instalación.
3. Inicia MailCopilot desde el menú Inicio o el acceso directo del escritorio.

## Primer inicio

Al iniciar por primera vez, primero verá una pantalla de consentimiento titulada **¿Enviar datos de diagnóstico?**, preguntando si MailCopilot puede enviar datos de diagnóstico y de uso -- consulte [Telemetría](../privacy/telemetry) para saber exactamente qué significa eso. No se envía nada hasta que responda, y su elección no afecta a la sincronización de correo ni al asistente de IA. Sí cambia una cosa en Ajustes -> Acerca de: con el diagnóstico desactivado, el formulario de comentarios integrado se sustituye por un enlace al sitio web de MailCopilot. Después de responder, se abrirá el asistente de configuración de cuenta, que le guiará para conectar su primera cuenta de correo electrónico.

Sus contraseñas se almacenan de forma segura en el llavero del sistema (keytar) y nunca se escriben en archivos de configuración en texto plano.

## Actualizaciones automáticas

MailCopilot busca actualizaciones automáticamente. Cuando hay una nueva versión disponible, aparece una notificación en la aplicación. Puedes descargar la actualización y reiniciar con un clic.

:::note
Las actualizaciones automáticas integradas en la aplicación solo están disponibles cuando MailCopilot está instalado en una ubicación con permisos de escritura — por ejemplo, un AppImage almacenado en su directorio personal. Al instalar desde un paquete de sistema `.deb` o `.rpm`, el directorio de instalación suele ser propiedad de root y no tiene permisos de escritura para su cuenta de usuario, por lo que MailCopilot desactiva el actualizador integrado automáticamente. En ese caso, actualice a través de su gestor de paquetes (`apt`/`dnf`) o descargando y reinstalando el último paquete desde el sitio web.
:::
