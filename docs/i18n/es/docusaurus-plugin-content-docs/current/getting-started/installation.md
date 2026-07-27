---
sidebar_position: 1
title: Instalacion
---

# Instalacion

## Descargar MailCopilot

Visita [mailcopilot.io](https://mailcopilot.io) para descargar la ultima version.

## Instalacion en Linux

:::warning Ubuntu 23.10+ / 24.04 y otras distribuciones recientes
En Ubuntu 23.10 y versiones posteriores (incluyendo 24.04 LTS), y en otras distribuciones que incluyen el mismo endurecimiento del kernel, **instale el paquete `.deb`** (o el `.rpm` en Fedora/openSUSE) en lugar del AppImage.

Estos kernels restringen por defecto los espacios de nombres de usuario sin privilegios (`kernel.apparmor_restrict_unprivileged_userns=1`). MailCopilot esta basado en Electron, cuyo componente auxiliar `chrome-sandbox` necesita esa capacidad cuando se lanza desde un AppImage — por lo que el AppImage falla al iniciar con una senal `SIGTRAP`. Los paquetes `.deb` y `.rpm` no tienen este problema: sus scripts de instalacion configuran el componente auxiliar `chrome-sandbox` de forma adecuada — aplicando SUID-root (`chmod 4755`) donde los espacios de nombres de usuario sin privilegios estan restringidos, o instalando un perfil de AppArmor en sistemas Ubuntu mas recientes (24.04+).

**No** evite esto lanzando la aplicacion con `--no-sandbox` o deshabilitando globalmente `apparmor_restrict_unprivileged_userns` — ambas opciones debilitan el limite de seguridad que le protege del contenido de correo electronico no fiable. En su lugar, utilice el `.deb` o el `.rpm`.
:::

### Deb (Debian, Ubuntu, Mint) — recomendado

1. Descarga el archivo `.deb` desde el sitio web.
2. Instalalo haciendo doble clic o en un terminal:
   ```bash
   sudo dpkg -i mailcopilot-*.deb
   ```
3. Inicia MailCopilot desde el menu de aplicaciones.

### RPM (Fedora, openSUSE)

1. Descarga el archivo `.rpm` desde el sitio web.
2. Instalalo haciendo doble clic o en un terminal:
   ```bash
   sudo rpm -i mailcopilot-*.rpm
   ```
3. Inicia MailCopilot desde el menu de aplicaciones.

### AppImage

El AppImage es un unico archivo autocontenido que no requiere instalacion. Funciona bien en distribuciones mas antiguas, pero consulte la advertencia anterior antes de usarlo en Ubuntu 23.10+ / 24.04.

1. Descarga el archivo `.AppImage` desde el sitio web.
2. Hazlo ejecutable:
   - Clic derecho > **Propiedades** > **Permisos** > **Permitir ejecutar como programa**.
   - O en un terminal: `chmod +x mailcopilot-*.AppImage`
3. Haz doble clic en el AppImage para iniciar MailCopilot.

El runtime de AppImage requiere FUSE. En versiones recientes de Debian/Ubuntu, instala el paquete `libfuse2t64` (en versiones mas antiguas se llama `libfuse2`):

```bash
sudo apt install libfuse2t64
```

:::tip
Puedes mover el AppImage a cualquier ubicacion, como `~/Applications/`. La aplicacion es completamente autonoma.
:::

## Instalacion en Windows

1. Descarga el instalador `.exe` desde el sitio web.
2. Ejecuta el instalador y sigue las instrucciones. Puedes elegir el directorio de instalacion.
3. Inicia MailCopilot desde el menu Inicio o el acceso directo del escritorio.

## Primer inicio

Al iniciar por primera vez, aparecera el asistente de configuracion de cuenta. La aplicacion le guiara para conectar su primera cuenta de correo electronico.

Sus contrasenas se almacenan de forma segura en el llavero del sistema (keytar) y nunca se escriben en archivos de configuracion en texto plano.

## Actualizaciones automaticas

MailCopilot busca actualizaciones automaticamente. Cuando hay una nueva version disponible, aparece una notificacion en la aplicacion. Puedes descargar la actualizacion y reiniciar con un clic.

:::note
Las actualizaciones automaticas integradas en la aplicacion solo estan disponibles cuando MailCopilot esta instalado en una ubicacion con permisos de escritura — por ejemplo, un AppImage almacenado en su directorio personal. Al instalar desde un paquete de sistema `.deb` o `.rpm`, el directorio de instalacion suele ser propiedad de root y no tiene permisos de escritura para su cuenta de usuario, por lo que MailCopilot desactiva el actualizador integrado automaticamente. En ese caso, actualice a traves de su gestor de paquetes (`apt`/`dnf`) o descargando y reinstalando el ultimo paquete desde el sitio web.
:::
