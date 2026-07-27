---
sidebar_position: 4
title: Configuración de carpetas
---

# Configuración de carpetas

Abra **Configuración > Carpetas** para configurar cómo MailCopilot gestiona sus carpetas de correo electrónico.

## Asignación de roles de carpetas

MailCopilot necesita saber qué carpeta del servidor corresponde a cada rol especial (Archivo, Papelera, Enviados, Borradores, Spam). La detección es automática según los atributos IMAP estándar, pero puede modificar la asignación manualmente.

Para cada rol, puede:
- Dejar **Auto** para usar la carpeta detectada automáticamente.
- Seleccionar una carpeta específica en la lista desplegable.
- Hacer clic en **Crear** para crear la carpeta estándar en el servidor si no existe.

## Política de sincronización de carpetas

Debajo de la asignación de roles, encontrará una configuración detallada para cada carpeta de su cuenta:

### Visibilidad

- **Mostrar en la barra lateral** -- determina si la carpeta aparece en la barra lateral. Desmarque esta opción para ocultar carpetas que usa con poca frecuencia.

### Insignias de no leídos

- **Incluir en insignias de no leídos** -- determina si la cantidad de mensajes no leídos de esta carpeta se incluye en la insignia total de la aplicación.

### Indexación para búsqueda

- **Incluir en la búsqueda** -- determina si los cuerpos de los mensajes de esta carpeta se indexan para la búsqueda de texto completo. Cuando está desactivado, la carpeta sigue siendo visible en la lista de mensajes y sus encabezados son buscables, pero las consultas `body:` no devolverán resultados de esta carpeta.

Las carpetas de correo no deseado, Spam y Papelera tienen la indexación de búsqueda desactivada de forma predeterminada para evitar saturar los resultados de búsqueda y reducir el uso del disco. Puede activar la indexación para cualquier carpeta si lo necesita.

### Modo de sincronización de encabezados

Controla cómo se sincronizan los encabezados de mensajes para la carpeta:

- **Todos los mensajes** -- sincronizar todos los encabezados (recomendado para la bandeja de entrada).
- **Al abrir** -- sincronizar los encabezados solo cuando acceda a la carpeta.
- **Por período** -- sincronizar los encabezados de los últimos N días únicamente.

Para detener completamente la sincronización de una carpeta, ocúltela mediante la opción **Ocultar de la barra lateral** del menú contextual. Las carpetas ocultas quedan completamente excluidas de la sincronización de encabezados, el almacenamiento sin conexión y los badges.

### Modo sin conexión {#offline-mode}

Controla la descarga de cuerpos de mensajes para lectura sin conexión:

- **Desactivado** -- no descargar los cuerpos de mensajes.
- **Por período** -- descargar los cuerpos de los últimos N días.
- **Todos los mensajes** -- descargar todos los cuerpos de mensajes.

## Selección de cuenta

Si tiene varias cuentas, use el selector de cuenta en la parte superior para cambiar entre cuentas y configurar las carpetas de cada una por separado.
